// ==============================================================================
// Streaming edit engine
//
// Single-pass byte-level edit pipeline for `trueline_edit`.  Streams the source
// file from disk to a temp file, applying edits inline without loading the
// entire file into memory.  Unchanged lines are written as raw bytes with zero
// string allocation; only edit boundaries and replacement content are decoded.
//
// Key design choices:
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
import { FNV_OFFSET_BASIS, checksumToLetters, fnv1aHashBytes, foldHash, hashToLetters } from "./hash.ts";
import { EMPTY_BUF, LF_BUF } from "./line-splitter.ts";
import { transcodedLines, encodeBuffer } from "./encoding.ts";
import type { DiffCollector } from "./diff-collector.ts";
import { BARE_LINE_HASH, type ChecksumRef } from "./parse.ts";

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
  /** Populated during streaming with the original content of deleted lines. */
  deletedContent?: string[];
}

// ==============================================================================
// Streaming edit engine
// ==============================================================================

type StreamingEditResult =
  | {
      ok: true;
      newLineCount: number;
      newHash: string;
      newStartLetters: string;
      newEndLetters: string;
      changed: boolean;
    }
  | { ok: false; error: string };

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
  // ---- Build lookup structures ----

  // Map from line number to list of ops starting at that line
  const opsByStartLine = Map.groupBy(ops, (op) => op.startLine);

  // Per-checksum-ref accumulators (sorted by startLine from validateEdits, which
  // also fixes the order stale refs are reported in after the stream)
  const csAccumulators = checksumRefs.map((ref) => ({
    ref,
    hash: FNV_OFFSET_BASIS,
  }));

  // ---- Temp file setup ----
  const dir = dirname(resolvedPath);
  const tmpName = `.trueline-tmp-${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);
  const fd = await open(tmpPath, "w");

  // transcodedLines handles BOM stripping and UTF-16→UTF-8 transcoding.
  // After this point, lineBytes are always UTF-8 regardless of original encoding.
  // It skips binary detection for UTF-16 itself (null bytes are expected there).
  const transcoded = await transcodedLines(resolvedPath, { detectBinary: true });
  const targetEncoding = transcoded.bomInfo.encoding;

  // Buffered writer — accumulates small writes and flushes at 64KB to
  // minimize syscalls. This is dramatically faster than createWriteStream
  // for the many-small-writes pattern (2 writes per source line).
  const WRITE_BUF_SIZE = 65536;
  const writeBuf = Buffer.allocUnsafe(WRITE_BUF_SIZE);
  let writeBufPos = 0;

  // Write BOM if the original file had one
  const { bom } = transcoded.bomInfo;
  if (bom.length > 0) {
    await fd.write(bom, 0, bom.length);
  }

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
  let outputFirstLineHash = 0;
  let outputLastLineHash = 0;

  // Track which replace op we're currently inside (skipping source lines)
  let activeReplace: StreamEditOp | null = null;
  let activeReplaceOrigBytes: Buffer[] = []; // original line bytes for no-op detection
  let activeReplaceOrigEols: Buffer[] = []; // original EOL bytes for each replaced line

  // ---- Helpers ----

  async function flushPending(): Promise<void> {
    if (pendingWrite !== null) {
      await writeBytes(encodeBuffer(pendingWrite, targetEncoding));
      await writeBytes(encodeBuffer(pendingEol, targetEncoding));
      pendingWrite = null;
    }
  }

  async function enqueueLine(buf: Buffer, precomputedHash?: number, eol?: Buffer): Promise<void> {
    await flushPending();
    pendingWrite = buf;
    pendingEol = eol ?? detectedEol;
    const lineH = precomputedHash ?? fnv1aHashBytes(buf);
    if (outputLineCount === 0) outputFirstLineHash = lineH;
    outputLastLineHash = lineH;
    outputChecksumAcc = foldHash(outputChecksumAcc, lineH);
    outputLineCount++;
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
    for (const line of content) {
      await enqueueLine(Buffer.from(line, encoding));
      collector?.insert(line);
    }
  }

  // Emits insert_after content anchored at lineNumber. The insert's own
  // startHash is verified only on insert-only lines (below); on a replace
  // line the replace's boundary hash check stands in for it.
  async function emitInserts(lineNumber: number): Promise<void> {
    for (const op of opsByStartLine.get(lineNumber) ?? []) {
      if (!op.insertAfter) continue;
      contentChanged = true;
      await writeContentLines(op.content);
    }
  }

  // Compare replacement content against original bytes. If identical, write
  // the original buffers (no-op); otherwise write the replacement.
  //
  // Fast path: when line counts differ, skip Buffer allocation entirely —
  // the content is definitely changed.
  async function writeReplaceOrOriginal(op: StreamEditOp, origBytes: Buffer[], origEols: Buffer[]): Promise<void> {
    const same =
      op.content.length === origBytes.length &&
      op.content.every((s, k) => Buffer.from(s, encoding).equals(origBytes[k]));
    if (same) {
      for (let k = 0; k < origBytes.length; k++) {
        const eol = origEols[k];
        await enqueueLine(origBytes[k], undefined, eol && eol.length > 0 ? eol : undefined);
      }
      if (collector) for (const buf of origBytes) collector.context(buf.toString(encoding));
      return;
    }
    contentChanged = true;
    if (op.content.length === 0) {
      op.deletedContent = origBytes.map((buf) => buf.toString(encoding));
    }
    if (collector) for (const buf of origBytes) collector.delete(buf.toString(encoding));
    await writeContentLines(op.content);
  }

  function hashMismatchMsg(lineNumber: number, expected: string, got: string): string {
    if (expected === BARE_LINE_HASH) {
      return (
        `wrong hash prefix for line ${lineNumber}. ` +
        `Re-read the file to get current hashLine references before retrying.`
      );
    }
    return (
      `hash mismatch at line ${lineNumber}: file has "${got}", edit specified "${expected}". ` +
      `The file content at this line changed since your last read. ` +
      `Re-read the file with trueline_read to get current hashes before retrying.`
    );
  }

  // ---- Handle line-0 insert_after (prepend) before streaming ----
  const line0Ops = opsByStartLine.get(0);
  if (line0Ops) {
    for (const op of line0Ops) {
      await writeContentLines(op.content);
    }
    contentChanged = true;
  }

  // ---- Stream source file ----
  try {
    for await (const { lineBytes, eolBytes, lineNumber } of transcoded.lines) {
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
      const lineH = fnv1aHashBytes(lineBytes);
      const letters = hashToLetters(lineH);

      // Fold lineH into every accumulator whose range covers this line.
      // Ranges may overlap.
      for (const acc of csAccumulators) {
        if (lineNumber >= acc.ref.startLine && lineNumber <= acc.ref.endLine) {
          acc.hash = foldHash(acc.hash, lineH);
        }
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
          await emitInserts(lineNumber);
        }
        continue;
      }

      // Check for ops starting at this line
      const opsAtLine = opsByStartLine.get(lineNumber);
      if (opsAtLine) {
        const replaceOp = opsAtLine.find((op) => !op.insertAfter);

        if (replaceOp) {
          // Verify start boundary hash
          if (replaceOp.startHash !== "" && letters !== replaceOp.startHash) {
            return await fail(hashMismatchMsg(lineNumber, replaceOp.startHash, letters));
          }

          if (replaceOp.startLine === replaceOp.endLine) {
            // Single-line replace: handle immediately
            await writeReplaceOrOriginal(replaceOp, [lineBytes], [eolBytes]);

            await emitInserts(lineNumber);
          } else {
            // Multi-line replace: enter active replace mode
            activeReplace = replaceOp;
            activeReplaceOrigBytes = [lineBytes];
            activeReplaceOrigEols = [eolBytes];

            // The end hash and any insert_after at endLine are handled on reaching
            // endLine. validateEdits rejects inserts anywhere in a replace except
            // its endLine, so none share this start line.
          }
        } else {
          // No replace op — just write the line and process insert_after
          // Verify boundary hash for insert_after ops
          for (const iaOp of opsAtLine) {
            if (iaOp.startHash !== "" && letters !== iaOp.startHash) {
              return await fail(hashMismatchMsg(lineNumber, iaOp.startHash, letters));
            }
          }

          await enqueueLine(lineBytes, lineH, eolBytes.length > 0 ? eolBytes : undefined);
          if (collector) collector.context(lineBytes.toString(encoding));

          await emitInserts(lineNumber);
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
    return await fail(`stream read failed: ${(err as Error).message}`);
  }

  // ---- Post-stream: flush last line ----
  // The pending write pattern: the last line gets flushed with or without
  // EOL based on whether the original file had a trailing newline.
  try {
    if (pendingWrite !== null) {
      await writeBytes(encodeBuffer(pendingWrite, targetEncoding));
      // If the last source line had a non-empty eolBytes, the file had a trailing newline
      if (lastEolBytes.length > 0) {
        await writeBytes(encodeBuffer(detectedEol, targetEncoding));
      }
    }
  } catch (err) {
    return await fail(`flush last line failed: ${(err as Error).message}`);
  }

  // Flush remaining buffered bytes and close the file descriptor.
  try {
    await flushWriteBuf();
    try {
      // Only a temp file that will replace the original needs to be durable;
      // on macOS, Node's fsync (F_FULLFSYNC) costs ~5 ms even for tiny files.
      if (contentChanged && !dryRun) await fd.sync();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Swallow only filesystem-incompatibility codes (e.g. FAT, NFS, /proc);
      // data-integrity failures like EIO and ENOSPC must propagate so the outer
      // catch can clean up the temp file and surface the error to the caller.
      const ignorable = new Set(["EINVAL", "ENOTSUP", "ENOSYS", "ENOTTY"]);
      if (!code || !ignorable.has(code)) throw err;
    }
    await fd.close();
  } catch (err) {
    // EIO and ENOSPC reach here — the temp file was not fully written;
    // returning a structured error is safer than propagating an exception.
    return await fail(`flush/close failed: ${(err as Error).message}`);
  }

  // ---- Verify checksums ----
  for (const acc of csAccumulators) {
    const ref = acc.ref;

    // Skip empty-file sentinel
    if (ref.startLine === 0 && ref.endLine === 0) {
      if (totalLines !== 0) {
        return await fail(
          `Checksum mismatch: ref indicates an empty file but the file has ${totalLines} lines. Re-read with trueline_read.`,
        );
      }
      continue;
    }

    // Check if checksum range exceeds file length
    if (ref.endLine > totalLines) {
      return await fail(
        `Edit range ${ref.startLine}-${ref.endLine} exceeds file length (${totalLines} lines). ` +
          `The file may have been truncated since your last read. Re-read with trueline_read.`,
      );
    }

    const expected = ref.hash;
    const actual = checksumToLetters(acc.hash);
    if (actual !== expected) {
      await cleanupTmp();

      // If we reached post-stream checksum verification, all boundary
      // hashes passed during the stream.  That means the edit-target
      // lines are unchanged — only other lines in the checksum range
      // changed.  Suggest a narrow re-read of just the target lines.
      let minLine = Infinity;
      let maxLine = -Infinity;
      for (const op of ops) {
        if (op.startLine > 0) {
          minLine = Math.min(minLine, op.startLine);
          maxLine = Math.max(maxLine, op.endLine);
        }
      }

      const base =
        `${resolvedPath}: checksum mismatch for lines ${ref.startLine}\u2013${ref.endLine}. ` +
        `File changed since last read.` +
        `\n\nYour ref is stale \u2014 the file was modified after the ref was issued. ` +
        `Re-read with trueline_read to get a fresh ref. ` +
        `A wider ref from a prior read (covering more lines) is valid for editing any sub-range within it.`;

      const narrowHint =
        minLine === Infinity
          ? ""
          : `\n\n` +
            `However, lines ${minLine}\u2013${maxLine} appear unchanged. ` +
            `Re-read with trueline_read(file_paths=["${resolvedPath}:${minLine}-${maxLine}"]) ` +
            `to get a narrow checksum, then retry the edit.`;

      return { ok: false, error: base + narrowHint };
    }
  }

  const summary = {
    newLineCount: outputLineCount,
    newHash: checksumToLetters(outputChecksumAcc),
    newStartLetters: hashToLetters(outputFirstLineHash),
    newEndLetters: hashToLetters(outputLastLineHash),
  };

  // ---- No-op or dry run: skip write ----
  if (!contentChanged || dryRun) {
    await cleanupTmp();
    return { ok: true, ...summary, changed: contentChanged };
  }

  // ---- Atomic rename with mtime check ----
  let originalMode: number | undefined;
  try {
    const fileStat = await stat(resolvedPath);
    originalMode = fileStat.mode;
    if (fileStat.mtimeMs !== mtimeMs) {
      return await fail(
        "File was modified by another process during the edit. Your ref is stale. Re-read with trueline_read to get a fresh ref.",
      );
    }
  } catch (err: unknown) {
    // ENOENT means the file was deleted between validatePath and here —
    // proceed with rename so the edit still lands. Any other error
    // (EPERM, EIO, etc.) is unexpected and should not be silently ignored.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return await fail(`stat failed: ${(err as NodeJS.ErrnoException).message}`);
    }
  }

  try {
    // On win32, Node's chmod only toggles the read-only bit (0o200); all other
    // bits are silently ignored. Calling chmod when the file is already writable
    // is a no-op that can still trip ACL filters or AV hooks, so skip it.
    const skipChmod = process.platform === "win32" && originalMode !== undefined && (originalMode & 0o200) !== 0; // original was writable — chmod would be a no-op

    // On Windows, AV/Defender/indexers can briefly hold a handle on the temp
    // file or destination without FILE_SHARE_DELETE, causing rename() to fail
    // with EPERM/EACCES/EBUSY. Retry with exponential back-off before giving up.
    // Produce a human-readable error for rename failures.
    function formatRenameError(err: unknown, tmp: string, dest: string, attempts: number): Error {
      const errno = err as NodeJS.ErrnoException;
      const code = errno.code ?? "UNKNOWN";
      let hint = errno.message;
      if (process.platform === "win32") {
        if (code === "EPERM" || code === "EACCES") {
          hint =
            "likely antivirus, file indexer, or editor holding a handle without FILE_SHARE_DELETE; the file may also be read-only or on a permission-restricted volume";
        } else if (code === "EBUSY") {
          hint = "the destination is currently locked by another process (often an editor or watcher)";
        }
      }
      const retryNote =
        process.platform === "win32" && attempts > 0 ? `; retried ${attempts} times with backoff before failing` : "";
      return new Error(`${code}: rename '${tmp}' -> '${dest}': ${hint}${retryNote}`);
    }

    async function renameWithRetry(): Promise<void> {
      // Read the delay sequence from TRUELINE_RENAME_DELAYS_MS at call time so
      // tests can opt into zero-delay retries by setting the env var dynamically
      // (module-scope evaluation would miss changes made after import). An unset,
      // empty, or malformed value falls back to the production default silently.
      const rawDelays = process.env.TRUELINE_RENAME_DELAYS_MS;
      const parsed = rawDelays?.trim() ? rawDelays.split(",").map((s) => parseInt(s.trim(), 10)) : null;
      const delays: number[] = parsed?.every((n) => !Number.isNaN(n) && n >= 0) ? parsed : [10, 30, 100, 300, 1000];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        // Before each retry (not the first attempt — that's covered by the
        // pre-rename mtime check above), re-stat the destination to detect
        // external writes during the backoff sleep. A changed mtime means
        // another process modified the file; overwriting it silently would
        // corrupt their changes. ENOENT is tolerated: destination was deleted
        // between attempts, and rename() will recreate it.
        if (attempt > 0) {
          const currentStat = await stat(resolvedPath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          });
          if (currentStat && currentStat.mtimeMs !== mtimeMs) {
            throw new Error("File was modified by another process during retry backoff. Your ref is stale.");
          }
        }
        try {
          await rename(tmpPath, resolvedPath);
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (process.platform !== "win32" || !code || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
            throw formatRenameError(err, tmpPath, resolvedPath, 0); // non-retryable: wrong platform, or non-transient error code
          }
          lastErr = err;
          if (attempt < delays.length) {
            await new Promise<void>((r) => setTimeout(r, delays[attempt]));
          }
        }
      }
      // delays.length retries attempted (delays.length + 1 total attempts)
      throw formatRenameError(lastErr, tmpPath, resolvedPath, delays.length);
    }
    await renameWithRetry();
    // chmod the destination after a successful rename, not the temp file before.
    // Doing it beforehand made the temp read-only on win32 when the source was
    // read-only; a subsequent rename failure left cleanupTmp unable to unlink
    // the temp (EACCES), stranding it on disk.
    if (originalMode !== undefined && !skipChmod) {
      // Rename already committed the new content. A chmod failure must not
      // mask that success — surface it as a warning instead of failing.
      try {
        await chmod(resolvedPath, originalMode);
      } catch (chmodErr) {
        process.stderr.write(
          `[trueline-mcp] warning: failed to restore mode on ${resolvedPath}: ${(chmodErr as Error).message}\n`,
        );
      }
    }
  } catch (err) {
    // rename threw — formatRenameError already embedded full path/errno/AV hint.
    return await fail((err as Error).message);
  }

  return { ok: true, ...summary, changed: true };
}
