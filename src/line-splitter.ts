// ==============================================================================
// Shared byte-level line splitter
//
// Single source of truth for CR/LF/CRLF line splitting.  Streams the file
// from disk as raw bytes, yielding one RawLine per line.  Both trueline_read
// and the streaming edit engine wrap this generator with their specific needs.
//
// Binary detection (null-byte scan) is essentially free during the byte scan
// for line terminators, so it's offered as an opt-in flag rather than forcing
// each caller to implement it separately.
// ==============================================================================

import { createReadStream } from "node:fs";

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
// Core line-splitting generator
// ==============================================================================

/**
 * Stream lines from a file as raw Buffers without decoding to JS strings.
 *
 * Yields one `RawLine` per line: the raw line bytes (no EOL), the EOL
 * bytes (LF / CRLF / CR / empty for last line without trailing newline),
 * and the 1-based line number.  Handles `\r\n` pairs split across chunk
 * boundaries correctly.
 *
 * When `detectBinary` is true, throws if a null byte (0x00) is encountered.
 * This check is essentially free during the byte scan for line terminators.
 */
export async function* splitLines(filePath: string, opts?: { detectBinary?: boolean }): AsyncGenerator<RawLine> {
  const detectBinary = opts?.detectBinary ?? false;
  const stream = createReadStream(filePath);
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

  for await (const rawChunk of stream) {
    const buf: Buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let lineStart = 0;

    // If the previous chunk ended with \r, resolve whether it's \r\n or bare \r.
    if (prevChunkEndedWithCR) {
      prevChunkEndedWithCR = false;
      const eol = buf.length > 0 && buf[0] === 0x0a ? CRLF_BUF : CR_BUF;
      if (eol === CRLF_BUF) lineStart = 1;
      yield { lineBytes: flushPartials(), eolBytes: eol, lineNumber: ++lineNumber };
    }

    for (let i = lineStart; i < buf.length; i++) {
      const byte = buf[i];

      if (detectBinary && byte === 0x00) {
        stream.destroy();
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
          partials.push(slice);
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
      const remainder = buf.subarray(lineStart);
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
