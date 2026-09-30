// ==============================================================================
// Shared byte-level line splitter
//
// Single source of truth for CR/LF/CRLF line splitting.  The core logic
// lives in `splitChunks`, which accepts an async iterable of raw byte
// buffers and yields one RawLine per line.
//
// Binary detection (null-byte scan) is essentially free during the byte scan
// for line terminators, so it's offered as an opt-in flag rather than forcing
// each caller to implement it separately.
// ==============================================================================

import { constants, open, type FileHandle } from "node:fs/promises";

// ==============================================================================
// Public types and constants
// ==============================================================================

export interface RawLine {
  lineBytes: Buffer; // line content without EOL
  eolBytes: Buffer; // LF_BUF | CRLF_BUF | CR_BUF | EMPTY_BUF
  lineNumber: number; // 1-based
}

export const LF_BUF = Buffer.from("\n");
const CRLF_BUF = Buffer.from("\r\n");
const CR_BUF = Buffer.from("\r");
export const EMPTY_BUF = Buffer.alloc(0);

// ==============================================================================
// Core chunk-based line-splitting generator
// ==============================================================================

/**
 * Index of the next CR or LF at or after `from`, or -1. Kept out of the
 * async generator: JSC leaves loops in generator bodies under-optimized,
 * and the per-byte scan ran ~2x slower inline.
 */
function findTerminator(buf: Buffer, from: number, detectBinary: boolean): number {
  for (let i = from; i < buf.length; i++) {
    const byte = buf[i];
    if (detectBinary && byte === 0x00) {
      throw new Error("File appears to be binary (contains null bytes)");
    }
    if (byte === 0x0d || byte === 0x0a) return i;
  }
  return -1;
}

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

    while (true) {
      let lineBytes: Buffer;
      let eol: Buffer;

      if (prevChunkEndedWithCR) {
        // The previous chunk ended with \r; this chunk's first byte decides \r\n vs bare \r.
        prevChunkEndedWithCR = false;
        eol = buf[0] === 0x0a ? CRLF_BUF : CR_BUF;
        if (eol === CRLF_BUF) lineStart = 1;
        lineBytes = flushPartials();
      } else {
        let i = findTerminator(buf, lineStart, detectBinary);
        if (i === -1) break;

        // Found a line terminator — extract content and determine EOL type.
        const slice = buf.subarray(lineStart, i);

        if (buf[i] === 0x0d) {
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
            break;
          }
        } else {
          eol = LF_BUF;
        }

        lineBytes = flushPartials(slice);
        lineStart = i + 1;
      }

      // Keep this the loop's only yield: a second yield site made JSC run
      // the generator 2-3x slower.
      yield { lineBytes, eolBytes: eol, lineNumber: ++lineNumber };
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
// File descriptor chunk reader
// ==============================================================================

/**
 * Reads chunks from an open fd until EOF, closing it when done. Used by the
 * encoding-aware transcoding paths in encoding.ts.
 *
 * `leadingChunk` (already read by the caller, e.g. for BOM sniffing) is
 * yielded inside the try so an early `return()` still closes the fd.
 */
export async function* readFdChunks(fd: FileHandle, readBuf: Buffer, leadingChunk?: Buffer): AsyncGenerator<Buffer> {
  try {
    if (leadingChunk && leadingChunk.length > 0) yield leadingChunk;
    let bytesRead: number;
    do {
      ({ bytesRead } = await fd.read(readBuf, 0, readBuf.length));
      if (bytesRead === 0) break;
      // Copy — readBuf is reused, and consumers may hold references to yielded slices.
      yield Buffer.from(readBuf.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    await fd.close();
  }
}

// O_NOFOLLOW: fail if the leaf path is a symlink, guarding against
// TOCTOU races between validatePath() and this open.
export function openNoFollow(filePath: string): Promise<FileHandle> {
  return open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
}

// Outline parsers treat a leading U+FEFF as content (a line-1 heading or
// front matter stops matching; the first tree-sitter entry gains the character).
function stripUtf8Bom(buf: Buffer): Buffer {
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
}

/** Reads a file as UTF-8 via openNoFollow, dropping a leading BOM. Returns null if it contains a NUL byte (binary). */
export async function readTextNoFollow(filePath: string): Promise<string | null> {
  const fh = await openNoFollow(filePath);
  const buf = await fh.readFile().finally(() => fh.close());
  return buf.includes(0) ? null : stripUtf8Bom(buf).toString("utf-8");
}
