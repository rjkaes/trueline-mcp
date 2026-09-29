// ==============================================================================
// Protocol-format parsing
// ==============================================================================

const DECIMAL_INT = /^\d+$/;

/** Sentinel hash for bare line numbers (e.g. "78" instead of "rn78"). */
export const BARE_LINE_HASH = "??";
interface LineRef {
  line: number;
  hash: string;
}

/**
 * Parse a hashLine reference string like "mp4".
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
  if (DECIMAL_INT.test(ref)) {
    // Bare number
    const line = Number(ref);
    if (line !== 0) {
      return { line, hash: BARE_LINE_HASH };
    }
    return { line: 0, hash: "" };
  }

  const hash = ref.slice(0, 2);
  const lineStr = ref.slice(2);

  if (!DECIMAL_INT.test(lineStr)) {
    throw new Error(`Invalid line number in "${ref}" — must be a non-negative integer`);
  }

  const line = Number(lineStr);

  if (line === 0) {
    throw new Error(`Invalid hashLine reference "${ref}" — line 0 must use bare "0" with no hash`);
  }
  if (!/^[a-z]{2}$/.test(hash)) {
    throw new Error(
      `Invalid hashLine reference "${ref}" — expected format "hashLine" (e.g. "ab${line}"). ` +
        "Copy the 2-letter prefix and line number from trueline_read/trueline_search output.",
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
 *   - "gh12-yz21"  — explicit start-end range (replace)
 *   - "ab5"          — single-line shorthand, equivalent to "ab5-ab5"
 *   - "+ab5"         — insert-after line 5 (single-line only)
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
    throw new Error(
      `Invalid range "${range}" — insert-after (+) requires a single-line target, not a range. Use "+ab10" to insert after line 10.`,
    );
  }

  if (dashIdx === -1) {
    const ref = parseHashLine(raw);
    return { start: ref, end: { ...ref }, insertAfter };
  }

  const start = parseHashLine(raw.slice(0, dashIdx));
  const end = parseHashLine(raw.slice(dashIdx + 1));

  if (start.line > end.line) {
    throw new Error(
      `Invalid range "${range}" — start line ${start.line} must be ≤ end line ${end.line}. Did you swap start and end?`,
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
 * Parse a checksum string from trueline_read or trueline_search.
 *
 * Accepts both the decimal format ("9-10/abcdef") and the hashLine
 * format ("aj9-na10/abcdef") as well as mixed and single-line forms.
 * Strips a "checksum: " or "ref: " label prefix and trims whitespace.
 *
 * The special sentinel "0-0/aaaaaa" represents an empty file.
 * Throws on invalid format.
 */
export function parseChecksum(checksum: string): ChecksumRef {
  // Step 1: Normalize — trim then strip the "checksum: " label if present.
  let raw = checksum.trim();
  if (raw.startsWith("checksum:")) {
    raw = raw.slice("checksum:".length).trimStart();
  } else if (raw.startsWith("ref:")) {
    raw = raw.slice("ref:".length).trimStart();
  }

  // Step 2: Split on the last "/" to separate the range part from the hex hash.
  const slashIdx = raw.lastIndexOf("/");
  if (slashIdx === -1) {
    throw new Error(
      `Invalid checksum "${checksum}" — expected format "startLine-endLine/letters", e.g. "aj9-na10/abcdef"`,
    );
  }

  const rangePart = raw.slice(0, slashIdx);
  const hash = raw.slice(slashIdx + 1).toLowerCase();

  if (!/^[a-z]{6}$/.test(hash)) {
    throw new Error(`Invalid checksum "${checksum}" — hash must be 6 lowercase letters, got "${hash}"`);
  }

  // Step 3: Find the dash separating start from end. The first "-" that is
  // immediately preceded by a digit (not a letter) is the range separator.
  const dashIdx = rangePart.search(/(?<=\d)-/);

  let startRef: string;
  let endRef: string;

  if (dashIdx === -1) {
    // Single-line reference: start = end.
    startRef = rangePart;
    endRef = rangePart;
  } else {
    startRef = rangePart.slice(0, dashIdx);
    endRef = rangePart.slice(dashIdx + 1);
  }

  const startLine = extractLineNumber(startRef, checksum, "start");
  const endLine = extractLineNumber(endRef, checksum, "end");

  // 0-0 is the empty-file sentinel; any other use of 0 is invalid.
  if (startLine === 0 && endLine !== 0) {
    throw new Error(`Invalid checksum "${checksum}" — startLine 0 requires endLine 0`);
  }
  if (startLine > endLine) {
    throw new Error(`Invalid checksum "${checksum}" — start ${startLine} must be ≤ end ${endLine}`);
  }
  if (startLine === 0 && endLine === 0 && hash !== "aaaaaa") {
    throw new Error(`Invalid checksum "${checksum}" — empty-file sentinel must have hash aaaaaa`);
  }

  return { startLine, endLine, hash };
}

/**
 * Parse a single side of a checksum range — either "aj9" or "9" format.
 * Returns the line number.
 */
function extractLineNumber(ref: string, originalInput: string, which: "start" | "end"): number {
  if (!DECIMAL_INT.test(ref)) {
    // hashLine format: "aj9"
    const hashPrefix = ref.slice(0, 2).toLowerCase();
    const lineStr = ref.slice(2);
    if (!/^[a-z]{2}$/.test(hashPrefix)) {
      throw new Error(
        `Invalid checksum "${originalInput}" — ${which} hash prefix must be 2 lowercase letters, got "${hashPrefix}"`,
      );
    }
    if (!DECIMAL_INT.test(lineStr)) {
      throw new Error(
        `Invalid checksum "${originalInput}" — ${which} line must be a decimal integer, got "${lineStr}"`,
      );
    }
    return Number(lineStr);
  }

  // Decimal format: "9"
  return Number(ref);
}

export interface ReadRange {
  start: number;
  end: number;
}

/** Merges overlapping or adjacent ranges. `ranges` must already be sorted by start. Mutates and returns its input. */
export function mergeSortedRanges(ranges: ReadRange[]): ReadRange[] {
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const curr = ranges[i];
    if (prev.end === Infinity || curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
      ranges.splice(i, 1);
      i--;
    }
  }
  return ranges;
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
  return mergeSortedRanges(parsed);
}

// ---------------------------------------------------------------------------
// Inline range parsing for file_paths entries (e.g. "src/foo.ts:10-25")
// ---------------------------------------------------------------------------

interface FilePathWithRanges {
  path: string;
  rangeSpecs: string[] | undefined;
}

/**
 * Split a file_path entry into path and optional inline ranges.
 *
 * Accepted forms:
 *   "src/foo.ts"             → { path: "src/foo.ts", rangeSpecs: undefined }
 *   "src/foo.ts:10-25"       → { path: "src/foo.ts", rangeSpecs: ["10-25"] }
 *   "src/foo.ts:1-20,200-220" → { path: "src/foo.ts", rangeSpecs: ["1-20", "200-220"] }
 *   "src/foo.ts:10"          → { path: "src/foo.ts", rangeSpecs: ["10"] }
 *   "src/foo.ts:10-"         → { path: "src/foo.ts", rangeSpecs: ["10-"] }
 *
 * The split point is the last ':' followed by a digit. This avoids
 * ambiguity with Windows drive letters (C:\...) or other colons in paths.
 */
export function parseFilePathWithRanges(entry: string): FilePathWithRanges {
  // Path needs 2+ chars so a drive letter ("C:1") is never split off.
  const match = /^(.{2,}):(\d.*)$/s.exec(entry);
  if (!match) return { path: entry, rangeSpecs: undefined };
  return { path: match[1], rangeSpecs: match[2].split(",").map((r) => r.trim()) };
}
