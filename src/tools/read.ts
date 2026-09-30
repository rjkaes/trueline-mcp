// ==============================================================================
// trueline_read handler
//
// Streams the file line-by-line via `transcodedLines` — the file is never loaded
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

// Node fs errors (EACCES, EIO, ...) belong to one file, so a batch keeps its other files. Only the
// errno code is shown: the error message carries the resolved absolute path.
function unreadableFileError(file_path: string, err: unknown): ToolResult {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string") throw err;
  return errorResult(`"${file_path}" could not be read (${code})`);
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
  // Where the open chunk began, so a chunk of only boundary context can be dropped once EOF is known.
  let chunkStart = { chunks: 0, len: 0 };
  let truncated = false;

  // Resolve encoding before streaming — transcodedLines peeks at the BOM.
  // It refuses UTF-32 there; as a result, not a throw, a batch read keeps its other files.
  let transcoded: Awaited<ReturnType<typeof transcodedLines>>;
  try {
    transcoded = await transcodedLines(resolvedPath, { detectBinary: true });
  } catch (err: unknown) {
    if (isBinaryError(err)) return errorResult(`"${file_path}": ${err.message}`);
    return unreadableFileError(file_path, err);
  }
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
      const prefix = Buffer.from(`${letters}${lineNumber}\t`);
      const lineLen = prefix.length + lineBytes.length + 1;

      // Boundary context is not a requested line: it does not count toward the line cap,
      // and dropping it at a cap is not truncation.
      const isRequested = requestedRanges.some((r) => lineNumber >= r.start && lineNumber <= r.end);

      // Check output limits before committing this line
      if (outputLines >= MAX_OUTPUT_LINES || outputLen + lineLen > MAX_OUTPUT_BYTES) {
        if (!isRequested) continue;
        truncated = true;
        break;
      }
      if (isRequested) outputLines++;
      if (rangeFirstLine === 0) {
        chunkStart = { chunks: outputChunks.length, len: outputLen };
        rangeFirstLine = lineNumber;
        rangeFirstLetters = letters;
      }

      rangeLastLine = lineNumber;
      rangeLastLetters = letters;
      rangeChecksumHash = foldHash(rangeChecksumHash, h);
      outputChunks.push(prefix, lineBytes, LF_BUF);
      outputLen += lineLen;
    }
  } catch (err: unknown) {
    if (isBinaryError(err)) return binaryFileError(file_path);
    return unreadableFileError(file_path, err);
  }

  // Empty file
  if (totalLines === 0 && !truncated) {
    return textResult("(empty file)\n\nref: 0-0/aaaaaa");
  }

  // Check requested ranges, not the boundary-expanded ones, or the error names
  // start-1 and a range one line past EOF is served as the last line. A truncated
  // read stopped early, so ranges it never reached say nothing about EOF.
  const pastEof = truncated ? [] : requestedRanges.filter((r) => r.start > totalLines);
  // Graceful degradation: error only when no range is servable; otherwise the
  // valid ranges are returned and each past-EOF one is named in the trailer.
  if (pastEof.length === requestedRanges.length) {
    return errorResult(`start_line ${pastEof[0].start} out of range (file has ${totalLines} lines)`);
  }

  // A range starting one line past EOF still pulled in the last line as its leading boundary.
  // A chunk with no requested line is that leak: drop it.
  if (
    !truncated &&
    rangeFirstLine > 0 &&
    !requestedRanges.some((r) => r.start <= rangeLastLine && r.end >= rangeFirstLine)
  ) {
    outputChunks.length = chunkStart.chunks;
    outputLen = chunkStart.len;
    rangeFirstLine = 0;
  }

  // Emit inline ref for the last range (only if we output any lines in it)
  if (rangeFirstLine > 0 && rangeLastLine > 0) {
    const ck = checksumToLetters(rangeChecksumHash);
    const refLine = `\nref: ${rangeFirstLetters}${rangeFirstLine}-${rangeLastLetters}${rangeLastLine}/${ck}`;
    append(refLine);
  }

  // Notices hold non-ASCII text; keep them out of the buffer that is decoded
  // with the caller's encoding (latin1 would garble the UTF-8 bytes).
  let trailer = "";
  for (const r of pastEof) {
    const spec = r.end === Infinity ? `${r.start}-` : r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`;
    trailer += `\n\n(range ${spec} skipped — out of range, file has ${totalLines} lines)`;
  }

  // Append truncation notice so the agent knows to use narrower ranges
  if (truncated) {
    const reason = outputLines >= MAX_OUTPUT_LINES ? `${MAX_OUTPUT_LINES} line` : "20 MB output";
    const notice = `\n\n(truncated at ${reason} limit — use ranges for specific sections)`;
    trailer += notice;
  }

  // Nudge toward targeted reads when a full-file read returns many lines.
  const LARGE_READ_NUDGE = 150;
  const isFullFileRead = requestedRanges.length === 1 && requestedRanges[0].end === Infinity;
  if (!truncated && isFullFileRead && outputLines > LARGE_READ_NUDGE) {
    trailer += `\n\n(${outputLines} lines — consider ranges for targeted reads)`;
  }

  // Include encoding metadata when non-default, so trueline_edit can round-trip
  if (bomInfo.bom.length > 0) {
    const encLabel = bomInfo.encoding === "utf-8" ? "utf-8-bom" : bomInfo.encoding;
    trailer += `\nencoding: ${encLabel}`;
  }

  // UTF-16 content has been transcoded to UTF-8; always decode output as UTF-8.
  const outputEnc = bomInfo.encoding === "utf-8" ? enc : "utf-8";
  return textResult(Buffer.concat(outputChunks, outputLen).toString(outputEnc) + trailer);
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

  // Expand globs; entries without glob characters pass through unchanged.
  const expanded = await expandGlobs(candidates, rest.projectDir, rest.allowedDirs);

  // Only user-supplied entries carry inline ranges (e.g. "src/foo.ts:10-25").
  // A glob match is a real filename, so one named "backup:5" is never split.
  const literalEntries = new Set(
    candidates.map((entry) => (process.platform === "win32" ? entry.replaceAll("\\", "/") : entry)),
  );
  const parsed = await Promise.all(
    expanded.map(async (entry) => {
      if (!literalEntries.has(entry)) return { path: entry, rangeSpecs: undefined };
      const split = parseFilePathWithRanges(entry);
      // An existing file named "snapshot-10:30" is that file, not line 30 of "snapshot-10".
      const namedFile =
        split.rangeSpecs !== undefined && (await validatePath(entry, "Read", rest.projectDir, rest.allowedDirs)).ok;
      return namedFile ? { path: entry, rangeSpecs: undefined } : split;
    }),
  );

  // Top-level ranges with multiple files is ambiguous; reject it. Rejected
  // entries count, or the ranges would silently rebind to the surviving file.
  if (ranges?.length && parsed.length + rejectedSections.length > 1) {
    return errorResult(
      "Top-level ranges cannot be used with multiple file_paths. " +
        'Use inline range syntax instead: file_paths: ["src/foo.ts:10-25", "src/bar.ts:1-50"]',
    );
  }

  // A glob or several paths get headers even when one file matches, so the output
  // names the file it came from. An existing path that merely contains glob
  // characters passes expansion unchanged and is a literal.
  const headed = file_paths.length > 1 || expanded.some((entry) => !literalEntries.has(entry));

  // Single file: top-level ranges still work for backward compat
  if (parsed.length === 1 && rejectedSections.length === 0 && !headed) {
    const fp = parsed[0];
    const effectiveRanges = fp.rangeSpecs ?? ranges;
    return handleRead({ ...rest, file_path: fp.path, ranges: effectiveRanges });
  }

  // Multiple files: skip per-file errors (deny patterns, missing files) so one
  // bad path from a glob doesn't abort the entire batch.
  const parts: string[] = [...rejectedSections];
  for (const fp of parsed) {
    const result = await handleRead({ ...rest, file_path: fp.path, ranges: fp.rangeSpecs ?? ranges });
    const text = (result.content[0] as { text: string }).text;
    parts.push(`--- ${displayPath(fp.path, rest.projectDir)} ---\n${result.isError ? "error: " : ""}${text}`);
  }
  return textResult(parts.join("\n\n"));
}
