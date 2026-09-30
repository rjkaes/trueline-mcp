import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { handleRead } from "../../src/tools/read.ts";
import { lineHash, rangeChecksum, issueTestRef, setupFile, writeTestFile } from "../helpers.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-edge-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// =============================================================================
// Single-edit results (one handleEdit call, then the file contents)
// =============================================================================

interface EditCase {
  name: string;
  content: string;
  // refLines narrows that edit's ref to a line span; omitted means the whole file.
  edits: { range: string; content: string; refLines?: [number, number] }[];
  expected: string;
}

async function expectEditResult({ content, edits, expected }: EditCase) {
  const { path, lines, ref } = setupFile(testDir, "fixture.txt", content);

  const result = await handleEdit({
    file_path: path,
    edits: edits.map(({ refLines, ...edit }) => ({ ref: refLines ? issueTestRef(lines, ...refLines) : ref, ...edit })),
    projectDir: testDir,
  });

  expect(result.isError).toBeUndefined();
  expect(readFileSync(path, "utf-8")).toBe(expected);
}

describe("single-edit results", () => {
  test.each<EditCase>([
    // single-line file edits
    {
      name: "replace the only line in a one-line file (with trailing newline)",
      content: "only\n",
      edits: [{ range: `${lineHash("only")}1`, content: "replaced" }],
      expected: "replaced\n",
    },
    {
      // Should preserve absence of trailing newline
      name: "replace the only line in a one-line file (no trailing newline)",
      content: "only",
      edits: [{ range: `${lineHash("only")}1`, content: "replaced" }],
      expected: "replaced",
    },
    {
      name: "replace one line with multiple lines",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "x1\nx2\nx3" }],
      expected: "aaa\nx1\nx2\nx3\nccc\n",
    },
    {
      name: "replace multiple lines with one line",
      content: "aaa\nbbb\nccc\nddd\n",
      edits: [{ range: `${lineHash("bbb")}2-${lineHash("ccc")}3`, content: "merged" }],
      expected: "aaa\nmerged\nddd\n",
    },
    {
      name: "delete lines by replacing with empty content",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "" }],
      expected: "aaa\nccc\n",
    },
    // insert-after (+ prefix)
    {
      name: "insert after last line",
      content: "aaa\nbbb\n",
      edits: [{ range: `+${lineHash("bbb")}2`, content: "appended" }],
      expected: "aaa\nbbb\nappended\n",
    },
    {
      name: "insert after first line",
      content: "aaa\nbbb\n",
      edits: [{ range: `+${lineHash("aaa")}1`, content: "inserted" }],
      expected: "aaa\ninserted\nbbb\n",
    },
    {
      name: "multiple insert-after at different lines",
      content: "aaa\nbbb\nccc\n",
      edits: [
        { range: `+${lineHash("aaa")}1`, content: "after-1" },
        { range: `+${lineHash("ccc")}3`, content: "after-3" },
      ],
      expected: "aaa\nafter-1\nbbb\nccc\nafter-3\n",
    },
    {
      name: "replace and insert-after at the same line",
      content: "aaa\nbbb\nccc\n",
      edits: [
        { range: `${lineHash("bbb")}2`, content: "BBB" },
        { range: `+${lineHash("bbb")}2`, content: "inserted" },
      ],
      expected: "aaa\nBBB\ninserted\nccc\n",
    },
    {
      // Empty original: no trailing newline is added
      name: "insertAfter at line 0 on empty file with multi-line content",
      content: "",
      edits: [{ range: "+0", content: "line1\nline2" }],
      expected: "line1\nline2",
    },
    // multi-line replacements
    {
      name: "replace all lines in file",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("aaa")}1-${lineHash("ccc")}3`, content: "entirely\nnew" }],
      expected: "entirely\nnew\n",
    },
    {
      name: "replace first and last lines independently",
      content: "aaa\nbbb\nccc\n",
      edits: [
        { range: `${lineHash("aaa")}1`, content: "AAA" },
        { range: `${lineHash("ccc")}3`, content: "CCC" },
      ],
      expected: "AAA\nbbb\nCCC\n",
    },
    {
      // Deleting all lines should produce an empty file
      name: "delete all lines (replace with empty content)",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("aaa")}1-${lineHash("ccc")}3`, content: "" }],
      expected: "",
    },
    // checksum validation
    {
      name: "narrow checksum covering only the edit range works",
      content: "aaa\nbbb\nccc\nddd\neee\n",
      edits: [{ range: `${lineHash("ccc")}3`, content: "CCC", refLines: [2, 4] }],
      expected: "aaa\nbbb\nCCC\nddd\neee\n",
    },
    {
      name: "two edits sharing the same checksum",
      content: "aaa\nbbb\nccc\nddd\n",
      edits: [
        { range: `${lineHash("aaa")}1`, content: "AAA" },
        { range: `${lineHash("ddd")}4`, content: "DDD" },
      ],
      expected: "AAA\nbbb\nccc\nDDD\n",
    },
    // unicode in edits
    {
      name: "replace with astral plane characters",
      content: "hello\nworld\n",
      edits: [{ range: `${lineHash("hello")}1`, content: "🎉 héllo 𝕳" }],
      expected: "🎉 héllo 𝕳\nworld\n",
    },
    {
      name: "edit file containing CJK content",
      content: "日本語\n中文\n한국어\n",
      edits: [{ range: `${lineHash("中文")}2`, content: "中文（修正済み）" }],
      expected: "日本語\n中文（修正済み）\n한국어\n",
    },
    // overlap detection
    {
      name: "two adjacent but non-overlapping replace ops succeed",
      content: "aaa\nbbb\nccc\nddd\n",
      edits: [
        { range: `${lineHash("aaa")}1-${lineHash("bbb")}2`, content: "AB" },
        { range: `${lineHash("ccc")}3-${lineHash("ddd")}4`, content: "CD" },
      ],
      expected: "AB\nCD\n",
    },
    // hash verification
    {
      name: "correct hashes on multi-line range pass",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("aaa")}1-${lineHash("ccc")}3`, content: "only" }],
      expected: "only\n",
    },
    // special content
    {
      name: "line containing pipe characters",
      content: "a|b|c\nd|e\n",
      edits: [{ range: `${lineHash("a|b|c")}1`, content: "x|y|z" }],
      expected: "x|y|z\nd|e\n",
    },
    {
      name: "line containing colon characters",
      content: "key: value\nother: stuff\n",
      edits: [{ range: `${lineHash("key: value")}1`, content: "key: new_value" }],
      expected: "key: new_value\nother: stuff\n",
    },
    {
      name: "line with leading/trailing whitespace",
      content: "  indented  \n\ttabbed\t\n",
      edits: [{ range: `${lineHash("  indented  ")}1`, content: "    more indented    " }],
      expected: "    more indented    \n\ttabbed\t\n",
    },
    {
      // content "\n\n" drops one trailing terminator, leaving two blank lines (not three).
      name: "empty replacement lines",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "\n\n" }],
      expected: "aaa\n\n\nccc\n",
    },
  ])("$name", expectEditResult);
});

// =============================================================================
// Empty file operations
// =============================================================================

describe("empty file operations", () => {
  test("insert into empty file via +0: prefix", async () => {
    const { path, ref } = setupFile(testDir, "empty.txt", "");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: "+0",
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
    const { path, ref } = setupFile(testDir, "empty2.txt", "");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: "0",
          content: "nope",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("insert-after");
  });

  test("empty-file checksum against non-empty file fails", async () => {
    const { path } = setupFile(testDir, "not-empty.txt", "content\n");
    const emptyRef = "0-0/aaaaaa";

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: emptyRef,
          range: "+0",
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
  test("+0: prefix prepends before all content", async () => {
    const { path, ref } = setupFile(testDir, "prepend.txt", "existing\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: "+0",
          content: "prepended",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("prepended\nexisting\n");
  });
});

// =============================================================================
// No-op detection
// =============================================================================

describe("no-op detection", () => {
  test("replacing range with identical multi-line content is no-op", async () => {
    const { path, ref } = setupFile(testDir, "noop-multi.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}1-${lineHash("ccc")}3`,
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
  test("checksum range must cover edit range — too narrow fails", async () => {
    const { path, lines } = setupFile(testDir, "too-narrow.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const narrowRef = issueTestRef(lines, 2, 3);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: narrowRef,
          range: `${lineHash("ddd")}4`,
          content: "DDD",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("checksum range exceeding file length fails", async () => {
    const { path, lines } = setupFile(testDir, "short.txt", "aaa\nbbb\n");
    // Fabricate a ref claiming to cover lines 1-10 with the correct hash for lines 1-2
    const cs = rangeChecksum(lines, 1, 2);
    const hashHex = cs.slice(cs.indexOf("/") + 1);
    const fakeRef = `${lineHash(lines[0])}1-${lineHash(lines[0])}10/${hashHex}`;

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: fakeRef,
          range: `${lineHash("aaa")}1`,
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
    const f = writeTestFile(testDir, "cr.txt", "aaa\rbbb\rccc\r");

    const lines = ["aaa", "bbb", "ccc"];
    const ref = issueTestRef(lines, 1, 3);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}2`,
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
    const f = writeTestFile(testDir, "crlf-multi.txt", "aaa\r\nbbb\r\nccc\r\n");

    const lines = ["aaa", "bbb", "ccc"];
    const ref = issueTestRef(lines, 1, 3);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}1-${lineHash("bbb")}2`,
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
    const f = writeTestFile(testDir, "no-nl-insert.txt", "aaa\nbbb");

    const lines = ["aaa", "bbb"];
    const ref = issueTestRef(lines, 1, 2);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `+${lineHash("bbb")}2`,
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
// Read-then-edit round-trip
// =============================================================================

describe("read-then-edit round-trip", () => {
  test("ref from handleRead works as handleEdit input", async () => {
    const f = writeTestFile(testDir, "roundtrip.txt", "alpha\nbeta\ngamma\n");

    // Read the file
    const readResult = await handleRead({ file_path: f, projectDir: testDir });
    expect(readResult.isError).toBeUndefined();
    const text = readResult.content[0].text;

    // Extract ref
    const refMatch = text.match(/ref: (\S+)/);
    expect(refMatch).toBeTruthy();
    const ref = refMatch![1];

    // Extract line hash for line 2
    const lineMatch = text.match(/^([a-z]{2})2\t/m);
    expect(lineMatch).toBeTruthy();
    const lh = lineMatch![1];

    // Edit using the extracted values
    const editResult = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lh}2`,
          content: "BETA",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("partial-range read ref works for edit", async () => {
    const f = writeTestFile(testDir, "partial-roundtrip.txt", "aaa\nbbb\nccc\nddd\neee\n");

    // Read only lines 2-4
    const readResult = await handleRead({
      file_path: f,
      start_line: 2,
      end_line: 4,
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();
    const text = readResult.content[0].text;

    const refMatch = text.match(/ref: (\S+)/);
    const ref = refMatch![1];
    const lineMatch = text.match(/^([a-z]{2})3\t/m);
    const lh = lineMatch![1];

    const editResult = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lh}3`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
  });
});

// =============================================================================
// Overlap detection
// =============================================================================

describe("overlap detection", () => {
  test("two replace ops on the same line are rejected", async () => {
    const { path, ref } = setupFile(testDir, "same-line.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        { ref, range: `${lineHash("bbb")}2`, content: "X" },
        { ref, range: `${lineHash("bbb")}2`, content: "Y" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Overlapping");
  });

  test("insert-after ops at the same line do not count as overlapping", async () => {
    const { path, ref } = setupFile(testDir, "multi-ia.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("aaa")}1`,
          content: "ins1",
        },
        {
          ref,
          range: `+${lineHash("aaa")}1`,
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
    const { path, ref } = setupFile(testDir, "bad-start.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `zz1-${lineHash("ccc")}3`,

          content: "new",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("wrong end hash on multi-line range is rejected", async () => {
    const { path, ref } = setupFile(testDir, "bad-end.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}1-zz3`,
          content: "new",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });
});

// =============================================================================
// Stale file detection (file modified externally between read and edit)
// =============================================================================

describe("stale file detection", () => {
  test("file content changed (checksum mismatch)", async () => {
    const { path, ref } = setupFile(testDir, "stale.txt", "aaa\nbbb\nccc\n");

    // Externally modify the file
    writeFileSync(path, "aaa\nXXX\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}2`,
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
// File permissions preserved
// =============================================================================

describe("file metadata", () => {
  // Windows doesn't support Unix file permissions — chmod is a no-op.
  test.skipIf(process.platform === "win32")("file permissions are preserved after edit", async () => {
    const { path, ref } = setupFile(testDir, "perms.txt", "aaa\nbbb\n");

    // Make file executable
    const { mode: origMode } = statSync(path);
    const execMode = origMode | 0o111;
    const { chmodSync } = await import("node:fs");
    chmodSync(path, execMode);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}1`,
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
