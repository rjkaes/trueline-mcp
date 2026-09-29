import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lineHash, rangeChecksum, writeTestFile } from "./helpers.ts";
import { type EditInput, validateEdits } from "../src/tools/shared.ts";
import { streamingEdit } from "../src/streaming-edit.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-stream-test-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});
/**
 * Issue a ref from a checksum string like "1-4/abcdef".
 * For validateEdits tests that don't use real files, filePath defaults to "test.txt".
 */
function refFromChecksum(checksum: string, _filePath = "test.txt"): string {
  // In stateless mode, the ref IS the inline checksum string
  return checksum;
}

describe("validateEdits", () => {
  test("accepts valid single replace edit", () => {
    const ref = refFromChecksum("1-4/abcdef");
    const result = validateEdits([{ ref, range: "ab2-cd3", content: "x\ny" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].startLine).toBe(2);
      expect(result.ops[0].endLine).toBe(3);
      expect(result.ops[0].startHash).toBe("ab");
      expect(result.ops[0].endHash).toBe("cd");
      expect(result.checksumRefs[0].startLine).toBe(1);
      expect(result.checksumRefs[0].endLine).toBe(4);
    }
  });

  test("accepts valid insert_after at line 0", () => {
    const ref = refFromChecksum("0-0/aaaaaa");
    const result = validateEdits([{ ref, range: "+0", content: "new" }]);
    expect(result.ok).toBe(true);
  });

  test("rejects line 0 without insert_after", () => {
    const ref = refFromChecksum("0-0/aaaaaa");
    const result = validateEdits([{ ref, range: "0", content: "x" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("insert-after");
    }
  });

  test("rejects ref that does not cover edit range", () => {
    const ref = refFromChecksum("1-2/abcdef");
    const result = validateEdits([{ ref, range: "ab4-ab4", content: "x" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("does not cover");
    }
  });

  test("rejects overlapping replace ranges", () => {
    const ref = refFromChecksum("1-4/abcdef");
    const result = validateEdits([
      { ref, range: "aa1-bb2", content: "A" },
      { ref, range: "bb2-bb2", content: "B" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("Overlapping");
    }
  });

  test("allows insert_after ops at same anchor (no overlap)", () => {
    const ref = refFromChecksum("1-4/abcdef");
    const result = validateEdits([
      { ref, range: "+aa1", content: "A" },
      { ref, range: "+aa1", content: "B" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
    }
  });

  test("rejects insert-after inside a replace range", () => {
    // Replace covers lines 2-4, insert-after at line 3 is ambiguous
    const ref = refFromChecksum("1-5/abcdef");
    const result = validateEdits([
      { ref, range: "aa2-bb4", content: "A\nB\nC" },
      { ref, range: "+cc3", content: "inserted" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("Insert-after at line 3 conflicts with replace range");
    }
  });

  test("allows insert-after at end of replace range (not inside)", () => {
    // Replace covers lines 2-4, insert-after at line 4 is at the boundary
    const ref = refFromChecksum("1-5/abcdef");
    const result = validateEdits([
      { ref, range: "aa2-bb4", content: "A\nB\nC" },
      { ref, range: "+bb4", content: "after replace" },
    ]);
    expect(result.ok).toBe(true);
  });
});

// ==============================================================================
// streamingEdit tests
// ==============================================================================

describe("streamingEdit", () => {
  // Helper to run streamingEdit with proper setup
  async function runEdit(filePath: string, edits: Omit<EditInput, "ref">[], checksum: string) {
    const { mtimeMs } = statSync(filePath);
    const ref = refFromChecksum(checksum, filePath);
    const editsWithRef = edits.map((e) => ({ ref, ...e }));
    const validated = validateEdits(editsWithRef);
    if (!validated.ok) throw new Error(`validateEdits failed: ${validated.error.content[0].text}`);
    return streamingEdit(filePath, validated.ops, validated.checksumRefs, mtimeMs);
  }

  // --------------------------------------------------------------------------
  // Task 4: Basic replace
  // --------------------------------------------------------------------------

  test("replaces a single line", async () => {
    const f = writeTestFile(testDir, "replace.txt", "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `${h2}2`, content: "replaced" }], cs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\nreplaced\nline 3\n");
  });

  test("replaces a range of lines", async () => {
    const f = writeTestFile(testDir, "range.txt", "line 1\nline 2\nline 3\nline 4\n");
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await runEdit(f, [{ range: `${h2}2-${h3}3`, content: "replaced 2\nreplaced 3" }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  test("deletes lines (empty replacement)", async () => {
    const f = writeTestFile(testDir, "delete.txt", "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `${h2}2`, content: "" }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\nline 3\n");
  });

  test("returns correct full-file checksum after edit", async () => {
    const f = writeTestFile(testDir, "checksum.txt", "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `${h2}2`, content: "replaced" }], cs);
    if (!result.ok) return;

    const newLines = ["line 1", "replaced", "line 3"];
    const { newStartLetters, newEndLetters, newLineCount, newHash } = result;
    expect(`${newStartLetters}1-${newEndLetters}${newLineCount}/${newHash}`).toBe(rangeChecksum(newLines, 1, 3));
  });

  // --------------------------------------------------------------------------
  // Task 5: insert_after
  // --------------------------------------------------------------------------

  test("inserts after a line", async () => {
    const f = writeTestFile(testDir, "insert.txt", "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");

    const result = await runEdit(f, [{ range: `+${h1}1`, content: "inserted" }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\ninserted\nline 2\nline 3\n");
  });

  test("multiple insert_after at same anchor preserves input order", async () => {
    const f = writeTestFile(testDir, "multi-insert.txt", "anchor\nnext\n");
    const lines = ["anchor", "next"];
    const cs = rangeChecksum(lines, 1, 2);
    const h = lineHash("anchor");

    const result = await runEdit(
      f,
      [
        { range: `+${h}1`, content: "first" },
        { range: `+${h}1`, content: "second" },
        { range: `+${h}1`, content: "third" },
      ],
      cs,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("anchor\nfirst\nsecond\nthird\nnext\n");
  });

  test("insert_after at line 0 (prepend to file)", async () => {
    const f = writeTestFile(testDir, "prepend.txt", "existing\n");
    const lines = ["existing"];
    const cs = rangeChecksum(lines, 1, 1);

    const result = await runEdit(f, [{ range: "+0", content: "prepended" }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("prepended\nexisting\n");
  });

  // --------------------------------------------------------------------------
  // Task 6: Multiple edits
  // --------------------------------------------------------------------------

  test("handles multiple replace edits", async () => {
    const f = writeTestFile(testDir, "multi-replace.txt", "line 1\nline 2\nline 3\nline 4\n");
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h1 = lineHash("line 1");
    const h4 = lineHash("line 4");

    const result = await runEdit(
      f,
      [
        { range: `${h1}1`, content: "A" },
        { range: `${h4}4`, content: "D" },
      ],
      cs,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("A\nline 2\nline 3\nD\n");
  });

  test("handles replace + insert_after in same batch", async () => {
    const f = writeTestFile(testDir, "mixed-ops.txt", "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");
    const h3 = lineHash("line 3");

    const result = await runEdit(
      f,
      [
        { range: `${h1}1`, content: "A" },
        { range: `+${h3}3`, content: "inserted" },
      ],
      cs,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("A\nline 2\nline 3\ninserted\n");
  });

  // --------------------------------------------------------------------------
  // Task 7: Checksum/hash verification
  // --------------------------------------------------------------------------

  test("rejects stale checksum", async () => {
    const f = writeTestFile(testDir, "stale.txt", "line 1\nline 2\nline 3\n");
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ ref: refFromChecksum("1-3/aaaaaa", f), range: "aa1-aa1", content: "nope" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mismatch");
  });

  test("rejects wrong line hash at boundary", async () => {
    const f = writeTestFile(testDir, "bad-hash.txt", "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ ref: refFromChecksum(cs, f), range: "zz1-zz1", content: "nope" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mismatch");
  });

  test("rejects checksum range exceeding file length", async () => {
    const f = writeTestFile(testDir, "short.txt", "only\n");
    const { mtimeMs } = statSync(f);
    const h = lineHash("only");

    const validated = validateEdits([{ ref: refFromChecksum("1-5/abcdef", f), range: `${h}1-${h}1`, content: "x" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exceeds");
  });

  // --------------------------------------------------------------------------
  // Task 8: Edge cases
  // --------------------------------------------------------------------------

  test("preserves CRLF line endings in replacements", async () => {
    const f = writeTestFile(testDir, "crlf.txt", "line 1\r\nline 2\r\nline 3\r\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `${h2}2`, content: "replaced" }], cs);
    expect(result.ok).toBe(true);
    const written = readFileSync(f, "utf-8");
    expect(written).toBe("line 1\r\nreplaced\r\nline 3\r\n");
    expect(written).not.toMatch(/(?<!\r)\n/);
  });

  test("preserves absence of trailing newline", async () => {
    const f = writeTestFile(testDir, "no-trail.txt", "line 1\nline 2");
    const lines = ["line 1", "line 2"];
    const cs = rangeChecksum(lines, 1, 2);
    const h1 = lineHash("line 1");

    const result = await runEdit(f, [{ range: `${h1}1`, content: "replaced" }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("replaced\nline 2");
  });

  test("rejects binary file", async () => {
    const f = join(testDir, "binary.bin");
    writeFileSync(f, Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]));
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ ref: refFromChecksum("1-1/abcdef", f), range: "aa1", content: "x" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("binary");
  });

  test("handles empty file with insert_after", async () => {
    const f = writeTestFile(testDir, "empty.txt", "");
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ ref: refFromChecksum("0-0/aaaaaa", f), range: "+0", content: "new content" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toContain("new content");
  });

  test("detects no-op and skips write", async () => {
    const f = writeTestFile(testDir, "noop.txt", "aaa\nbbb\nccc\n");
    const { mtimeMs: before } = statSync(f);
    const lines = ["aaa", "bbb", "ccc"];
    const cs = rangeChecksum(lines, 1, 3);

    const result = await runEdit(f, [{ range: `${lineHash("bbb")}2`, content: "bbb" }], cs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(false);
    expect(statSync(f).mtimeMs).toBe(before);
  });

  test("detects concurrent modification via mtime", async () => {
    const f = writeTestFile(testDir, "mtime.txt", "line 1\nline 2\n");
    const { mtimeMs: oldMtime } = statSync(f);

    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(f, "line 1\nline 2\n");
    const { mtimeMs: newMtime } = statSync(f);
    expect(newMtime).not.toBe(oldMtime);

    const lines = ["line 1", "line 2"];
    const cs = rangeChecksum(lines, 1, 2);
    const h1 = lineHash("line 1");

    const validated = validateEdits([{ ref: refFromChecksum(cs, f), range: `${h1}1`, content: "changed" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, oldMtime);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("modified by another process");
  });

  test("error messages include file path", async () => {
    const f = writeTestFile(testDir, "path-in-error.txt", "line 1\nline 2\n");
    const { mtimeMs } = statSync(f);

    // Wrong checksum to trigger a mismatch error
    const validated = validateEdits([{ ref: refFromChecksum("1-2/aaaaaa", f), range: "aa1-aa1", content: "x" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(f);
    }
  });

  test("binary detection error includes file path", async () => {
    const f = join(testDir, "binary-path.bin");
    writeFileSync(f, Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]));
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ ref: refFromChecksum("1-1/abcdef", f), range: "aa1", content: "x" }]);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRefs, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(f);
      expect(result.error).toContain("binary");
    }
  });
});
