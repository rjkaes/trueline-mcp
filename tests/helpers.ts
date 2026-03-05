import { FNV_OFFSET_BASIS, foldHash, fnv1aHash, formatChecksum } from "../src/hash.ts";

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
 * Compute 2-letter content hash for a line.
 *
 * Maps FNV-1a output to two lowercase ASCII letters (676 possible values).
 */
export function lineHash(line: string): string {
  const h = fnv1aHash(line);
  const c1 = String.fromCharCode(97 + (h % 26));
  const c2 = String.fromCharCode(97 + ((h >>> 8) % 26));
  return c1 + c2;
}
