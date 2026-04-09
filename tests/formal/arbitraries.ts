import fc from "fast-check";

// --- File content ---

/** A single realistic line: 1-120 chars, no newlines. */
export const arbLine = fc.stringMatching(/^[^\n\r]{1,120}$/).filter((s) => s.length >= 1);

/** A file as an array of lines (1-20 lines). */
export const arbFileContent = fc.array(arbLine, { minLength: 1, maxLength: 20 });

// --- Edit operations ---

export interface TestEditOp {
  startLine: number;
  endLine: number;
  content: string[];
  insertAfter: boolean;
}

/**
 * Generate a single valid edit op for a file of `lineCount` lines.
 * `startLine` and `endLine` are 1-based, inclusive.
 */
export function arbEditOp(lineCount: number): fc.Arbitrary<TestEditOp> {
  return fc
    .record({
      startLine: fc.integer({ min: 1, max: lineCount }),
      endLine: fc.integer({ min: 1, max: lineCount }),
      replacementLines: fc.array(arbLine, { minLength: 0, maxLength: 5 }),
      insertAfter: fc.boolean(),
    })
    .map(({ startLine, endLine, replacementLines, insertAfter }) => {
      // Normalize: startLine <= endLine for replace ops
      const lo = Math.min(startLine, endLine);
      const hi = Math.max(startLine, endLine);
      if (insertAfter) {
        // insert-after uses a single anchor line
        return { startLine: lo, endLine: lo, content: replacementLines, insertAfter: true };
      }
      return { startLine: lo, endLine: hi, content: replacementLines, insertAfter: false };
    });
}

/**
 * Generate 1-3 non-overlapping edit ops for a file of `lineCount` lines.
 * All ops are replace (not insert-after) to simplify overlap checking.
 */
export function arbNonOverlappingEdits(lineCount: number): fc.Arbitrary<TestEditOp[]> {
  return fc
    .array(arbEditOp(lineCount), { minLength: 1, maxLength: 3 })
    .map((ops) => {
      // Filter to non-insert-after, then remove overlaps greedily
      const replaces = ops.filter((op) => !op.insertAfter);
      const sorted = [...replaces].sort((a, b) => a.startLine - b.startLine);
      const result: TestEditOp[] = [];
      let lastEnd = 0;
      for (const op of sorted) {
        if (op.startLine > lastEnd) {
          result.push(op);
          lastEnd = op.endLine;
        }
      }
      return result;
    })
    .filter((ops) => ops.length > 0);
}

/**
 * Generate an external mutation: change one line's content.
 */
export function arbExternalMutation(lineCount: number): fc.Arbitrary<{ lineIndex: number; newContent: string }> {
  return fc.record({
    lineIndex: fc.integer({ min: 0, max: lineCount - 1 }),
    newContent: arbLine,
  });
}
