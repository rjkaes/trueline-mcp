import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { handleRead } from "../../src/tools/read.ts";
import { lineHash, rangeChecksum } from "../helpers.ts";
import { EMPTY_FILE_CHECKSUM } from "../../src/hash.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-edge-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// Convenience: write a file, compute checksum over all lines
function setupFile(name: string, content: string) {
  const f = join(testDir, name);
  writeFileSync(f, content);
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // Remove trailing empty element if content ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const cs = lines.length > 0 ? rangeChecksum(lines, 1, lines.length) : EMPTY_FILE_CHECKSUM;
  return { path: f, lines, cs };
}

// =============================================================================
// Single-line file edits
// =============================================================================

describe("single-line file edits", () => {
  test("replace the only line in a one-line file (with trailing newline)", async () => {
    const { path, cs } = setupFile("one.txt", "only\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("only")}`,
          content: "replaced",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("replaced\n");
  });

  test("replace the only line in a one-line file (no trailing newline)", async () => {
    const { path, cs } = setupFile("one-no-nl.txt", "only");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("only")}`,
          content: "replaced",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    // Should preserve absence of trailing newline
    expect(readFileSync(path, "utf-8")).toBe("replaced");
  });

  test("replace one line with multiple lines", async () => {
    const { path, cs } = setupFile("expand.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "x1\nx2\nx3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nx1\nx2\nx3\nccc\n");
  });

  test("replace multiple lines with one line", async () => {
    const { path, cs } = setupFile("collapse.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}..3:${lineHash("ccc")}`,
          content: "merged",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nmerged\nddd\n");
  });

  test("delete lines by replacing with empty content", async () => {
    const { path, cs } = setupFile("delete.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nccc\n");
  });
});

// =============================================================================
// Empty file operations
// =============================================================================

describe("empty file operations", () => {
  test("insert into empty file via +0: prefix", async () => {
    const { path } = setupFile("empty.txt", "");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: EMPTY_FILE_CHECKSUM,
          range: "+0:",
          content: "first\nsecond",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toContain("first");
    expect(written).toContain("second");
  });

  test("line 0 without + prefix is rejected", async () => {
    const { path } = setupFile("empty2.txt", "");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: EMPTY_FILE_CHECKSUM,
          range: "0:",
          content: "nope",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("insert-after");
  });

  test("empty-file checksum against non-empty file fails", async () => {
    const { path } = setupFile("not-empty.txt", "content\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: EMPTY_FILE_CHECKSUM,
          range: "+0:",
          content: "prepend",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// insert-after (+ prefix) edge cases
// =============================================================================

describe("insert-after (+ prefix)", () => {
  test("insert after last line", async () => {
    const { path, cs } = setupFile("append.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `+2:${lineHash("bbb")}`,
          content: "appended",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nbbb\nappended\n");
  });

  test("insert after first line", async () => {
    const { path, cs } = setupFile("after-first.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `+1:${lineHash("aaa")}`,
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\ninserted\nbbb\n");
  });

  test("+0: prefix prepends before all content", async () => {
    const { path, cs } = setupFile("prepend.txt", "existing\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: "+0:",
          content: "prepended",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("prepended\nexisting\n");
  });

  test("multiple insert-after at different lines", async () => {
    const { path, cs } = setupFile("multi-insert.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `+1:${lineHash("aaa")}`,
          content: "after-1",
        },
        {
          checksum: cs,
          range: `+3:${lineHash("ccc")}`,
          content: "after-3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nafter-1\nbbb\nccc\nafter-3\n");
  });

  test("replace and insert-after at the same line", async () => {
    const { path, cs } = setupFile("replace-and-insert.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "BBB",
        },
        {
          checksum: cs,
          range: `+2:${lineHash("bbb")}`,
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nBBB\ninserted\nccc\n");
  });
});

// =============================================================================
// Multi-line range replacement
// =============================================================================

describe("multi-line replacements", () => {
  test("replace all lines in file", async () => {
    const { path, cs } = setupFile("replace-all.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}..3:${lineHash("ccc")}`,
          content: "entirely\nnew",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("entirely\nnew\n");
  });

  test("replace first and last lines independently", async () => {
    const { path, cs } = setupFile("bookends.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}`,
          content: "AAA",
        },
        {
          checksum: cs,
          range: `3:${lineHash("ccc")}`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nbbb\nCCC\n");
  });

  test("delete all lines (replace with empty content)", async () => {
    const { path, cs } = setupFile("delete-all.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}..3:${lineHash("ccc")}`,
          content: "",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    // Deleting all lines should produce an empty file
    expect(readFileSync(path, "utf-8")).toBe("");
  });
});

// =============================================================================
// No-op detection
// =============================================================================

describe("no-op detection", () => {
  test("replacing line with identical content reports no changes", async () => {
    const { path, cs } = setupFile("noop.txt", "aaa\nbbb\nccc\n");
    const { mtimeMs: before } = statSync(path);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "bbb",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no changes");
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("replacing range with identical multi-line content is no-op", async () => {
    const { path, cs } = setupFile("noop-multi.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}..3:${lineHash("ccc")}`,
          content: "aaa\nbbb\nccc",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no changes");
  });
});

// =============================================================================
// Checksum validation
// =============================================================================

describe("checksum validation", () => {
  test("narrow checksum covering only the edit range works", async () => {
    const { path, lines } = setupFile("narrow.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const narrowCs = rangeChecksum(lines, 2, 4);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: narrowCs,
          range: `3:${lineHash("ccc")}`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
  });

  test("checksum range must cover edit range — too narrow fails", async () => {
    const { path, lines } = setupFile("too-narrow.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const narrowCs = rangeChecksum(lines, 2, 3);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: narrowCs,
          range: `4:${lineHash("ddd")}`,
          content: "DDD",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("two edits sharing the same checksum", async () => {
    const { path, cs } = setupFile("shared-cs.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}`,
          content: "AAA",
        },
        {
          checksum: cs,
          range: `4:${lineHash("ddd")}`,
          content: "DDD",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nbbb\nccc\nDDD\n");
  });

  test("checksum range exceeding file length fails", async () => {
    const { path, lines } = setupFile("short.txt", "aaa\nbbb\n");
    // Fabricate a checksum claiming to cover lines 1-10
    const fakeCs = rangeChecksum(lines, 1, 2).replace(/^1-2:/, "1-10:");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: fakeCs,
          range: `1:${lineHash("aaa")}`,
          content: "AAA",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exceeds");
  });
});

// =============================================================================
// Line ending preservation
// =============================================================================

describe("line ending preservation", () => {
  test("bare CR file preserves CR endings", async () => {
    const f = join(testDir, "cr.txt");
    writeFileSync(f, "aaa\rbbb\rccc\r");

    const lines = ["aaa", "bbb", "ccc"];
    const cs = rangeChecksum(lines, 1, 3);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "BBB",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(f, "utf-8");
    // Should use \r as line separator (detected from first line ending)
    expect(written).toBe("aaa\rBBB\rccc\r");
  });

  test("CRLF file preserves CRLF after multi-line replacement", async () => {
    const f = join(testDir, "crlf-multi.txt");
    writeFileSync(f, "aaa\r\nbbb\r\nccc\r\n");

    const lines = ["aaa", "bbb", "ccc"];
    const cs = rangeChecksum(lines, 1, 3);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}..2:${lineHash("bbb")}`,
          content: "XXX\nYYY\nZZZ",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(f, "utf-8");
    expect(written).toBe("XXX\r\nYYY\r\nZZZ\r\nccc\r\n");
  });

  test("no trailing newline preserved after insert-after at last line", async () => {
    const f = join(testDir, "no-nl-insert.txt");
    writeFileSync(f, "aaa\nbbb");

    const lines = ["aaa", "bbb"];
    const cs = rangeChecksum(lines, 1, 2);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: cs,
          range: `+2:${lineHash("bbb")}`,
          content: "appended",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(f, "utf-8");
    // The original file had no trailing newline; the result should also not
    // have one after the last inserted line.
    expect(written).toBe("aaa\nbbb\nappended");
  });
});

// =============================================================================
// Unicode content in edits
// =============================================================================

describe("unicode in edits", () => {
  test("replace with astral plane characters", async () => {
    const { path, cs } = setupFile("unicode-edit.txt", "hello\nworld\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("hello")}`,
          content: "🎉 héllo 𝕳",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("🎉 héllo 𝕳\nworld\n");
  });

  test("edit file containing CJK content", async () => {
    const { path, cs } = setupFile("cjk.txt", "日本語\n中文\n한국어\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("中文")}`,
          content: "中文（修正済み）",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("日本語\n中文（修正済み）\n한국어\n");
  });
});

// =============================================================================
// Read-then-edit round-trip
// =============================================================================

describe("read-then-edit round-trip", () => {
  test("checksum from handleRead works as handleEdit input", async () => {
    const f = join(testDir, "roundtrip.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");

    // Read the file
    const readResult = await handleRead({ file_path: f, projectDir: testDir });
    expect(readResult.isError).toBeUndefined();
    const text = readResult.content[0].text;

    // Extract checksum
    const csMatch = text.match(/checksum: (.+)/);
    expect(csMatch).toBeTruthy();
    const cs = csMatch![1];

    // Extract line hash for line 2
    const lineMatch = text.match(/^2:([a-z]{2})\|/m);
    expect(lineMatch).toBeTruthy();
    const lh = lineMatch![1];

    // Edit using the extracted values
    const editResult = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: cs,
          range: `2:${lh}`,
          content: "BETA",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("partial-range read checksum works for edit", async () => {
    const f = join(testDir, "partial-roundtrip.txt");
    writeFileSync(f, "aaa\nbbb\nccc\nddd\neee\n");

    // Read only lines 2-4
    const readResult = await handleRead({
      file_path: f,
      start_line: 2,
      end_line: 4,
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();
    const text = readResult.content[0].text;

    const csMatch = text.match(/checksum: (.+)/);
    const cs = csMatch![1];
    const lineMatch = text.match(/^3:([a-z]{2})\|/m);
    const lh = lineMatch![1];

    const editResult = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: cs,
          range: `3:${lh}`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
  });

  test("edit returns new checksum that enables a second edit", async () => {
    const f = join(testDir, "chain.txt");
    writeFileSync(f, "aaa\nbbb\nccc\n");

    // First edit
    const { cs } = setupFile("chain.txt", "aaa\nbbb\nccc\n");
    const edit1 = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "BBB",
        },
      ],
      projectDir: testDir,
    });
    expect(edit1.isError).toBeUndefined();

    // Read the updated file to get new checksum
    const readResult = await handleRead({ file_path: f, projectDir: testDir });
    const text = readResult.content[0].text;
    const csMatch = text.match(/checksum: (.+)/);
    const newCs = csMatch![1];
    const lineMatch = text.match(/^3:([a-z]{2})\|/m);
    const lh = lineMatch![1];

    // Second edit using new checksum
    const edit2 = await handleEdit({
      file_path: f,
      edits: [
        {
          checksum: newCs,
          range: `3:${lh}`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(edit2.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("aaa\nBBB\nCCC\n");
  });
});

// =============================================================================
// Overlap detection
// =============================================================================

describe("overlap detection", () => {
  test("two replace ops on the same line are rejected", async () => {
    const { path, cs } = setupFile("same-line.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        { checksum: cs, range: `2:${lineHash("bbb")}`, content: "X" },
        { checksum: cs, range: `2:${lineHash("bbb")}`, content: "Y" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Overlapping");
  });

  test("two adjacent but non-overlapping replace ops succeed", async () => {
    const { path, cs } = setupFile("adjacent.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1:${lineHash("aaa")}..2:${lineHash("bbb")}`, content: "AB" },
        { checksum: cs, range: `3:${lineHash("ccc")}..4:${lineHash("ddd")}`, content: "CD" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AB\nCD\n");
  });

  test("insert-after ops at the same line do not count as overlapping", async () => {
    const { path, cs } = setupFile("multi-ia.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `+1:${lineHash("aaa")}`,
          content: "ins1",
        },
        {
          checksum: cs,
          range: `+1:${lineHash("aaa")}`,
          content: "ins2",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toContain("ins1");
    expect(written).toContain("ins2");
  });
});

// =============================================================================
// Hash verification
// =============================================================================

describe("hash verification", () => {
  test("wrong start hash on multi-line range is rejected", async () => {
    const { path, cs } = setupFile("bad-start.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:zz..3:${lineHash("ccc")}`,
          content: "new",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("wrong end hash on multi-line range is rejected", async () => {
    const { path, cs } = setupFile("bad-end.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}..3:zz`,
          content: "new",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("correct hashes on multi-line range pass", async () => {
    const { path, cs } = setupFile("good-hash.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}..3:${lineHash("ccc")}`,
          content: "only",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("only\n");
  });
});

// =============================================================================
// Stale file detection (file modified externally between read and edit)
// =============================================================================

describe("stale file detection", () => {
  test("file content changed (checksum mismatch)", async () => {
    const { path, cs } = setupFile("stale.txt", "aaa\nbbb\nccc\n");

    // Externally modify the file
    writeFileSync(path, "aaa\nXXX\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "BBB",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    // Either hash mismatch or checksum mismatch
    expect(result.content[0].text).toMatch(/mismatch/i);
  });
});

// =============================================================================
// Edge cases with content containing special characters
// =============================================================================

describe("special content", () => {
  test("line containing pipe characters", async () => {
    const { path, cs } = setupFile("pipes.txt", "a|b|c\nd|e\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("a|b|c")}`,
          content: "x|y|z",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("x|y|z\nd|e\n");
  });

  test("line containing colon characters", async () => {
    const { path, cs } = setupFile("colons.txt", "key: value\nother: stuff\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("key: value")}`,
          content: "key: new_value",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("key: new_value\nother: stuff\n");
  });

  test("line with leading/trailing whitespace", async () => {
    const { path, cs } = setupFile("ws.txt", "  indented  \n\ttabbed\t\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("  indented  ")}`,
          content: "    more indented    ",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("    more indented    \n\ttabbed\t\n");
  });

  test("empty replacement lines", async () => {
    const { path, cs } = setupFile("empty-lines.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `2:${lineHash("bbb")}`,
          content: "\n\n",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\n\n\n\nccc\n");
  });
});

// =============================================================================
// File permissions preserved
// =============================================================================

describe("file metadata", () => {
  test("file permissions are preserved after edit", async () => {
    const { path, cs } = setupFile("perms.txt", "aaa\nbbb\n");

    // Make file executable
    const { mode: origMode } = statSync(path);
    const execMode = origMode | 0o111;
    const { chmodSync } = await import("node:fs");
    chmodSync(path, execMode);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          checksum: cs,
          range: `1:${lineHash("aaa")}`,
          content: "AAA",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const { mode: newMode } = statSync(path);
    expect(newMode & 0o777).toBe(execMode & 0o777);
  });
});
