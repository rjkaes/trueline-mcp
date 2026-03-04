import { writeFile, rename, stat, chmod, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

// ==============================================================================
// FNV-1a Hash
// ==============================================================================

export const FNV_OFFSET_BASIS = 2166136261;
export const FNV_PRIME = 16777619;

/**
 * Sentinel checksum representing an empty file (zero lines).
 *
 * `verifyChecksum` accepts this value when the file has no lines, so
 * callers can use the output of `trueline_read` on an empty file directly
 * as the `checksum` field in a subsequent `trueline_edit` call.
 */
export const EMPTY_FILE_CHECKSUM = "0-0:00000000";

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
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < line.length) {
      const lo = line.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
        i++;
      }
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
 * Compute 2-letter content hash for a line.
 *
 * Maps FNV-1a output to two lowercase ASCII letters (676 possible values).
 * Matches the vscode-hashline-edit-tool spec:
 *   letter1 = (hash_value % 26) → 'a'..'z'
 *   letter2 = ((hash_value >> 8) % 26) → 'a'..'z'
 */
export function lineHash(line: string): string {
  const h = fnv1aHash(line);
  const c1 = String.fromCharCode(97 + (h % 26));
  const c2 = String.fromCharCode(97 + ((h >>> 8) % 26));
  return c1 + c2;
}

/**
 * Compute a read-range checksum over a slice of file lines.
 *
 * Feeds each line's full 32-bit FNV-1a hash (4 bytes, little-endian) directly
 * into a second FNV-1a accumulator. Using the full hash rather than the
 * 2-letter `lineHash` proxy doubles the effective entropy per line and makes
 * accidental collisions across similar lines far less likely.
 *
 * `effectiveEnd` clamps `endLine` to `lines.length` so the label in the
 * returned string always reflects the lines that were actually hashed,
 * preventing a mismatch between the label and the hash value when
 * `endLine` exceeds the file length.
 *
 * @param lines - Full file lines array (0-indexed, lines[0] = line 1)
 * @param startLine - 1-based first line of range
 * @param endLine - 1-based last line of range (inclusive)
 * @returns Checksum string: "<startLine>-<effectiveEnd>:<8hex>"
 */
export function rangeChecksum(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  let hash = FNV_OFFSET_BASIS;
  const effectiveEnd = Math.min(endLine, lines.length);
  for (let i = startLine - 1; i < effectiveEnd; i++) {
    const h = fnv1aHash(lines[i]);
    hash = Math.imul(hash ^ (h & 0xff),          FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 8) & 0xff),  FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 16) & 0xff), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 24) & 0xff), FNV_PRIME) >>> 0;
  }
  return `${startLine}-${effectiveEnd}:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Compute a range checksum from precomputed FNV-1a hashes.
 *
 * Like `rangeChecksum` but takes a `number[]` of pre-hashed values
 * instead of re-hashing the raw line strings.
 *
 * @param hashes - Array of precomputed FNV-1a hashes (0-indexed)
 * @param startLine - 1-based first line label
 * @param endLine - 1-based last line label (inclusive)
 */
export function rangeChecksumFromHashes(
  hashes: number[],
  startLine: number,
  endLine: number,
): string {
  let hash = FNV_OFFSET_BASIS;
  for (const h of hashes) {
    hash = Math.imul(hash ^ (h & 0xff),          FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 8) & 0xff),  FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 16) & 0xff), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((h >>> 24) & 0xff), FNV_PRIME) >>> 0;
  }
  return `${startLine}-${endLine}:${hash.toString(16).padStart(8, "0")}`;
}

// ==============================================================================
// Line Ending Detection & Splitting
// ==============================================================================

export interface ParsedContent {
  lines: string[];
  eol: "\r\n" | "\n";
  hasTrailingNewline: boolean;
}

/**
 * Parse raw file content into normalized lines and detected EOL in one pass.
 *
 * Combines EOL detection, CRLF/CR normalization, and line splitting into a
 * single charCode scan — avoids reading the content three times.  The lines
 * contain no `\r` or `\n` characters.  A trailing newline produces no extra
 * empty element (standard text files end with `\n`).
 */
export function parseContent(content: string): ParsedContent {
  if (content === "") return { lines: [], eol: "\n", hasTrailingNewline: false };

  const lines: string[] = [];
  let crlf = 0;
  let lf = 0;
  let lineStart = 0;

  for (let i = 0, len = content.length; i < len; i++) {
    const ch = content.charCodeAt(i);
    if (ch === 0x0d /* \r */) {
      lines.push(content.slice(lineStart, i));
      if (i + 1 < len && content.charCodeAt(i + 1) === 0x0a /* \n */) {
        crlf++;
        i++; // skip \n half of \r\n pair
      } else {
        lf++; // bare \r counts toward LF
      }
      lineStart = i + 1;
    } else if (ch === 0x0a /* \n */) {
      lines.push(content.slice(lineStart, i));
      lf++;
      lineStart = i + 1;
    }
  }

  // Content after the last line ending (or the entire string if no endings).
  // An empty tail means the file ended with a newline — don't push, matching
  // the trailing-newline convention (no phantom empty last element).
  const tail = content.slice(lineStart);
  if (tail !== "") {
    lines.push(tail);
  }

  // A file has a trailing newline if its last character was a line ending.
  // Empty files have no trailing newline by definition.
  const hasTrailingNewline = content.length > 0 && lineStart === content.length;

  return { lines, eol: crlf > lf ? "\r\n" : "\n", hasTrailingNewline };
}

// ==============================================================================
// Line Formatting
// ==============================================================================

/**
 * Format pre-split lines as truelines: `{lineNumber}:{hash}|{content}`
 *
 * Formats each line as `{lineNumber}:{2-letter hash}|{content}`.
 *
 * @param lines - Array of line strings (no trailing newline elements)
 * @param startLine - 1-based line number for the first line (default: 1)
 * @returns Formatted string with one trueline per input line
 */
export function formatTruelinesFromArray(
  lines: string[],
  startLine: number = 1,
): string {
  if (lines.length === 0) return "";

  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    out[i] = `${startLine + i}:${lineHash(lines[i])}|${lines[i]}`;
  }
  return out.join("\n");
}

/**
 * Format pre-split lines as truelines using precomputed FNV-1a hashes.
 *
 * Like `formatTruelinesFromArray` but avoids recomputing hashes when
 * the caller already has them (e.g., for shared use with checksumming).
 */
export function formatTruelinesWithHashes(
  lines: string[],
  hashes: number[],
  startLine: number = 1,
): string {
  if (lines.length === 0) return "";

  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const c1 = String.fromCharCode(97 + (hashes[i] % 26));
    const c2 = String.fromCharCode(97 + ((hashes[i] >>> 8) % 26));
    out[i] = `${startLine + i}:${c1}${c2}|${lines[i]}`;
  }
  return out.join("\n");
}

// ==============================================================================
// Parsing
// ==============================================================================

export interface LineRef {
  line: number;
  hash: string;
}

/**
 * Parse a `line:hash` reference string like "4:mp".
 *
 * Special case: "0:" is valid (insert at file start, empty hash).
 * Throws on invalid format.
 */
export function parseLineHash(ref: string): LineRef {
  const colonIdx = ref.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`Invalid line:hash reference "${ref}" — missing colon`);
  }

  const lineStr = ref.slice(0, colonIdx);
  const hash = ref.slice(colonIdx + 1);

  // Reject non-decimal strings before Number() conversion. Without this,
  // Number("") === 0 and Number(" ") === 0 would silently parse as line 0.
  if (!/^\d+$/.test(lineStr)) {
    throw new Error(
      `Invalid line number in "${ref}" — must be a non-negative integer`,
    );
  }

  const line = Number(lineStr);

  if (!Number.isInteger(line) || line < 0) {
    throw new Error(
      `Invalid line number in "${ref}" — must be a non-negative integer`,
    );
  }

  // "0:" is allowed (insert at start) and must have an empty hash.
  if (line === 0 && hash !== "") {
    throw new Error(
      `Invalid line:hash reference "${ref}" — line 0 must have empty hash`,
    );
  }
  if (line > 0 && !/^[a-z]{2}$/.test(hash)) {
    throw new Error(
      `Invalid hash in "${ref}" — must be exactly 2 lowercase letters`,
    );
  }

  return { line, hash };
}

export interface RangeRef {
  start: LineRef;
  end: LineRef;
}

/**
 * Parse a range string into start/end LineRefs.
 *
 * Accepts two forms:
 *   - "12:gh..21:yz"  — explicit start..end range
 *   - "5:ab"          — single-line shorthand, equivalent to "5:ab..5:ab"
 *
 * Throws on invalid format or if start line > end line.
 */
export function parseRange(range: string): RangeRef {
  const dotIdx = range.indexOf("..");
  if (dotIdx === -1) {
    // Single line:hash — treat as a self-range (start == end)
    const ref = parseLineHash(range);
    return { start: ref, end: { ...ref } };
  }

  const startStr = range.slice(0, dotIdx);
  const endStr = range.slice(dotIdx + 2);

  const start = parseLineHash(startStr);
  const end = parseLineHash(endStr);

  if (start.line > end.line) {
    throw new Error(
      `Invalid range "${range}" — start line ${start.line} must be ≤ end line ${end.line}`,
    );
  }

  return { start, end };
}

export interface ChecksumRef {
  startLine: number;
  endLine: number;
  hash: string;
}

/**
 * Parse a checksum string like "10-25:f7e2" from trueline_read.
 *
 * Format: "<startLine>-<endLine>:<8hex>"
 * Throws on invalid format.
 */
export function parseChecksum(checksum: string): ChecksumRef {
  const dashIdx = checksum.indexOf("-");
  if (dashIdx === -1) {
    throw new Error(
      `Invalid checksum "${checksum}" — expected format "startLine-endLine:hex"`,
    );
  }

  const colonIdx = checksum.indexOf(":", dashIdx);
  if (colonIdx === -1) {
    throw new Error(
      `Invalid checksum "${checksum}" — expected format "startLine-endLine:hex"`,
    );
  }

  // Validate that start/end are plain decimal integers before converting to
  // Number. Without this, "1e2-3:..." would parse as startLine=100 because
  // Number("1e2") === 100, silently accepting scientific notation.
  if (!/^\d+$/.test(checksum.slice(0, dashIdx))) {
    throw new Error(`Invalid checksum "${checksum}" — start line must be a decimal integer`);
  }
  if (!/^\d+$/.test(checksum.slice(dashIdx + 1, colonIdx))) {
    throw new Error(`Invalid checksum "${checksum}" — end line must be a decimal integer`);
  }

  const startLine = Number(checksum.slice(0, dashIdx));
  const endLine = Number(checksum.slice(dashIdx + 1, colonIdx));
  const hash = checksum.slice(colonIdx + 1);

  // "0-0:..." is the empty-file sentinel; validate it specially.
  const isEmpty = startLine === 0 && endLine === 0;
  if (startLine === 0 && endLine !== 0) {
    throw new Error(
      `Invalid checksum "${checksum}" — startLine 0 requires endLine 0`,
    );
  }
  if (!isEmpty) {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error(`Invalid checksum "${checksum}" — bad start line`);
    }
    if (!Number.isInteger(endLine) || endLine < 1) {
      throw new Error(`Invalid checksum "${checksum}" — bad end line`);
    }
    if (startLine > endLine) {
      throw new Error(
        `Invalid checksum "${checksum}" — start ${startLine} must be ≤ end ${endLine}`,
      );
    }
  }
  if (!/^[0-9a-f]{8}$/.test(hash)) {
    throw new Error(
      `Invalid checksum "${checksum}" — hash must be 8 hex chars, got "${hash}"`,
    );
  }

  return { startLine, endLine, hash };
}

/**
 * Verify a checksum string against current file content.
 *
 * Accepts the `EMPTY_FILE_CHECKSUM` sentinel ("0-0:00000000") when the file
 * has zero lines, enabling edits on empty files without special-casing
 * at the call site.
 *
 * Recomputes the range checksum from the current lines and compares.
 * Returns null if valid, or an error message if the file has changed.
 */
export function verifyChecksum(
  lines: string[],
  checksum: string,
): string | null {
  if (checksum === EMPTY_FILE_CHECKSUM) {
    return lines.length === 0
      ? null
      : `Checksum mismatch: expected empty file but file has ${lines.length} lines. Re-read with trueline_read.`;
  }

  // Catch bare hex hashes early with a targeted message. Agents sometimes
  // strip the "startLine-endLine:" prefix; we can't infer the range
  // (it might be a partial read) so we ask for the full string instead.
  if (/^[0-9a-f]{8}$/.test(checksum)) {
    return (
      `Invalid checksum "${checksum}" — pass the full checksum from ` +
      `trueline_read including the range prefix (e.g. "1-${lines.length}:${checksum}").`
    );
  }

  const parsed = parseChecksum(checksum);

  // Any 0-0 checksum other than the exact EMPTY_FILE_CHECKSUM sentinel
  // (handled above) is invalid. Without this guard, rangeChecksum would
  // loop from index -1, accessing lines[-1] (undefined) and crashing.
  if (parsed.startLine === 0 && parsed.endLine === 0) {
    return `Checksum mismatch: "0-0:${parsed.hash}" is not a valid empty-file checksum (expected "${EMPTY_FILE_CHECKSUM}").`;
  }

  if (parsed.endLine > lines.length) {
    return (
      `Checksum range ${parsed.startLine}-${parsed.endLine} exceeds ` +
      `file length (${lines.length} lines). File may have been truncated.`
    );
  }

  const recomputed = rangeChecksum(lines, parsed.startLine, parsed.endLine);
  const recomputedHash = recomputed.slice(recomputed.indexOf(":") + 1);

  if (recomputedHash !== parsed.hash) {
    return (
      `Checksum mismatch for lines ${parsed.startLine}-${parsed.endLine}: ` +
      `expected ${parsed.hash}, got ${recomputedHash}. ` +
      `File changed since last read. Re-read with trueline_read.`
    );
  }

  return null;
}

// ==============================================================================
// Hash Verification
// ==============================================================================

/**
 * Verify that line:hash pairs match the current file content.
 *
 * @param lines - Array of file lines (0-indexed, so lines[0] is line 1)
 * @param refs - Parsed line:hash references to verify
 * @returns null if all match, or an error message if any mismatch
 */
export function verifyHashes(
  lines: string[],
  refs: LineRef[],
): string | null {
  for (const ref of refs) {
    if (ref.line === 0 && ref.hash === "") continue; // "0:" always valid

    if (ref.line < 1 || ref.line > lines.length) {
      return `Line ${ref.line} out of range (file has ${lines.length} lines)`;
    }

    const actual = lineHash(lines[ref.line - 1]);
    if (actual !== ref.hash) {
      return (
        `Hash mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual}. ` +
        `File may have changed since last read. Re-read with trueline_read.`
      );
    }
  }
  return null;
}

// ==============================================================================
// Edit Application
// ==============================================================================

export interface EditOp {
  startLine: number; // 1-based (0 for insertAfter at file start)
  endLine: number; // 1-based, inclusive
  content: string[]; // array of lines, no EOL chars
  insertAfter: boolean;
}

/**
 * Apply a batch of edits to a single file.
 *
 * Edits are sorted by line number descending so that earlier line
 * numbers remain valid as later lines are modified. Returns the
 * new lines array — callers join with the appropriate EOL for their
 * context (file write vs diff preview).
 *
 * Uses `slice().concat()` instead of `splice(...spread)` to avoid
 * V8's ~65 536 function-argument limit when inserting large blocks.
 *
 * @param fileLines - Current file lines (0-indexed array)
 * @param ops - Parsed and verified edit operations
 * @returns New file lines array
 */
export function applyEdits(fileLines: string[], ops: EditOp[]): string[] {
  // Sort descending by start line so edits don't shift earlier positions.
  // For insertAfter ops at the same anchor, reverse their sub-order so that
  // when applied back-to-front each new block lands after the anchor but
  // before the previously inserted block — preserving input order in the
  // final file.
  //
  // The comparator is stable because we break ties with the original input
  // index, avoiding undefined behavior from a non-transitive comparator.
  const indexed = ops.map((op, i) => ({ op, i }));
  indexed.sort((a, b) => {
    const aLine = a.op.startLine;
    const bLine = b.op.startLine;
    if (bLine !== aLine) return bLine - aLine;
    // Same anchor: insertAfter ops go before replace ops in back-to-front pass
    if (a.op.insertAfter !== b.op.insertAfter) return a.op.insertAfter ? -1 : 1;
    // Both insertAfter: reverse input order so they appear in input order after insertion
    if (a.op.insertAfter) return b.i - a.i;
    return a.i - b.i;
  });
  const sorted = indexed.map((x) => x.op);

  let result = fileLines.slice();

  for (const op of sorted) {
    // Copy to avoid mutating the input when the dedup logic trims trailing blanks.
    const newLines = [...op.content];

    if (op.insertAfter) {
      const afterLine = op.startLine; // 0-based insert index
      // Avoid double blank lines: if inserted content ends with an empty
      // line and the next existing line is also empty, drop the trailing
      // empty element to prevent a doubled gap.
      if (
        newLines.length > 1 &&
        newLines[newLines.length - 1] === "" &&
        afterLine < result.length &&
        result[afterLine] === ""
      ) {
        newLines.pop();
      }
      // Use concat instead of splice(...spread) to avoid V8 argument limit
      result = result.slice(0, afterLine).concat(newLines, result.slice(afterLine));
    } else {
      const firstIdx = op.startLine - 1;
      const span = op.endLine - op.startLine + 1;
      result = result.slice(0, firstIdx).concat(newLines, result.slice(firstIdx + span));
    }
  }

  return result;
}

/**
 * Write content to a file atomically: write to temp file in same
 * directory, then rename. This prevents partial writes if the process
 * is interrupted.
 *
 * Preserves the original file's permissions on the temp file before
 * renaming so that the mode is not silently changed to the process umask.
 * Cleans up the temp file on error to avoid leaving orphaned files.
 *
 * @param expectedMtimeMs - If provided, the file's mtime (from when it
 *   was read) is re-checked before the final rename. If another process
 *   modified the file in the interim, the write is aborted. This narrows
 *   the TOCTOU window but does not eliminate it — a concurrent write
 *   could still land between the re-stat and the rename.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<void> {
  const dir = dirname(filePath);
  const tmpName = `.trueline-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);

  let originalMode: number | undefined;
  try {
    originalMode = (await stat(filePath)).mode;
  } catch { /* new file — no original mode to preserve */ }

  try {
    await writeFile(tmpPath, content, "utf-8");
    if (originalMode !== undefined) {
      await chmod(tmpPath, originalMode);
    }

    // Narrow the TOCTOU window: if we know the mtime from when we read,
    // verify it hasn't changed before committing the rename. This does not
    // eliminate the race but catches the common case of concurrent edits.
    if (expectedMtimeMs !== undefined) {
      try {
        const currentMtime = (await stat(filePath)).mtimeMs;
        if (currentMtime !== expectedMtimeMs) {
          throw new Error(
            `File was modified by another process (expected mtime ${expectedMtimeMs}, ` +
            `got ${currentMtime}). Re-read with trueline_read.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("File was modified")) throw err;
        // stat failed (file deleted?) — proceed with rename
      }
    }

    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
