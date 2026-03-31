// ==============================================================================
// BOM detection and UTF-16 transcoding
//
// Provides a streaming transcoding layer that sits between file I/O and the
// line splitter.  For UTF-16 LE/BE files, chunks are transcoded to UTF-8
// via TextDecoder({ stream: true }) before line splitting.  For UTF-8 BOM
// files, the BOM is stripped from the first chunk.  Plain UTF-8 files pass
// through with zero overhead.
//
// The write path provides helpers to re-encode UTF-8 content back to the
// original encoding, preserving round-trip fidelity.
// ==============================================================================

import { open } from "node:fs/promises";
import { splitChunks, type RawLine, type SplitChunksOpts } from "./line-splitter.ts";

// ==============================================================================
// BOM detection
// ==============================================================================

export type DetectedEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface BOMInfo {
  encoding: DetectedEncoding;
  bomLength: number;
  hasBOM: boolean;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);

/**
 * Detect BOM from the first bytes of a file.
 *
 * Detection order: UTF-8 BOM (3 bytes) first to avoid ambiguity with
 * UTF-16 LE BOM (2 bytes, prefix of some UTF-8 BOM sequences is not
 * an issue but checking longer matches first is standard practice).
 */
export function detectBOM(firstBytes: Buffer): BOMInfo {
  if (firstBytes.length >= 3 && firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf) {
    return { encoding: "utf-8", bomLength: 3, hasBOM: true };
  }
  if (firstBytes.length >= 2 && firstBytes[0] === 0xff && firstBytes[1] === 0xfe) {
    return { encoding: "utf-16le", bomLength: 2, hasBOM: true };
  }
  if (firstBytes.length >= 2 && firstBytes[0] === 0xfe && firstBytes[1] === 0xff) {
    return { encoding: "utf-16be", bomLength: 2, hasBOM: true };
  }
  return { encoding: "utf-8", bomLength: 0, hasBOM: false };
}

// ==============================================================================
// Transcoded line generator
// ==============================================================================

export interface TranscodedLinesResult {
  lines: AsyncGenerator<RawLine>;
  bomInfo: BOMInfo;
}

const READ_BUF_SIZE = 65536;

/**
 * Stream lines from a file, transparently handling BOM and UTF-16 transcoding.
 *
 * Returns both the line generator and BOM metadata so callers know the
 * original encoding for write-back.
 *
 * For UTF-16: reads raw chunks, strips BOM, transcodes via TextDecoder
 * with streaming mode, then feeds UTF-8 bytes into splitChunks.
 *
 * For UTF-8 BOM: strips the 3-byte BOM from the first chunk, then
 * delegates to splitChunks directly.
 *
 * For plain UTF-8: delegates to splitChunks with zero overhead.
 */
export async function transcodedLines(filePath: string, opts?: SplitChunksOpts): Promise<TranscodedLinesResult> {
  const fd = await open(filePath, "r");
  const readBuf = Buffer.allocUnsafe(READ_BUF_SIZE);

  // Read the first chunk to detect BOM
  const { bytesRead: firstBytesRead } = await fd.read(readBuf, 0, READ_BUF_SIZE);

  if (firstBytesRead === 0) {
    await fd.close();
    // Empty file — return an empty generator
    async function* empty(): AsyncGenerator<RawLine> {}
    return { lines: empty(), bomInfo: { encoding: "utf-8", bomLength: 0, hasBOM: false } };
  }

  const firstChunk = Buffer.from(readBuf.subarray(0, firstBytesRead));
  const bomInfo = detectBOM(firstChunk);

  if (bomInfo.encoding === "utf-16le" || bomInfo.encoding === "utf-16be") {
    // UTF-16: transcode all chunks to UTF-8 before line splitting.
    // Binary detection is disabled — UTF-16 is full of null bytes.
    const optsWithoutBinary = { ...opts, detectBinary: false };

    async function* utf16Chunks(): AsyncGenerator<Buffer> {
      const decoder = new TextDecoder(bomInfo.encoding);

      // First chunk: strip BOM, then transcode
      const afterBom = firstChunk.subarray(bomInfo.bomLength);
      if (afterBom.length > 0) {
        const decoded = decoder.decode(afterBom, { stream: true });
        if (decoded.length > 0) yield Buffer.from(decoded, "utf-8");
      }

      // Remaining chunks
      try {
        let bytesRead: number;
        do {
          ({ bytesRead } = await fd.read(readBuf, 0, READ_BUF_SIZE));
          if (bytesRead === 0) break;
          const chunk = Buffer.from(readBuf.subarray(0, bytesRead));
          const decoded = decoder.decode(chunk, { stream: true });
          if (decoded.length > 0) yield Buffer.from(decoded, "utf-8");
        } while (bytesRead > 0);

        // Flush any remaining buffered data in the decoder
        const final = decoder.decode(new Uint8Array(0), { stream: false });
        if (final.length > 0) yield Buffer.from(final, "utf-8");
      } finally {
        await fd.close();
      }
    }

    return { lines: splitChunks(utf16Chunks(), optsWithoutBinary), bomInfo };
  }

  // UTF-8 (with or without BOM): strip BOM if present, then split directly.
  async function* utf8Chunks(): AsyncGenerator<Buffer> {
    // First chunk: strip BOM bytes if present
    const afterBom = bomInfo.hasBOM ? firstChunk.subarray(bomInfo.bomLength) : firstChunk;
    if (afterBom.length > 0) yield afterBom;

    // Remaining chunks
    try {
      let bytesRead: number;
      do {
        ({ bytesRead } = await fd.read(readBuf, 0, READ_BUF_SIZE));
        if (bytesRead === 0) break;
        yield Buffer.from(readBuf.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      await fd.close();
    }
  }

  return { lines: splitChunks(utf8Chunks(), opts), bomInfo };
}

// ==============================================================================
// Write-path encoding helpers
// ==============================================================================

/**
 * Get the BOM bytes for a given encoding. Returns an empty buffer if no BOM.
 */
export function bomBytes(bomInfo: BOMInfo): Buffer {
  if (!bomInfo.hasBOM) return Buffer.alloc(0);
  switch (bomInfo.encoding) {
    case "utf-8":
      return UTF8_BOM;
    case "utf-16le":
      return UTF16_LE_BOM;
    case "utf-16be":
      return UTF16_BE_BOM;
  }
}

/**
 * Encode a UTF-8 string to the target encoding's byte representation.
 *
 * Node's Buffer.from(str, encoding) supports 'utf-8' and 'utf16le' natively.
 * For UTF-16 BE, we encode as UTF-16 LE then swap byte pairs.
 */
export function encodeString(str: string, encoding: DetectedEncoding): Buffer {
  if (encoding === "utf-8") return Buffer.from(str, "utf-8");
  if (encoding === "utf-16le") return Buffer.from(str, "utf16le");

  // UTF-16 BE: encode as LE then swap each byte pair
  const le = Buffer.from(str, "utf16le");
  for (let i = 0; i < le.length - 1; i += 2) {
    const tmp = le[i];
    le[i] = le[i + 1];
    le[i + 1] = tmp;
  }
  return le;
}

/**
 * Encode a UTF-8 Buffer to the target encoding.
 *
 * Decodes the buffer to a string first, then re-encodes. This is the
 * write-path counterpart to the read-path transcoding.
 */
export function encodeBuffer(buf: Buffer, encoding: DetectedEncoding): Buffer {
  if (encoding === "utf-8") return buf;
  return encodeString(buf.toString("utf-8"), encoding);
}
