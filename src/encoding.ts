// ==============================================================================
// BOM detection and UTF-16 transcoding
//
// Provides a streaming transcoding layer that sits between file I/O and the
// line splitter.  For UTF-16 LE/BE files, chunks are transcoded to WTF-8
// (UTF-8 that also keeps lone surrogates) before line splitting.  For UTF-8 BOM
// files, the BOM is stripped from the first chunk.  Plain UTF-8 files pass
// through with zero overhead.
//
// The write path provides helpers to re-encode UTF-8 content back to the
// original encoding, preserving round-trip fidelity.
// ==============================================================================

import {
  EMPTY_BUF,
  openNoFollow,
  readFdChunks,
  splitChunks,
  type RawLine,
  type SplitChunksOpts,
} from "./line-splitter.ts";

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

// Refused rather than transcoded; FF FE 00 00 would otherwise match the UTF-16LE BOM.
const UTF32_BOMS = [Buffer.from([0xff, 0xfe, 0x00, 0x00]), Buffer.from([0x00, 0x00, 0xfe, 0xff])];

// ==============================================================================
// Transcoded line generator
// ==============================================================================

interface TranscodedLinesResult {
  lines: AsyncGenerator<RawLine>;
  bomInfo: BOMInfo;
  /** Closes the source fd when `lines` was never started (return() on an unstarted generator skips its finally). */
  close: () => Promise<void>;
  /** An odd-length UTF-16 file's unpaired last byte, withheld from `lines`; set once `lines` is exhausted. */
  trailingByte: () => Buffer;
}

const READ_BUF_SIZE = 65536;

/** Check whether an error from `transcodedLines` indicates a binary file. */
export function isBinaryError(err: unknown): err is Error {
  // Anchored to the splitter's and encoding's own messages: an fs error (EACCES) quotes the
  // path, and a path can contain "binary".
  return err instanceof Error && /^(File appears to be binary|UTF-32 is not supported)/.test(err.message);
}

/**
 * Stream lines from a file, transparently handling BOM and UTF-16 transcoding.
 *
 * Returns both the line generator and BOM metadata so callers know the
 * original encoding for write-back.
 *
 * For UTF-16: reads raw chunks, strips BOM, transcodes to WTF-8 so
 * encodeBuffer can restore every code unit, then feeds it into splitChunks.
 *
 * For UTF-8 BOM: strips the 3-byte BOM from the first chunk, then
 * delegates to splitChunks directly.
 *
 * For plain UTF-8: delegates to splitChunks with zero overhead.
 */
export async function transcodedLines(filePath: string, opts?: SplitChunksOpts): Promise<TranscodedLinesResult> {
  const fd = await openNoFollow(filePath);
  const readBuf = Buffer.allocUnsafe(READ_BUF_SIZE);

  // Read the first chunk to detect BOM. No generator owns the fd yet, so a
  // failed read must close it here.
  const { bytesRead: firstBytesRead } = await fd.read(readBuf, 0, READ_BUF_SIZE).catch(async (err: unknown) => {
    await fd.close();
    throw err;
  });

  const firstChunk = Buffer.from(readBuf.subarray(0, firstBytesRead));
  if (UTF32_BOMS.some((bom) => firstChunk.subarray(0, bom.length).equals(bom))) {
    await fd.close();
    // isBinaryError matches the "UTF-32 is not supported" prefix, so search and verify skip the file
    // as they did when UTF-32BE's NUL bytes tripped binary detection.
    // No path: callers name the file, as for splitChunks' binary error.
    throw new Error("UTF-32 is not supported; the file is treated as binary");
  }
  const bomInfo: BOMInfo = BOMS.find(({ bom }) => firstChunk.subarray(0, bom.length).equals(bom)) ?? {
    encoding: "utf-8",
    bom: Buffer.alloc(0),
  };

  if (bomInfo.encoding === "utf-16le" || bomInfo.encoding === "utf-16be") {
    // UTF-16: transcode all chunks to UTF-8 before line splitting.
    // Binary detection is disabled — UTF-16 is full of null bytes.
    const optsWithoutBinary = { ...opts, detectBinary: false };
    const encoding = bomInfo.encoding;
    let trailing = EMPTY_BUF;

    async function* utf16Chunks(): AsyncGenerator<Buffer> {
      // Held for the next chunk: half a code unit, or a high surrogate whose low half may follow.
      let carry = EMPTY_BUF;
      for await (const chunk of readFdChunks(fd, readBuf, firstChunk.subarray(bomInfo.bom.length))) {
        const raw = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        let end = raw.length - (raw.length % 2);
        const lastUnit =
          end === 0 ? 0 : encoding === "utf-16le" ? raw.readUInt16LE(end - 2) : raw.readUInt16BE(end - 2);
        if ((lastUnit & 0xfc00) === 0xd800) end -= 2;
        carry = Buffer.from(raw.subarray(end));
        if (end > 0) yield utf16ToWtf8(raw.subarray(0, end), encoding);
      }

      // Half a code unit is not a character; the edit engine writes it back at EOF.
      const even = carry.length - (carry.length % 2);
      if (even > 0) yield utf16ToWtf8(carry.subarray(0, even), encoding);
      trailing = carry.subarray(even);
    }

    return {
      lines: splitChunks(utf16Chunks(), optsWithoutBinary),
      bomInfo,
      close: () => fd.close(),
      trailingByte: () => trailing,
    };
  }

  // UTF-8 (with or without BOM): strip BOM if present, then split directly.
  const afterBom = bomInfo.bom.length > 0 ? firstChunk.subarray(bomInfo.bom.length) : firstChunk;
  return {
    lines: splitChunks(readFdChunks(fd, readBuf, afterBom), opts),
    bomInfo,
    close: () => fd.close(),
    trailingByte: () => EMPTY_BUF,
  };
}

// With the u flag a valid pair is one code point outside this range, so only lone surrogates match.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

/**
 * UTF-16 code units to WTF-8: UTF-8 that also encodes each lone surrogate as
 * three bytes, where TextDecoder and Buffer's UTF-8 encoder would substitute
 * U+FFFD. encodeBuffer inverts it, so untouched lines round-trip byte-exact.
 */
function utf16ToWtf8(units: Buffer, encoding: "utf-16le" | "utf-16be"): Buffer {
  const text = (encoding === "utf-16le" ? units : Buffer.from(units).swap16()).toString("utf16le");
  if (text.isWellFormed()) return Buffer.from(text, "utf-8");
  const parts: Buffer[] = [];
  let start = 0;
  for (const { index } of text.matchAll(LONE_SURROGATE)) {
    const unit = text.charCodeAt(index);
    parts.push(
      Buffer.from(text.slice(start, index), "utf-8"),
      Buffer.from([0xed, 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f)]),
    );
    start = index + 1;
  }
  parts.push(Buffer.from(text.slice(start), "utf-8"));
  return Buffer.concat(parts);
}

// ==============================================================================
// Write-path encoding helpers
// ==============================================================================

/**
 * Encode a UTF-8 (or WTF-8, from the read path) Buffer to the target encoding.
 *
 * Decodes the buffer to a string first, then re-encodes, restoring each WTF-8
 * lone surrogate as the code unit it came from.
 *
 * Node's Buffer.from(str, encoding) supports 'utf-8' and 'utf16le' natively.
 * For UTF-16 BE, we encode as UTF-16 LE then swap byte pairs.
 */
export function encodeBuffer(buf: Buffer, encoding: DetectedEncoding): Buffer {
  if (encoding === "utf-8") return buf;
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = buf.indexOf(0xed); i !== -1; i = buf.indexOf(0xed, i + 1)) {
    // ED 80–9F starts an ordinary U+D000–U+D7FF; ED A0–BF, a lone surrogate.
    if (buf[i + 1] < 0xa0) continue;
    const unit = 0xd000 | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f);
    parts.push(Buffer.from(buf.toString("utf-8", start, i), "utf16le"), Buffer.from([unit & 0xff, unit >> 8]));
    start = i + 3;
  }
  parts.push(Buffer.from(buf.toString("utf-8", start), "utf16le"));
  const utf16le = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  return encoding === "utf-16le" ? utf16le : utf16le.swap16();
}
