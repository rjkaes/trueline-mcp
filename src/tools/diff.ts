import { readTextNoFollow } from "../line-splitter.ts";
import { lcsMiddle, trimCommonEnds } from "../diff-collector.ts";
import { extname, relative, resolve } from "node:path";
import { extractSymbols, diffSymbols, type SymbolDiff } from "../semantic-diff.ts";
import { getLanguageConfig } from "../outline/languages.ts";
import { gitExec, isAbsolutePathArg, relativePathError, type ToolContext, validatePath } from "./shared.ts";
import { type ToolResult, textResult, errorResult } from "./types.ts";

interface DiffParams extends ToolContext {
  file_paths: string[];
  compare_against?: string;
}

export async function handleDiff(params: DiffParams): Promise<ToolResult> {
  const { compare_against = "HEAD", projectDir, allowedDirs, requireAbsolutePath } = params;
  let filePaths = params.file_paths;

  // Expand "*" to all changed files
  if (filePaths.length === 1 && filePaths[0] === "*") {
    filePaths = await getChangedFiles(projectDir ?? process.cwd(), compare_against);
    if (filePaths.length === 0) {
      return textResult("No changed files found.");
    }
  }

  const sections: string[] = [];

  for (const filePath of filePaths) {
    if (requireAbsolutePath && filePath !== "*" && !isAbsolutePathArg(filePath)) {
      const errorText = (relativePathError(filePath).content[0] as { text: string }).text;
      sections.push(`## ${filePath}\n\n${errorText}`);
      continue;
    }

    const validated = await validatePath(filePath, "Read", projectDir, allowedDirs);
    if (!validated.ok) {
      sections.push(`## ${filePath}\n\nAccess denied.`);
      continue;
    }

    const { resolvedPath } = validated;
    const ext = extname(resolvedPath);
    const relPath = filePath.startsWith("/") ? relative(projectDir ?? process.cwd(), resolvedPath) : filePath;

    // Read disk content
    let diskContent: string | null;
    try {
      diskContent = await readTextNoFollow(resolvedPath);
    } catch {
      sections.push(`## ${relPath}\n\nFile not readable.`);
      continue;
    }
    if (diskContent === null) {
      return errorResult(`"${filePath}" appears to be a binary file`);
    }

    // Read git content
    const gitContent = await getGitContent(resolvedPath, compare_against, projectDir ?? process.cwd());

    // Extract symbols from both
    const [oldSymbols, newSymbols] = await Promise.all([
      extractSymbols(gitContent, ext),
      extractSymbols(diskContent, ext),
    ]);

    // Unsupported file type: extension has no language config
    if (!getLanguageConfig(ext)) {
      sections.push(`## ${relPath}\n\nFile type not supported for semantic diffing.`);
      continue;
    }

    const diff = diffSymbols(oldSymbols, newSymbols);
    sections.push(formatDiffSection(relPath, diff, compare_against));
  }

  return textResult(sections.join("\n\n"));
}

// ==============================================================================
// Git helpers
// ==============================================================================

async function getGitContent(filePath: string, ref: string, cwd: string): Promise<string> {
  try {
    // Use git's own toplevel to compute the relative path, so that
    // Windows 8.3 short-name mismatches between realpath() and the
    // test's realpathSync() don't produce wrong relative paths.
    const toplevel = (await gitExec(["rev-parse", "--show-toplevel"], cwd)).trim();
    const relPath = relative(toplevel, filePath).replace(/\\/g, "/");
    return await gitExec(["show", `${ref}:${relPath}`], cwd);
  } catch {
    return ""; // untracked or not in git
  }
}

async function getChangedFiles(cwd: string, ref: string): Promise<string[]> {
  try {
    const output = await gitExec(["diff", "--name-only", ref], cwd);
    const untrackedOutput = await gitExec(["ls-files", "--others", "--exclude-standard"], cwd);
    const files = [...output.trim().split("\n"), ...untrackedOutput.trim().split("\n")]
      .filter(Boolean)
      .map((f) => resolve(cwd, f));
    return [...new Set(files)];
  } catch {
    return [];
  }
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
