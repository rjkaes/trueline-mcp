// ==============================================================================
// Protocol-format parsing
// ==============================================================================

const DECIMAL_INT = /^\d+$/;

interface LineRef {
  line: number;
  hash: string;
}

/**
 * Parse a `line:hash` reference string like "4:mp".
 *
 * Special case: "0:" is valid (insert at file start, empty hash).
 * Throws on invalid format.
 */
function parseLineHash(ref: string): LineRef {
  const colonIdx = ref.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`Invalid line:hash reference "${ref}" — missing colon`);
  }

  const lineStr = ref.slice(0, colonIdx);
  const hash = ref.slice(colonIdx + 1);

  // Reject non-decimal strings before Number() conversion — without this,
  // Number("") === 0 and Number(" ") === 0 would silently parse as line 0.
  if (!DECIMAL_INT.test(lineStr)) {
    throw new Error(
      `Invalid line number in "${ref}" — must be a non-negative integer`,
    );
  }

  const line = Number(lineStr);

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

interface RangeRef {
  start: LineRef;
  end: LineRef;
  insertAfter: boolean;
}

/**
 * Parse a range string into start/end LineRefs.
 *
 * Accepts three forms:
 *   - "12:gh..21:yz"  — explicit start..end range (replace)
 *   - "5:ab"          — single-line shorthand, equivalent to "5:ab..5:ab"
 *   - "+5:ab"         — insert-after line 5 (single-line only)
 *
 * The `+` prefix signals insert-after and is only valid on single-line
 * ranges (no `..`). Throws on invalid format or if start line > end line.
 */
export function parseRange(range: string): RangeRef {
  // Detect and strip insert-after prefix
  let insertAfter = false;
  let raw = range;
  if (raw.startsWith("+")) {
    insertAfter = true;
    raw = raw.slice(1);
  }

  const dotIdx = raw.indexOf("..");

  if (insertAfter && dotIdx !== -1) {
    throw new Error(
      `Invalid range "${range}" — insert-after (+) cannot be used with a multi-line range`,
    );
  }

  if (dotIdx === -1) {
    const ref = parseLineHash(raw);
    return { start: ref, end: { ...ref }, insertAfter };
  }

  const start = parseLineHash(raw.slice(0, dotIdx));
  const end = parseLineHash(raw.slice(dotIdx + 2));

  if (start.line > end.line) {
    throw new Error(
      `Invalid range "${range}" — start line ${start.line} must be ≤ end line ${end.line}`,
    );
  }

  return { start, end, insertAfter };
}

export interface ChecksumRef {
  startLine: number;
  endLine: number;
  hash: string;
}

/**
 * Parse a checksum string like "10-25:f7e2abcd" from trueline_read.
 *
 * Format: "<startLine>-<endLine>:<8hex>"
 * The special sentinel "0-0:<8hex>" represents an empty file.
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

  // Slice all three parts up front, then validate formats.
  const startStr = checksum.slice(0, dashIdx);
  const endStr = checksum.slice(dashIdx + 1, colonIdx);
  const hash = checksum.slice(colonIdx + 1);

  // Validate decimal integers before Number() conversion to reject
  // scientific notation (e.g. "1e2" → 100) and empty/whitespace strings.
  if (!DECIMAL_INT.test(startStr)) {
    throw new Error(`Invalid checksum "${checksum}" — start line must be a decimal integer`);
  }
  if (!DECIMAL_INT.test(endStr)) {
    throw new Error(`Invalid checksum "${checksum}" — end line must be a decimal integer`);
  }
  if (!/^[0-9a-f]{8}$/.test(hash)) {
    throw new Error(
      `Invalid checksum "${checksum}" — hash must be 8 hex chars, got "${hash}"`,
    );
  }

  const startLine = Number(startStr);
  const endLine = Number(endStr);

  // 0-0 is the empty-file sentinel; any other use of 0 is invalid.
  if (startLine === 0 && endLine !== 0) {
    throw new Error(
      `Invalid checksum "${checksum}" — startLine 0 requires endLine 0`,
    );
  }
  if (startLine > endLine) {
    throw new Error(
      `Invalid checksum "${checksum}" — start ${startLine} must be ≤ end ${endLine}`,
    );
  }

  return { startLine, endLine, hash };
}
