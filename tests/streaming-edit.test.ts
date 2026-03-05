import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fnv1aHash, FNV_OFFSET_BASIS } from "../src/hash.ts";
import { lineHash, rangeChecksum } from "./helpers.ts";
import { validateEdits } from "../src/tools/shared.ts";
import { streamingEdit } from "../src/streaming-edit.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-stream-test-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("validateEdits", () => {
  test("accepts valid single replace edit", () => {
    const result = validateEdits([{ range: "2:ab..3:cd", content: ["x", "y"] }], "1-4:abcdef01");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].startLine).toBe(2);
      expect(result.ops[0].endLine).toBe(3);
      expect(result.ops[0].startHash).toBe("ab");
      expect(result.ops[0].endHash).toBe("cd");
      expect(result.checksumRef.startLine).toBe(1);
      expect(result.checksumRef.endLine).toBe(4);
    }
  });

  test("accepts valid insert_after at line 0", () => {
    const result = validateEdits([{ range: "+0:", content: ["new"] }], "0-0:00000000");
    expect(result.ok).toBe(true);
  });

  test("rejects line 0 without insert_after", () => {
    const result = validateEdits([{ range: "0:", content: ["x"] }], "0-0:00000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("insert-after (use +0: prefix)");
    }
  });

  test("rejects checksum that does not cover edit range", () => {
    const result = validateEdits([{ range: "4:ab..4:ab", content: ["x"] }], "1-2:abcdef01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("does not cover");
    }
  });

  test("rejects overlapping replace ranges", () => {
    const result = validateEdits(
      [
        { range: "1:aa..2:bb", content: ["A"] },
        { range: "2:bb..2:bb", content: ["B"] },
      ],
      "1-4:abcdef01",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.content[0].text).toContain("Overlapping");
    }
  });

  test("allows insert_after ops at same anchor (no overlap)", () => {
    const result = validateEdits(
      [
        { range: "+1:aa", content: ["A"] },
        { range: "+1:aa", content: ["B"] },
      ],
      "1-4:abcdef01",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
    }
  });
});

// ==============================================================================
// streamingEdit tests
// ==============================================================================

describe("streamingEdit", () => {
  // Helper to run streamingEdit with proper setup
  async function runEdit(filePath: string, edits: any[], checksum: string) {
    const { mtimeMs } = statSync(filePath);
    const validated = validateEdits(edits, checksum);
    if (!validated.ok) throw new Error("validateEdits failed: " + validated.error.content[0].text);
    return streamingEdit(filePath, validated.ops, validated.checksumRef, mtimeMs);
  }

  // --------------------------------------------------------------------------
  // Task 4: Basic replace
  // --------------------------------------------------------------------------

  test("replaces a single line", async () => {
    const f = join(testDir, "replace.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `2:${h2}`, content: ["replaced"] }], cs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\nreplaced\nline 3\n");
  });

  test("replaces a range of lines", async () => {
    const f = join(testDir, "range.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\nline 4\n");
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await runEdit(f, [{ range: `2:${h2}..3:${h3}`, content: ["replaced 2", "replaced 3"] }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  test("deletes lines (empty replacement)", async () => {
    const f = join(testDir, "delete.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `2:${h2}`, content: [] }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\nline 3\n");
  });

  test("returns correct full-file checksum after edit", async () => {
    const f = join(testDir, "checksum.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `2:${h2}`, content: ["replaced"] }], cs);
    if (!result.ok) return;

    const newLines = ["line 1", "replaced", "line 3"];
    const expectedCs = rangeChecksum(newLines, 1, 3);
    expect(result.newChecksum).toBe(expectedCs);
  });

  // --------------------------------------------------------------------------
  // Task 5: insert_after
  // --------------------------------------------------------------------------

  test("inserts after a line", async () => {
    const f = join(testDir, "insert.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");

    const result = await runEdit(f, [{ range: `+1:${h1}`, content: ["inserted"] }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("line 1\ninserted\nline 2\nline 3\n");
  });

  test("multiple insert_after at same anchor preserves input order", async () => {
    const f = join(testDir, "multi-insert.txt");
    writeFileSync(f, "anchor\nnext\n");
    const lines = ["anchor", "next"];
    const cs = rangeChecksum(lines, 1, 2);
    const h = lineHash("anchor");

    const result = await runEdit(
      f,
      [
        { range: `+1:${h}`, content: ["first"] },
        { range: `+1:${h}`, content: ["second"] },
        { range: `+1:${h}`, content: ["third"] },
      ],
      cs,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("anchor\nfirst\nsecond\nthird\nnext\n");
  });

  test("insert_after at line 0 (prepend to file)", async () => {
    const f = join(testDir, "prepend.txt");
    writeFileSync(f, "existing\n");
    const lines = ["existing"];
    const cs = rangeChecksum(lines, 1, 1);

    const result = await runEdit(f, [{ range: "+0:", content: ["prepended"] }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("prepended\nexisting\n");
  });

  // --------------------------------------------------------------------------
  // Task 6: Multiple edits
  // --------------------------------------------------------------------------

  test("handles multiple replace edits", async () => {
    const f = join(testDir, "multi-replace.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\nline 4\n");
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const cs = rangeChecksum(lines, 1, 4);
    const h1 = lineHash("line 1");
    const h4 = lineHash("line 4");

    const result = await runEdit(
      f,
      [
        { range: `1:${h1}`, content: ["A"] },
        { range: `4:${h4}`, content: ["D"] },
      ],
      cs,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("A\nline 2\nline 3\nD\n");
  });

  test("handles replace + insert_after in same batch", async () => {
    const f = join(testDir, "mixed-ops.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");
    const h3 = lineHash("line 3");

    const result = await runEdit(
      f,
      [
        { range: `1:${h1}`, content: ["A"] },
        { range: `+3:${h3}`, content: ["inserted"] },
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
    const f = join(testDir, "stale.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ range: "1:aa..1:aa", content: ["nope"] }], "1-3:00000000");
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRef, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mismatch");
  });

  test("rejects wrong line hash at boundary", async () => {
    const f = join(testDir, "bad-hash.txt");
    writeFileSync(f, "line 1\nline 2\nline 3\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ range: "1:zz..1:zz", content: ["nope"] }], cs);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRef, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mismatch");
  });

  test("rejects checksum range exceeding file length", async () => {
    const f = join(testDir, "short.txt");
    writeFileSync(f, "only\n");
    const { mtimeMs } = statSync(f);
    const h = lineHash("only");

    const validated = validateEdits([{ range: `1:${h}..1:${h}`, content: ["x"] }], "1-5:abcdef01");
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRef, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exceeds");
  });

  // --------------------------------------------------------------------------
  // Task 8: Edge cases
  // --------------------------------------------------------------------------

  test("preserves CRLF line endings in replacements", async () => {
    const f = join(testDir, "crlf.txt");
    writeFileSync(f, "line 1\r\nline 2\r\nline 3\r\n");
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await runEdit(f, [{ range: `2:${h2}`, content: ["replaced"] }], cs);
    expect(result.ok).toBe(true);
    const written = readFileSync(f, "utf-8");
    expect(written).toBe("line 1\r\nreplaced\r\nline 3\r\n");
    expect(written).not.toMatch(/(?<!\r)\n/);
  });

  test("preserves absence of trailing newline", async () => {
    const f = join(testDir, "no-trail.txt");
    writeFileSync(f, "line 1\nline 2");
    const lines = ["line 1", "line 2"];
    const cs = rangeChecksum(lines, 1, 2);
    const h1 = lineHash("line 1");

    const result = await runEdit(f, [{ range: `1:${h1}`, content: ["replaced"] }], cs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("replaced\nline 2");
  });

  test("rejects binary file", async () => {
    const f = join(testDir, "binary.bin");
    writeFileSync(f, Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]));
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ range: "1:aa", content: ["x"] }], "1-1:abcdef01");
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRef, mtimeMs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("binary");
  });

  test("handles empty file with insert_after", async () => {
    const f = join(testDir, "empty.txt");
    writeFileSync(f, "");
    const { mtimeMs } = statSync(f);

    const validated = validateEdits([{ range: "+0:", content: ["new content"] }], "0-0:00000000");
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRef, mtimeMs);
    expect(result.ok).toBe(true);
    expect(readFileSync(f, "utf-8")).toContain("new content");
  });

  test("detects no-op and skips write", async () => {
    const f = join(testDir, "noop.txt");
    writeFileSync(f, "aaa\nbbb\nccc\n");
    const { mtimeMs: before } = statSync(f);
    const lines = ["aaa", "bbb", "ccc"];
    const cs = rangeChecksum(lines, 1, 3);

    const result = await runEdit(f, [{ range: `2:${lineHash("bbb")}`, content: ["bbb"] }], cs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(false);
    expect(statSync(f).mtimeMs).toBe(before);
  });

  test("detects concurrent modification via mtime", async () => {
    const f = join(testDir, "mtime.txt");
    writeFileSync(f, "line 1\nline 2\n");
    const { mtimeMs: oldMtime } = statSync(f);

    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(f, "line 1\nline 2\n");
    const { mtimeMs: newMtime } = statSync(f);
    expect(newMtime).not.toBe(oldMtime);

    const lines = ["line 1", "line 2"];
    const cs = rangeChecksum(lines, 1, 2);
    const h1 = lineHash("line 1");

    const validated = validateEdits([{ range: `1:${h1}`, content: ["changed"] }], cs);
    if (!validated.ok) return;

    const result = await streamingEdit(f, validated.ops, validated.checksumRef, oldMtime);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("modified by another process");
  });
});
