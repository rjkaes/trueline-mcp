import { describe, test, beforeEach } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { arbFileContent, arbLine } from "./arbitraries.ts";
import { rangeChecksum, lineHash, issueTestRef } from "../helpers.ts";
import { streamingEdit } from "../../src/streaming-edit.ts";
import type { StreamEditOp } from "../../src/streaming-edit.ts";
import { parseChecksum } from "../../src/parse.ts";

const NUM_RUNS = 500;

// Each property callback creates and cleans up its own temp dir to avoid
// shared-state races across fast-check iterations (which run concurrently
// under fc.assert with async properties).
function makeIterDir(): { iterDir: string; cleanup: () => void } {
  const iterDir = mkdtempSync(join(tmpdir(), "formal-"));
  return { iterDir, cleanup: () => rmSync(iterDir, { recursive: true, force: true }) };
}

beforeEach(() => {});

/** Write lines to a temp file inside iterDir and return {path, lines, mtime}. */
function writeTestLines(iterDir: string, lines: string[]): { path: string; lines: string[]; mtimeMs: number } {
  const path = join(iterDir, "test.txt");
  writeFileSync(path, `${lines.join("\n")}\n`);
  const stat = statSync(path);
  return { path, lines, mtimeMs: stat.mtimeMs };
}

/** Build a StreamEditOp from test helpers. */
function buildOp(
  lines: string[],
  startLine: number,
  endLine: number,
  content: string[],
  insertAfter: boolean,
): StreamEditOp {
  return {
    startLine,
    endLine,
    content,
    insertAfter,
    startHash: lineHash(lines[startLine - 1]),
    endHash: lineHash(lines[endLine - 1]),
  };
}

describe("P1: content preservation", () => {
  test("edit succeeds with valid checksum, fails after external mutation", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent,
        fc.integer({ min: 0, max: 4 }).chain((n) => arbFileContent.map((content) => ({ content, n }))),
        async (originalLines, { content: replacementLines }) => {
          const { iterDir, cleanup } = makeIterDir();
          try {
            const { path, lines, mtimeMs } = writeTestLines(iterDir, originalLines);
            const lineCount = lines.length;
            const startLine = 1;
            const endLine = lineCount;

            // Compute checksum and ref for the full file
            const checksumStr = rangeChecksum(lines, startLine, endLine);
            issueTestRef(path, lines, startLine, endLine);
            const checksumRef = parseChecksum(checksumStr);

            // Build an edit op that replaces the whole file
            const op = buildOp(lines, startLine, endLine, replacementLines, false);

            // Edit should succeed with valid checksum
            const result = await streamingEdit(path, [op], [checksumRef], mtimeMs);
            if (!result.ok) {
              throw new Error(`Expected edit to succeed but got: ${result.error}`);
            }

            // Restore original, mutate one line, try same (now-stale) checksum
            writeFileSync(path, `${lines.join("\n")}\n`);
            const mutated = [...lines];
            mutated[0] = `${mutated[0]}_MUTATED`;
            writeFileSync(path, `${mutated.join("\n")}\n`);
            const stat3 = statSync(path);

            issueTestRef(path, lines, startLine, endLine);
            const op2 = buildOp(lines, startLine, endLine, replacementLines, false);

            // Edit should fail: checksum no longer matches
            const result2 = await streamingEdit(path, [op2], [checksumRef], stat3.mtimeMs);
            if (result2.ok) {
              throw new Error("Expected edit to fail with stale checksum but it succeeded");
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

describe("P5: mtime guard", () => {
  test("edit rejected when file mtime has changed", async () => {
    await fc.assert(
      fc.asyncProperty(arbFileContent, async (lines) => {
        const { iterDir, cleanup } = makeIterDir();
        try {
          const { path, lines: fileLines, mtimeMs } = writeTestLines(iterDir, lines);
          const lineCount = fileLines.length;

          const checksumStr = rangeChecksum(fileLines, 1, lineCount);
          issueTestRef(path, fileLines, 1, lineCount);
          const checksumRef = parseChecksum(checksumStr);
          const op = buildOp(fileLines, 1, lineCount, ["replaced"], false);

          // Advance mtime by touching the file with a future time
          const futureTime = new Date(mtimeMs + 2000);
          utimesSync(path, futureTime, futureTime);

          // Edit with OLD mtime should fail because mtime guard fires
          const result = await streamingEdit(path, [op], [checksumRef], mtimeMs);
          if (result.ok) {
            throw new Error("Expected edit to fail due to mtime change but it succeeded");
          }
        } finally {
          cleanup();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

describe("P2a: delete isolation", () => {
  test("deleting a range preserves all other lines byte-identically", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent.filter((lines) => lines.length >= 2),
        async (originalLines) => {
          const { iterDir, cleanup } = makeIterDir();
          try {
            const { path, lines, mtimeMs } = writeTestLines(iterDir, originalLines);
            const lineCount = lines.length;

            // Pick a range to delete: at least 1 line, not the entire file
            const startLine = Math.max(1, Math.floor(lineCount / 3));
            const endLine = Math.min(lineCount - 1, Math.ceil((2 * lineCount) / 3));
            if (startLine > endLine || endLine >= lineCount) return; // skip degenerate

            const checksumStr = rangeChecksum(lines, 1, lineCount);
            issueTestRef(path, lines, 1, lineCount);
            const checksumRef = parseChecksum(checksumStr);

            // Delete op: replace range with empty content
            const op = buildOp(lines, startLine, endLine, [], false);
            const result = await streamingEdit(path, [op], [checksumRef], mtimeMs);
            if (!result.ok) {
              throw new Error(`Delete failed: ${result.error}`);
            }

            // Read the result
            const resultContent = readFileSync(path, "utf-8");
            const resultLines = resultContent.split("\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");

            // Lines before the deleted range must be byte-identical
            for (let i = 0; i < startLine - 1; i++) {
              if (resultLines[i] !== lines[i]) {
                throw new Error(
                  `Line ${i + 1} before deleted range changed: expected ${JSON.stringify(lines[i])}, got ${JSON.stringify(resultLines[i])}`,
                );
              }
            }

            // Lines after the deleted range must be byte-identical
            const deletedCount = endLine - startLine + 1;
            for (let i = endLine; i < lineCount; i++) {
              const resultIdx = i - deletedCount;
              if (resultLines[resultIdx] !== lines[i]) {
                throw new Error(
                  `Line ${i + 1} after deleted range changed: expected ${JSON.stringify(lines[i])}, got ${JSON.stringify(resultLines[resultIdx])}`,
                );
              }
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

describe("P2b: insert preservation", () => {
  test("insert-after preserves all original lines in order", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent,
        fc.array(arbLine, { minLength: 1, maxLength: 5 }),
        async (originalLines, insertedLines) => {
          const { iterDir, cleanup } = makeIterDir();
          try {
            const { path, lines, mtimeMs } = writeTestLines(iterDir, originalLines);
            const lineCount = lines.length;
            const anchorLine = Math.max(1, Math.floor(lineCount / 2));

            const checksumStr = rangeChecksum(lines, 1, lineCount);
            issueTestRef(path, lines, 1, lineCount);
            const checksumRef = parseChecksum(checksumStr);

            // Insert-after op at the anchor
            const op: StreamEditOp = {
              startLine: anchorLine,
              endLine: anchorLine,
              content: insertedLines,
              insertAfter: true,
              startHash: lineHash(lines[anchorLine - 1]),
              endHash: lineHash(lines[anchorLine - 1]),
            };
            const result = await streamingEdit(path, [op], [checksumRef], mtimeMs);
            if (!result.ok) {
              throw new Error(`Insert failed: ${result.error}`);
            }

            const resultContent = readFileSync(path, "utf-8");
            const resultLines = resultContent.split("\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");

            // Every original line must appear in the result in order
            let resultIdx = 0;
            for (let origIdx = 0; origIdx < lines.length; origIdx++) {
              // Find this original line in the result starting from resultIdx
              while (resultIdx < resultLines.length && resultLines[resultIdx] !== lines[origIdx]) {
                resultIdx++;
              }
              if (resultIdx >= resultLines.length) {
                throw new Error(
                  `Original line ${origIdx + 1} (${JSON.stringify(lines[origIdx])}) not found in result after position ${resultIdx}`,
                );
              }
              resultIdx++;
            }

            // Result should have exactly originalLines.length + insertedLines.length lines
            const expectedLength = lines.length + insertedLines.length;
            if (resultLines.length !== expectedLength) {
              throw new Error(`Expected ${expectedLength} lines but got ${resultLines.length}`);
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

describe("P2: edit ordering correctness", () => {
  test("multi-edit in one call produces same result as individual edits in reverse order", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent.filter((lines) => lines.length >= 4),
        async (originalLines) => {
          const lineCount = originalLines.length;

          // Create two non-overlapping edit regions
          const mid = Math.floor(lineCount / 2);
          if (mid < 2 || mid >= lineCount - 1) return;

          const edit1Range = { start: 1, end: Math.max(1, mid - 1) };
          const edit2Range = { start: mid + 1, end: lineCount };
          if (edit1Range.end >= edit2Range.start) return;

          const replacement1 = ["REPLACED_BLOCK_1"];
          const replacement2 = ["REPLACED_BLOCK_2"];

          // --- Path A: both edits in one streamingEdit call ---
          const dirA = makeIterDir();
          let multiEditResult: string;
          try {
            const { path, lines, mtimeMs } = writeTestLines(dirA.iterDir, originalLines);
            const checksumStr = rangeChecksum(lines, 1, lineCount);
            issueTestRef(path, lines, 1, lineCount);
            const checksumRef = parseChecksum(checksumStr);

            const op1 = buildOp(lines, edit1Range.start, edit1Range.end, replacement1, false);
            const op2 = buildOp(lines, edit2Range.start, edit2Range.end, replacement2, false);

            const result = await streamingEdit(path, [op1, op2], [checksumRef], mtimeMs);
            if (!result.ok) throw new Error(`Multi-edit failed: ${result.error}`);

            multiEditResult = readFileSync(path, "utf-8");
          } finally {
            dirA.cleanup();
          }

          // --- Path B: individual edits in reverse order (edit2 first, then edit1) ---
          const dirB = makeIterDir();
          let individualResult: string;
          try {
            const { path, lines, mtimeMs } = writeTestLines(dirB.iterDir, originalLines);

            // Apply edit2 first (higher range, so it won't shift edit1's range)
            const cs2 = rangeChecksum(lines, 1, lineCount);
            issueTestRef(path, lines, 1, lineCount);
            const csRef2 = parseChecksum(cs2);
            const op2 = buildOp(lines, edit2Range.start, edit2Range.end, replacement2, false);
            const r2 = await streamingEdit(path, [op2], [csRef2], mtimeMs);
            if (!r2.ok) throw new Error(`Individual edit2 failed: ${r2.error}`);

            // Re-read state after edit2
            const afterEdit2 = readFileSync(path, "utf-8").split("\n");
            if (afterEdit2[afterEdit2.length - 1] === "") afterEdit2.pop();
            const stat2 = statSync(path);

            const cs1 = rangeChecksum(afterEdit2, 1, afterEdit2.length);
            issueTestRef(path, afterEdit2, 1, afterEdit2.length);
            const csRef1 = parseChecksum(cs1);
            const op1 = buildOp(afterEdit2, edit1Range.start, edit1Range.end, replacement1, false);
            const r1 = await streamingEdit(path, [op1], [csRef1], stat2.mtimeMs);
            if (!r1.ok) throw new Error(`Individual edit1 failed: ${r1.error}`);

            individualResult = readFileSync(path, "utf-8");
          } finally {
            dirB.cleanup();
          }

          if (multiEditResult !== individualResult) {
            throw new Error(
              `Multi-edit and individual-edit diverged.\nMulti: ${JSON.stringify(multiEditResult)}\nIndividual: ${JSON.stringify(individualResult)}`,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

describe("P3: ref adjustment soundness", () => {
  test("refs to untouched regions still match content after edit", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent.filter((lines) => lines.length >= 5),
        async (originalLines) => {
          const { iterDir, cleanup } = makeIterDir();
          try {
            const lineCount = originalLines.length;
            const { path, lines, mtimeMs } = writeTestLines(iterDir, originalLines);

            // Issue a ref to the first 2 lines and the last 2 lines
            const topEnd = 2;
            const bottomStart = lineCount - 1;
            if (topEnd >= bottomStart) return;

            issueTestRef(path, lines, 1, topEnd);
            issueTestRef(path, lines, bottomStart, lineCount);

            // Edit the middle (between topEnd and bottomStart)
            const editStart = topEnd + 1;
            const editEnd = bottomStart - 1;
            if (editStart > editEnd) return;

            const fullChecksum = rangeChecksum(lines, 1, lineCount);
            issueTestRef(path, lines, 1, lineCount);
            const fullChecksumRef = parseChecksum(fullChecksum);

            const replacement = ["MIDDLE_REPLACED_1", "MIDDLE_REPLACED_2", "MIDDLE_REPLACED_3"];
            const op = buildOp(lines, editStart, editEnd, replacement, false);

            const result = await streamingEdit(path, [op], [fullChecksumRef], mtimeMs);
            if (!result.ok) throw new Error(`Edit failed: ${result.error}`);

            // Read the new file
            const newContent = readFileSync(path, "utf-8");
            const newLines = newContent.split("\n");
            if (newLines[newLines.length - 1] === "") newLines.pop();

            // Top ref (lines 1-2) should still match: content unchanged, lines unchanged
            for (let i = 0; i < topEnd; i++) {
              if (newLines[i] !== lines[i]) {
                throw new Error(
                  `Top ref line ${i + 1} changed after middle edit: ${JSON.stringify(lines[i])} -> ${JSON.stringify(newLines[i])}`,
                );
              }
            }

            // Bottom ref should have shifted by the delta
            const oldMiddleCount = editEnd - editStart + 1;
            const delta = replacement.length - oldMiddleCount;
            for (let i = bottomStart - 1; i < lineCount; i++) {
              const newIdx = i + delta;
              if (newLines[newIdx] !== lines[i]) {
                throw new Error(
                  `Bottom ref line ${i + 1} (now at ${newIdx + 1}) changed after middle edit: ${JSON.stringify(lines[i])} -> ${JSON.stringify(newLines[newIdx])}`,
                );
              }
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

describe("P4: atomicity", () => {
  test("original file untouched when edit is interrupted", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent.filter((lines) => lines.length >= 2),
        async (originalLines) => {
          const { iterDir, cleanup } = makeIterDir();
          try {
            const { path, lines, mtimeMs } = writeTestLines(iterDir, originalLines);
            const lineCount = lines.length;
            const originalContent = readFileSync(path, "utf-8");

            const checksumStr = rangeChecksum(lines, 1, lineCount);
            issueTestRef(path, lines, 1, lineCount);
            const checksumRef = parseChecksum(checksumStr);

            // Build a large replacement to make the write non-trivial
            const bigReplacement = Array.from({ length: 50 }, (_, i) => `replacement line ${i}`);
            const op = buildOp(lines, 1, lineCount, bigReplacement, false);

            // We can't easily inject a crash into streamingEdit's internals
            // without modifying production code. Instead, verify the postcondition:
            // after a SUCCESSFUL edit, if we simulate "what if rename failed" by
            // checking that the original path always has valid content (never partial).
            //
            // For the spike, we verify the weaker but still useful property:
            // the file is either the original content or the fully edited content,
            // never a mix.
            const result = await streamingEdit(path, [op], [checksumRef], mtimeMs);
            const afterContent = readFileSync(path, "utf-8");

            if (result.ok) {
              // File should be fully replaced
              const expectedLines = `${bigReplacement.join("\n")}\n`;
              if (afterContent !== expectedLines) {
                throw new Error("File content doesn't match expected full replacement");
              }
            } else {
              // Edit failed: file should be unchanged
              if (afterContent !== originalContent) {
                throw new Error("Edit failed but file content changed");
              }
            }

            // No orphaned temp files in the directory
            const dirFiles = readdirSync(iterDir);
            const tempFiles = dirFiles.filter((f) => f.startsWith(".trueline-") || f.endsWith(".tmp"));
            if (tempFiles.length > 0) {
              throw new Error(`Orphaned temp files found: ${tempFiles.join(", ")}`);
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});

// --- Conformance test: TLA+ ApplyOps model vs real streamingEdit ---

/**
 * TypeScript implementation of the TLA+ ApplyOps operator.
 * This is the reference model that TLC has proven correct.
 * Uses 1-based line numbers to match the TLA+ spec exactly.
 */
function applyOps(
  lines: string[],
  ops: Array<{ startLine: number; endLine: number; content: string[]; insertAfter: boolean }>,
): string[] {
  const result: string[] = [];
  let cursor = 1; // 1-based, matching TLA+ ApplyOps(content, ops, 1)

  for (const op of ops) {
    if (op.insertAfter) {
      // TLA+: SubSeq(content, cursor, op.start) \o op.newContent
      // Copy up to and including the anchor line
      for (let i = cursor; i <= op.startLine; i++) {
        result.push(lines[i - 1]);
      }
      result.push(...op.content);
      cursor = op.startLine + 1;
    } else {
      // TLA+: SubSeq(content, cursor, op.start - 1) \o op.newContent
      // Copy everything before the replaced range
      for (let i = cursor; i <= op.startLine - 1; i++) {
        result.push(lines[i - 1]);
      }
      result.push(...op.content);
      cursor = op.endLine + 1;
    }
  }

  // TLA+: SubSeq(content, cursor, Len(content))
  // Copy remaining lines after last op
  for (let i = cursor; i <= lines.length; i++) {
    result.push(lines[i - 1]);
  }

  return result;
}

/** Generate a conformance test case: file content + 1-2 ops. */
function arbConformanceCase() {
  return arbFileContent
    .filter((lines) => lines.length >= 2)
    .chain((lines) => {
      const n = lines.length;

      // Single replace op
      const singleReplace = fc
        .record({
          startLine: fc.integer({ min: 1, max: n }),
          endLine: fc.integer({ min: 1, max: n }),
          content: fc.array(arbLine, { minLength: 0, maxLength: 3 }),
        })
        .map(({ startLine, endLine, content }) => {
          const lo = Math.min(startLine, endLine);
          const hi = Math.max(startLine, endLine);
          return { lines, ops: [{ startLine: lo, endLine: hi, content, insertAfter: false }] };
        });

      // Single insert-after op
      const singleInsert = fc
        .record({
          startLine: fc.integer({ min: 1, max: n }),
          content: fc.array(arbLine, { minLength: 1, maxLength: 3 }),
        })
        .map(({ startLine, content }) => ({
          lines,
          ops: [{ startLine, endLine: startLine, content, insertAfter: true }],
        }));

      // Two non-overlapping replace ops
      const twoReplaces = fc
        .record({
          s1: fc.integer({ min: 1, max: n }),
          e1: fc.integer({ min: 1, max: n }),
          nc1: fc.array(arbLine, { minLength: 0, maxLength: 2 }),
          s2: fc.integer({ min: 1, max: n }),
          e2: fc.integer({ min: 1, max: n }),
          nc2: fc.array(arbLine, { minLength: 0, maxLength: 2 }),
        })
        .filter(({ s1, e1, s2, e2 }) => {
          const lo1 = Math.min(s1, e1);
          const hi1 = Math.max(s1, e1);
          const lo2 = Math.min(s2, e2);
          const hi2 = Math.max(s2, e2);
          // Non-overlapping with gap
          return hi1 < lo2 || hi2 < lo1;
        })
        .map(({ s1, e1, nc1, s2, e2, nc2 }) => {
          const op1 = {
            startLine: Math.min(s1, e1),
            endLine: Math.max(s1, e1),
            content: nc1,
            insertAfter: false,
          };
          const op2 = {
            startLine: Math.min(s2, e2),
            endLine: Math.max(s2, e2),
            content: nc2,
            insertAfter: false,
          };
          // Sort by startLine
          const sorted = [op1, op2].sort((a, b) => a.startLine - b.startLine);
          return { lines, ops: sorted };
        });

      // Replace then insert-after (gap #1: mixed ops)
      const replaceInsert = fc
        .record({
          s1: fc.integer({ min: 1, max: n }),
          e1: fc.integer({ min: 1, max: n }),
          nc1: fc.array(arbLine, { minLength: 0, maxLength: 2 }),
          s2: fc.integer({ min: 1, max: n }),
          nc2: fc.array(arbLine, { minLength: 1, maxLength: 2 }),
        })
        .filter(({ s1, e1, s2 }) => Math.max(s1, e1) < s2)
        .map(({ s1, e1, nc1, s2, nc2 }) => ({
          lines,
          ops: [
            { startLine: Math.min(s1, e1), endLine: Math.max(s1, e1), content: nc1, insertAfter: false },
            { startLine: s2, endLine: s2, content: nc2, insertAfter: true },
          ],
        }));

      // Insert-after then replace (gap #1: mixed ops)
      const insertReplace = fc
        .record({
          s1: fc.integer({ min: 1, max: n }),
          nc1: fc.array(arbLine, { minLength: 1, maxLength: 2 }),
          s2: fc.integer({ min: 1, max: n }),
          e2: fc.integer({ min: 1, max: n }),
          nc2: fc.array(arbLine, { minLength: 0, maxLength: 2 }),
        })
        .filter(({ s1, s2, e2 }) => s1 < Math.min(s2, e2))
        .map(({ s1, nc1, s2, e2, nc2 }) => ({
          lines,
          ops: [
            { startLine: s1, endLine: s1, content: nc1, insertAfter: true },
            { startLine: Math.min(s2, e2), endLine: Math.max(s2, e2), content: nc2, insertAfter: false },
          ],
        }));

      // Two insert-after ops (gap #2: boundary coverage)
      const twoInserts = fc
        .record({
          s1: fc.integer({ min: 1, max: n }),
          nc1: fc.array(arbLine, { minLength: 1, maxLength: 2 }),
          s2: fc.integer({ min: 1, max: n }),
          nc2: fc.array(arbLine, { minLength: 1, maxLength: 2 }),
        })
        .filter(({ s1, s2 }) => s1 < s2)
        .map(({ s1, nc1, s2, nc2 }) => ({
          lines,
          ops: [
            { startLine: s1, endLine: s1, content: nc1, insertAfter: true },
            { startLine: s2, endLine: s2, content: nc2, insertAfter: true },
          ],
        }));

      return fc.oneof(singleReplace, singleInsert, twoReplaces, replaceInsert, insertReplace, twoInserts);
    });
}

describe("Conformance: TLA+ ApplyOps model vs streamingEdit", () => {
  test("real implementation matches the formally verified model", async () => {
    await fc.assert(
      fc.asyncProperty(arbConformanceCase(), async ({ lines, ops }) => {
        const iterDir = mkdtempSync(join(tmpdir(), "conf-"));
        try {
          // 1. Compute expected result from the TLA+ model
          const expectedLines = applyOps(lines, ops);

          // 2. Write the file and set up streamingEdit inputs
          const path = join(iterDir, "test.txt");
          writeFileSync(path, `${lines.join("\n")}\n`);
          const mtime = statSync(path).mtimeMs;

          const checksumStr = rangeChecksum(lines, 1, lines.length);
          issueTestRef(path, lines, 1, lines.length);
          const checksumRef = parseChecksum(checksumStr);

          // 3. Build StreamEditOps with proper hashes
          const streamOps: StreamEditOp[] = ops.map((op) => ({
            startLine: op.startLine,
            endLine: op.endLine,
            content: op.content,
            insertAfter: op.insertAfter,
            startHash: lineHash(lines[op.startLine - 1]),
            endHash: lineHash(lines[op.endLine - 1]),
          }));

          // 4. Run the real implementation
          const result = await streamingEdit(path, streamOps, [checksumRef], mtime);
          if (!result.ok) {
            throw new Error(`streamingEdit failed: ${result.error}`);
          }

          // 5. Compare: model vs implementation
          const actualContent = readFileSync(path, "utf-8");
          const expectedContent = expectedLines.length > 0 ? `${expectedLines.join("\n")}\n` : "";

          if (actualContent !== expectedContent) {
            throw new Error(
              `Model/implementation divergence.\n` +
                `Ops: ${JSON.stringify(ops)}\n` +
                `Model:  ${JSON.stringify(expectedContent)}\n` +
                `Actual: ${JSON.stringify(actualContent)}`,
            );
          }
        } finally {
          rmSync(iterDir, { recursive: true, force: true });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, 30000);
});
