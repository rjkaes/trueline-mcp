import { checksumToLetters, FNV_OFFSET_BASIS, foldHash, fnv1aHash, hashToLetters } from "../src/hash.ts";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Fold loop shared by rangeChecksum (prints the clamped end line) and
// issueTestRef (prints endLine as passed).
function foldRange(lines: string[], startLine: number, endLine: number) {
  let hash = FNV_OFFSET_BASIS;
  const effectiveEnd = Math.min(endLine, lines.length);
  let firstLetters = "";
  let lastLetters = "";
  for (let i = startLine - 1; i < effectiveEnd; i++) {
    const h = fnv1aHash(lines[i]);
    const letters = hashToLetters(h);
    if (i === startLine - 1) firstLetters = letters;
    lastLetters = letters;
    hash = foldHash(hash, h);
  }
  return { hash, firstLetters, lastLetters, effectiveEnd };
}

/**
 * Compute a read-range checksum over a slice of file lines.
 *
 * Test-only helper — production code computes checksums inline during
 * streaming reads. Tests need a standalone version to fabricate valid
 * checksum strings for `handleEdit` / `handleDiff` inputs.
 */
export function rangeChecksum(lines: string[], startLine: number, endLine: number): string {
  const { hash, firstLetters, lastLetters, effectiveEnd } = foldRange(lines, startLine, endLine);
  return `${firstLetters}${startLine}-${lastLetters}${effectiveEnd}/${checksumToLetters(hash)}`;
}

/**
 * Compute 2-character content hash for a line.
 *
 * Maps FNV-1a output to a two-character tag via `hashToLetters`.
 */
export function lineHash(line: string): string {
  return hashToLetters(fnv1aHash(line));
}

/**
 * Build a `hashLine` reference for use in edit ranges.
 *
 * Mirrors the output format of trueline_read: `ab12` where `ab` is the
 * 2-letter content hash and `12` is the line number.
 */
export function hashLine(line: string, lineNumber: number): string {
  return `${lineHash(line)}${lineNumber}`;
}

/**
 * Regex that matches the new `hashLine\tcontent` output format from
 * trueline_read / trueline_search.
 */
export const LINE_PATTERN = /^[a-z]{2}\d+\t/;

/**
 * Extract the text string from an MCP tool result.
 */
export function getText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

/**
 * Write a file into a test directory and return its absolute path.
 */
export function writeTestFile(testDir: string, name: string, content: string): string {
  const path = join(testDir, name);
  writeFileSync(path, content);
  return path;
}

/**
 * Compute an inline ref string for a test file range.
 * Returns "ab.N-cd.M:efghij" format used by trueline_read/trueline_search.
 */
export function issueTestRef(lines: string[], startLine: number, endLine: number): string {
  const { hash, firstLetters, lastLetters } = foldRange(lines, startLine, endLine);
  return `${firstLetters}${startLine}-${lastLetters}${endLine}/${checksumToLetters(hash)}`;
}

/**
 * Write a file into a test directory; return its path, logical lines, and a
 * ref over all of them (the "0-0/aaaaaa" sentinel for an empty file).
 */
export function setupFile(testDir: string, name: string, content: string) {
  const path = writeTestFile(testDir, name, content);
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const ref = lines.length > 0 ? issueTestRef(lines, 1, lines.length) : "0-0/aaaaaa";
  return { path, lines, ref };
}

// Strip inherited GIT_* env vars: under `git commit -a`, lefthook exports an absolute
// GIT_INDEX_FILE that would point fixture repos at the parent repo's pending commit.
export const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

/**
 * Create a throwaway git repo under the OS temp dir; the caller removes `dir`.
 *
 * `git` takes argv (`git("add", ".")`) or one whole command (`git("add .")`), which is
 * split on spaces: no real git invocation has a single argument containing a space.
 */
export function makeGitRepo(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]) =>
    execFileSync("git", args.length === 1 ? args[0].split(" ") : args, {
      cwd: dir,
      stdio: "pipe",
      env: cleanEnv,
      encoding: "utf-8",
    });
  git("init", "-q");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}
