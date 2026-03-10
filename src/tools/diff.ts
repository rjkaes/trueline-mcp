import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { extractSymbols, diffSymbols, type SymbolDiff } from "../semantic-diff.ts";
import { getLanguageConfig } from "../outline/languages.ts";
import { validatePath } from "./shared.ts";
import { type ToolResult, textResult } from "./types.ts";

interface DiffParams {
  file_paths: string[];
  compare_against?: string;
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleDiff(params: DiffParams): Promise<ToolResult> {
  const { compare_against = "HEAD", projectDir, allowedDirs } = params;
  let filePaths = params.file_paths;

  // Expand "*" to all changed files
  if (filePaths.length === 1 && filePaths[0] === "*") {
    filePaths = getChangedFiles(projectDir ?? process.cwd(), compare_against);
    if (filePaths.length === 0) {
      return textResult("No changed files found.");
    }
  }

  const sections: string[] = [];

  for (const filePath of filePaths) {
    const validated = await validatePath(filePath, "Read", projectDir, allowedDirs);
    if (!validated.ok) {
      sections.push(`## ${filePath}\n\nAccess denied.`);
      continue;
    }

    const { resolvedPath } = validated;
    const ext = extname(resolvedPath).replace(/^\./, "");
    const relPath = filePath.startsWith("/") ? relative(projectDir ?? process.cwd(), resolvedPath) : filePath;

    // Read disk content
    let diskContent: string;
    try {
      diskContent = await readFile(resolvedPath, "utf-8");
    } catch {
      sections.push(`## ${relPath}\n\nFile not readable.`);
      continue;
    }

    // Read git content
    const gitContent = getGitContent(resolvedPath, compare_against, projectDir ?? process.cwd());

    // Extract symbols from both
    const [oldSymbols, newSymbols] = await Promise.all([
      extractSymbols(gitContent, ext),
      extractSymbols(diskContent, ext),
    ]);

    // Unsupported file type: extension has no language config
    if (!getLanguageConfig(`.${ext}`)) {
      sections.push(`## ${relPath}\n\nFile type not supported for semantic diffing.`);
      continue;
    }

    const diff = diffSymbols(oldSymbols, newSymbols);
    const formatted = formatDiffSection(relPath, diff, compare_against);
    if (formatted) sections.push(formatted);
  }

  if (sections.length === 0) {
    return textResult("No structural changes detected.");
  }

  return textResult(sections.join("\n\n"));
}

// ==============================================================================
// Git helpers
// ==============================================================================

// Strip inherited GIT_* env vars so git discovers the repo from cwd,
// not from a parent worktree or other inherited context.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"], env: gitEnv }).toString("utf-8");
}

function getGitContent(filePath: string, ref: string, cwd: string): string {
  try {
    // Use git's own toplevel to compute the relative path, so that
    // Windows 8.3 short-name mismatches between realpath() and the
    // test's realpathSync() don't produce wrong relative paths.
    const toplevel = gitExec("git rev-parse --show-toplevel", cwd).trim();
    const relPath = relative(toplevel, filePath).replace(/\\/g, "/");
    return gitExec(`git show ${ref}:${relPath}`, cwd);
  } catch {
    return ""; // untracked or not in git
  }
}

function getChangedFiles(cwd: string, ref: string): string[] {
  try {
    const output = gitExec(`git diff --name-only ${ref}`, cwd);
    const untrackedOutput = gitExec("git ls-files --others --exclude-standard", cwd);
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

function formatDiffSection(relPath: string, diff: SymbolDiff, ref: string): string | null {
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
    parts.push("\n**Added:**");
    for (const s of diff.added) parts.push(`- \`${s.signature}\``);
  }

  if (diff.removed.length > 0) {
    parts.push("\n**Removed:**");
    for (const s of diff.removed) parts.push(`- \`${s.signature}\``);
  }

  if (diff.renamed.length > 0) {
    parts.push("\n**Renamed:**");
    for (const r of diff.renamed) parts.push(`- \`${r.oldName}\` \u2192 \`${r.newName}\``);
  }

  if (diff.signatureChanged.length > 0) {
    parts.push("\n**Signature changed:**");
    for (const s of diff.signatureChanged) {
      parts.push(`- \`${s.name}\`: \`${s.oldSig}\` \u2192 \`${s.newSig}\``);
    }
  }

  if (diff.logicChanged.length > 0) {
    parts.push("\n**Logic modified:**");
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
  const m = oldLines.length;
  const n = newLines.length;

  // Strip common prefix and suffix to shrink the DP table. For typical
  // diffs (a few lines changed in a large function) this makes the
  // O(m*n) LCS tractable.
  let prefixLen = 0;
  while (prefixLen < m && prefixLen < n && oldLines[prefixLen] === newLines[prefixLen]) prefixLen++;

  let suffixLen = 0;
  while (
    suffixLen < m - prefixLen &&
    suffixLen < n - prefixLen &&
    oldLines[m - 1 - suffixLen] === newLines[n - 1 - suffixLen]
  )
    suffixLen++;

  const oldMid = oldLines.slice(prefixLen, m - suffixLen);
  const newMid = newLines.slice(prefixLen, n - suffixLen);
  const mm = oldMid.length;
  const nn = newMid.length;

  // If the remaining region is still too large, bail out.
  const MAX_DP_CELLS = 1_000_000;
  if (mm * nn > MAX_DP_CELLS) return null;

  // Build LCS length table on the trimmed middle region
  const dp: number[][] = Array.from({ length: mm + 1 }, () => new Array(nn + 1).fill(0));
  for (let i = 1; i <= mm; i++) {
    for (let j = 1; j <= nn; j++) {
      if (oldMid[i - 1] === newMid[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find removed/added lines
  const removed: string[] = [];
  const added: string[] = [];
  let i = mm;
  let j = nn;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldMid[i - 1] === newMid[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added.push(newMid[j - 1]);
      j--;
    } else {
      removed.push(oldMid[i - 1]);
      i--;
    }
  }

  const totalDiffLines = removed.length + added.length;
  if (totalDiffLines === 0 || totalDiffLines > INLINE_DIFF_THRESHOLD) return null;

  // Reverse since we backtracked from the end
  removed.reverse();
  added.reverse();

  const lines: string[] = [];
  for (const r of removed) lines.push(`  - ${r.trim()}`);
  for (const a of added) lines.push(`  + ${a.trim()}`);
  return lines.join("\n");
}
