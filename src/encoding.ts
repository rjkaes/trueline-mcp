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

import { openNoFollow, readFdChunks, splitChunks, type RawLine, type SplitChunksOpts } from "./line-splitter.ts";

// ==============================================================================
// BOM detection
// ==============================================================================

type DetectedEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface BOMInfo {
  encoding: DetectedEncoding;
  /** Empty when the file has no BOM. */
  bom: Buffer;
}

// Checked in order, longest BOM first.
const BOMS: BOMInfo[] = [
  { encoding: "utf-8", bom: Buffer.from([0xef, 0xbb, 0xbf]) },
  { encoding: "utf-16le", bom: Buffer.from([0xff, 0xfe]) },
  { encoding: "utf-16be", bom: Buffer.from([0xfe, 0xff]) },
];

// ==============================================================================
// Transcoded line generator
// ==============================================================================

interface TranscodedLinesResult {
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
  const fd = await openNoFollow(filePath);
  const readBuf = Buffer.allocUnsafe(READ_BUF_SIZE);

  // Read the first chunk to detect BOM
  const { bytesRead: firstBytesRead } = await fd.read(readBuf, 0, READ_BUF_SIZE);

  const firstChunk = Buffer.from(readBuf.subarray(0, firstBytesRead));
  const bomInfo: BOMInfo = BOMS.find(({ bom }) => firstChunk.subarray(0, bom.length).equals(bom)) ?? {
    encoding: "utf-8",
    bom: Buffer.alloc(0),
  };

  if (bomInfo.encoding === "utf-16le" || bomInfo.encoding === "utf-16be") {
    // UTF-16: transcode all chunks to UTF-8 before line splitting.
    // Binary detection is disabled — UTF-16 is full of null bytes.
    const optsWithoutBinary = { ...opts, detectBinary: false };

    async function* utf16Chunks(): AsyncGenerator<Buffer> {
      const decoder = new TextDecoder(bomInfo.encoding);

      for await (const chunk of readFdChunks(fd, readBuf, firstChunk.subarray(bomInfo.bom.length))) {
        const decoded = decoder.decode(chunk, { stream: true });
        if (decoded.length > 0) yield Buffer.from(decoded, "utf-8");
      }

      // Flush any remaining buffered data in the decoder
      const final = decoder.decode(new Uint8Array(0), { stream: false });
      if (final.length > 0) yield Buffer.from(final, "utf-8");
    }

    return { lines: splitChunks(utf16Chunks(), optsWithoutBinary), bomInfo };
  }

  // UTF-8 (with or without BOM): strip BOM if present, then split directly.
  const afterBom = bomInfo.bom.length > 0 ? firstChunk.subarray(bomInfo.bom.length) : firstChunk;
  return { lines: splitChunks(readFdChunks(fd, readBuf, afterBom), opts), bomInfo };
}

// ==============================================================================
// Write-path encoding helpers
// ==============================================================================

/**
 * Encode a UTF-8 Buffer to the target encoding.
 *
 * Decodes the buffer to a string first, then re-encodes. This is the
 * write-path counterpart to the read-path transcoding.
 *
 * Node's Buffer.from(str, encoding) supports 'utf-8' and 'utf16le' natively.
 * For UTF-16 BE, we encode as UTF-16 LE then swap byte pairs.
 */
export function encodeBuffer(buf: Buffer, encoding: DetectedEncoding): Buffer {
  if (encoding === "utf-8") return buf;
  const utf16le = Buffer.from(buf.toString("utf-8"), "utf16le");
  return encoding === "utf-16le" ? utf16le : utf16le.swap16();
}
