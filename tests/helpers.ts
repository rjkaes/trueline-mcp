import {
  checksumToLetters,
  FNV_OFFSET_BASIS,
  fnv1aHashBytes,
  foldHash,
  fnv1aHash,
  hashToLetters,
} from "../src/hash.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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
 * Compute 2-letter content hash from raw bytes.
 */
export function rawLineHash(buf: Buffer): string {
  const h = fnv1aHashBytes(buf);
  return hashToLetters(h);
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
 * Compute an inline ref string for a raw byte buffer range.
 */
export function issueTestRefRaw(bufs: Buffer[], startLine: number, endLine: number): string {
  let hash = FNV_OFFSET_BASIS;
  let firstLetters = "";
  let lastLetters = "";
  for (let i = 0; i < bufs.length; i++) {
    const h = fnv1aHashBytes(bufs[i]);
    if (i === 0) firstLetters = hashToLetters(h);
    lastLetters = hashToLetters(h);
    hash = foldHash(hash, h);
  }
  const ck = checksumToLetters(hash);
  return `${firstLetters}${startLine}-${lastLetters}${endLine}/${ck}`;
}
