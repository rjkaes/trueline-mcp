// ==============================================================================
// trueline_read handler
//
// Streams the file line-by-line via `splitLines` — the file is never loaded
// into memory as a whole.  Supports reading multiple disjoint ranges in a
// single call, each producing its own checksum.  Each line is decoded to a JS
// string (required for the trueline output format), hashed with `fnv1aHash`,
// and formatted as `lineNumber:hash|content`.
// ==============================================================================

import { splitLines } from "../line-splitter.ts";
import {
  EMPTY_FILE_CHECKSUM,
  FNV_OFFSET_BASIS,
  fnv1aHashBytes,
  foldHash,
  formatChecksum,
  hashToLetters,
} from "../hash.ts";
import { parseRanges, type ReadRange } from "../parse.ts";
import { validateEncoding, validatePath } from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

interface ReadParams {
  file_path: string;
  encoding?: string;
  start_line?: number;
  end_line?: number;
  ranges?: Array<{ start?: number; end?: number }>;
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleRead(params: ReadParams): Promise<ToolResult> {
  const { file_path, start_line, end_line, projectDir, allowedDirs } = params;

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  let enc: BufferEncoding;
  try {
    enc = validateEncoding(params.encoding);
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  const { resolvedPath } = validated;

  // Support both legacy start_line/end_line and new ranges param
  let ranges: ReadRange[];
  try {
    if (params.ranges) {
      ranges = parseRanges(params.ranges);
    } else if (start_line !== undefined || end_line !== undefined) {
      const start = start_line ?? 1;
      if (start < 1) {
        return errorResult(`start_line ${start} must be >= 1`);
      }
      if (end_line !== undefined && end_line < start) {
        return errorResult(`end_line ${end_line} must be >= start_line ${start}`);
      }
      ranges = [{ start, end: end_line ?? Infinity }];
    } else {
      ranges = [{ start: 1, end: Infinity }];
    }
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  const outputParts: string[] = [];
  let rangeIdx = 0;
  let currentRange = ranges[0];
  let rangeChecksumHash = FNV_OFFSET_BASIS;
  let rangeFirstLine = 0;
  let rangeLastLine = 0;
  let totalLines = 0;

  try {
    for await (const { lineBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: true })) {
      totalLines = lineNumber;

      // Past all ranges — stop early
      if (rangeIdx >= ranges.length) break;

      currentRange = ranges[rangeIdx];

      // Before current range
      if (lineNumber < currentRange.start) continue;

      // Past current range — close it, advance
      if (lineNumber > currentRange.end) {
        outputParts.push("");
        outputParts.push(`checksum: ${formatChecksum(rangeFirstLine, rangeLastLine, rangeChecksumHash)}`);

        rangeIdx++;
        rangeChecksumHash = FNV_OFFSET_BASIS;
        rangeFirstLine = 0;

        // Check if new range starts at this line
        if (rangeIdx >= ranges.length) break;
        currentRange = ranges[rangeIdx];
        if (lineNumber < currentRange.start) continue;
      }

      // Within current range — hash and output
      if (rangeFirstLine === 0) rangeFirstLine = lineNumber;
      rangeLastLine = lineNumber;
      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const line = lineBytes.toString(enc);
      rangeChecksumHash = foldHash(rangeChecksumHash, h);
      outputParts.push(`${lineNumber}:${hashToLetters(h)}|${line}`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("binary")) {
      return errorResult(`"${file_path}" appears to be a binary file`);
    }
    throw err;
  }

  // Empty file
  if (totalLines === 0) {
    return textResult(`(empty file)\n\nchecksum: ${EMPTY_FILE_CHECKSUM}`);
  }

  // Check if first range's start is out of range
  if (ranges[0].start > totalLines) {
    return errorResult(`start_line ${ranges[0].start} out of range (file has ${totalLines} lines)`);
  }

  // Emit checksum for the last range
  if (rangeFirstLine > 0) {
    outputParts.push("");
    outputParts.push(`checksum: ${formatChecksum(rangeFirstLine, rangeLastLine, rangeChecksumHash)}`);
  }

  return textResult(outputParts.join("\n"));
}
