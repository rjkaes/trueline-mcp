// ==============================================================================
// trueline_read handler
//
// Streams the file line-by-line via `splitLines` — the file is never loaded
// into memory as a whole.  Supports reading multiple disjoint ranges in a
// single call, each producing its own inline ref.
//
// Output is assembled as raw byte buffers (line prefixes are ASCII, line
// content stays as the original bytes) and decoded to a string once at the
// end.  This avoids a per-line `Buffer.toString()` allocation.
// ==============================================================================
import { LF_BUF } from "../line-splitter.ts";
import { transcodedLines } from "../encoding.ts";
import { checksumToLetters, FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash, hashToLetters } from "../hash.ts";
import { parseFilePathWithRanges, parseRanges, type ReadRange } from "../parse.ts";
import { binaryFileError, displayPath, expandGlobs, isBinaryError, validateEncoding, validatePath } from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

/** Expand each range by 1 line on each side for boundary context, then re-merge. */
function expandRanges(ranges: ReadRange[]): ReadRange[] {
  const expanded = ranges.map((r) => ({
    start: r.start > 1 && r.end !== Infinity ? r.start - 1 : r.start,
    end: r.end !== Infinity ? r.end + 1 : r.end,
  }));
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

  const { resolvedPath } = validated;

  let ranges: ReadRange[];
  try {
    ranges = parseRanges(params.ranges);
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  // Expand each range by 1 line on each side for boundary context, then re-merge.
  const requestedRanges = ranges;
  ranges = expandRanges(ranges);

  const MAX_OUTPUT_LINES = 2000;
  const MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20 MB
  const outputChunks: Buffer[] = [];
  let outputLen = 0;
  let rangeIdx = 0;
  let currentRange = ranges[0];
  let rangeChecksumHash = FNV_OFFSET_BASIS;
  let rangeFirstLine = 0;
  let rangeLastLine = 0;
  let rangeFirstLetters = "";
  let rangeLastLetters = "";
  let totalLines = 0;
  let outputLines = 0;
  let truncated = false;
  // Tracks the highest line number actually pushed to events; used after the
  // loop to compute the zero-padding width independently of range resets.
  let maxLineEmitted = 0;

  // Collect line entries during the streaming pass so we can zero-pad line
  // numbers to a uniform width after we know the maximum line emitted.
  type LineEntry = { letters: string; lineNumber: number; lineBytes: Buffer };
  type RefEntry = { kind: "ref"; text: string };
  const events: Array<LineEntry | RefEntry> = [];

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
        const ck = checksumToLetters(rangeChecksumHash);
        const refLine = `\nref: ${rangeFirstLetters}.${rangeFirstLine}-${rangeLastLetters}.${rangeLastLine}:${ck}\n`;
        events.push({ kind: "ref", text: refLine });
        // account for the ref line bytes in the output length estimate
        outputLen += Buffer.byteLength(refLine);

        rangeIdx++;
        rangeChecksumHash = FNV_OFFSET_BASIS;
        rangeFirstLine = 0;
        rangeLastLine = 0;
        rangeFirstLetters = "";
        rangeLastLetters = "";

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
        rangeFirstLetters = letters;
      }
      // Estimate line length using unpadded width for output limit checks;
      // actual prefix is assembled after the loop with zero-padded width.
      const lineLen = 2 + 1 + String(lineNumber).length + 1 + lineBytes.length + 1;

      // Check output limits before committing this line
      outputLines++;
      if (outputLines > MAX_OUTPUT_LINES || outputLen + lineLen > MAX_OUTPUT_BYTES) {
        truncated = true;
        break;
      }

      rangeLastLine = lineNumber;
      rangeLastLetters = letters;
      rangeChecksumHash = foldHash(rangeChecksumHash, h);
      events.push({ letters, lineNumber, lineBytes });
      if (lineNumber > maxLineEmitted) maxLineEmitted = lineNumber;
      outputLen += lineLen;
    }
  } catch (err: unknown) {
    if (isBinaryError(err)) return binaryFileError(file_path);
    throw err;
  }

  // Empty file
  if (totalLines === 0 && !truncated) {
    return textResult("(empty file)\n\nref: 0-0:aaaaaa");
  }

  // Check if first range's start is out of range
  if (rangeFirstLine === 0 && ranges[0].start > totalLines) {
    return errorResult(`start_line ${ranges[0].start} out of range (file has ${totalLines} lines)`);
  }

  // Now that we know the highest line number emitted, compute the zero-padding
  // width so every line's number occupies the same number of characters.
  // Width 1 when nothing was emitted (edge case: truncated before first line).
  const lineNumWidth = maxLineEmitted > 0 ? String(maxLineEmitted).length : 1;

  // Assemble events into outputChunks: line entries get zero-padded prefixes,
  // ref events are emitted as-is.
  for (const ev of events) {
    if ("kind" in ev) {
      const cb = Buffer.from(ev.text);
      outputChunks.push(cb);
    } else {
      const paddedNum = String(ev.lineNumber).padStart(lineNumWidth, "0");
      const prefix = Buffer.from(`${ev.letters}.${paddedNum}\t`);
      outputChunks.push(prefix, ev.lineBytes, LF_BUF);
    }
  }

  // Emit inline ref for the last range (only if we output any lines in it)
  if (rangeFirstLine > 0 && rangeLastLine > 0) {
    const ck = checksumToLetters(rangeChecksumHash);
    const refLine = `\nref: ${rangeFirstLetters}.${rangeFirstLine}-${rangeLastLetters}.${rangeLastLine}:${ck}`;
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

  // Nudge toward targeted reads when a full-file read returns many lines.
  const LARGE_READ_NUDGE = 150;
  const isFullFileRead = requestedRanges.length === 1 && requestedRanges[0].end === Infinity;
  if (!truncated && isFullFileRead && outputLines > LARGE_READ_NUDGE) {
    const nudge = Buffer.from(`\n\n(${outputLines} lines — consider ranges for targeted reads)`);
    outputChunks.push(nudge);
    outputLen += nudge.length;
  }

  // Include encoding metadata when non-default, so trueline_edit can round-trip
  if (bomInfo.hasBOM) {
    const encLabel = bomInfo.encoding === "utf-8" ? "utf-8-bom" : bomInfo.encoding;
    const encLine = Buffer.from(`\nencoding: ${encLabel}`);
    outputChunks.push(encLine);
    outputLen += encLine.length;
  }

  // UTF-16 content has been transcoded to UTF-8; always decode output as UTF-8.
  const outputEnc = bomInfo.encoding === "utf-8" ? enc : "utf-8";
  return textResult(Buffer.concat(outputChunks).toString(outputEnc));
}

export async function handleReadMulti(params: ReadMultiParams): Promise<ToolResult> {
  const { file_paths, ranges, ...rest } = params;

  // Expand globs before parsing inline ranges (globs never contain ':')
  const expanded = await expandGlobs(file_paths, rest.projectDir);

  // Parse inline ranges from file_paths (e.g. "src/foo.ts:10-25")
  const parsed = expanded.map(parseFilePathWithRanges);

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

  // Multiple files: skip per-file errors (deny patterns, missing files) so one
  // bad path from a glob doesn't abort the entire batch.
  const parts: string[] = [];
  for (const fp of parsed) {
    const result = await handleRead({ ...rest, file_path: fp.path, ranges: fp.rangeSpecs });
    const text = (result.content[0] as { text: string }).text;
    if (result.isError) {
      parts.push(`--- ${displayPath(fp.path, rest.projectDir)} ---\nerror: ${text}`);
      continue;
    }
    parts.push(`--- ${displayPath(fp.path, rest.projectDir)} ---\n${text}`);
  }
  return textResult(parts.join("\n\n"));
}
