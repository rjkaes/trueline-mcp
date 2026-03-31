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
// ==============================================================================

import { LF_BUF } from "../line-splitter.ts";
import { transcodedLines } from "../encoding.ts";
import {
  EMPTY_FILE_CHECKSUM,
  FNV_OFFSET_BASIS,
  fnv1aHashBytes,
  foldHash,
  formatChecksum,
  hashToLetters,
} from "../hash.ts";
import { parseRanges, type ReadRange } from "../parse.ts";
import { binaryFileError, isBinaryError, validateEncoding, validatePath } from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

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
        const checksumLine = `\nchecksum: ${formatChecksum(rangeFirstLine, rangeLastLine, rangeChecksumHash)}\n`;
        const cb = Buffer.from(checksumLine);
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
      if (rangeFirstLine === 0) rangeFirstLine = lineNumber;

      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const prefix = Buffer.from(`${hashToLetters(h)}.${lineNumber}\t`);
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
    return textResult(`(empty file)\n\nchecksum: ${EMPTY_FILE_CHECKSUM}`);
  }

  // Check if first range's start is out of range
  if (rangeFirstLine === 0 && ranges[0].start > totalLines) {
    return errorResult(`start_line ${ranges[0].start} out of range (file has ${totalLines} lines)`);
  }

  // Emit checksum for the last range (only if we output any lines in it)
  if (rangeFirstLine > 0 && rangeLastLine > 0) {
    const checksumLine = `\nchecksum: ${formatChecksum(rangeFirstLine, rangeLastLine, rangeChecksumHash)}`;
    const cb = Buffer.from(checksumLine);
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

  // UTF-16 content has been transcoded to UTF-8; always decode output as UTF-8.
  const outputEnc = bomInfo.encoding === "utf-8" ? enc : "utf-8";
  return textResult(Buffer.concat(outputChunks, outputLen).toString(outputEnc));
}

export async function handleReadMulti(params: ReadMultiParams): Promise<ToolResult> {
  const { file_paths, ...rest } = params;
  if (file_paths.length === 1) {
    return handleRead({ ...rest, file_path: file_paths[0] });
  }
  const parts: string[] = [];
  for (const fp of file_paths) {
    const result = await handleRead({ ...rest, file_path: fp });
    if (result.isError) return result;
    const text = (result.content[0] as { text: string }).text;
    parts.push(`--- ${fp} ---\n${text}`);
  }
  return textResult(parts.join("\n\n"));
}
