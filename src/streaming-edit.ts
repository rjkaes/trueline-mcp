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
//    used previously) because we have no random access during streaming.
//  - Pending-write pattern: each output line is buffered and flushed when the
//    next line arrives, so the last line can omit its EOL if the original file
//    had no trailing newline.
//  - Buffered fd writes: small writes accumulate in a 64KB buffer and flush
//    via `fs.write()` to minimize syscalls (much faster than createWriteStream).
//  - EOL detection from first line ending since we cannot rescan during a
//    single pass.
//  - No-op detection: byte-compares replacement content against original lines
//    to skip the atomic rename when nothing actually changed.
// ==============================================================================

import { randomBytes } from "node:crypto";
import { chmod, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  EMPTY_FILE_CHECKSUM,
  FNV_OFFSET_BASIS,
  fnv1aHashBytes,
  foldHash,
  formatChecksum,
  hashToLetters,
} from "./hash.ts";
import { EMPTY_BUF, LF_BUF, splitLines } from "./line-splitter.ts";
import type { DiffCollector } from "./diff-collector.ts";
import type { ChecksumRef } from "./parse.ts";

// ==============================================================================
// StreamEditOp — the validated, parsed representation of a single edit
// ==============================================================================

export interface StreamEditOp {
  startLine: number;
  endLine: number;
  content: string[];
  insertAfter: boolean;
  startHash: string;
  endHash: string;
}

// ==============================================================================
// Streaming edit engine
// ==============================================================================

type StreamingEditResult =
  | { ok: true; newChecksum: string; changed: boolean; tmpPath?: string }
  | { ok: false; error: string };

function buffersEqual(a: Buffer[], b: Buffer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!a[i].equals(b[i])) return false;
  }
  return true;
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
  dryRun = false,
  encoding: BufferEncoding = "utf-8",
  collector?: DiffCollector,
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
  const sortedOps = indexed.map((x) => x.op);

  // ---- Build lookup structures ----

  // Map from line number to list of ops starting at that line
  const opsByStartLine = new Map<number, StreamEditOp[]>();
  for (const op of sortedOps) {
    const list = opsByStartLine.get(op.startLine) ?? [];
    list.push(op);
    opsByStartLine.set(op.startLine, list);
  }

  // Per-checksum-ref accumulators (sorted by startLine from validateEdits)
  const csAccumulators = checksumRefs.map((ref) => ({
    ref,
    hash: FNV_OFFSET_BASIS,
    verified: false,
  }));
  let csIdx = 0;

  // ---- Temp file setup ----
  const dir = dirname(resolvedPath);
  const tmpName = `.trueline-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);
  const fd = await open(tmpPath, "w");

  // Buffered writer — accumulates small writes and flushes at 64KB to
  // minimize syscalls. This is dramatically faster than createWriteStream
  // for the many-small-writes pattern (2 writes per source line).
  const WRITE_BUF_SIZE = 65536;
  const writeBuf = Buffer.allocUnsafe(WRITE_BUF_SIZE);
  let writeBufPos = 0;

  async function flushWriteBuf(): Promise<void> {
    if (writeBufPos > 0) {
      await fd.write(writeBuf, 0, writeBufPos);
      writeBufPos = 0;
    }
  }

  async function writeBytes(buf: Buffer): Promise<void> {
    // If the buffer is larger than remaining space, flush first
    if (writeBufPos + buf.length > WRITE_BUF_SIZE) {
      await flushWriteBuf();
      // If it's larger than the entire buffer, write directly
      if (buf.length > WRITE_BUF_SIZE) {
        await fd.write(buf, 0, buf.length);
        return;
      }
    }
    buf.copy(writeBuf, writeBufPos);
    writeBufPos += buf.length;
  }

  // ---- State ----
  let detectedEol: Buffer = LF_BUF; // default, updated from first line ending
  let eolDetected = false;
  let contentChanged = false;
  let totalLines = 0;
  let pendingWrite: Buffer | null = null; // buffered output line (no EOL)
  let pendingEol: Buffer = LF_BUF; // EOL to use when flushing pendingWrite
  let lastEolBytes: Buffer = EMPTY_BUF; // EOL of the last source line seen
  let outputLineCount = 0;
  let outputChecksumAcc = FNV_OFFSET_BASIS; // full-file checksum of output

  // Track which replace op we're currently inside (skipping source lines)
  let activeReplace: StreamEditOp | null = null;
  let activeReplaceOrigBytes: Buffer[] = []; // original line bytes for no-op detection
  let activeReplaceOrigEols: Buffer[] = []; // original EOL bytes for each replaced line

  // ---- Helpers ----

  async function flushPending(): Promise<void> {
    if (pendingWrite !== null) {
      await writeBytes(pendingWrite);
      await writeBytes(pendingEol);
      pendingWrite = null;
    }
  }

  async function enqueueLine(buf: Buffer, precomputedHash?: number, eol?: Buffer): Promise<void> {
    await flushPending();
    pendingWrite = buf;
    pendingEol = eol ?? detectedEol;
    const lineH = precomputedHash ?? fnv1aHashBytes(buf, 0, buf.length);
    outputChecksumAcc = foldHash(outputChecksumAcc, lineH);
    outputLineCount++;
  }

  async function enqueueString(s: string): Promise<void> {
    await enqueueLine(Buffer.from(s, encoding));
  }

  async function cleanupTmp(): Promise<void> {
    try {
      await fd.close();
    } catch {
      /* best-effort */
    }
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort */
    }
  }

  async function fail(error: string): Promise<StreamingEditResult> {
    await cleanupTmp();
    return { ok: false, error: `${resolvedPath}: ${error}` };
  }

  async function writeContentLines(content: string[]): Promise<void> {
    for (const line of content) await enqueueString(line);
  }

  // Compare replacement content against original bytes. If identical, write
  // the original buffers (no-op); otherwise write the replacement.
  //
  // Fast path: when line counts differ, skip Buffer allocation entirely —
  // the content is definitely changed.
  async function writeReplaceOrOriginal(op: StreamEditOp, origBytes: Buffer[], origEols?: Buffer[]): Promise<void> {
    if (op.content.length !== origBytes.length) {
      contentChanged = true;
      for (const s of op.content) await enqueueString(s);
      if (collector) {
        for (const buf of origBytes) collector.delete(buf.toString(encoding));
        for (const s of op.content) collector.insert(s);
      }
      return;
    }
    // Same line count — encode and compare byte-by-byte
    const replacementBufs = op.content.map((s) => Buffer.from(s, encoding));
    if (buffersEqual(replacementBufs, origBytes)) {
      for (let k = 0; k < origBytes.length; k++) {
        const eol = origEols?.[k];
        await enqueueLine(origBytes[k], undefined, eol && eol.length > 0 ? eol : undefined);
      }
      if (collector) for (const buf of origBytes) collector.context(buf.toString(encoding));
    } else {
      contentChanged = true;
      for (const buf of replacementBufs) await enqueueLine(buf);
      if (collector) {
        for (const buf of origBytes) collector.delete(buf.toString(encoding));
        for (const s of op.content) collector.insert(s);
      }
    }
  }

  function outputChecksumStr(): string {
    return outputLineCount > 0 ? formatChecksum(1, outputLineCount, outputChecksumAcc) : EMPTY_FILE_CHECKSUM;
  }

  function hashMismatchMsg(lineNumber: number, expected: string, got: string): string {
    return `hash mismatch at line ${lineNumber}: expected ${expected}, got ${got}`;
  }

  // ---- Handle line-0 insert_after (prepend) before streaming ----
  const line0Ops = opsByStartLine.get(0);
  if (line0Ops) {
    for (const op of line0Ops) {
      await writeContentLines(op.content);
      if (collector) for (const line of op.content) collector.insert(line);
    }
    contentChanged = true;
    opsByStartLine.delete(0);
  }

  // ---- Stream source file ----
  try {
    for await (const { lineBytes, eolBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: true })) {
      totalLines = lineNumber;
      lastEolBytes = eolBytes;

      // EOL detection from first line ending seen
      if (!eolDetected && eolBytes.length > 0) {
        detectedEol = eolBytes;
        eolDetected = true;
        // Update pending EOL for any line-0 content written before EOL detection
        pendingEol = detectedEol;
      }

      // Compute line hash for checksum accumulators and boundary verification
      const lineH = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const letters = hashToLetters(lineH);

      // Feed into checksum accumulators. Overlapping ranges are supported:
      // advance csIdx past fully consumed accumulators, then fold lineH into
      // every accumulator whose range covers this line.
      while (csIdx < csAccumulators.length && csAccumulators[csIdx].ref.endLine < lineNumber) {
        csAccumulators[csIdx].verified = true;
        csIdx++;
      }
      for (let ci = csIdx; ci < csAccumulators.length; ci++) {
        const acc = csAccumulators[ci];
        if (lineNumber < acc.ref.startLine) break;
        if (lineNumber > acc.ref.endLine) continue;
        acc.hash = foldHash(acc.hash, lineH);
      }

      // Check if we're inside an active replace range (skipping lines)
      if (activeReplace && lineNumber <= activeReplace.endLine) {
        // Verify end boundary hash
        if (lineNumber === activeReplace.endLine && activeReplace.endHash !== "") {
          if (letters !== activeReplace.endHash) {
            return await fail(hashMismatchMsg(lineNumber, activeReplace.endHash, letters));
          }
        }

        activeReplaceOrigBytes.push(lineBytes);
        activeReplaceOrigEols.push(eolBytes);

        // End of replace range: write replacement content
        if (lineNumber === activeReplace.endLine) {
          const op = activeReplace;
          activeReplace = null;

          await writeReplaceOrOriginal(op, activeReplaceOrigBytes, activeReplaceOrigEols);

          activeReplaceOrigBytes = [];
          activeReplaceOrigEols = [];

          // Process insert_after ops at this line
          const opsAtLine = opsByStartLine.get(lineNumber);
          if (opsAtLine) {
            for (const iaOp of opsAtLine) {
              if (iaOp.insertAfter) {
                contentChanged = true;
                await writeContentLines(iaOp.content);
                if (collector) for (const line of iaOp.content) collector.insert(line);
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
            return await fail(hashMismatchMsg(lineNumber, replaceOp.startHash, letters));
          }

          if (replaceOp.startLine === replaceOp.endLine) {
            // Single-line replace: handle immediately
            await writeReplaceOrOriginal(replaceOp, [lineBytes], [eolBytes]);

            // Process insert_after ops at this line
            for (const iaOp of insertOps) {
              contentChanged = true;
              await writeContentLines(iaOp.content);
              if (collector) for (const line of iaOp.content) collector.insert(line);
            }
          } else {
            // Multi-line replace: enter active replace mode
            activeReplace = replaceOp;
            activeReplaceOrigBytes = [lineBytes];
            activeReplaceOrigEols = [eolBytes];

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
              return await fail(hashMismatchMsg(lineNumber, iaOp.startHash, letters));
            }
          }

          await enqueueLine(lineBytes, lineH, eolBytes.length > 0 ? eolBytes : undefined);
          if (collector) collector.context(lineBytes.toString(encoding));

          for (const iaOp of insertOps) {
            contentChanged = true;
            await writeContentLines(iaOp.content);
            if (collector) for (const line of iaOp.content) collector.insert(line);
          }
        }
      } else {
        // No ops at this line — write raw bytes unchanged
        await enqueueLine(lineBytes, lineH, eolBytes.length > 0 ? eolBytes : undefined);
        if (collector) collector.context(lineBytes.toString(encoding));
      }
    }
  } catch (err: unknown) {
    // Binary detection throws from splitLines — convert to a structured
    // error result so callers get { ok: false } instead of an exception.
    if (err instanceof Error && err.message.includes("binary")) {
      return await fail(err.message);
    }
    await cleanupTmp();
    throw err;
  }

  // ---- Post-stream: flush last line ----
  // The pending write pattern: the last line gets flushed with or without
  // EOL based on whether the original file had a trailing newline.
  try {
    if (pendingWrite !== null) {
      await writeBytes(pendingWrite);
      // If the last source line had a non-empty eolBytes, the file had a trailing newline
      if (lastEolBytes.length > 0) {
        await writeBytes(detectedEol);
      }
    }
  } catch (err) {
    await cleanupTmp();
    throw err;
  }

  // Flush remaining buffered bytes and close the file descriptor.
  try {
    await flushWriteBuf();
    await fd.close();
  } catch (err) {
    await cleanupTmp();
    throw err;
  }

  // ---- Verify checksums ----
  for (const acc of csAccumulators) {
    const ref = acc.ref;

    // Skip empty-file sentinel
    if (ref.startLine === 0 && ref.endLine === 0) {
      if (totalLines !== 0) {
        return await fail(`Checksum mismatch: expected empty file but file has ${totalLines} lines`);
      }
      continue;
    }

    // Check if checksum range exceeds file length
    if (ref.endLine > totalLines) {
      return await fail(
        `Checksum range ${ref.startLine}-${ref.endLine} exceeds ` + `file length (${totalLines} lines)`,
      );
    }

    const expected = ref.hash;
    const actual = acc.hash.toString(16).padStart(8, "0");
    if (actual !== expected) {
      await cleanupTmp();

      // If we reached post-stream checksum verification, all boundary
      // hashes passed during the stream.  That means the edit-target
      // lines are unchanged — only other lines in the checksum range
      // changed.  Suggest a narrow re-read of just the target lines.
      let minLine = Infinity;
      let maxLine = -Infinity;
      for (const op of sortedOps) {
        if (op.startLine > 0) {
          minLine = Math.min(minLine, op.startLine);
          maxLine = Math.max(maxLine, op.endLine);
        }
      }

      const base =
        `${resolvedPath}: checksum mismatch for lines ${ref.startLine}\u2013${ref.endLine}: ` +
        `expected ${expected}, got ${actual}. File changed since last read.`;

      if (minLine !== Infinity) {
        return {
          ok: false,
          error:
            base +
            `\n\n` +
            `However, lines ${minLine}\u2013${maxLine} appear unchanged. ` +
            `Re-read with trueline_read(ranges=[{start: ${minLine}, end: ${maxLine}}]) ` +
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
    await cleanupTmp();
    return { ok: true, newChecksum: outputChecksumStr(), changed: false };
  }

  // ---- Atomic rename with mtime check ----
  if (!dryRun) {
    let originalMode: number | undefined;
    try {
      const fileStat = await stat(resolvedPath);
      originalMode = fileStat.mode;
      if (fileStat.mtimeMs !== mtimeMs) {
        return await fail("File was modified by another process. Re-read with trueline_read.");
      }
    } catch (err: unknown) {
      // ENOENT means the file was deleted between validatePath and here —
      // proceed with rename so the edit still lands. Any other error
      // (EPERM, EIO, etc.) is unexpected and should not be silently ignored.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        await cleanupTmp();
        throw err;
      }
    }

    try {
      if (originalMode !== undefined) {
        await chmod(tmpPath, originalMode);
      }
      await rename(tmpPath, resolvedPath);
    } catch (err) {
      await cleanupTmp();
      throw err;
    }
  }

  return {
    ok: true,
    newChecksum: outputChecksumStr(),
    changed: true,
    ...(dryRun ? { tmpPath } : {}),
  };
}
