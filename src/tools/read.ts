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
import { mergeSortedRanges, parseFilePathWithRanges, parseRanges, type ReadRange } from "../parse.ts";
import {
  binaryFileError,
  displayPath,
  expandGlobs,
  filterAbsolutePaths,
  isAbsolutePathArg,
  isBinaryError,
  relativePathError,
  type ToolContext,
  validateEncoding,
  validatePath,
} from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

/** Expand each range by 1 line on each side for boundary context, then re-merge. */
function expandRanges(ranges: ReadRange[]): ReadRange[] {
  const expanded = ranges.map((r) => ({
    start: r.start > 1 ? r.start - 1 : r.start,
    end: r.end !== Infinity ? r.end + 1 : r.end,
  }));
  return mergeSortedRanges(expanded);
}
interface ReadParams {
  file_path: string;
  encoding?: string;

  ranges?: string[];
  projectDir?: string;
  allowedDirs?: string[];
}

interface ReadMultiParams extends ToolContext {
  file_paths: string[];
  encoding?: string;
  ranges?: string[];
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
  const append = (text: string) => {
    const buf = Buffer.from(text);
    outputChunks.push(buf);
    outputLen += buf.length;
  };
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
        const refLine = `\nref: ${rangeFirstLetters}${rangeFirstLine}-${rangeLastLetters}${rangeLastLine}/${ck}\n`;
        append(refLine);

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
      const h = fnv1aHashBytes(lineBytes);
      const letters = hashToLetters(h);
      if (rangeFirstLine === 0) {
        rangeFirstLine = lineNumber;
        rangeFirstLetters = letters;
      }
      const prefix = Buffer.from(`${letters}${lineNumber}\t`);
      const lineLen = prefix.length + lineBytes.length + 1;

      // Check output limits before committing this line
      outputLines++;
      if (outputLines > MAX_OUTPUT_LINES || outputLen + lineLen > MAX_OUTPUT_BYTES) {
        truncated = true;
        break;
      }

      rangeLastLine = lineNumber;
      rangeLastLetters = letters;
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
    return textResult("(empty file)\n\nref: 0-0/aaaaaa");
  }

  // Check if first range's start is out of range
  if (rangeFirstLine === 0 && ranges[0].start > totalLines) {
    return errorResult(`start_line ${ranges[0].start} out of range (file has ${totalLines} lines)`);
  }

  // Emit inline ref for the last range (only if we output any lines in it)
  if (rangeFirstLine > 0 && rangeLastLine > 0) {
    const ck = checksumToLetters(rangeChecksumHash);
    const refLine = `\nref: ${rangeFirstLetters}${rangeFirstLine}-${rangeLastLetters}${rangeLastLine}/${ck}`;
    append(refLine);
  }

  // Append truncation notice so the agent knows to use narrower ranges
  if (truncated) {
    const reason = outputLines > MAX_OUTPUT_LINES ? `${MAX_OUTPUT_LINES} line` : "20 MB output";
    const notice = `\n\n(truncated at ${reason} limit — use ranges for specific sections)`;
    append(notice);
  }

  // Nudge toward targeted reads when a full-file read returns many lines.
  const LARGE_READ_NUDGE = 150;
  const isFullFileRead = requestedRanges.length === 1 && requestedRanges[0].end === Infinity;
  if (!truncated && isFullFileRead && outputLines > LARGE_READ_NUDGE) {
    append(`\n\n(${outputLines} lines — consider ranges for targeted reads)`);
  }

  // Include encoding metadata when non-default, so trueline_edit can round-trip
  if (bomInfo.bom.length > 0) {
    const encLabel = bomInfo.encoding === "utf-8" ? "utf-8-bom" : bomInfo.encoding;
    append(`\nencoding: ${encLabel}`);
  }

  // UTF-16 content has been transcoded to UTF-8; always decode output as UTF-8.
  const outputEnc = bomInfo.encoding === "utf-8" ? enc : "utf-8";
  return textResult(Buffer.concat(outputChunks, outputLen).toString(outputEnc));
}

export async function handleReadMulti(params: ReadMultiParams): Promise<ToolResult> {
  const { file_paths, ranges, requireAbsolutePath, ...rest } = params;

  if (requireAbsolutePath && file_paths.length === 1 && !isAbsolutePathArg(file_paths[0])) {
    return relativePathError(file_paths[0]);
  }

  // Reject relative entries before glob expansion, so a relative glob like
  // "src/*.ts" is never resolved against a possibly-stale projectDir.
  // Absolute siblings still proceed (graceful degradation).
  const { candidates, rejectedSections } = filterAbsolutePaths(file_paths, requireAbsolutePath, (entry, errorText) => {
    const { path } = parseFilePathWithRanges(entry);
    return `--- ${displayPath(path, rest.projectDir)} ---\nerror: ${errorText}`;
  });

  // Expand globs before parsing inline ranges (globs never contain ':')
  const expanded = await expandGlobs(candidates, rest.projectDir, rest.allowedDirs);

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
  if (parsed.length === 1 && rejectedSections.length === 0) {
    const fp = parsed[0];
    const effectiveRanges = fp.rangeSpecs ?? ranges;
    return handleRead({ ...rest, file_path: fp.path, ranges: effectiveRanges });
  }

  // Multiple files: skip per-file errors (deny patterns, missing files) so one
  // bad path from a glob doesn't abort the entire batch.
  const parts: string[] = [...rejectedSections];
  for (const fp of parsed) {
    const result = await handleRead({ ...rest, file_path: fp.path, ranges: fp.rangeSpecs });
    const text = (result.content[0] as { text: string }).text;
    parts.push(`--- ${displayPath(fp.path, rest.projectDir)} ---\n${result.isError ? "error: " : ""}${text}`);
  }
  return textResult(parts.join("\n\n"));
}
