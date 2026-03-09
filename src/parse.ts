// ==============================================================================
// Protocol-format parsing
// ==============================================================================

const DECIMAL_INT = /^\d+$/;

interface RangeRef {
  start: number;
  end: number;
  insertAfter: boolean;
}

/**
 * Parse a line number string, validating it's a non-negative decimal integer.
 * Throws on invalid format.
 */
function parseLineNumber(s: string): number {
  if (!DECIMAL_INT.test(s)) {
    throw new Error(`Invalid line number "${s}" — must be a non-negative integer`);
  }
  return Number(s);
}

/**
 * Parse a range string into start/end line numbers.
 *
 * Accepts three forms:
 *   - "12-21"   — explicit start-end range (replace)
 *   - "5"       — single-line shorthand, equivalent to "5-5"
 *   - "+5"      — insert-after line 5 (single-line only)
 *
 * The `+` prefix signals insert-after and is only valid on single-line
 * ranges (no `-`). Throws on invalid format or if start line > end line.
 */
export function parseRange(range: string): RangeRef {
  // Detect and strip insert-after prefix
  let insertAfter = false;
  let raw = range;
  if (raw.startsWith("+")) {
    insertAfter = true;
    raw = raw.slice(1);
  }

  const dashIdx = raw.indexOf("-");

  if (insertAfter && dashIdx !== -1) {
    throw new Error(`Invalid range "${range}" — insert-after (+) cannot be used with a multi-line range`);
  }

  if (dashIdx === -1) {
    const line = parseLineNumber(raw);
    return { start: line, end: line, insertAfter };
  }

  const start = parseLineNumber(raw.slice(0, dashIdx));
  const end = parseLineNumber(raw.slice(dashIdx + 1));

  if (start > end) {
    throw new Error(`Invalid range "${range}" — start line ${start} must be ≤ end line ${end}`);
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
    throw new Error(`Invalid checksum "${checksum}" — expected format "startLine-endLine:hex"`);
  }

  const colonIdx = checksum.indexOf(":", dashIdx);
  if (colonIdx === -1) {
    throw new Error(`Invalid checksum "${checksum}" — expected format "startLine-endLine:hex"`);
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
    throw new Error(`Invalid checksum "${checksum}" — hash must be 8 hex chars, got "${hash}"`);
  }

  const startLine = Number(startStr);
  const endLine = Number(endStr);

  // 0-0 is the empty-file sentinel; any other use of 0 is invalid.
  if (startLine === 0 && endLine !== 0) {
    throw new Error(`Invalid checksum "${checksum}" — startLine 0 requires endLine 0`);
  }
  if (startLine > endLine) {
    throw new Error(`Invalid checksum "${checksum}" — start ${startLine} must be ≤ end ${endLine}`);
  }
  if (startLine === 0 && endLine === 0 && hash !== "00000000") {
    throw new Error(`Invalid checksum "${checksum}" — empty-file sentinel must have hash 00000000`);
  }

  return { startLine, endLine, hash };
}

export interface ReadRange {
  start: number;
  end: number;
}

/**
 * Parse and validate the `ranges` input for trueline_read.
 *
 * Accepts string ranges like "10-20", "10" (single line), or "10-" (to EOF).
 * Returns a sorted, non-overlapping array of ranges. Undefined or empty
 * input returns a single whole-file range.
 */
export function parseRanges(ranges: string[] | undefined): ReadRange[] {
  if (!ranges || ranges.length === 0) {
    return [{ start: 1, end: Infinity }];
  }

  const parsed: ReadRange[] = ranges.map((r) => {
    const dashIdx = r.indexOf("-");

    let start: number;
    let end: number;

    if (dashIdx === -1) {
      // "10" — single line
      start = Number(r);
      end = start;
    } else if (dashIdx === 0) {
      // "-20" — from start to line 20
      start = 1;
      end = Number(r.slice(1));
    } else if (dashIdx === r.length - 1) {
      // "10-" — from line 10 to EOF
      start = Number(r.slice(0, -1));
      end = Infinity;
    } else {
      // "10-20" — explicit range
      start = Number(r.slice(0, dashIdx));
      end = Number(r.slice(dashIdx + 1));
    }

    if (!Number.isInteger(start) || start < 1) {
      throw new Error(`Invalid range "${r}": start must be a positive integer`);
    }
    if (end !== Infinity && (!Number.isInteger(end) || end < 1)) {
      throw new Error(`Invalid range "${r}": end must be a positive integer`);
    }
    if (start > end) {
      throw new Error(`Invalid range "${r}": start ${start} must be <= end ${end}`);
    }
    return { start, end };
  });

  parsed.sort((a, b) => a.start - b.start);

  // Merge overlapping or adjacent ranges
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1];
    const curr = parsed[i];
    if (prev.end === Infinity || curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
      parsed.splice(i, 1);
      i--;
    }
  }

  return parsed;
}
