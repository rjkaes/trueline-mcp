// ==============================================================================
// Protocol-format parsing
// ==============================================================================

const DECIMAL_INT = /^\d+$/;

interface LineRef {
  line: number;
  hash: string;
}

/**
 * Parse a `hash.line` reference string like "mp.4".
 *
 * The hash is the 2-letter tag that appears before the line number in
 * trueline_read / trueline_search output. The agent copies it verbatim
 * when constructing the edit range, so the boundary hash travels with
 * the line number naturally.
 *
 * Special case: bare "0" is valid (insert at file start, no hash).
 * Throws on invalid format.
 */
function parseHashLine(ref: string): LineRef {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    // No dot — must be bare "0" for insert-at-start
    if (!DECIMAL_INT.test(ref)) {
      throw new Error(
        `Invalid hash.line reference "${ref}" — expected format "hash.line" (e.g. "ab.12"). ` +
          "Copy the 2-letter prefix and line number from trueline_read/trueline_search output.",
      );
    }
    const line = Number(ref);
    if (line !== 0) {
      throw new Error(
        `Invalid hash.line reference "${ref}" — bare line number only allowed for 0. ` +
          `Use the hash.line format from trueline_read/trueline_search output (e.g. "ab.${ref}").`,
      );
    }
    return { line: 0, hash: "" };
  }

  const hash = ref.slice(0, dotIdx);
  const lineStr = ref.slice(dotIdx + 1);

  if (!DECIMAL_INT.test(lineStr)) {
    throw new Error(`Invalid line number in "${ref}" — must be a non-negative integer`);
  }

  const line = Number(lineStr);

  if (line === 0) {
    throw new Error(`Invalid hash.line reference "${ref}" — line 0 must use bare "0" with no hash`);
  }
  if (!/^[a-z]{2}$/.test(hash)) {
    throw new Error(`Invalid hash in "${ref}" — must be exactly 2 lowercase letters`);
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
 *   - "gh.12-yz.21"  — explicit start-end range (replace)
 *   - "ab.5"          — single-line shorthand, equivalent to "ab.5-ab.5"
 *   - "+ab.5"         — insert-after line 5 (single-line only)
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

  // Find "-" separator between two hash.line refs. Since neither hashes
  // ([a-z]{2}) nor line numbers (digits) contain "-", indexOf is unambiguous.
  const dashIdx = raw.indexOf("-");

  if (insertAfter && dashIdx !== -1) {
    throw new Error(`Invalid range "${range}" — insert-after (+) cannot be used with a multi-line range`);
  }

  if (dashIdx === -1) {
    const ref = parseHashLine(raw);
    return { start: ref, end: { ...ref }, insertAfter };
  }

  const start = parseHashLine(raw.slice(0, dashIdx));
  const end = parseHashLine(raw.slice(dashIdx + 1));

  if (start.line > end.line) {
    throw new Error(`Invalid range "${range}" — start line ${start.line} must be ≤ end line ${end.line}`);
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
