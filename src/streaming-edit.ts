// ==============================================================================
// Streaming edit engine
//
// Single-pass byte-level edit pipeline for `trueline_edit`.  Streams the source
// file from disk to a temp file, applying edits inline without loading the
// entire file into memory.  Unchanged lines are written as raw bytes with zero
// string allocation; only edit boundaries and replacement content are decoded.
//
// Key design choices:
//  - Forward ascending sort (opposite of the in-memory back-to-front approach
//    in `applyEdits`) because we have no random access during streaming.
//  - Pending-write pattern: each output line is buffered and flushed when the
//    next line arrives, so the last line can omit its EOL if the original file
//    had no trailing newline.
//  - Backpressure: `outStream.write()` return values are checked and `drain`
//    events are awaited to prevent unbounded buffering.
//  - EOL detection from first line ending (not majority-wins like `parseContent`)
//    since we cannot rescan during a single pass.
//  - No-op detection: byte-compares replacement content against original lines
//    to skip the atomic rename when nothing actually changed.
// ==============================================================================

import { createReadStream, createWriteStream } from "node:fs";
import { stat, rename, chmod, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { FNV_OFFSET_BASIS, FNV_PRIME, EMPTY_FILE_CHECKSUM, foldHash, formatChecksum } from "./trueline.ts";
import type { ChecksumRef } from "./trueline.ts";
import type { StreamEditOp } from "./tools/shared.ts";

/**
 * Compute FNV-1a 32-bit hash directly on raw UTF-8 bytes in a Buffer.
 *
 * Equivalent to `fnv1aHash(str)` when the buffer contains the UTF-8
 * encoding of `str`, but avoids the JS string -> UTF-8 re-encoding that
 * `fnv1aHash` performs internally. This lets us hash file content
 * without ever decoding it to a JS string.
 */
export function fnv1aHashBytes(
  buf: Buffer,
  start: number,
  end: number,
): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = start; i < end; i++) {
    hash = Math.imul(hash ^ buf[i], FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

// ==============================================================================
// Byte-level line streaming
// ==============================================================================

export interface ByteLine {
  lineBytes: Buffer;
  eolBytes: Buffer;
  lineNumber: number;
}

const LF_BUF = Buffer.from("\n");
const CRLF_BUF = Buffer.from("\r\n");
const CR_BUF = Buffer.from("\r");
const EMPTY_BUF = Buffer.alloc(0);

/**
 * Stream lines from a file as raw Buffers without decoding to JS strings.
 *
 * Yields one `ByteLine` per line: the raw line bytes (no EOL), the EOL
 * bytes (LF / CRLF / CR / empty for last line without trailing newline),
 * and the 1-based line number. Handles `\r\n` pairs split across chunk
 * boundaries the same way `streamLines` in `read.ts` does.
 */
export async function* streamByteLines(filePath: string): AsyncGenerator<ByteLine> {
  const stream = createReadStream(filePath);
  let partials: Buffer[] = [];
  let partialsLen = 0;
  let lineNumber = 0;
  let prevChunkEndedWithCR = false;

  for await (const rawChunk of stream) {
    const buf: Buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let lineStart = 0;

    // If the previous chunk ended with \r, resolve whether it's \r\n or bare \r.
    if (prevChunkEndedWithCR) {
      prevChunkEndedWithCR = false;
      const eol = (buf.length > 0 && buf[0] === 0x0a) ? CRLF_BUF : CR_BUF;
      if (eol === CRLF_BUF) lineStart = 1;
      lineNumber++;
      yield { lineBytes: flushPartials(partials, partialsLen), eolBytes: eol, lineNumber };
      partials = [];
      partialsLen = 0;
    }

    for (let i = lineStart; i < buf.length; i++) {
      const byte = buf[i];
      const isCR = byte === 0x0d;
      const isLF = byte === 0x0a;

      if (!isCR && !isLF) continue;

      // ============================================================
      // Found a line terminator — accumulate content and emit.
      // ============================================================
      const slice = buf.subarray(lineStart, i);

      // Determine EOL type.
      let eol: Buffer;
      if (isCR) {
        const nextIndex = i + 1;
        if (nextIndex < buf.length) {
          // \r\n within the same chunk — skip the \n.
          if (buf[nextIndex] === 0x0a) {
            eol = CRLF_BUF;
            i++;
          } else {
            eol = CR_BUF;
          }
        } else {
          // \r at chunk boundary — defer until next chunk.
          partials.push(slice);
          partialsLen += slice.length;
          prevChunkEndedWithCR = true;
          lineStart = i + 1;
          continue;
        }
      } else {
        eol = LF_BUF;
      }

      // Emit the line.
      lineNumber++;
      if (partialsLen > 0) {
        partials.push(slice);
        yield { lineBytes: flushPartials(partials, partialsLen + slice.length), eolBytes: eol, lineNumber };
        partials = [];
        partialsLen = 0;
      } else {
        yield { lineBytes: slice, eolBytes: eol, lineNumber };
      }

      lineStart = i + 1;
    }

    // Remaining bytes from this chunk become partial.
    if (lineStart < buf.length) {
      partials.push(buf.subarray(lineStart));
      partialsLen += buf.length - lineStart;
    }
  }

  // Final content: pending CR at EOF or leftover partials (no trailing newline).
  if (prevChunkEndedWithCR || partialsLen > 0) {
    lineNumber++;
    yield {
      lineBytes: flushPartials(partials, partialsLen),
      eolBytes: prevChunkEndedWithCR ? CR_BUF : EMPTY_BUF,
      lineNumber,
    };
  }
}

function flushPartials(partials: Buffer[], totalLen: number): Buffer {
  if (partials.length === 0) return EMPTY_BUF;
  if (partials.length === 1) return partials[0];
  return Buffer.concat(partials, totalLen);
}

// ==============================================================================
// Streaming edit engine
// ==============================================================================

export type StreamingEditResult =
  | { ok: true; newChecksum: string; changed: boolean }
  | { ok: false; error: string };

/**
 * Convert a line's FNV-1a hash to the 2-letter hash used in line references.
 *
 * Same mapping as `lineHash` in trueline.ts but operates on a precomputed
 * numeric hash rather than a string, avoiding redundant UTF-8 encoding.
 */
function hashToLetters(h: number): string {
  const c1 = String.fromCharCode(97 + (h % 26));
  const c2 = String.fromCharCode(97 + ((h >>> 8) % 26));
  return c1 + c2;
}

/**
 * Single-pass byte-level streaming edit engine.
 *
 * Streams the source file line-by-line, verifies checksums and boundary
 * hashes on the fly, writes output to a temp file, and atomically renames
 * on success. Returns the new full-file checksum.
 */
export async function streamingEdit(
  resolvedPath: string,
  ops: StreamEditOp[],
  checksumRefs: ChecksumRef[],
  mtimeMs: number,
): Promise<StreamingEditResult> {
  // ---- Sort ops ascending by startLine, insert_after after replace at same line ----
  const indexed = ops.map((op, i) => ({ op, i }));
  indexed.sort((a, b) => {
    if (a.op.startLine !== b.op.startLine) return a.op.startLine - b.op.startLine;
    // At same line: replace before insert_after
    if (a.op.insertAfter !== b.op.insertAfter) return a.op.insertAfter ? 1 : -1;
    // Same type at same line: preserve input order
    return a.i - b.i;
  });
  const sortedOps = indexed.map(x => x.op);

  // ---- Build lookup structures ----

  // Map from line number to list of ops starting at that line
  const opsByStartLine = new Map<number, StreamEditOp[]>();
  for (const op of sortedOps) {
    const list = opsByStartLine.get(op.startLine) ?? [];
    list.push(op);
    opsByStartLine.set(op.startLine, list);
  }

  // Checksum accumulators: one per unique checksumRef
  interface CsAcc {
    ref: ChecksumRef;
    hash: number;
  }
  const csAccs: CsAcc[] = checksumRefs.map(ref => ({
    ref,
    hash: FNV_OFFSET_BASIS,
  }));

  // ---- Temp file setup ----
  const dir = dirname(resolvedPath);
  const tmpName = `.trueline-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);
  const outStream = createWriteStream(tmpPath);

  // Capture write errors eagerly — if the error listener is only attached at
  // stream end, errors emitted during streaming (e.g. disk full) are missed.
  let writeError: Error | null = null;
  outStream.on("error", (err) => { writeError = err; });

  // Await backpressure drain to prevent unbounded buffering in the writable
  // stream's internal buffer, which would defeat the memory-efficiency goal.
  async function drain(): Promise<void> {
    if (writeError) throw writeError;
    await new Promise<void>((res) => outStream.once("drain", res));
  }

  // ---- State ----
  let detectedEol: Buffer = LF_BUF;  // default, updated from first line ending
  let eolDetected = false;
  let contentChanged = false;
  let totalLines = 0;
  let pendingWrite: Buffer | null = null;  // buffered output line (no EOL)
  let lastEolBytes: Buffer = EMPTY_BUF;    // EOL of the last source line seen
  let outputLineCount = 0;
  let outputChecksumAcc = FNV_OFFSET_BASIS; // full-file checksum of output

  // Track which replace op we're currently inside (skipping source lines)
  let activeReplace: StreamEditOp | null = null;
  let activeReplaceOrigBytes: Buffer[] = [];  // original line bytes for no-op detection

  // ---- Helpers ----

  async function flushPending(): Promise<void> {
    if (pendingWrite !== null) {
      if (!outStream.write(pendingWrite)) await drain();
      if (!outStream.write(detectedEol)) await drain();
      pendingWrite = null;
    }
  }

  async function enqueueLine(buf: Buffer): Promise<void> {
    await flushPending();
    pendingWrite = buf;
    // Hash the output line for full-file checksum
    const lineH = fnv1aHashBytes(buf, 0, buf.length);
    outputChecksumAcc = foldHash(outputChecksumAcc, lineH);
    outputLineCount++;
  }

  async function enqueueString(s: string): Promise<void> {
    await enqueueLine(Buffer.from(s, "utf-8"));
  }

  // ---- Handle line-0 insert_after (prepend) before streaming ----
  const line0Ops = opsByStartLine.get(0);
  if (line0Ops) {
    for (const op of line0Ops) {
      for (const line of op.content) {
        await enqueueString(line);
      }
    }
    contentChanged = true;
    opsByStartLine.delete(0);
  }

  // ---- Stream source file ----
  try {
    for await (const { lineBytes, eolBytes, lineNumber } of streamByteLines(resolvedPath)) {
      totalLines = lineNumber;
      lastEolBytes = eolBytes;

      // Binary detection: null byte in line content
      for (let i = 0; i < lineBytes.length; i++) {
        if (lineBytes[i] === 0x00) {
          outStream.destroy();
          try { await unlink(tmpPath); } catch { /* best-effort */ }
          return { ok: false, error: "File appears to be binary (contains null bytes)" };
        }
      }

      // EOL detection from first line ending seen
      if (!eolDetected && eolBytes.length > 0) {
        detectedEol = eolBytes;
        eolDetected = true;
      }

      // Compute line hash for checksum accumulators and boundary verification
      const lineH = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const letters = hashToLetters(lineH);

      // Feed into checksum accumulators
      for (const acc of csAccs) {
        if (lineNumber >= acc.ref.startLine && lineNumber <= acc.ref.endLine) {
          acc.hash = foldHash(acc.hash, lineH);
        }
      }

      // Check if we're inside an active replace range (skipping lines)
      if (activeReplace && lineNumber <= activeReplace.endLine) {
        // Verify end boundary hash
        if (lineNumber === activeReplace.endLine && activeReplace.endHash !== "") {
          if (letters !== activeReplace.endHash) {
            outStream.destroy();
            try { await unlink(tmpPath); } catch { /* best-effort */ }
            return {
              ok: false,
              error: `Hash mismatch at line ${lineNumber}: expected ${activeReplace.endHash}, got ${letters}`,
            };
          }
        }

        activeReplaceOrigBytes.push(lineBytes);

        // End of replace range: write replacement content
        if (lineNumber === activeReplace.endLine) {
          const op = activeReplace;
          activeReplace = null;

          // No-op detection: compare replacement with original
          const replacementBufs = op.content.map(s => Buffer.from(s, "utf-8"));
          let isNoop = replacementBufs.length === activeReplaceOrigBytes.length;
          if (isNoop) {
            for (let i = 0; i < replacementBufs.length; i++) {
              if (!replacementBufs[i].equals(activeReplaceOrigBytes[i])) {
                isNoop = false;
                break;
              }
            }
          }

          if (isNoop) {
            // Write original bytes unchanged
            for (const origBuf of activeReplaceOrigBytes) {
              await enqueueLine(origBuf);
            }
          } else {
            contentChanged = true;
            for (const line of op.content) {
              await enqueueString(line);
            }
          }

          activeReplaceOrigBytes = [];

          // Process insert_after ops at this line
          const opsAtLine = opsByStartLine.get(lineNumber);
          if (opsAtLine) {
            for (const iaOp of opsAtLine) {
              if (iaOp.insertAfter) {
                contentChanged = true;
                for (const line of iaOp.content) {
                  await enqueueString(line);
                }
              }
            }
          }
        }
        continue;
      }

      // Check for ops starting at this line
      const opsAtLine = opsByStartLine.get(lineNumber);
      if (opsAtLine) {
        // Separate replace ops and insert_after ops
        let replaceOp: StreamEditOp | null = null;
        const insertOps: StreamEditOp[] = [];

        for (const op of opsAtLine) {
          if (op.insertAfter) {
            insertOps.push(op);
          } else {
            replaceOp = op;
          }
        }

        if (replaceOp) {
          // Verify start boundary hash
          if (replaceOp.startHash !== "" && letters !== replaceOp.startHash) {
            outStream.destroy();
            try { await unlink(tmpPath); } catch { /* best-effort */ }
            return {
              ok: false,
              error: `Hash mismatch at line ${lineNumber}: expected ${replaceOp.startHash}, got ${letters}`,
            };
          }

          if (replaceOp.startLine === replaceOp.endLine) {
            // Single-line replace: handle immediately
            const replacementBufs = replaceOp.content.map(s => Buffer.from(s, "utf-8"));
            let isNoop = replacementBufs.length === 1 && replacementBufs[0].equals(lineBytes);

            if (isNoop) {
              await enqueueLine(lineBytes);
            } else {
              contentChanged = true;
              for (const line of replaceOp.content) {
                await enqueueString(line);
              }
            }

            // Process insert_after ops at this line
            for (const iaOp of insertOps) {
              contentChanged = true;
              for (const line of iaOp.content) {
                await enqueueString(line);
              }
            }
          } else {
            // Multi-line replace: enter active replace mode
            activeReplace = replaceOp;
            activeReplaceOrigBytes = [lineBytes];

            // Verify start boundary hash for the end line too (done when we reach it)
            // insert_after ops at endLine will be handled when we reach it
            // But insert_after ops at startLine that aren't the end? Not meaningful
            // for multi-line replace starting at startLine.
          }
        } else {
          // No replace op — just write the line and process insert_after
          // Verify boundary hash for insert_after ops
          for (const iaOp of insertOps) {
            if (iaOp.startHash !== "" && letters !== iaOp.startHash) {
              outStream.destroy();
              try { await unlink(tmpPath); } catch { /* best-effort */ }
              return {
                ok: false,
                error: `Hash mismatch at line ${lineNumber}: expected ${iaOp.startHash}, got ${letters}`,
              };
            }
          }

          await enqueueLine(lineBytes);

          for (const iaOp of insertOps) {
            contentChanged = true;
            for (const line of iaOp.content) {
              await enqueueString(line);
            }
          }
        }
      } else {
        // No ops at this line — write raw bytes unchanged
        await enqueueLine(lineBytes);
      }
    }
  } catch (err) {
    outStream.destroy();
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    throw err;
  }

  // ---- Post-stream: flush last line ----
  // The pending write pattern: the last line gets flushed with or without
  // EOL based on whether the original file had a trailing newline.
  if (pendingWrite !== null) {
    if (!outStream.write(pendingWrite)) await drain();
    // If the last source line had a non-empty eolBytes, the file had a trailing newline
    if (lastEolBytes.length > 0) {
      if (!outStream.write(detectedEol)) await drain();
    }
  }

  // Check for errors captured during streaming before finishing
  if (writeError) {
    outStream.destroy();
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    throw writeError;
  }

  // Finish writing — error listener already attached at stream creation
  await new Promise<void>((res, rej) => {
    outStream.on("error", rej);
    outStream.end(() => res());
  });

  // ---- Verify checksum accumulators ----
  for (const acc of csAccs) {
    // Skip empty-file sentinel
    if (acc.ref.startLine === 0 && acc.ref.endLine === 0) {
      if (totalLines !== 0) {
        try { await unlink(tmpPath); } catch { /* best-effort */ }
        return {
          ok: false,
          error: `Checksum mismatch: expected empty file but file has ${totalLines} lines`,
        };
      }
      continue;
    }

    // Check if checksum range exceeds file length
    if (acc.ref.endLine > totalLines) {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      return {
        ok: false,
        error: `Checksum range ${acc.ref.startLine}-${acc.ref.endLine} exceeds ` +
          `file length (${totalLines} lines)`,
      };
    }

    const expected = acc.ref.hash;
    const actual = acc.hash.toString(16).padStart(8, "0");
    if (actual !== expected) {
      try { await unlink(tmpPath); } catch { /* best-effort */ }

      // If we reached post-stream checksum verification, all boundary
      // hashes passed during the stream.  That means the edit-target
      // lines are unchanged — only other lines in the checksum range
      // changed.  Suggest a narrow re-read of just the target lines.
      const csKey = `${acc.ref.startLine}-${acc.ref.endLine}:${expected}`;
      let minLine = Infinity;
      let maxLine = -Infinity;
      for (const op of sortedOps) {
        if (op.checksum === csKey && op.startLine > 0) {
          minLine = Math.min(minLine, op.startLine);
          maxLine = Math.max(maxLine, op.endLine);
        }
      }

      const base = `Checksum mismatch for lines ${acc.ref.startLine}-${acc.ref.endLine}: ` +
        `expected ${expected}, got ${actual}. File changed since last read.`;

      if (minLine !== Infinity) {
        return {
          ok: false,
          error: base + `\n\n` +
            `However, lines ${minLine}-${maxLine} appear unchanged. ` +
            `Re-read with trueline_read(start_line=${minLine}, end_line=${maxLine}) ` +
            `to get a narrow checksum, then retry the edit.`,
        };
      }

      return {
        ok: false,
        error: base,
      };
    }
  }

  // ---- No-op: skip write if nothing changed ----
  if (!contentChanged) {
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    const checksumStr = outputLineCount > 0
      ? formatChecksum(1, outputLineCount, outputChecksumAcc)
      : EMPTY_FILE_CHECKSUM;
    return { ok: true, newChecksum: checksumStr, changed: false };
  }

  // ---- Atomic rename with mtime check ----
  let originalMode: number | undefined;
  try {
    const fileStat = await stat(resolvedPath);
    originalMode = fileStat.mode;
    if (fileStat.mtimeMs !== mtimeMs) {
      try { await unlink(tmpPath); } catch { /* best-effort */ }
      return {
        ok: false,
        error: "File was modified by another process. Re-read with trueline_read.",
      };
    }
  } catch {
    // stat failed (file deleted?) — proceed with rename
  }

  try {
    if (originalMode !== undefined) {
      await chmod(tmpPath, originalMode);
    }
    await rename(tmpPath, resolvedPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* best-effort */ }
    throw err;
  }

  const checksumStr = outputLineCount > 0
    ? formatChecksum(1, outputLineCount, outputChecksumAcc)
    : EMPTY_FILE_CHECKSUM;
  return { ok: true, newChecksum: checksumStr, changed: true };
}
