// ==============================================================================
// trueline_read handler
//
// Streams the file line-by-line via `splitLines` — the file is never loaded
// into memory as a whole.  Supports reading multiple disjoint ranges in a
// single call, each producing its own checksum.
//
// Output is assembled as raw byte buffers (line prefixes are ASCII, line
// content stays as the original bytes) and decoded to a string once at the
// end.  This avoids a per-line `Buffer.toString()` allocation.
//
// Unchanged-file optimization: when a file has been read before and its mtime
// hasn't changed, returns a stub message with cached checksums instead of
// re-streaming the file. The model already has the content in context from the
// earlier read.
// ==============================================================================

import { LF_BUF } from "../line-splitter.ts";
import { transcodedLines } from "../encoding.ts";
import { FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash, hashToLetters } from "../hash.ts";
import { parseFilePathWithRanges, parseRanges, type ReadRange } from "../parse.ts";
import { hasRef, issueRef } from "../ref-store.ts";
import { binaryFileError, isBinaryError, validateEncoding, validatePath } from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

// ==============================================================================
// Read cache — returns a stub when a file hasn't changed since the last read
// ==============================================================================

interface ReadCacheEntry {
  mtimeMs: number;
  rangesKey: string; // serialized ranges for cache key
  refs: string[]; // ref IDs (e.g., "R1", "R2")
  encodingLine: string; // encoding metadata line, or empty
}

// Keyed by resolved (absolute) file path. Bounded to match the ref store.
const MAX_READ_CACHE = 500;
const readCache = new Map<string, ReadCacheEntry>();

/** Serialize ranges into a stable cache key. */
function rangesKey(ranges: ReadRange[]): string {
  return ranges.map((r) => `${r.start}-${r.end}`).join(",");
}

/** Expand each range by 1 line on each side for boundary context, then re-merge. */
function expandRanges(ranges: ReadRange[]): ReadRange[] {
  const expanded = ranges.map((r) => ({
    start: r.start > 1 && r.end !== Infinity ? r.start - 1 : r.start,
    end: r.end !== Infinity ? r.end + 1 : r.end,
  }));
  // Re-merge: expansion can make previously non-adjacent ranges overlap
  for (let i = 1; i < expanded.length; i++) {
    const prev = expanded[i - 1];
    const curr = expanded[i];
    if (prev.end === Infinity || curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
      expanded.splice(i, 1);
      i--;
    }
  }
  return expanded;
}
/** Build the stub response for an unchanged file. */
function unchangedStub(entry: ReadCacheEntry): string {
  const parts = [
    "File unchanged since last read. Content from the earlier read is still current.",
    "",
    ...entry.refs.map((r) => `ref: ${r} (still valid)`),
  ];
  if (entry.encodingLine) parts.push(entry.encodingLine);
  parts.push("", "To edit: trueline_edit (not Edit tool)");
  return parts.join("\n");
}

/** Clear the read cache (for testing). */
export function clearReadCache(): void {
  readCache.clear();
}

function evictReadCacheIfNeeded(): void {
  if (readCache.size < MAX_READ_CACHE) return;
  // FIFO eviction: Map iterates in insertion order
  const key = readCache.keys().next().value;
  if (key !== undefined) readCache.delete(key);
}

interface ReadParams {
  file_path: string;
  encoding?: string;

  ranges?: string[];
  projectDir?: string;
  allowedDirs?: string[];
}

export interface ReadMultiParams {
  file_paths: string[];
  encoding?: string;
  ranges?: string[];
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleRead(params: ReadParams): Promise<ToolResult> {
  const { file_path, projectDir, allowedDirs } = params;

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  let enc: BufferEncoding;
  try {
    enc = validateEncoding(params.encoding);
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  const { resolvedPath, mtimeMs } = validated;

  let ranges: ReadRange[];
  try {
    ranges = parseRanges(params.ranges);
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  // Cache key uses the requested ranges; actual streaming uses expanded ranges
  // with 1 line of context on each side so the agent sees boundary lines.
  const requestedRanges = ranges;
  ranges = expandRanges(ranges);
  // Check cache: if same file, same ranges, same mtime → return stub + checksums
  const rKey = rangesKey(requestedRanges);
  const cached = readCache.get(resolvedPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.rangesKey === rKey && cached.refs.every(hasRef)) {
    return textResult(unchangedStub(cached));
  }

  const MAX_OUTPUT_LINES = 2000;
  const MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20 MB
  const outputChunks: Buffer[] = [];
  let outputLen = 0;
  let rangeIdx = 0;
  let currentRange = ranges[0];
  let rangeChecksumHash = FNV_OFFSET_BASIS;
  let rangeFirstLine = 0;
  let rangeLastLine = 0;
  let totalLines = 0;
  let outputLines = 0;
  let truncated = false;
  const collectedRefs: string[] = [];

  // Resolve encoding before streaming — transcodedLines peeks at the BOM.
  const transcoded = await transcodedLines(resolvedPath, { detectBinary: true });
  const { bomInfo } = transcoded;

  try {
    for await (const { lineBytes, lineNumber } of transcoded.lines) {
      totalLines = lineNumber;

      // Past all ranges — stop early
      if (rangeIdx >= ranges.length) break;

      currentRange = ranges[rangeIdx];

      // Before current range
      if (lineNumber < currentRange.start) continue;

      // Past current range — close it, advance
      if (lineNumber > currentRange.end) {
        const hex = rangeChecksumHash.toString(16).padStart(8, "0");
        const refId = issueRef(resolvedPath, rangeFirstLine, rangeLastLine, hex);
        collectedRefs.push(refId);
        const refLine = `\nref: ${refId} (lines ${rangeFirstLine}-${rangeLastLine})\n`;
        const cb = Buffer.from(refLine);
        outputChunks.push(cb);
        outputLen += cb.length;

        rangeIdx++;
        rangeChecksumHash = FNV_OFFSET_BASIS;
        rangeFirstLine = 0;
        rangeLastLine = 0;

        // Check if new range starts at this line
        if (rangeIdx >= ranges.length) break;
        currentRange = ranges[rangeIdx];
        if (lineNumber < currentRange.start) continue;
      }

      // Within current range — hash and output
      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const letters = hashToLetters(h);
      if (rangeFirstLine === 0) {
        rangeFirstLine = lineNumber;
      }
      const prefix = Buffer.from(`${letters}.${lineNumber}\t`);
      const lineLen = prefix.length + lineBytes.length + 1;

      // Check output limits before committing this line
      outputLines++;
      if (outputLines > MAX_OUTPUT_LINES || outputLen + lineLen > MAX_OUTPUT_BYTES) {
        truncated = true;
        break;
      }

      rangeLastLine = lineNumber;
      rangeChecksumHash = foldHash(rangeChecksumHash, h);
      outputChunks.push(prefix, lineBytes, LF_BUF);
      outputLen += lineLen;
    }
  } catch (err: unknown) {
    if (isBinaryError(err)) return binaryFileError(file_path);
    throw err;
  }

  // Empty file
  if (totalLines === 0 && !truncated) {
    const emptyRef = issueRef(resolvedPath, 0, 0, "00000000");
    evictReadCacheIfNeeded();
    readCache.set(resolvedPath, { mtimeMs, rangesKey: rKey, refs: [emptyRef], encodingLine: "" });
    return textResult(`(empty file)\n\nref: ${emptyRef} (empty file)`);
  }

  // Check if first range's start is out of range
  if (rangeFirstLine === 0 && ranges[0].start > totalLines) {
    return errorResult(`start_line ${ranges[0].start} out of range (file has ${totalLines} lines)`);
  }

  // Emit ref for the last range (only if we output any lines in it)
  if (rangeFirstLine > 0 && rangeLastLine > 0) {
    const hex = rangeChecksumHash.toString(16).padStart(8, "0");
    const refId = issueRef(resolvedPath, rangeFirstLine, rangeLastLine, hex);
    collectedRefs.push(refId);
    const refLine = `\nref: ${refId} (lines ${rangeFirstLine}-${rangeLastLine})`;
    const cb = Buffer.from(refLine);
    outputChunks.push(cb);
    outputLen += cb.length;
  }

  // Append truncation notice so the agent knows to use narrower ranges
  if (truncated) {
    const reason = outputLines > MAX_OUTPUT_LINES ? `${MAX_OUTPUT_LINES} line` : "20 MB output";
    const notice = `\n\n(truncated at ${reason} limit — use ranges for specific sections)`;
    const nb = Buffer.from(notice);
    outputChunks.push(nb);
    outputLen += nb.length;
  }

  // Include encoding metadata when non-default, so trueline_edit can round-trip
  if (bomInfo.hasBOM) {
    const encLabel = bomInfo.encoding === "utf-8" ? "utf-8-bom" : bomInfo.encoding;
    const encLine = Buffer.from(`\nencoding: ${encLabel}`);
    outputChunks.push(encLine);
    outputLen += encLine.length;
  }

  // Steer agents toward trueline_edit instead of the built-in Edit tool.
  const hint = Buffer.from("\n\nTo edit: trueline_edit (not Edit tool)");
  outputChunks.push(hint);
  outputLen += hint.length;

  // Populate cache for future unchanged-file checks (skip truncated reads —
  // they don't cover the full requested range, so the refs are incomplete)
  if (!truncated && collectedRefs.length > 0) {
    const encodingLine = bomInfo.hasBOM
      ? `encoding: ${bomInfo.encoding === "utf-8" ? "utf-8-bom" : bomInfo.encoding}`
      : "";
    evictReadCacheIfNeeded();
    readCache.set(resolvedPath, { mtimeMs, rangesKey: rKey, refs: collectedRefs, encodingLine });
  }

  // UTF-16 content has been transcoded to UTF-8; always decode output as UTF-8.
  const outputEnc = bomInfo.encoding === "utf-8" ? enc : "utf-8";
  return textResult(Buffer.concat(outputChunks, outputLen).toString(outputEnc));
}

export async function handleReadMulti(params: ReadMultiParams): Promise<ToolResult> {
  const { file_paths, ranges, ...rest } = params;

  // Parse inline ranges from file_paths (e.g. "src/foo.ts:10-25")
  const parsed = file_paths.map(parseFilePathWithRanges);

  // Top-level ranges with multiple files is ambiguous; reject it.
  if (ranges?.length && parsed.length > 1) {
    return errorResult(
      "Top-level ranges cannot be used with multiple file_paths. " +
        'Use inline range syntax instead: file_paths: ["src/foo.ts:10-25", "src/bar.ts:1-50"]',
    );
  }

  // Single file: top-level ranges still work for backward compat
  if (parsed.length === 1) {
    const fp = parsed[0];
    const effectiveRanges = fp.rangeSpecs ?? ranges;
    return handleRead({ ...rest, file_path: fp.path, ranges: effectiveRanges });
  }

  // Multiple files: each gets its own inline ranges (or whole file)
  const parts: string[] = [];
  for (const fp of parsed) {
    const result = await handleRead({ ...rest, file_path: fp.path, ranges: fp.rangeSpecs });
    if (result.isError) return result;
    const text = (result.content[0] as { text: string }).text;
    parts.push(`--- ${fp.path} ---\n${text}`);
  }
  return textResult(parts.join("\n\n"));
}
