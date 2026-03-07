import { FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash, fnv1aHash, formatChecksum, hashToLetters } from "../src/hash.ts";

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
