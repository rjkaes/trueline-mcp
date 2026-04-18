// ==============================================================================
// FNV-1a Hash
// ==============================================================================

export const FNV_OFFSET_BASIS = 2166136261;
export const FNV_PRIME = 16777619;

/** Sentinel checksum representing an empty file (zero lines). */
export const EMPTY_FILE_CHECKSUM = "0-0:aaaaaa";

/**
 * Compute FNV-1a 32-bit hash of a string's UTF-8 bytes.
 *
 * FNV-1a is a fast, non-cryptographic hash with good distribution.
 * We use it because the vscode-hashline-edit-tool spec chose
 * it, and matching the spec means interoperability with other tools.
 *
 * Encodes UTF-8 inline to avoid per-call Buffer allocation.
 */
export function fnv1aHash(line: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < line.length; i++) {
    let cp = line.charCodeAt(i);

    // Handle surrogate pairs (codepoints > 0xFFFF)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (i + 1 < line.length) {
        const lo = line.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = ((cp - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
          i++;
        } else {
          // Unpaired high surrogate: encode as U+FFFD to match UTF-8 file I/O
          cp = 0xfffd;
        }
      } else {
        // Trailing high surrogate: encode as U+FFFD
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      // Unpaired low surrogate: encode as U+FFFD
      cp = 0xfffd;
    }

    // Encode codepoint as UTF-8 bytes, feeding each to FNV-1a
    if (cp < 0x80) {
      hash = Math.imul(hash ^ cp, FNV_PRIME) >>> 0;
    } else if (cp < 0x800) {
      hash = Math.imul(hash ^ (0xc0 | (cp >> 6)), FNV_PRIME) >>> 0;
      hash = Math.imul(hash ^ (0x80 | (cp & 0x3f)), FNV_PRIME) >>> 0;
    } else if (cp < 0x10000) {
      hash = Math.imul(hash ^ (0xe0 | (cp >> 12)), FNV_PRIME) >>> 0;
      hash = Math.imul(hash ^ (0x80 | ((cp >> 6) & 0x3f)), FNV_PRIME) >>> 0;
      hash = Math.imul(hash ^ (0x80 | (cp & 0x3f)), FNV_PRIME) >>> 0;
    } else {
      hash = Math.imul(hash ^ (0xf0 | (cp >> 18)), FNV_PRIME) >>> 0;
      hash = Math.imul(hash ^ (0x80 | ((cp >> 12) & 0x3f)), FNV_PRIME) >>> 0;
      hash = Math.imul(hash ^ (0x80 | ((cp >> 6) & 0x3f)), FNV_PRIME) >>> 0;
      hash = Math.imul(hash ^ (0x80 | (cp & 0x3f)), FNV_PRIME) >>> 0;
    }
  }

  return hash >>> 0;
}

/**
 * Compute FNV-1a 32-bit hash directly on raw bytes in a Buffer.
 *
 * Equivalent to `fnv1aHash(str)` when the buffer contains the UTF-8
 * encoding of `str`, but works on any encoding. This is the canonical
 * hash function — both read and edit paths use it to hash raw file bytes,
 * making hashes encoding-independent.
 */
export function fnv1aHashBytes(buf: Buffer, start: number, end: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = start; i < end; i++) {
    hash = Math.imul(hash ^ buf[i], FNV_PRIME) >>> 0;
  }
  return hash;
}

/**
 * Fold a 32-bit line hash into a running checksum accumulator.
 *
 * Feeds all 4 bytes of `h` (little-endian) into the FNV-1a accumulator.
 * This is the core building block for streaming checksum computation
 * in `handleRead`.
 */
export function foldHash(accumulator: number, h: number): number {
  accumulator = Math.imul(accumulator ^ (h & 0xff), FNV_PRIME) >>> 0;
  accumulator = Math.imul(accumulator ^ ((h >>> 8) & 0xff), FNV_PRIME) >>> 0;
  accumulator = Math.imul(accumulator ^ ((h >>> 16) & 0xff), FNV_PRIME) >>> 0;
  accumulator = Math.imul(accumulator ^ ((h >>> 24) & 0xff), FNV_PRIME) >>> 0;
  return accumulator;
}

const BASE26 = "abcdefghijklmnopqrstuvwxyz";

/** Encode a 32-bit checksum as 6 lowercase letters via base-26. 26^6 = 308M values. */
export function checksumToLetters(h: number): string {
  let result = "";
  let n = h >>> 0;
  for (let i = 0; i < 6; i++) {
    result = BASE26[n % 26] + result;
    n = (n / 26) | 0;
  }
  return result;
}

/** Format a checksum as `"<start>-<end>:<6letters>"`, optionally with hash letters. */
export function formatChecksum(
  startLine: number,
  endLine: number,
  hash: number,
  startLetters?: string,
  endLetters?: string,
): string {
  const ck = checksumToLetters(hash);
  if (startLetters && endLetters) {
    return `${startLetters}.${startLine}-${endLetters}.${endLine}:${ck}`;
  }
  return `${startLine}-${endLine}:${ck}`;
}

/**
 * 26-char alphabet: lowercase a-z only.
 * Fewer combinations (676) than the prior base32 alphabet (1024),
 * but LLMs transcribe pure-letter hashes more reliably.
 */
const HASH_CHARS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Pre-computed lookup table of all 676 two-character hash tags.
 * Avoids per-call string concatenation in the hot loop.
 */
const LETTER_TABLE: string[] = /* @__PURE__ */ (() => {
  const t = new Array<string>(676);
  for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) t[i * 26 + j] = HASH_CHARS[i] + HASH_CHARS[j];
  return t;
})();

/**
 * Map an FNV-1a hash to a two-character tag (676 possible values).
 */
export function hashToLetters(h: number): string {
  // XOR-fold upper and lower 16 bits to decorrelate the two characters.
  // Without this, FNV-1a's adjacent-byte correlation causes h%26 and
  // (h>>>8)%26 to cluster, using only ~50% of the 676-tag space.
  const folded = ((h >>> 16) ^ (h & 0xffff)) >>> 0;
  return LETTER_TABLE[(folded % 26) * 26 + (((folded >>> 8) >>> 0) % 26)];
}
