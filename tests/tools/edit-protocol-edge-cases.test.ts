import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, issueTestRef, setupFile, writeTestFile } from "../helpers.ts";

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

function edit(opts: { file_path: string; edits: { ref: string; range: string; content: string }[] }) {
  return handleEdit({ ...opts, projectDir: testDir });
}

// =============================================================================
// Single-edit results (one edit call, then the file contents)
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

  const result = await edit({
    file_path: path,
    edits: edits.map(({ refLines, ...e }) => ({ ref: refLines ? issueTestRef(lines, ...refLines) : ref, ...e })),
  });

  expect(result.isError).toBeUndefined();
  expect(readFileSync(path, "utf-8")).toBe(expected);
}

describe("single-edit results", () => {
  const longLine = "x".repeat(10000);

  test.each<EditCase>([
    // range format parsing
    {
      name: "single-line shorthand (no dash)",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "BBB" }],
      expected: "aaa\nBBB\nccc\n",
    },
    {
      name: "explicit single-line range (N:hash-N:hash)",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2-${lineHash("bbb")}2`, content: "BBB" }],
      expected: "aaa\nBBB\nccc\n",
    },
    {
      name: "+0: prefix for prepend requires no hash",
      content: "aaa\nbbb\n",
      edits: [{ range: "+0", content: "header" }],
      expected: "header\naaa\nbbb\n",
    },
    // insert-after (+) semantics
    {
      name: "insert after the very last line",
      content: "aaa\nbbb\n",
      edits: [{ range: `+${lineHash("bbb")}2`, content: "ccc" }],
      expected: "aaa\nbbb\nccc\n",
    },
    {
      name: "insert multiple lines after an anchor",
      content: "aaa\nbbb\n",
      edits: [{ range: `+${lineHash("aaa")}1`, content: "x\ny\nz" }],
      expected: "aaa\nx\ny\nz\nbbb\n",
    },
    // multi-edit batches
    {
      name: "two non-overlapping replacements in one call",
      content: "aaa\nbbb\nccc\nddd\neee\n",
      edits: [
        { range: `${lineHash("aaa")}1`, content: "AAA" },
        { range: `${lineHash("ccc")}3`, content: "CCC" },
      ],
      expected: "AAA\nbbb\nCCC\nddd\neee\n",
    },
    {
      // Edit for line 3 is provided before the edit for line 1
      name: "edits provided out of order succeed (engine sorts)",
      content: "aaa\nbbb\nccc\nddd\n",
      edits: [
        { range: `${lineHash("ccc")}3`, content: "CCC" },
        { range: `${lineHash("aaa")}1`, content: "AAA" },
      ],
      expected: "AAA\nbbb\nCCC\nddd\n",
    },
    {
      name: "batch with replace + insert-after at different lines",
      content: "aaa\nbbb\nccc\n",
      edits: [
        { range: `${lineHash("aaa")}1`, content: "AAA" },
        { range: `+${lineHash("ccc")}3`, content: "ddd" },
      ],
      expected: "AAA\nbbb\nccc\nddd\n",
    },
    {
      name: "adjacent ranges (non-overlapping) succeed",
      content: "aaa\nbbb\nccc\nddd\n",
      edits: [
        { range: `${lineHash("aaa")}1-${lineHash("bbb")}2`, content: "AA\nBB" },
        { range: `${lineHash("ccc")}3-${lineHash("ddd")}4`, content: "CC\nDD" },
      ],
      expected: "AA\nBB\nCC\nDD\n",
    },
    // checksum coverage
    {
      name: "checksum from partial read covers insert-after anchor line",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `+${lineHash("bbb")}2`, content: "inserted", refLines: [1, 2] }],
      expected: "aaa\nbbb\ninserted\nccc\n",
    },
    // content growth and shrinkage
    {
      name: "replace one line with many (file grows)",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "x1\nx2\nx3\nx4\nx5" }],
      expected: "aaa\nx1\nx2\nx3\nx4\nx5\nccc\n",
    },
    {
      name: "replace many lines with one (file shrinks)",
      content: "aaa\nbbb\nccc\nddd\neee\n",
      edits: [{ range: `${lineHash("bbb")}2-${lineHash("ddd")}4`, content: "only" }],
      expected: "aaa\nonly\neee\n",
    },
    {
      name: "delete lines (empty content string)",
      content: "aaa\nbbb\nccc\nddd\n",
      edits: [{ range: `${lineHash("bbb")}2-${lineHash("ccc")}3`, content: "" }],
      expected: "aaa\nddd\n",
    },
    {
      name: "delete all lines leaves empty file",
      content: "aaa\nbbb\n",
      edits: [{ range: `${lineHash("aaa")}1-${lineHash("bbb")}2`, content: "" }],
      expected: "",
    },
    // unicode and special content
    {
      name: "emoji content hashes and edits correctly",
      content: "hello\n🎉🎊🎈\nworld\n",
      edits: [{ range: `${lineHash("🎉🎊🎈")}2`, content: "🚀 launched" }],
      expected: "hello\n🚀 launched\nworld\n",
    },
    {
      name: "CJK characters",
      content: "你好\n世界\n测试\n",
      edits: [{ range: `${lineHash("世界")}2`, content: "地球" }],
      expected: "你好\n地球\n测试\n",
    },
    {
      // These chars appear in the trueline format itself; ensure they don't
      // confuse the parser when they're in file content.
      name: "lines containing colons and pipe characters",
      content: "key:value|extra\nnormal\n",
      edits: [{ range: `${lineHash("key:value|extra")}1`, content: "new:val|stuff" }],
      expected: "new:val|stuff\nnormal\n",
    },
    {
      name: "lines with only whitespace",
      content: "  \n\t\t\n   \n",
      edits: [
        { range: `${lineHash("  ")}1`, content: "trimmed" },
        { range: `${lineHash("\t\t")}2`, content: "also trimmed" },
      ],
      expected: "trimmed\nalso trimmed\n   \n",
    },
    {
      // "\n" is one blank-line terminator, not a separator producing two blanks.
      name: "single newline in content string produces empty line",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "\n" }],
      expected: "aaa\n\nccc\n",
    },
    {
      name: "very long line",
      content: `aaa\n${longLine}\nccc\n`,
      edits: [{ range: `${lineHash(longLine)}2`, content: "short" }],
      expected: "aaa\nshort\nccc\n",
    },
  ])("$name", expectEditResult);
});

// =============================================================================
// Range format parsing
// =============================================================================

describe("range format parsing", () => {
  test("rejects malformed range — missing hash", async () => {
    const { path, ref } = setupFile(testDir, "bad.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: ".1", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("rejects malformed range — non-numeric line number", async () => {
    const { path, ref } = setupFile(testDir, "bad2.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "aa.abc-bb2", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("rejects range where start > end", async () => {
    const { path, ref } = setupFile(testDir, "rev.txt", "aaa\nbbb\nccc\n");
    const h1 = lineHash("aaa");
    const h3 = lineHash("ccc");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h3}3-${h1}1`, content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("rejects line 0 without + prefix", async () => {
    const { path, ref } = setupFile(testDir, "zero.txt", "aaa\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "aa0-aa0", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("rejects edit targeting line beyond EOF", async () => {
    const { path, ref } = setupFile(testDir, "short.txt", "aaa\nbbb\n");
    const h = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h}99-${h}99`, content: "x" }],
    });

    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// Insert-after (+) semantics
// =============================================================================

describe("insert-after (+) semantics", () => {
  test("multiple inserts at the same anchor preserve order", async () => {
    const { path, ref } = setupFile(testDir, "multi-ins.txt", "aaa\nbbb\n");
    const h1 = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [
        { ref, range: `+${h1}1`, content: "first" },
        { ref, range: `+${h1}1`, content: "second" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("aaa\nfirst\nsecond\nbbb\n");
  });

  test("insert-after and replace at the same line", async () => {
    const { path, ref } = setupFile(testDir, "ins-rep.txt", "aaa\nbbb\nccc\n");
    const h2 = lineHash("bbb");

    const result = await edit({
      file_path: path,
      edits: [
        { ref, range: `${h2}2`, content: "BBB" },
        { ref, range: `+${h2}2`, content: "inserted" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    // Replace happens, then insert-after the replaced line
    expect(written).toBe("aaa\nBBB\ninserted\nccc\n");
  });
});

// =============================================================================
// Multi-edit batches
// =============================================================================

describe("multi-edit batches", () => {
  test("overlapping replace ranges are rejected", async () => {
    const { path, ref } = setupFile(testDir, "overlap.txt", "aaa\nbbb\nccc\nddd\n");
    const h1 = lineHash("aaa");
    const h2 = lineHash("bbb");
    const h3 = lineHash("ccc");

    const result = await edit({
      file_path: path,
      edits: [
        { ref, range: `${h1}1-${h2}2`, content: "X" },
        { ref, range: `${h2}2-${h3}3`, content: "Y" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/[Oo]verlap/);
  });

  test("empty edits array is rejected or no-ops gracefully", async () => {
    const { path } = setupFile(testDir, "empty-edits.txt", "aaa\n");

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
  test("checksum range must cover all edits in batch", async () => {
    const { path, lines } = setupFile(testDir, "partial.txt", "aaa\nbbb\nccc\nddd\neee\n");
    // Ref covers lines 1-3 but edit targets line 5
    const narrowRef = issueTestRef(lines, 1, 3);
    const h5 = lineHash("eee");

    const result = await edit({
      file_path: path,
      edits: [{ ref: narrowRef, range: `${h5}5`, content: "EEE" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("empty-file sentinel rejected for non-empty file", async () => {
    const { path } = setupFile(testDir, "notempty.txt", "aaa\n");
    const emptyRef = "0-0/aaaaaa";

    const result = await edit({
      file_path: path,
      edits: [{ ref: emptyRef, range: "+0", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });
});

// =============================================================================
// Content growth and shrinkage
// =============================================================================

describe("content growth and shrinkage", () => {
  test("replace with empty then chain a second edit using returned ref", async () => {
    const { path, ref } = setupFile(testDir, "chain.txt", "aaa\nbbb\nccc\n");
    const h2 = lineHash("bbb");

    const r1 = await edit({
      file_path: path,
      edits: [{ ref, range: `${h2}2`, content: "" }],
    });
    expect(r1.isError).toBeUndefined();

    // Extract returned ref and use for second edit
    const refMatch = r1.content[0].text.match(/ref: (\S+)/);
    expect(refMatch).not.toBeNull();
    const newRef = refMatch![1];

    const h1 = lineHash("aaa");
    const r2 = await edit({
      file_path: path,
      edits: [{ ref: newRef, range: `${h1}1`, content: "AAA" }],
    });
    expect(r2.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("AAA\nccc\n");
  });
});

// =============================================================================
// Line ending preservation
// =============================================================================

describe("line ending edge cases", () => {
  test("CRLF file: replacement uses CRLF", async () => {
    const { path, ref } = setupFile(testDir, "crlf.txt", "aaa\r\nbbb\r\nccc\r\n");
    const h2 = lineHash("bbb");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h2}2`, content: "BBB" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("aaa\r\nBBB\r\nccc\r\n");
  });

  test("LF file: no CRLF introduced by edit", async () => {
    const { path, ref } = setupFile(testDir, "lf.txt", "aaa\nbbb\nccc\n");
    const h2 = lineHash("bbb");

    await edit({
      file_path: path,
      edits: [{ ref, range: `${h2}2`, content: "BBB" }],
    });

    const written = readFileSync(path, "utf-8");
    expect(written).not.toContain("\r");
  });

  test("file without trailing newline preserves that after edit", async () => {
    const { path, ref } = setupFile(testDir, "notl.txt", "aaa\nbbb");
    const h1 = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h1}1`, content: "AAA" }],
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(path, "utf-8");
    expect(written).toBe("AAA\nbbb");
    expect(written.endsWith("\n")).toBe(false);
  });

  test("file with trailing newline preserves it after edit", async () => {
    const { path, ref } = setupFile(testDir, "tl.txt", "aaa\nbbb\n");
    const h1 = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h1}1`, content: "AAA" }],
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
  test("insert-after with content is not a no-op (always changes file)", async () => {
    const { path, ref } = setupFile(testDir, "ins-noop.txt", "aaa\nbbb\n");
    const h1 = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `+${h1}1`, content: "inserted" }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain("no changes");
  });
});

// =============================================================================
// Returned ref enables chaining
// =============================================================================

describe("returned ref enables chaining", () => {
  test("returned ref works for a subsequent edit", async () => {
    const { path, ref } = setupFile(testDir, "chain1.txt", "aaa\nbbb\nccc\n");
    const h2 = lineHash("bbb");

    const r1 = await edit({
      file_path: path,
      edits: [{ ref, range: `${h2}2`, content: "BBB" }],
    });
    expect(r1.isError).toBeUndefined();

    const refMatch = r1.content[0].text.match(/ref: (\S+)/);
    expect(refMatch).not.toBeNull();
    const newRef = refMatch![1];

    const hBBB = lineHash("BBB");
    const r2 = await edit({
      file_path: path,
      edits: [{ ref: newRef, range: `${hBBB}2`, content: "FINAL" }],
    });

    expect(r2.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("aaa\nFINAL\nccc\n");
  });

  test("old ref is rejected after file was edited", async () => {
    const { path, ref } = setupFile(testDir, "stale.txt", "aaa\nbbb\nccc\n");
    const h2 = lineHash("bbb");

    await edit({
      file_path: path,
      edits: [{ ref, range: `${h2}2`, content: "BBB" }],
    });

    // Try using the old ref — it was invalidated after the edit
    const h3 = lineHash("ccc");
    const r2 = await edit({
      file_path: path,
      edits: [{ ref, range: `${h3}3`, content: "CCC" }],
    });

    expect(r2.isError).toBe(true);
    // The old ref was invalidated, so it should be unknown
    expect(r2.content[0].text).toMatch(/unknown ref|mismatch/i);
  });
});

// =============================================================================
// Hash verification
// =============================================================================

describe("boundary hash verification", () => {
  test("wrong start hash rejected", async () => {
    const { path, ref } = setupFile(testDir, "bad-start.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `zz1-${lineHash("bbb")}2`, content: "x\ny" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("wrong end hash rejected", async () => {
    const { path, ref } = setupFile(testDir, "bad-end.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${lineHash("aaa")}1-zz2`, content: "x\ny" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });
});

describe("wrong hash prefix recovery", () => {
  test("bare line number in range tells LLM to re-read", async () => {
    const { path, ref } = setupFile(testDir, "bare.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "2", content: "xxx" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("wrong hash prefix");
    expect(text).toContain("Re-read the file");
    // Must NOT reveal the correct hash
    expect(text).not.toContain(`${lineHash("bbb")}2`);
  });

  test("bare line number in insert-after range tells LLM to re-read", async () => {
    const { path, ref } = setupFile(testDir, "bare-ia.txt", "aaa\nbbb\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "+1", content: "xxx" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("wrong hash prefix");
    expect(text).toContain("Re-read the file");
    expect(text).not.toContain(`${lineHash("aaa")}1`);
  });

  test("bare line number in multi-line range tells LLM to re-read", async () => {
    const { path, ref } = setupFile(testDir, "bare-multi.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "1-3", content: "xxx" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("wrong hash prefix");
    expect(text).toContain("Re-read the file");
    expect(text).not.toContain(`${lineHash("aaa")}1`);
  });

  test("invalid hash format tells LLM it must be a non-negative integer", async () => {
    const { path, ref } = setupFile(testDir, "bad-fmt.txt", "aaa\nbbb\nccc\n");

    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "78.2", content: "xxx" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a non-negative integer");
  });
});
// =============================================================================
// Security and file validation
// =============================================================================

describe("security and file validation", () => {
  test("rejects path outside project directory", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-outside-")));
    const outsideFile = writeTestFile(outsideDir, "escape.txt", "secret\n");

    try {
      const staleRef = "aa1-aa1/aaaaaa";
      const result = await edit({
        file_path: outsideFile,
        edits: [{ ref: staleRef, range: "aa1", content: "hacked" }],
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

    const staleRef = "aa1-aa1/aaaaaa";
    const result = await edit({
      file_path: binFile,
      edits: [{ ref: staleRef, range: "aa1", content: "text" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/binary/i);
  });

  test("rejects nonexistent file", async () => {
    const staleRef = "aa1-aa1/aaaaaa";
    const result = await edit({
      file_path: join(testDir, "does-not-exist.txt"),
      edits: [{ ref: staleRef, range: "aa1", content: "x" }],
    });

    expect(result.isError).toBe(true);
  });

  test("symlink within project directory is allowed", async () => {
    const realFile = writeTestFile(testDir, "real.txt", "aaa\nbbb\n");
    const linkFile = join(testDir, "link.txt");
    symlinkSync(realFile, linkFile);

    const lines = ["aaa", "bbb"];
    // Use realFile for the ref since symlinks resolve to the real path
    const ref = issueTestRef(lines, 1, 2);
    const h1 = lineHash("aaa");

    const result = await edit({
      file_path: linkFile,
      edits: [{ ref, range: `${h1}1`, content: "AAA" }],
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(realFile, "utf-8")).toBe("AAA\nbbb\n");
  });

  test("symlink escaping project directory is rejected", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-symesc-")));
    const outsideFile = writeTestFile(outsideDir, "target.txt", "secret\n");
    const linkFile = join(testDir, "escape-link.txt");
    symlinkSync(outsideFile, linkFile);

    try {
      const staleRef = "aa1-aa1/aaaaaa";
      const result = await edit({
        file_path: linkFile,
        edits: [{ ref: staleRef, range: "aa1", content: "hacked" }],
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
    const secretFile = writeTestFile(testDir, "passwords.secret", "hunter2\n");

    const lines = ["hunter2"];
    const ref = issueTestRef(lines, 1, 1);
    const h = lineHash("hunter2");

    const result = await edit({
      file_path: secretFile,
      edits: [{ ref, range: `${h}1`, content: "redacted" }],
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
    const { path } = setupFile(testDir, "large.txt", content);

    const target = "line 500";
    const h500 = lineHash(target);
    const narrowRef = issueTestRef(lines, 498, 502);

    const result = await edit({
      file_path: path,
      edits: [{ ref: narrowRef, range: `${h500}500`, content: "REPLACED 500" }],
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
    const { path } = setupFile(testDir, "scatter.txt", content);

    const ref = issueTestRef(lines, 1, 500);

    const result = await edit({
      file_path: path,
      edits: [
        { ref, range: `${lineHash("line 1")}1`, content: "FIRST" },
        { ref, range: `${lineHash("line 250")}250`, content: "MIDDLE" },
        { ref, range: `${lineHash("line 500")}500`, content: "LAST" },
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
// Ref validation
// =============================================================================

describe("ref validation", () => {
  test("rejects unknown ref", async () => {
    const { path } = setupFile(testDir, "nopfx.txt", "aaa\n");
    const h = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [{ ref: "NONEXISTENT", range: `${h}1`, content: "x" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid checksum");
  });

  test("rejects garbled ref", async () => {
    const { path } = setupFile(testDir, "garbled.txt", "aaa\n");
    const h = lineHash("aaa");

    const result = await edit({
      file_path: path,
      edits: [{ ref: "not-a-ref", range: `${h}1`, content: "x" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid checksum");
  });
});
