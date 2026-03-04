// ==============================================================================
// trueline_read handler
//
// Streams the file line-by-line via `createReadStream` — the file is never
// loaded into memory as a whole.  Lines before `start_line` are counted and
// skipped; lines after `end_line` stop the stream early.  Each line is decoded
// to a JS string (required for the trueline output format), hashed with
// `fnv1aHash`, and formatted as `lineNumber:hash|content`.
// ==============================================================================

import { createReadStream } from "node:fs";
import {
  EMPTY_FILE_CHECKSUM,
  FNV_OFFSET_BASIS,
  fnv1aHash,
  foldHash,
  formatChecksum,
} from "../trueline.ts";
import { validatePath } from "./shared.ts";
import { type ToolResult } from "./types.ts";

interface ReadParams {
  file_path: string;
  start_line?: number;
  end_line?: number;
  projectDir?: string;
  allowedDirs?: string[];
}

/**
 * Stream lines from a file, treating \r\n, \r, and \n as line endings.
 * (\r\n, \r, and \n are all line endings).
 *
 * Yields one string per line with no trailing EOL characters.  Handles
 * \r\n pairs split across chunk boundaries.
 */
async function* streamLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  let partial = "";
  let prevChunkEndedWithCR = false;

  for await (const chunk of stream) {
    let lineStart = 0;

    // If the previous chunk ended with \r and this chunk starts with \n,
    // they form a single \r\n pair — skip the \n.
    if (prevChunkEndedWithCR && chunk.length > 0 && chunk.charCodeAt(0) === 0x0a) {
      lineStart = 1;
    }
    prevChunkEndedWithCR = false;

    for (let i = lineStart; i < chunk.length; i++) {
      const ch = chunk.charCodeAt(i);
      const isCR = ch === 0x0d;
      const isLF = ch === 0x0a;

      if (!isCR && !isLF) continue;

      // ============================================================
      // Found a line terminator (\r, \n, or \r\n) — emit the line.
      // ============================================================
      yield partial + chunk.slice(lineStart, i);
      partial = "";

      // Consume the \n half of a \r\n pair, if present.
      if (isCR) {
        const nextIndex = i + 1;
        if (nextIndex < chunk.length) {
          // \r\n within the same chunk — skip the \n.
          if (chunk.charCodeAt(nextIndex) === 0x0a) i++;
        } else {
          // \r at chunk boundary — the \n may open the next chunk.
          prevChunkEndedWithCR = true;
        }
      }

      lineStart = i + 1;
    }

    // Accumulate any remaining text after the last terminator.
    if (lineStart < chunk.length) {
      partial += chunk.slice(lineStart);
    }
  }

  // File without a trailing newline — emit the final partial line.
  if (partial.length > 0) {
    yield partial;
  }
}

export async function handleRead(params: ReadParams): Promise<ToolResult> {
  const { file_path, start_line, end_line, projectDir, allowedDirs } = params;

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath } = validated;

  const start = start_line ?? 1;
  if (start < 1) {
    return {
      content: [{ type: "text", text: `start_line ${start} must be >= 1` }],
      isError: true,
    };
  }
  if (end_line !== undefined && end_line < start) {
    return {
      content: [{ type: "text", text: `end_line ${end_line} must be >= start_line ${start}` }],
      isError: true,
    };
  }

  const end = end_line ?? Infinity;
  const outputParts: string[] = [];
  let checksumHash = FNV_OFFSET_BASIS;
  let lineNo = 0;
  let lastLine = 0;

  for await (const line of streamLines(resolvedPath)) {
    lineNo++;

    // Binary detection: null bytes indicate non-text content.
    if (line.includes("\0")) {
      return {
        content: [{ type: "text", text: `"${file_path}" appears to be a binary file` }],
        isError: true,
      };
    }

    if (lineNo < start) continue;
    if (lineNo > end) break;

    lastLine = lineNo;
    const h = fnv1aHash(line);
    checksumHash = foldHash(checksumHash, h);

    // Format trueline: "lineNo:ab|content"
    const c1 = String.fromCharCode(97 + (h % 26));
    const c2 = String.fromCharCode(97 + ((h >>> 8) % 26));
    outputParts.push(`${lineNo}:${c1}${c2}|${line}`);
  }

  // Empty file
  if (lineNo === 0) {
    return { content: [{ type: "text", text: `(empty file)\n\nchecksum: ${EMPTY_FILE_CHECKSUM}` }] };
  }

  // start_line out of range
  if (start > lineNo) {
    return {
      content: [{ type: "text", text: `start_line ${start} out of range (file has ${lineNo} lines)` }],
      isError: true,
    };
  }

  const checksum = formatChecksum(start, lastLine, checksumHash);
  return { content: [{ type: "text", text: `${outputParts.join("\n")}\n\nchecksum: ${checksum}` }] };
}
