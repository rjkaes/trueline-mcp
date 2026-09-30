import { readTextNoFollow } from "../line-splitter.ts";
import { lcsMiddle, trimCommonEnds } from "../diff-collector.ts";
import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { extractSymbols, diffSymbols, type SymbolDiff } from "../semantic-diff.ts";
import { getLanguageConfig } from "../outline/languages.ts";
import {
  checkPathBoundary,
  gitExec,
  isAbsolutePathArg,
  relativePathError,
  type ToolContext,
  validatePath,
} from "./shared.ts";
import { type ToolResult, errorResult, textResult } from "./types.ts";

interface DiffParams extends ToolContext {
  file_paths: string[];
  compare_against?: string;
}

export async function handleDiff(params: DiffParams): Promise<ToolResult> {
  const { compare_against = "HEAD", projectDir, allowedDirs, requireAbsolutePath } = params;
  const cwd = projectDir ?? process.cwd();
  let filePaths = params.file_paths;
  // Old cwd-relative path of each file git reports as renamed, keyed by its new absolute path.
  let renamedFrom = new Map<string, string>();

  // The ref goes straight into git argv, where a leading dash is an option:
  // --output=<path> would write outside allowedDirs.
  if (compare_against.startsWith("-")) {
    return errorResult(`Invalid compare_against "${compare_against}": a git ref cannot start with "-".`);
  }
  // An unresolvable ref must fail loudly: as an empty baseline it reports every symbol as added.
  // Checked on first use, so per-file notes (unsupported, binary, denied) still work outside a repo.
  const invalidRef = errorResult(`compare_against "${compare_against}" is not a commit in this git repository.`);
  let refKind: Promise<"commit" | "unborn" | "invalid"> | undefined;
  const checkRefOnce = () => (refKind ??= checkRef(compare_against, cwd));

  // Expand "*" to all changed files
  if (filePaths.length === 1 && filePaths[0] === "*") {
    const kind = await checkRefOnce();
    if (kind === "invalid") return invalidRef;
    ({ files: filePaths, renamedFrom } = await getChangedFiles(cwd, kind === "unborn" ? undefined : compare_against));
    if (filePaths.length === 0) {
      return textResult("No changed files found.");
    }
  }

  const sections: string[] = [];
  // Every file shares one repo toplevel; spawn rev-parse once, on first use.
  let toplevel: Promise<string> | undefined;
  // resolvedPath is canonical, so the base must be too: an aliased projectDir
  // (symlink, /var vs /private/var, Windows 8.3 RUNNER~1) yields ../ headers.
  let realProject: Promise<string> | undefined;

  for (const filePath of filePaths) {
    if (requireAbsolutePath && filePath !== "*" && !isAbsolutePathArg(filePath)) {
      const errorText = (relativePathError(filePath).content[0] as { text: string }).text;
      sections.push(`## ${filePath}\n\n${errorText}`);
      continue;
    }

    realProject ??= realpath(cwd);
    let resolvedPath: string;
    let deletedOnDisk = false;
    const validated = await validatePath(filePath, "Read", projectDir, allowedDirs);
    if (validated.ok) {
      resolvedPath = validated.resolvedPath;
    } else {
      // validatePath realpaths its target, so it rejects a file deleted since the
      // ref. Rerun its boundary checks (checkPathBoundary) on the nearest existing
      // ancestor plus the missing tail; content then comes from git, not disk.
      const absolute = resolve(cwd, filePath);
      // Something is on disk (denied, oversize, not a regular file), so this is not a deletion. "*" never is.
      if (
        filePath === "*" ||
        (await lstat(absolute).then(
          () => true,
          () => false,
        ))
      ) {
        sections.push(`## ${filePath}\n\nAccess denied.`);
        continue;
      }
      resolvedPath = await resolveMissingPath(absolute);
      const boundary = await checkPathBoundary(filePath, absolute, resolvedPath, "Read", projectDir, allowedDirs);
      if (!boundary.ok) {
        sections.push(`## ${filePath}\n\nAccess denied.`);
        continue;
      }
      deletedOnDisk = true;
    }

    const ext = extname(resolvedPath).toLowerCase();
    // relative() yields backslashes on Windows; headers use forward slashes on every platform.
    const relPath = isAbsolute(filePath) ? relative(await realProject, resolvedPath).replace(/\\/g, "/") : filePath;

    // Unsupported file type: extension has no language config. Checked before
    // any I/O so lockfiles, JSON, and images skip the disk read and git spawns.
    if (!getLanguageConfig(ext)) {
      sections.push(`## ${relPath}\n\nFile type not supported for semantic diffing.`);
      continue;
    }

    // Read disk content
    let diskContent: string | null;
    try {
      diskContent = deletedOnDisk ? "" : await readTextNoFollow(resolvedPath);
    } catch {
      sections.push(`## ${relPath}\n\nFile not readable.`);
      continue;
    }
    if (diskContent === null) {
      sections.push(`## ${relPath}\n\nBinary file, not diffed.`);
      continue;
    }

    // Read git content
    const refState = await checkRefOnce();
    if (refState === "invalid") return invalidRef;
    const oldPath = renamedFrom.get(filePath);
    if (oldPath !== undefined) {
      // The old side is historical content of a path the caller never named: it needs its own boundary and deny check.
      const oldAbsolute = resolve(cwd, oldPath);
      const oldBoundary = await checkPathBoundary(
        oldPath,
        oldAbsolute,
        await resolveMissingPath(oldAbsolute),
        "Read",
        projectDir,
        allowedDirs,
      );
      if (!oldBoundary.ok) {
        sections.push(`## ${relPath}\n\nRenamed from a path that is not readable; not diffed.`);
        continue;
      }
    }
    let gitContent: string | null = null;
    try {
      // An unborn HEAD has no tree: every file is new. Spawning rev-parse there would leave its promise unawaited.
      if (refState !== "unborn") {
        toplevel ??= gitExec(["rev-parse", "--show-toplevel"], cwd).then((out) => out.trim());
        gitContent = await getGitContent(
          oldPath ? join(await realProject, oldPath) : resolvedPath,
          compare_against,
          cwd,
          toplevel,
        );
      }
    } catch (err) {
      const { code, stderr = "", message } = err as Error & { code?: string; stderr?: string };
      const reason =
        code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "it is over the 10 MB limit"
          : (stderr || message).trim().split("\n")[0];
      sections.push(`## ${relPath}\n\nCould not read the ${compare_against} version: ${reason}.`);
      continue;
    }
    if (gitContent === null && deletedOnDisk) {
      sections.push(`## ${relPath}\n\nFile not found.`);
      continue;
    }

    // Extract symbols from both
    const [oldSymbols, newSymbols] = await Promise.all([
      extractSymbols(gitContent ?? "", ext),
      extractSymbols(diskContent, ext),
    ]);

    const diff = diffSymbols(oldSymbols, newSymbols);
    sections.push(formatDiffSection(relPath, diff, compare_against));
  }

  return textResult(sections.join("\n\n"));
}

// ==============================================================================
// Git helpers
// ==============================================================================

/** "unborn" is HEAD in a repo with no commits, where every file is new. */
async function checkRef(ref: string, cwd: string): Promise<"commit" | "unborn" | "invalid"> {
  try {
    await gitExec(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    return "commit";
  } catch {
    const onBranch = await gitExec(["symbolic-ref", "--quiet", "HEAD"], cwd).then(
      () => true,
      () => false,
    );
    return ref === "HEAD" && onBranch ? "unborn" : "invalid";
  }
}

/**
 * Canonical location of a path that may be gone from disk: the realpath of its nearest
 * existing ancestor plus the missing tail. What checkPathBoundary expects as `realPath`.
 */
async function resolveMissingPath(absolute: string): Promise<string> {
  let ancestor = absolute;
  let realAncestor = await realpath(ancestor).catch(() => null);
  while (realAncestor === null) {
    ancestor = dirname(ancestor);
    realAncestor = await realpath(ancestor).catch(() => null);
  }
  return join(realAncestor, relative(ancestor, absolute));
}

/**
 * Content of `filePath` at `ref`; null when the ref has no such file (new or untracked).
 * Every other git failure throws: an empty baseline would report every symbol as added.
 */
async function getGitContent(
  filePath: string,
  ref: string,
  cwd: string,
  toplevel: Promise<string>,
): Promise<string | null> {
  // Use git's own toplevel to compute the relative path, so that
  // Windows 8.3 short-name mismatches between realpath() and the
  // test's realpathSync() don't produce wrong relative paths.
  const relPath = relative(await toplevel, filePath).replace(/\\/g, "/");
  // Not `git show <ref>:<path>`: for a glob-ish path (`zz*`, `[id]`) it exits 0 and prints the commit.
  // ls-tree matches the path literally, and cat-file reads the blob by id, so no path is re-parsed.
  // The `./` keeps a leading `:` from being read as pathspec magic.
  const listing = await gitExec(["ls-tree", "-z", "--full-tree", ref, "--", `./${relPath}`], cwd);
  const blobId = /^\d+ blob (\w+)\t/.exec(listing)?.[1];
  if (blobId === undefined) return null;
  const content = await gitExec(["cat-file", "blob", blobId], cwd);
  // The disk side is read without its BOM; match it so a BOM-prefixed file does not differ on its first symbol.
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Files changed since `ref` (undefined: no commits yet, so staged files count) plus untracked ones, as absolute paths. */
async function getChangedFiles(
  cwd: string,
  ref: string | undefined,
): Promise<{ files: string[]; renamedFrom: Map<string, string> }> {
  // -z: git octal-quotes non-ASCII names otherwise. --relative: names are relative to
  // cwd, not the repo root, so they resolve against cwd from a repo subdirectory.
  const baseline = ref ?? "--cached";
  const changes = (await gitExec(["diff", "--name-status", "-z", "-M", "--relative", baseline, "--"], cwd)).split("\0");
  const untracked = (await gitExec(["ls-files", "--others", "--exclude-standard", "-z"], cwd)).split("\0");
  const files = new Set<string>();
  const renamedFrom = new Map<string, string>();
  // Records are `<status>\0<path>\0`, or `R<score>\0<old>\0<new>\0` for a rename; the last split entry is empty.
  let i = 0;
  while (i < changes.length - 1) {
    const oldName = changes[i++].startsWith("R") ? changes[i++] : undefined;
    const file = resolve(cwd, changes[i++]);
    files.add(file);
    if (oldName !== undefined) renamedFrom.set(file, oldName);
  }
  for (const name of untracked.filter(Boolean)) files.add(resolve(cwd, name));
  return { files: [...files], renamedFrom };
}

// ==============================================================================
// Output formatting
// ==============================================================================

/** Threshold: inline mini-diff for body changes <= this many lines different */
const INLINE_DIFF_THRESHOLD = 5;

function formatDiffSection(relPath: string, diff: SymbolDiff, ref: string): string {
  const hasChanges =
    diff.added.length +
      diff.removed.length +
      diff.renamed.length +
      diff.signatureChanged.length +
      diff.logicChanged.length >
    0;

  if (!hasChanges) return `## ${relPath}\n\nNo structural changes.`;

  const parts: string[] = [];
  parts.push(`## ${relPath} (vs ${ref})`);

  if (diff.added.length > 0) {
    parts.push("\n+:");
    for (const s of diff.added) parts.push(`- \`${s.signature}\``);
  }

  if (diff.removed.length > 0) {
    parts.push("\n-:");
    for (const s of diff.removed) parts.push(`- \`${s.signature}\``);
  }

  if (diff.renamed.length > 0) {
    parts.push("\n~:");
    for (const r of diff.renamed) parts.push(`- \`${r.oldName}\` \u2192 \`${r.newName}\``);
  }

  if (diff.signatureChanged.length > 0) {
    parts.push("\nsig:");
    for (const s of diff.signatureChanged) {
      parts.push(`- \`${s.name}\`: \`${s.oldSig}\` \u2192 \`${s.newSig}\``);
    }
  }

  if (diff.logicChanged.length > 0) {
    parts.push("\nbody:");
    for (const s of diff.logicChanged) {
      const miniDiff = computeMiniDiff(s.oldBody, s.newBody);
      if (miniDiff) {
        parts.push(`- \`${s.name}\`:\n${miniDiff}`);
      } else {
        parts.push(`- \`${s.name}\``);
      }
    }
  }

  return parts.join("\n");
}

/** Compute a mini inline diff if the change is small enough. */
export function computeMiniDiff(oldBody?: string, newBody?: string): string | null {
  if (!oldBody || !newBody) return null;

  const oldLines = oldBody.split("\n");
  const newLines = newBody.split("\n");

  // Use LCS (longest common subsequence) to find the minimal diff.
  // The greedy approach fails for insertions that shift all lines.
  const { oldMid, newMid } = trimCommonEnds(oldLines, newLines);

  // If the remaining region is still too large, bail out.
  const MAX_DP_CELLS = 1_000_000;
  const script = lcsMiddle(oldMid, newMid, MAX_DP_CELLS);
  if (script === null) return null;

  const removed = script.filter((e) => e.type === "del").map((e) => e.text);
  const added = script.filter((e) => e.type === "ins").map((e) => e.text);

  const totalDiffLines = removed.length + added.length;
  if (totalDiffLines === 0 || totalDiffLines > INLINE_DIFF_THRESHOLD) return null;

  return [...removed.map((r) => `-${r.trim()}`), ...added.map((a) => `+${a.trim()}`)].join("\n");
}
