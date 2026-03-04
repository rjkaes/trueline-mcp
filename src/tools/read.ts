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
  FNV_PRIME,
  fnv1aHash,
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
 * Stream lines from a file, matching `parseContent` line-ending behaviour
 * (\r\n, \r, and \n are all line endings).
 *
 * Yields one string per line with no trailing EOL characters.  Handles
 * \r\n pairs split across chunk boundaries.
 */
async function* streamLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  let partial = "";
  let skipNextLF = false;

  for await (const chunk of stream) {
    let lineStart = 0;

    // Handle \r\n split across chunks: previous chunk ended with \r,
    // skip the \n that opens this chunk.
    if (skipNextLF && chunk.length > 0 && chunk.charCodeAt(0) === 0x0a) {
      lineStart = 1;
    }
    skipNextLF = false;

    for (let i = lineStart; i < chunk.length; i++) {
      const ch = chunk.charCodeAt(i);
      if (ch === 0x0d) { // \r
        if (i + 1 < chunk.length) {
          yield partial + chunk.slice(lineStart, i);
          partial = "";
          if (chunk.charCodeAt(i + 1) === 0x0a) i++; // skip \n of \r\n
          lineStart = i + 1;
        } else {
          // \r at end of chunk — might be first half of \r\n
          yield partial + chunk.slice(lineStart, i);
          partial = "";
          lineStart = i + 1;
          skipNextLF = true;
        }
      } else if (ch === 0x0a) { // \n
        yield partial + chunk.slice(lineStart, i);
        partial = "";
        lineStart = i + 1;
      }
    }

    if (lineStart < chunk.length) {
      partial += chunk.slice(lineStart);
    }
  }

  // Content after the last line ending (file without trailing newline)
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
  let clampedEnd = 0;

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

    clampedEnd = lineNo;
    const h = fnv1aHash(line);

    // Update running checksum (same algorithm as rangeChecksum)
    checksumHash = Math.imul(checksumHash ^ (h & 0xff),          FNV_PRIME) >>> 0;
    checksumHash = Math.imul(checksumHash ^ ((h >>> 8) & 0xff),  FNV_PRIME) >>> 0;
    checksumHash = Math.imul(checksumHash ^ ((h >>> 16) & 0xff), FNV_PRIME) >>> 0;
    checksumHash = Math.imul(checksumHash ^ ((h >>> 24) & 0xff), FNV_PRIME) >>> 0;

    // Format trueline
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

  const checksum = `${start}-${clampedEnd}:${checksumHash.toString(16).padStart(8, "0")}`;
  return { content: [{ type: "text", text: `${outputParts.join("\n")}\n\nchecksum: ${checksum}` }] };
}
