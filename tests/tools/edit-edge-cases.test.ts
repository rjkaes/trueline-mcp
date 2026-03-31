import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { handleRead } from "../../src/tools/read.ts";
import { lineHash, rangeChecksum, issueTestRef, resetRefStore } from "../helpers.ts";
import { issueRef } from "../../src/ref-store.ts";
import { EMPTY_FILE_CHECKSUM } from "../../src/hash.ts";

let testDir: string;

beforeEach(() => {
  resetRefStore();
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-edge-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  resetRefStore();
});

// Convenience: write a file, compute ref over all lines
function setupFile(name: string, content: string) {
  const f = join(testDir, name);
  writeFileSync(f, content);
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // Remove trailing empty element if content ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const ref = lines.length > 0 ? issueTestRef(f, lines, 1, lines.length) : issueRef(f, 0, 0, "00000000");
  return { path: f, lines, ref };
}

// =============================================================================
// Single-line file edits
// =============================================================================

describe("single-line file edits", () => {
  test("replace the only line in a one-line file (with trailing newline)", async () => {
    const { path, ref } = setupFile("one.txt", "only\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("only")}.1`,
          content: "replaced",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("replaced\n");
  });

  test("replace the only line in a one-line file (no trailing newline)", async () => {
    const { path, ref } = setupFile("one-no-nl.txt", "only");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("only")}.1`,
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
    const { path, ref } = setupFile("expand.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
          content: "x1\nx2\nx3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nx1\nx2\nx3\nccc\n");
  });

  test("replace multiple lines with one line", async () => {
    const { path, ref } = setupFile("collapse.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2-${lineHash("ccc")}.3`,
          content: "merged",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nmerged\nddd\n");
  });

  test("delete lines by replacing with empty content", async () => {
    const { path, ref } = setupFile("delete.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
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
    const { path, ref } = setupFile("empty.txt", "");

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
    const { path, ref } = setupFile("empty2.txt", "");

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
    const { path } = setupFile("not-empty.txt", "content\n");
    const emptyRef = issueRef(path, 0, 0, "00000000");

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
  test("insert after last line", async () => {
    const { path, ref } = setupFile("append.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("bbb")}.2`,
          content: "appended",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nbbb\nappended\n");
  });

  test("insert after first line", async () => {
    const { path, ref } = setupFile("after-first.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("aaa")}.1`,
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\ninserted\nbbb\n");
  });

  test("+0: prefix prepends before all content", async () => {
    const { path, ref } = setupFile("prepend.txt", "existing\n");

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

  test("multiple insert-after at different lines", async () => {
    const { path, ref } = setupFile("multi-insert.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("aaa")}.1`,
          content: "after-1",
        },
        {
          ref,
          range: `+${lineHash("ccc")}.3`,
          content: "after-3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nafter-1\nbbb\nccc\nafter-3\n");
  });

  test("replace and insert-after at the same line", async () => {
    const { path, ref } = setupFile("replace-and-insert.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
          content: "BBB",
        },
        {
          ref,
          range: `+${lineHash("bbb")}.2`,
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
    const { path, ref } = setupFile("replace-all.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1-${lineHash("ccc")}.3`,
          content: "entirely\nnew",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("entirely\nnew\n");
  });

  test("replace first and last lines independently", async () => {
    const { path, ref } = setupFile("bookends.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1`,
          content: "AAA",
        },
        {
          ref,
          range: `${lineHash("ccc")}.3`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nbbb\nCCC\n");
  });

  test("delete all lines (replace with empty content)", async () => {
    const { path, ref } = setupFile("delete-all.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1-${lineHash("ccc")}.3`,
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
    const { path, ref } = setupFile("noop.txt", "aaa\nbbb\nccc\n");
    const { mtimeMs: before } = statSync(path);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
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
    const { path, ref } = setupFile("noop-multi.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1-${lineHash("ccc")}.3`,
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
    const narrowRef = issueTestRef(path, lines, 2, 4);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: narrowRef,
          range: `${lineHash("ccc")}.3`,
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
    const narrowRef = issueTestRef(path, lines, 2, 3);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: narrowRef,
          range: `${lineHash("ddd")}.4`,
          content: "DDD",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("two edits sharing the same checksum", async () => {
    const { path, ref } = setupFile("shared-cs.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1`,
          content: "AAA",
        },
        {
          ref,
          range: `${lineHash("ddd")}.4`,
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
    // Fabricate a ref claiming to cover lines 1-10 with the correct hash for lines 1-2
    const cs = rangeChecksum(lines, 1, 2);
    const hashHex = cs.slice(cs.indexOf(":") + 1);
    const fakeRef = issueRef(path, 1, 10, hashHex);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: fakeRef,
          range: `${lineHash("aaa")}.1`,
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
    const ref = issueTestRef(f, lines, 1, 3);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
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
    const ref = issueTestRef(f, lines, 1, 3);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1-${lineHash("bbb")}.2`,
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
    const ref = issueTestRef(f, lines, 1, 2);

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `+${lineHash("bbb")}.2`,
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
    const { path, ref } = setupFile("unicode-edit.txt", "hello\nworld\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("hello")}.1`,
          content: "🎉 héllo 𝕳",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("🎉 héllo 𝕳\nworld\n");
  });

  test("edit file containing CJK content", async () => {
    const { path, ref } = setupFile("cjk.txt", "日本語\n中文\n한국어\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("中文")}.2`,
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
  test("ref from handleRead works as handleEdit input", async () => {
    const f = join(testDir, "roundtrip.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");

    // Read the file
    const readResult = await handleRead({ file_path: f, projectDir: testDir });
    expect(readResult.isError).toBeUndefined();
    const text = readResult.content[0].text;

    // Extract ref
    const refMatch = text.match(/ref: (R\d+)/);
    expect(refMatch).toBeTruthy();
    const ref = refMatch![1];

    // Extract line hash for line 2
    const lineMatch = text.match(/^([a-z]{2})\.2\t/m);
    expect(lineMatch).toBeTruthy();
    const lh = lineMatch![1];

    // Edit using the extracted values
    const editResult = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lh}.2`,
          content: "BETA",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("partial-range read ref works for edit", async () => {
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

    const refMatch = text.match(/ref: (R\d+)/);
    const ref = refMatch![1];
    const lineMatch = text.match(/^([a-z]{2})\.3\t/m);
    const lh = lineMatch![1];

    const editResult = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lh}.3`,
          content: "CCC",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("aaa\nbbb\nCCC\nddd\neee\n");
  });

  test("edit returns new ref that enables a second edit", async () => {
    const f = join(testDir, "chain.txt");
    writeFileSync(f, "aaa\nbbb\nccc\n");

    // First edit
    const { ref } = setupFile("chain.txt", "aaa\nbbb\nccc\n");
    const edit1 = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
          content: "BBB",
        },
      ],
      projectDir: testDir,
    });
    expect(edit1.isError).toBeUndefined();

    // Extract the new ref from the edit output
    const refMatch = edit1.content[0].text.match(/ref: (R\d+)/);
    expect(refMatch).toBeTruthy();
    const newRef = refMatch![1];
    const lineMatch2 = (await handleRead({ file_path: f, projectDir: testDir })).content[0].text.match(
      /^([a-z]{2})\.3\t/m,
    );
    const lh = lineMatch2![1];

    // Second edit using new ref from re-read
    const readResult = await handleRead({ file_path: f, projectDir: testDir });
    const readRef = readResult.content[0].text.match(/ref: (R\d+)/)![1];

    const edit2 = await handleEdit({
      file_path: f,
      edits: [
        {
          ref: readRef,
          range: `${lh}.3`,
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
    const { path, ref } = setupFile("same-line.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        { ref, range: `${lineHash("bbb")}.2`, content: "X" },
        { ref, range: `${lineHash("bbb")}.2`, content: "Y" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Overlapping");
  });

  test("two adjacent but non-overlapping replace ops succeed", async () => {
    const { path, ref } = setupFile("adjacent.txt", "aaa\nbbb\nccc\nddd\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        { ref, range: `${lineHash("aaa")}.1-${lineHash("bbb")}.2`, content: "AB" },
        { ref, range: `${lineHash("ccc")}.3-${lineHash("ddd")}.4`, content: "CD" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AB\nCD\n");
  });

  test("insert-after ops at the same line do not count as overlapping", async () => {
    const { path, ref } = setupFile("multi-ia.txt", "aaa\nbbb\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("aaa")}.1`,
          content: "ins1",
        },
        {
          ref,
          range: `+${lineHash("aaa")}.1`,
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
    const { path, ref } = setupFile("bad-start.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `zz.1-${lineHash("ccc")}.3`,

          content: "new",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("wrong end hash on multi-line range is rejected", async () => {
    const { path, ref } = setupFile("bad-end.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1-zz.3`,
          content: "new",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("correct hashes on multi-line range pass", async () => {
    const { path, ref } = setupFile("good-hash.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("aaa")}.1-${lineHash("ccc")}.3`,
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
    const { path, ref } = setupFile("stale.txt", "aaa\nbbb\nccc\n");

    // Externally modify the file
    writeFileSync(path, "aaa\nXXX\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
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
    const { path, ref } = setupFile("pipes.txt", "a|b|c\nd|e\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("a|b|c")}.1`,
          content: "x|y|z",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("x|y|z\nd|e\n");
  });

  test("line containing colon characters", async () => {
    const { path, ref } = setupFile("colons.txt", "key: value\nother: stuff\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("key: value")}.1`,
          content: "key: new_value",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("key: new_value\nother: stuff\n");
  });

  test("line with leading/trailing whitespace", async () => {
    const { path, ref } = setupFile("ws.txt", "  indented  \n\ttabbed\t\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("  indented  ")}.1`,
          content: "    more indented    ",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("    more indented    \n\ttabbed\t\n");
  });

  test("empty replacement lines", async () => {
    const { path, ref } = setupFile("empty-lines.txt", "aaa\nbbb\nccc\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
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
  // Windows doesn't support Unix file permissions — chmod is a no-op.
  test.skipIf(process.platform === "win32")("file permissions are preserved after edit", async () => {
    const { path, ref } = setupFile("perms.txt", "aaa\nbbb\n");

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
          range: `${lineHash("aaa")}.1`,
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
