import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { handleRead } from "../../src/tools/read.ts";
import { rangeChecksum } from "../helpers.ts";
import { EMPTY_FILE_CHECKSUM } from "../../src/hash.ts";

// =============================================================================
// Shared fixture setup
// =============================================================================

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-proto-edge-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function setupFile(name: string, content: string) {
  const f = join(testDir, name);
  writeFileSync(f, content);
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const cs = lines.length > 0 ? rangeChecksum(lines, 1, lines.length) : EMPTY_FILE_CHECKSUM;
  return { path: f, lines, cs };
}

function edit(opts: { file_path: string; edits: { checksum: string; range: string; content: string }[] }) {
  return handleEdit({ ...opts, projectDir: testDir });
}

// =============================================================================
// Range format parsing
// =============================================================================

describe("range format parsing", () => {
  test("single-line shorthand (no dash)", async () => {
    const { path, cs } = setupFile("single.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "BBB" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
  });

  test("explicit single-line range (N:hash-N:hash)", async () => {
    const { path, cs } = setupFile("explicit.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2-2`, content: "BBB" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nBBB\nccc\n");
  });

  test("rejects malformed range — trailing colon", async () => {
    const { path, cs } = setupFile("bad.txt", "aaa\nbbb\n");

    await expect(
      edit({
        file_path: path,
        edits: [{ checksum: cs, range: "1:", content: "x" }],
      }),
    ).rejects.toThrow();
  });

  test("rejects malformed range — non-numeric line number", async () => {
    const { path, cs } = setupFile("bad2.txt", "aaa\nbbb\n");

    await expect(
      edit({
        file_path: path,
        edits: [{ checksum: cs, range: "abc-2", content: "x" }],
      }),
    ).rejects.toThrow();
  });

  test("rejects range where start > end", async () => {
    const { path, cs } = setupFile("rev.txt", "aaa\nbbb\nccc\n");

    await expect(
      edit({
        file_path: path,
        edits: [{ checksum: cs, range: `3-1`, content: "x" }],
      }),
    ).rejects.toThrow();
  });

  test("rejects line 0 without + prefix", async () => {
    const { path, cs } = setupFile("zero.txt", "aaa\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: "0-0", content: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("insert-after");
  });

  test("+0 prefix for prepend", async () => {
    const { path, cs } = setupFile("prepend.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: "+0", content: "header" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("header\naaa\nbbb\n");
  });

  test("rejects edit targeting line beyond EOF", async () => {
    const { path, cs } = setupFile("short.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `99-99`, content: "x" }],
    });

    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// Insert-after (+) semantics
// =============================================================================

describe("insert-after (+) semantics", () => {
  test("insert after the very last line", async () => {
    const { path, cs } = setupFile("append.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `+2`, content: "ccc" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nbbb\nccc\n");
  });

  test("multiple inserts at the same anchor preserve order", async () => {
    const { path, cs } = setupFile("multi-ins.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `+1`, content: "first" },
        { checksum: cs, range: `+1`, content: "second" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("aaa\nfirst\nsecond\nbbb\n");
  });

  test("insert-after and replace at the same line", async () => {
    const { path, cs } = setupFile("ins-rep.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `2`, content: "BBB" },
        { checksum: cs, range: `+2`, content: "inserted" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    // Replace happens, then insert-after the replaced line
    expect(written).toBe("aaa\nBBB\ninserted\nccc\n");
  });

  test("insert multiple lines after an anchor", async () => {
    const { path, cs } = setupFile("multi-line-ins.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `+1`, content: "x\ny\nz" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nx\ny\nz\nbbb\n");
  });

  test("insert into empty file via +0", async () => {
    const f = join(testDir, "empty.txt");
    writeFileSync(f, "");

    const result = await edit({
      file_path: f,
      edits: [{ checksum: EMPTY_FILE_CHECKSUM, range: "+0", content: "first line\nsecond line" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(f, "utf-8");
    expect(written).toContain("first line");
    expect(written).toContain("second line");
  });
});

// =============================================================================
// Multi-edit batches
// =============================================================================

describe("multi-edit batches", () => {
  test("two non-overlapping replacements in one call", async () => {
    const { path, cs } = setupFile("batch.txt", "aaa\nbbb\nccc\nddd\neee\n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1`, content: "AAA" },
        { checksum: cs, range: `3`, content: "CCC" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nbbb\nCCC\nddd\neee\n");
  });

  test("edits provided out of order succeed (engine sorts)", async () => {
    const { path, cs } = setupFile("unsorted.txt", "aaa\nbbb\nccc\nddd\n");

    // Provide edit for line 3 before edit for line 1
    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `3`, content: "CCC" },
        { checksum: cs, range: `1`, content: "AAA" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nbbb\nCCC\nddd\n");
  });

  test("batch with replace + insert-after at different lines", async () => {
    const { path, cs } = setupFile("mixed.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1`, content: "AAA" },
        { checksum: cs, range: `+3`, content: "ddd" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nbbb\nccc\nddd\n");
  });

  test("overlapping replace ranges are rejected", async () => {
    const { path, cs } = setupFile("overlap.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1-2`, content: "X" },
        { checksum: cs, range: `2-3`, content: "Y" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/[Oo]verlap/);
  });

  test("adjacent ranges (non-overlapping) succeed", async () => {
    const { path, cs } = setupFile("adjacent.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1-2`, content: "AA\nBB" },
        { checksum: cs, range: `3-4`, content: "CC\nDD" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AA\nBB\nCC\nDD\n");
  });

  test("empty edits array is rejected or no-ops gracefully", async () => {
    const { path } = setupFile("empty-edits.txt", "aaa\n");

    const result = await edit({
      file_path: path,
      edits: [],
    });

    // Either an error or a clean no-op; either is acceptable
    if (!result.isError) {
      expect(readFileSync(path, "utf-8")).toBe("aaa\n");
    }
  });
});

// =============================================================================
// Checksum coverage validation
// =============================================================================

describe("checksum coverage", () => {
  test("narrow checksum covering only the edited line works", async () => {
    const { path, lines } = setupFile("narrow.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const narrowCs = rangeChecksum(lines, 2, 4);

    const result = await edit({
      file_path: path,
      edits: [{ checksum: narrowCs, range: `3`, content: "CCC" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
  });

  test("checksum range must cover all edits in batch", async () => {
    const { path, lines } = setupFile("partial.txt", "aaa\nbbb\nccc\nddd\neee\n");
    // Checksum covers lines 1-3 but edit targets line 5
    const narrowCs = rangeChecksum(lines, 1, 3);

    const result = await edit({
      file_path: path,
      edits: [{ checksum: narrowCs, range: `5`, content: "EEE" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("checksum from partial read covers insert-after anchor line", async () => {
    const { path, lines } = setupFile("partial-ins.txt", "aaa\nbbb\nccc\n");
    // Only cover lines 1-2
    const narrowCs = rangeChecksum(lines, 1, 2);

    const result = await edit({
      file_path: path,
      edits: [{ checksum: narrowCs, range: `+2`, content: "inserted" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nbbb\ninserted\nccc\n");
  });

  test("empty-file sentinel rejected for non-empty file", async () => {
    const { path } = setupFile("notempty.txt", "aaa\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: EMPTY_FILE_CHECKSUM, range: "+0", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// Content growth and shrinkage
// =============================================================================

describe("content growth and shrinkage", () => {
  test("replace one line with many (file grows)", async () => {
    const { path, cs } = setupFile("grow.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "x1\nx2\nx3\nx4\nx5" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nx1\nx2\nx3\nx4\nx5\nccc\n");
  });

  test("replace many lines with one (file shrinks)", async () => {
    const { path, cs } = setupFile("shrink.txt", "aaa\nbbb\nccc\nddd\neee\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2-4`, content: "only" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nonly\neee\n");
  });

  test("delete lines (empty content string)", async () => {
    const { path, cs } = setupFile("delete.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2-3`, content: "" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nddd\n");
  });

  test("delete all lines leaves empty file", async () => {
    const { path, cs } = setupFile("delall.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1-2`, content: "" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("");
  });

  test("replace with empty then chain a second edit using returned checksum", async () => {
    const { path, cs } = setupFile("chain.txt", "aaa\nbbb\nccc\n");

    const r1 = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "" }],
    });
    expect(r1.isError).toBeUndefined();

    // Extract returned checksum and use for second edit
    const csMatch = r1.content[0].text.match(/(\d+-\d+:[0-9a-f]+)/);
    expect(csMatch).not.toBeNull();
    const newCs = csMatch![1];

    const r2 = await edit({
      file_path: path,
      edits: [{ checksum: newCs, range: `1`, content: "AAA" }],
    });
    expect(r2.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nccc\n");
  });
});

// =============================================================================
// Unicode and special content
// =============================================================================

describe("unicode and special content", () => {
  test("emoji content hashes and edits correctly", async () => {
    const { path, cs } = setupFile("emoji.txt", "hello\n🎉🎊🎈\nworld\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "🚀 launched" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("hello\n🚀 launched\nworld\n");
  });

  test("CJK characters", async () => {
    const { path, cs } = setupFile("cjk.txt", "你好\n世界\n测试\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "地球" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("你好\n地球\n测试\n");
  });

  test("lines containing colons and pipe characters", async () => {
    // These chars appear in the trueline format itself — ensure they
    // don't confuse the parser when they're in file content.
    const { path, cs } = setupFile("special.txt", "key:value|extra\nnormal\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1`, content: "new:val|stuff" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("new:val|stuff\nnormal\n");
  });

  test("lines with only whitespace", async () => {
    const { path, cs } = setupFile("ws.txt", "  \n\t\t\n   \n");

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1`, content: "trimmed" },
        { checksum: cs, range: `2`, content: "also trimmed" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("trimmed\nalso trimmed\n   \n");
  });

  test("single newline in content string produces empty line", async () => {
    const { path, cs } = setupFile("blank.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "\n" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\n\n\nccc\n");
  });

  test("very long line", async () => {
    const longLine = "x".repeat(10000);
    const { path, cs } = setupFile("long.txt", `aaa\n${longLine}\nccc\n`);

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "short" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nshort\nccc\n");
  });
});

// =============================================================================
// Line ending preservation
// =============================================================================

describe("line ending edge cases", () => {
  test("CRLF file: replacement uses CRLF", async () => {
    const { path, cs } = setupFile("crlf.txt", "aaa\r\nbbb\r\nccc\r\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "BBB" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("aaa\r\nBBB\r\nccc\r\n");
  });

  test("LF file: no CRLF introduced by edit", async () => {
    const { path, cs } = setupFile("lf.txt", "aaa\nbbb\nccc\n");

    await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "BBB" }],
    });

    const written = readFileSync(path, "utf-8");
    expect(written).not.toContain("\r");
  });

  test("file without trailing newline preserves that after edit", async () => {
    const { path, cs } = setupFile("notl.txt", "aaa\nbbb");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1`, content: "AAA" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("AAA\nbbb");
    expect(written.endsWith("\n")).toBe(false);
  });

  test("file with trailing newline preserves it after edit", async () => {
    const { path, cs } = setupFile("tl.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1`, content: "AAA" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("AAA\nbbb\n");
    expect(written.endsWith("\n")).toBe(true);
  });
});

// =============================================================================
// No-op detection
// =============================================================================

describe("no-op detection", () => {
  test("replacing line with identical content is a no-op", async () => {
    const { path, cs } = setupFile("noop1.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "bbb" }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no changes");
  });

  test("replacing multi-line range with identical content is a no-op", async () => {
    const { path, cs } = setupFile("noop2.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1-3`, content: "aaa\nbbb\nccc" }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no changes");
  });

  test("insert-after with content is not a no-op (always changes file)", async () => {
    const { path, cs } = setupFile("ins-noop.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `+1`, content: "inserted" }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain("no changes");
  });
});

// =============================================================================
// Returned checksum chaining
// =============================================================================

describe("returned checksum enables chaining", () => {
  test("returned checksum works for a subsequent edit", async () => {
    const { path, cs } = setupFile("chain1.txt", "aaa\nbbb\nccc\n");

    const r1 = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "BBB" }],
    });
    expect(r1.isError).toBeUndefined();

    const csMatch = r1.content[0].text.match(/(\d+-\d+:[0-9a-f]+)/);
    expect(csMatch).not.toBeNull();
    const newCs = csMatch![1];

    const r2 = await edit({
      file_path: path,
      edits: [{ checksum: newCs, range: `2`, content: "FINAL" }],
    });

    expect(r2.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nFINAL\nccc\n");
  });

  test("old checksum is rejected after file was edited", async () => {
    const { path, cs } = setupFile("stale.txt", "aaa\nbbb\nccc\n");

    await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "BBB" }],
    });

    // Try using the old checksum — file has changed
    const r2 = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `3`, content: "CCC" }],
    });

    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain("mismatch");
  });
});

// =============================================================================
// Read-then-edit round-trip
// =============================================================================

describe("read-then-edit round-trip", () => {
  test("checksum from handleRead feeds directly into handleEdit", async () => {
    const f = join(testDir, "roundtrip.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");

    const readResult = await handleRead({
      file_path: f,
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();

    // Extract checksum from read output
    const csMatch = readResult.content[0].text.match(/checksum:\s*(\d+-\d+:[0-9a-f]+)/);
    expect(csMatch).not.toBeNull();

    const editResult = await edit({
      file_path: f,
      edits: [{ checksum: csMatch![1], range: `2`, content: "BETA" }],
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("partial read checksum covers the edit", async () => {
    const f = join(testDir, "partial-rt.txt");
    writeFileSync(f, "aaa\nbbb\nccc\nddd\neee\n");

    const readResult = await handleRead({
      file_path: f,
      start_line: 2,
      end_line: 4,
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();

    const csMatch = readResult.content[0].text.match(/checksum:\s*(\d+-\d+:[0-9a-f]+)/);
    expect(csMatch).not.toBeNull();

    const editResult = await edit({
      file_path: f,
      edits: [{ checksum: csMatch![1], range: `3`, content: "CCC" }],
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
  });
});

// =============================================================================
// Stale checksum recovery hints
// =============================================================================

describe("stale checksum recovery hints", () => {
  test("suggests narrow re-read when edit-target lines are unchanged", async () => {
    const f = join(testDir, "stale-hint.txt");
    writeFileSync(f, "aaa\nbbb\nccc\nddd\neee\n");

    const original = ["aaa", "bbb", "ccc", "ddd", "eee"];
    const cs = rangeChecksum(original, 1, 5);

    // External modification of line 5, outside edit target
    writeFileSync(f, "aaa\nbbb\nccc\nddd\nEEE\n");

    const result = await edit({
      file_path: f,
      edits: [{ checksum: cs, range: `2`, content: "BBB" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("ranges=");
  });

  test("stale checksum when edit-target line itself changed", async () => {
    const f = join(testDir, "stale-target.txt");
    writeFileSync(f, "aaa\nbbb\nccc\n");

    const original = ["aaa", "bbb", "ccc"];
    const cs = rangeChecksum(original, 1, 3);

    // External modification of line 2, which IS the edit target
    writeFileSync(f, "aaa\nBBB\nccc\n");

    const result = await edit({
      file_path: f,
      edits: [{ checksum: cs, range: `2`, content: "xxx" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("mismatch");
  });
});

// =============================================================================
// Security and file validation
// =============================================================================

describe("security and file validation", () => {
  test("rejects path outside project directory", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-outside-")));
    const outsideFile = join(outsideDir, "escape.txt");
    writeFileSync(outsideFile, "secret\n");

    try {
      const result = await edit({
        file_path: outsideFile,
        edits: [{ checksum: "1-1:00000000", range: "1", content: "hacked" }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("outside");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects binary file (null bytes)", async () => {
    const binFile = join(testDir, "binary.dat");
    writeFileSync(binFile, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));

    const result = await edit({
      file_path: binFile,
      edits: [{ checksum: "1-1:00000000", range: "1", content: "text" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/binary/i);
  });

  test("rejects directory path", async () => {
    const result = await edit({
      file_path: testDir,
      edits: [{ checksum: "1-1:00000000", range: "1", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("rejects nonexistent file", async () => {
    const result = await edit({
      file_path: join(testDir, "does-not-exist.txt"),
      edits: [{ checksum: "1-1:00000000", range: "1", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("symlink within project directory is allowed", async () => {
    const realFile = join(testDir, "real.txt");
    writeFileSync(realFile, "aaa\nbbb\n");
    const linkFile = join(testDir, "link.txt");
    symlinkSync(realFile, linkFile);

    const lines = ["aaa", "bbb"];
    const cs = rangeChecksum(lines, 1, 2);

    const result = await edit({
      file_path: linkFile,
      edits: [{ checksum: cs, range: `1`, content: "AAA" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(realFile, "utf-8")).toBe("AAA\nbbb\n");
  });

  test("symlink escaping project directory is rejected", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-symesc-")));
    const outsideFile = join(outsideDir, "target.txt");
    writeFileSync(outsideFile, "secret\n");
    const linkFile = join(testDir, "escape-link.txt");
    symlinkSync(outsideFile, linkFile);

    try {
      const result = await edit({
        file_path: linkFile,
        edits: [{ checksum: "1-1:00000000", range: "1", content: "hacked" }],
      });
      expect(result.isError).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("deny pattern blocks edit", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Edit(*.secret)"] },
      }),
    );
    const secretFile = join(testDir, "passwords.secret");
    writeFileSync(secretFile, "hunter2\n");

    const lines = ["hunter2"];
    const cs = rangeChecksum(lines, 1, 1);

    const result = await edit({
      file_path: secretFile,
      edits: [{ checksum: cs, range: `1`, content: "redacted" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied");
    // Verify file wasn't modified
    expect(readFileSync(secretFile, "utf-8")).toBe("hunter2\n");
  });
});

// =============================================================================
// Large file behavior
// =============================================================================

describe("large file edits", () => {
  test("edit line in a 1000-line file", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) lines.push(`line ${i + 1}`);
    const content = `${lines.join("\n")}\n`;
    const { path } = setupFile("large.txt", content);

    const narrowCs = rangeChecksum(lines, 498, 502);

    const result = await edit({
      file_path: path,
      edits: [{ checksum: narrowCs, range: `500`, content: "REPLACED 500" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toContain("REPLACED 500");
    expect(written).toContain("line 499");
    expect(written).toContain("line 501");
  });

  test("multiple scattered edits in a large file", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`line ${i + 1}`);
    const content = `${lines.join("\n")}\n`;
    const { path } = setupFile("scatter.txt", content);

    const cs = rangeChecksum(lines, 1, 500);

    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1`, content: "FIRST" },
        { checksum: cs, range: `250`, content: "MIDDLE" },
        { checksum: cs, range: `500`, content: "LAST" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written.startsWith("FIRST\n")).toBe(true);
    expect(written).toContain("MIDDLE");
    expect(written).toContain("LAST");
  });
});

// =============================================================================
// Checksum format validation
// =============================================================================

describe("checksum format validation", () => {
  test("rejects checksum without range prefix", async () => {
    const { path } = setupFile("nopfx.txt", "aaa\n");

    // Just the hex part, no "1-1:" prefix
    await expect(
      edit({
        file_path: path,
        edits: [{ checksum: "abcdef01", range: `1`, content: "x" }],
      }),
    ).rejects.toThrow();
  });

  test("rejects completely garbled checksum", async () => {
    const { path } = setupFile("garbled.txt", "aaa\n");

    await expect(
      edit({
        file_path: path,
        edits: [{ checksum: "not-a-checksum", range: `1`, content: "x" }],
      }),
    ).rejects.toThrow();
  });
});
