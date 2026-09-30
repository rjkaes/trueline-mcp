import { readTextNoFollow } from "../line-splitter.ts";
import { lcsMiddle, trimCommonEnds } from "../diff-collector.ts";
import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { extractSymbols, diffSymbols, normalizeBody, type SymbolDiff } from "../semantic-diff.ts";
import { getLanguageConfig, type LanguageConfig } from "../outline/languages.ts";
import {
  checkPathBoundary,
  displayPath,
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
  // `*` fills it; an explicit path loads it only when the file is new to the ref.
  let renamedFrom: Promise<Map<string, string>> | undefined;

  // The ref goes straight into git argv, where a leading dash is an option:
  // --output=<path> would write outside allowedDirs.
  if (compare_against.startsWith("-")) {
    return errorResult(`Invalid compare_against "${compare_against}": a git ref cannot start with "-".`);
  }
  // resolvedPath is canonical, so the base must be too: an aliased projectDir
  // (symlink, /var vs /private/var, Windows 8.3 RUNNER~1) yields ../ headers.
  // A missing project directory denies every path, so fail once here, plainly.
  const realProject = await realpath(cwd).catch(() => null);
  if (realProject === null) return errorResult("Project directory not found or inaccessible");
  // An unresolvable ref must fail loudly: as an empty baseline it reports every symbol as added.
  // Checked on first use, so per-file notes (unsupported, binary, denied) still work outside a repo.
  const invalidRef = errorResult(`compare_against "${compare_against}" is not a commit in this git repository.`);
  let refKind: Promise<"commit" | "unborn" | "index" | "invalid"> | undefined;
  const checkRefOnce = () => (refKind ??= checkRef(compare_against, cwd));

  // Expand "*" to all changed files
  if (filePaths.length === 1 && filePaths[0] === "*") {
    const kind = await checkRefOnce();
    if (kind === "invalid") return invalidRef;
    let changed: Awaited<ReturnType<typeof getChangedFiles>>;
    try {
      changed = await getChangedFiles(cwd, kind === "unborn" ? undefined : compare_against);
    } catch (err) {
      // A long untracked list overflows gitExec's buffer: answer, rather than reject as an internal error.
      const { code, stderr = "", message } = err as Error & { code?: string; stderr?: string };
      const reason =
        code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "git's file list is over the 10 MB limit"
          : (stderr || message).trim().split("\n")[0];
      return errorResult(`Could not list the changed files: ${reason}. Pass explicit file_paths instead of "*".`);
    }
    filePaths = changed.files;
    renamedFrom = Promise.resolve(changed.renamedFrom);
    if (filePaths.length === 0) {
      return textResult("No changed files found.");
    }
  }

  const sections: string[] = [];
  // Every file shares one repo toplevel; spawn rev-parse once, on first use.
  let toplevel: Promise<string> | undefined;

  for (const filePath of filePaths) {
    if (requireAbsolutePath && filePath !== "*" && !isAbsolutePathArg(filePath)) {
      const errorText = (relativePathError(filePath).content[0] as { text: string }).text;
      sections.push(`## ${filePath}\n\n${errorText}`);
      continue;
    }

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
      // Project-relative like every other header; a path that failed validation has no realpath to derive one from.
      const shown = isAbsolute(filePath) ? displayPath(filePath, cwd) : filePath;
      // Something is on disk (denied, oversize, not a regular file), so this is not a deletion. "*" never is.
      if (
        filePath === "*" ||
        (await lstat(absolute).then(
          () => true,
          () => false,
        ))
      ) {
        // Deny and boundary refusals stay generic; any other reason says what is wrong with the path itself.
        const refusal = (validated.error.content[0] as { text: string }).text;
        const reason =
          filePath === "*" || refusal.startsWith("Access denied")
            ? "Access denied."
            : `${refusal.replace(`"${filePath}"`, () => `"${shown}"`)}.`;
        sections.push(`## ${shown}\n\n${reason}`);
        continue;
      }
      resolvedPath = await resolveMissingPath(absolute);
      const boundary = await checkPathBoundary(filePath, absolute, resolvedPath, "Read", projectDir, allowedDirs);
      if (!boundary.ok) {
        sections.push(`## ${shown}\n\nAccess denied.`);
        continue;
      }
      deletedOnDisk = true;
    }

    const ext = extname(resolvedPath).toLowerCase();
    // relative() yields backslashes on Windows; headers use forward slashes on every platform.
    const relPath = isAbsolute(filePath) ? relative(realProject, resolvedPath).replace(/\\/g, "/") : filePath;

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
    let gitContent: string | null = null;
    try {
      // An unborn HEAD has no tree: every file is new. Spawning rev-parse there would leave its promise unawaited.
      if (refState !== "unborn") {
        toplevel ??= gitExec(["rev-parse", "--show-toplevel"], cwd).then((out) => out.trim());
        gitContent = await getGitContent(resolvedPath, compare_against, cwd, toplevel);
        // New to the ref may mean renamed: its old path is the baseline, or every symbol reads as added.
        if (gitContent === null && refState === "commit" && !deletedOnDisk) {
          renamedFrom ??= getChangedFiles(cwd, compare_against).then((changed) => changed.renamedFrom);
          const oldPath = (await renamedFrom).get(resolve(cwd, relative(realProject, resolvedPath)));
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
            gitContent = await getGitContent(join(realProject, oldPath), compare_against, cwd, toplevel);
          }
        }
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
    sections.push(formatDiffSection(relPath, diff, compare_against, getLanguageConfig(ext)?.whitespaceMode));
  }

  return textResult(sections.join("\n\n"));
}

// ==============================================================================
// Git helpers
// ==============================================================================

/** The ref advertised for staged content. */
const INDEX_REF = ":0";

/** "unborn" is HEAD in a repo with no commits, where every file is new. */
async function checkRef(ref: string, cwd: string): Promise<"commit" | "unborn" | "index" | "invalid"> {
  // Staged content lives in the index, not a commit: `^{commit}` would reject it.
  if (ref === INDEX_REF) {
    return gitExec(["rev-parse", "--git-dir"], cwd).then(
      () => "index" as const,
      () => "invalid" as const,
    );
  }
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
  // The index has no tree for ls-tree: ls-files lists it, `top` and `literal` making the pathspec root-relative
  // and matching `zz*` only as itself. Stage 0 and no gitlink (mode 160000): the entry must be a blob.
  const listing =
    ref === INDEX_REF
      ? await gitExec(["ls-files", "-z", "--stage", "--", `:(top,literal)${relPath}`], cwd)
      : await gitExec(["ls-tree", "-z", "--full-tree", ref, "--", `./${relPath}`], cwd);
  const blobId = (ref === INDEX_REF ? /^(?!160000)\d+ (\w+) 0\t/ : /^\d+ blob (\w+)\t/).exec(listing)?.[1];
  if (blobId === undefined) return null;
  const content = await gitExec(["cat-file", "blob", blobId], cwd);
  // The disk side is read without its BOM; match it so a BOM-prefixed file does not differ on its first symbol.
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Files changed since `ref` (undefined: no commits yet, so staged files count; `:0`: the working tree against the
 * index) plus untracked ones, as absolute paths. Directories are not files: git lists a dirty submodule and an
 * untracked nested repo by path.
 */
async function getChangedFiles(
  cwd: string,
  ref: string | undefined,
): Promise<{ files: string[]; renamedFrom: Map<string, string> }> {
  // -z: git octal-quotes non-ASCII names otherwise. --relative: names are relative to
  // cwd, not the repo root, so they resolve against cwd from a repo subdirectory.
  const baseline = ref === INDEX_REF ? [] : [ref ?? "--cached"];
  const diffArgs = ["diff", "--name-status", "-z", "-M", "--relative", ...baseline, "--"];
  const changes = (await gitExec(diffArgs, cwd)).split("\0");
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
  const kept: string[] = [];
  for (const file of files) {
    // Gone from disk is a deletion, which stays listed.
    const stats = await lstat(file).catch(() => null);
    if (!stats?.isDirectory()) kept.push(file);
  }
  return { files: kept, renamedFrom };
}

// ==============================================================================
// Output formatting
// ==============================================================================

/** Threshold: inline mini-diff for body changes <= this many lines different */
const INLINE_DIFF_THRESHOLD = 5;

function formatDiffSection(
  relPath: string,
  diff: SymbolDiff,
  ref: string,
  whitespaceMode?: LanguageConfig["whitespaceMode"],
): string {
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
      const miniDiff = computeMiniDiff(s.oldBody, s.newBody, whitespaceMode);
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
export function computeMiniDiff(
  oldBody?: string,
  newBody?: string,
  whitespaceMode?: LanguageConfig["whitespaceMode"],
): string | null {
  if (!oldBody || !newBody) return null;

  // Compare what the logic-change test compares, in the language's whitespace mode: a difference it ignores
  // (line endings, blank lines, and indentation outside Python-like languages) is no change here and takes no
  // share of the inline-diff budget.
  const oldLines = normalizeBody(oldBody, whitespaceMode).split("\n");
  const newLines = normalizeBody(newBody, whitespaceMode).split("\n");

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

  return [...removed.map((r) => `-${r}`), ...added.map((a) => `+${a}`)].join("\n");
}
