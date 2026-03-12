import { FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash, fnv1aHash, formatChecksum, hashToLetters } from "../src/hash.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

/**
 * Compute a read-range checksum over a slice of file lines.
 *
 * Test-only helper — production code computes checksums inline during
 * streaming reads. Tests need a standalone version to fabricate valid
 * checksum strings for `handleEdit` / `handleDiff` inputs.
 */
export function rangeChecksum(lines: string[], startLine: number, endLine: number): string {
  let hash = FNV_OFFSET_BASIS;
  const effectiveEnd = Math.min(endLine, lines.length);
  for (let i = startLine - 1; i < effectiveEnd; i++) {
    hash = foldHash(hash, fnv1aHash(lines[i]));
  }
  return formatChecksum(startLine, effectiveEnd, hash);
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
 * Compute a read-range checksum over raw byte buffers.
 *
 * Use this for non-UTF-8 test files where the raw bytes differ from
 * the UTF-8 encoding of the decoded string.
 */
export function rawRangeChecksum(bufs: Buffer[], startLine: number, endLine: number): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bufs.length; i++) {
    hash = foldHash(hash, fnv1aHashBytes(bufs[i], 0, bufs[i].length));
  }
  return formatChecksum(startLine, endLine, hash);
}

/**
 * Compute 2-letter content hash from raw bytes.
 */
export function rawLineHash(buf: Buffer): string {
  const h = fnv1aHashBytes(buf, 0, buf.length);
  return hashToLetters(h);
}

/**
 * Build a `hash.line` reference for use in edit ranges.
 *
 * Mirrors the output format of trueline_read: `ab.12` where `ab` is the
 * 2-letter content hash and `12` is the line number.
 */
export function hashDotLine(line: string, lineNumber: number): string {
  return `${lineHash(line)}.${lineNumber}`;
}

/**
 * Regex that matches the new `hash.line\tcontent` output format from
 * trueline_read / trueline_search.
 */
export const LINE_PATTERN = /^[a-z]{2}\.\d+\t/;

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
