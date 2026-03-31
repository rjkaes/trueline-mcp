// ==============================================================================
// Shared byte-level line splitter
//
// Single source of truth for CR/LF/CRLF line splitting.  The core logic
// lives in `splitChunks`, which accepts an async iterable of raw byte
// buffers and yields one RawLine per line.
//
// `splitLines` is a convenience wrapper that opens a file and feeds its
// 64KB chunks into `splitChunks`.
//
// Binary detection (null-byte scan) is essentially free during the byte scan
// for line terminators, so it's offered as an opt-in flag rather than forcing
// each caller to implement it separately.
// ==============================================================================

import { open } from "node:fs/promises";

// ==============================================================================
// Public types and constants
// ==============================================================================

export interface RawLine {
  lineBytes: Buffer; // line content without EOL
  eolBytes: Buffer; // LF_BUF | CRLF_BUF | CR_BUF | EMPTY_BUF
  lineNumber: number; // 1-based
}

export const LF_BUF = Buffer.from("\n");
export const CRLF_BUF = Buffer.from("\r\n");
export const CR_BUF = Buffer.from("\r");
export const EMPTY_BUF = Buffer.alloc(0);

// ==============================================================================
// Core chunk-based line-splitting generator
// ==============================================================================

export interface SplitChunksOpts {
  detectBinary?: boolean;
}

/**
 * Split an async stream of byte chunks into lines.
 *
 * Yields one `RawLine` per line: the raw line bytes (no EOL), the EOL
 * bytes (LF / CRLF / CR / empty for last line without trailing newline),
 * and the 1-based line number.  Handles `\r\n` pairs split across chunk
 * boundaries correctly.
 *
 * When `detectBinary` is true, throws if a null byte (0x00) is encountered.
 */
export async function* splitChunks(chunks: AsyncIterable<Buffer>, opts?: SplitChunksOpts): AsyncGenerator<RawLine> {
  const detectBinary = opts?.detectBinary ?? false;
  let partials: Buffer[] = [];
  let partialsLen = 0;
  let lineNumber = 0;
  let prevChunkEndedWithCR = false;

  /** Concatenate accumulated partials into a single buffer and reset. */
  function flushPartials(tail?: Buffer): Buffer {
    if (tail && tail.length > 0) {
      partials.push(tail);
      partialsLen += tail.length;
    }
    if (partialsLen === 0) return EMPTY_BUF;
    const result = partials.length === 1 ? partials[0] : Buffer.concat(partials, partialsLen);
    partials = [];
    partialsLen = 0;
    return result;
  }

  for await (const buf of chunks) {
    if (buf.length === 0) continue;

    let lineStart = 0;

    // If the previous chunk ended with \r, resolve whether it's \r\n or bare \r.
    if (prevChunkEndedWithCR) {
      prevChunkEndedWithCR = false;
      const eol = buf[0] === 0x0a ? CRLF_BUF : CR_BUF;
      if (eol === CRLF_BUF) lineStart = 1;
      yield { lineBytes: flushPartials(), eolBytes: eol, lineNumber: ++lineNumber };
    }

    for (let i = lineStart; i < buf.length; i++) {
      const byte = buf[i];

      if (detectBinary && byte === 0x00) {
        throw new Error("File appears to be binary (contains null bytes)");
      }

      if (byte !== 0x0d && byte !== 0x0a) continue;

      // Found a line terminator — extract content and determine EOL type.
      const slice = buf.subarray(lineStart, i);

      let eol: Buffer;
      if (byte === 0x0d) {
        if (i + 1 < buf.length) {
          if (buf[i + 1] === 0x0a) {
            eol = CRLF_BUF;
            i++;
          } else {
            eol = CR_BUF;
          }
        } else {
          // \r at chunk boundary — defer until next chunk to check for \r\n.
          partials.push(Buffer.from(slice));
          partialsLen += slice.length;
          prevChunkEndedWithCR = true;
          lineStart = i + 1;
          continue;
        }
      } else {
        eol = LF_BUF;
      }

      yield { lineBytes: flushPartials(slice), eolBytes: eol, lineNumber: ++lineNumber };
      lineStart = i + 1;
    }

    // Remaining bytes from this chunk become partial for the next chunk.
    if (lineStart < buf.length) {
      const remainder = Buffer.from(buf.subarray(lineStart, buf.length));
      partials.push(remainder);
      partialsLen += remainder.length;
    }
  }

  // Final content: pending CR at EOF or leftover content (no trailing newline).
  if (prevChunkEndedWithCR || partialsLen > 0) {
    yield {
      lineBytes: flushPartials(),
      eolBytes: prevChunkEndedWithCR ? CR_BUF : EMPTY_BUF,
      lineNumber: ++lineNumber,
    };
  }
}

// ==============================================================================
// File-based convenience wrapper
// ==============================================================================

const READ_BUF_SIZE = 65536;

/**
 * Stream lines from a file as raw Buffers without decoding to JS strings.
 *
 * Opens the file, reads it in 64KB chunks, and delegates to `splitChunks`.
 * When `detectBinary` is true, throws if a null byte (0x00) is encountered.
 */
export async function* splitLines(filePath: string, opts?: { detectBinary?: boolean }): AsyncGenerator<RawLine> {
  async function* fileChunks(): AsyncGenerator<Buffer> {
    const fd = await open(filePath, "r");
    const readBuf = Buffer.allocUnsafe(READ_BUF_SIZE);
    try {
      let bytesRead: number;
      do {
        ({ bytesRead } = await fd.read(readBuf, 0, READ_BUF_SIZE));
        if (bytesRead === 0) break;
        // Copy — readBuf is reused, and consumers may hold references to yielded slices.
        yield Buffer.from(readBuf.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      await fd.close();
    }
  }

  yield* splitChunks(fileChunks(), opts);
}
