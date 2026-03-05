import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../../src/tools/read.ts";
import { EMPTY_FILE_CHECKSUM } from "../../src/hash.ts";
import { rangeChecksum } from "../helpers.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-read-edge-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// =============================================================================
// Empty and single-line files
// =============================================================================

describe("empty and minimal files", () => {
  test("empty file returns sentinel checksum", async () => {
    const f = join(testDir, "empty.txt");
    writeFileSync(f, "");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("(empty file)");
    expect(result.content[0].text).toContain(EMPTY_FILE_CHECKSUM);
  });

  test("single line with trailing newline", async () => {
    const f = join(testDir, "single-trailing.txt");
    writeFileSync(f, "hello\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|hello$/);
  });

  test("single line without trailing newline", async () => {
    const f = join(testDir, "single-no-trailing.txt");
    writeFileSync(f, "hello");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|hello$/);
  });

  test("file with only a newline is one empty-string line", async () => {
    const f = join(testDir, "just-newline.txt");
    writeFileSync(f, "\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(1);
    // The line content is empty — so it should be "1:XX|" with nothing after the pipe
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|$/);
  });

  test("file with multiple blank lines", async () => {
    const f = join(testDir, "blank-lines.txt");
    writeFileSync(f, "\n\n\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(3);
  });
});

// =============================================================================
// Line ending variations
// =============================================================================

describe("line endings", () => {
  test("bare CR (classic Mac) line endings", async () => {
    const f = join(testDir, "bare-cr.txt");
    writeFileSync(f, "aaa\rbbb\rccc\r");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|aaa$/);
    expect(lines[1]).toMatch(/^2:[a-z]{2}\|bbb$/);
    expect(lines[2]).toMatch(/^3:[a-z]{2}\|ccc$/);
  });

  test("CRLF line endings", async () => {
    const f = join(testDir, "crlf.txt");
    writeFileSync(f, "aaa\r\nbbb\r\nccc\r\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(3);
    // Content should not contain \r
    for (const l of lines) {
      expect(l).not.toContain("\r");
    }
  });

  test("mixed line endings are all recognized", async () => {
    const f = join(testDir, "mixed-endings.txt");
    // LF, CRLF, CR — all should produce separate lines
    writeFileSync(f, "aaa\nbbb\r\nccc\rddd");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(4);
  });

  test("bare CR at end without trailing content", async () => {
    const f = join(testDir, "trailing-cr.txt");
    writeFileSync(f, "aaa\r");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|aaa$/);
  });
});

// =============================================================================
// Unicode and special content
// =============================================================================

describe("unicode content", () => {
  test("BMP characters (CJK, emoji)", async () => {
    const f = join(testDir, "unicode-bmp.txt");
    writeFileSync(f, "日本語\nΣΩΔ\n¡¿\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("日本語");
    expect(lines[1]).toContain("ΣΩΔ");
  });

  test("astral plane characters (surrogate pairs)", async () => {
    const f = join(testDir, "unicode-astral.txt");
    // 𝕳 (U+1D573) and 🎉 (U+1F389) require surrogate pairs in UTF-16
    writeFileSync(f, "𝕳ello 🎉\nworld 𝄞\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("𝕳ello 🎉");
    expect(lines[1]).toContain("world 𝄞");
  });

  test("line with only whitespace preserves content", async () => {
    const f = join(testDir, "whitespace.txt");
    writeFileSync(f, "  \t  \n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("  \t  ");
  });

  test("line containing pipe character in content", async () => {
    const f = join(testDir, "pipe-in-content.txt");
    writeFileSync(f, "a|b|c\nfoo | bar\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // The protocol format uses the first pipe as delimiter — content after
    // the first pipe should include subsequent pipes verbatim.
    expect(text).toContain("|a|b|c");
    expect(text).toContain("|foo | bar");
  });
});

// =============================================================================
// Binary detection
// =============================================================================

describe("binary detection", () => {
  test("null byte in first line", async () => {
    const f = join(testDir, "null-first.bin");
    writeFileSync(f, Buffer.from("abc\x00def\nline2\n"));

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("binary");
  });

  test("null byte in later line", async () => {
    const f = join(testDir, "null-later.bin");
    writeFileSync(f, "line1\nline2\x00oops\nline3\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("binary");
  });

  test("null byte beyond start_line range is still detected", async () => {
    const f = join(testDir, "null-in-range.bin");
    writeFileSync(f, "ok\nok\nbad\x00line\n");

    const result = await handleRead({ file_path: f, start_line: 3, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("binary");
  });
});

// =============================================================================
// start_line / end_line range handling
// =============================================================================

describe("range parameters", () => {
  test("start_line = 0 is rejected", async () => {
    const f = join(testDir, "range.txt");
    writeFileSync(f, "aaa\nbbb\n");

    const result = await handleRead({ file_path: f, start_line: 0, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be >= 1");
  });

  test("negative start_line is rejected", async () => {
    const f = join(testDir, "range-neg.txt");
    writeFileSync(f, "aaa\nbbb\n");

    const result = await handleRead({ file_path: f, start_line: -1, projectDir: testDir });
    expect(result.isError).toBe(true);
  });

  test("start_line beyond file length returns error", async () => {
    const f = join(testDir, "range-beyond.txt");
    writeFileSync(f, "aaa\nbbb\n");

    const result = await handleRead({ file_path: f, start_line: 100, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("out of range");
  });

  test("end_line < start_line is rejected", async () => {
    const f = join(testDir, "range-backwards.txt");
    writeFileSync(f, "aaa\nbbb\nccc\n");

    const result = await handleRead({ file_path: f, start_line: 3, end_line: 1, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be >= start_line");
  });

  test("end_line beyond file length silently clamps", async () => {
    const f = join(testDir, "range-overshoot.txt");
    writeFileSync(f, "aaa\nbbb\n");

    const result = await handleRead({ file_path: f, start_line: 1, end_line: 999, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(2);
  });

  test("start_line = end_line reads exactly one line", async () => {
    const f = join(testDir, "range-single.txt");
    writeFileSync(f, "aaa\nbbb\nccc\n");

    const result = await handleRead({ file_path: f, start_line: 2, end_line: 2, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^2:[a-z]{2}\|bbb$/);
  });

  test("reading a middle range produces correct checksum", async () => {
    const f = join(testDir, "range-checksum.txt");
    const fileLines = ["aaa", "bbb", "ccc", "ddd", "eee"];
    writeFileSync(f, fileLines.join("\n") + "\n");

    const result = await handleRead({ file_path: f, start_line: 2, end_line: 4, projectDir: testDir });
    expect(result.isError).toBeUndefined();

    const expectedCs = rangeChecksum(fileLines, 2, 4);
    expect(result.content[0].text).toContain(`checksum: ${expectedCs}`);
  });
});

// =============================================================================
// Checksum consistency
// =============================================================================

describe("checksum consistency", () => {
  test("full-file read checksum matches rangeChecksum helper", async () => {
    const f = join(testDir, "cs-full.txt");
    const fileLines = ["alpha", "beta", "gamma"];
    writeFileSync(f, fileLines.join("\n") + "\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    const expectedCs = rangeChecksum(fileLines, 1, 3);
    expect(result.content[0].text).toContain(`checksum: ${expectedCs}`);
  });

  test("identical content produces identical hashes", async () => {
    const f1 = join(testDir, "dup1.txt");
    const f2 = join(testDir, "dup2.txt");
    writeFileSync(f1, "same\ncontent\n");
    writeFileSync(f2, "same\ncontent\n");

    const r1 = await handleRead({ file_path: f1, projectDir: testDir });
    const r2 = await handleRead({ file_path: f2, projectDir: testDir });
    // Extract checksum lines
    const cs1 = r1.content[0].text.split("\n").find((l) => l.startsWith("checksum:"));
    const cs2 = r2.content[0].text.split("\n").find((l) => l.startsWith("checksum:"));
    expect(cs1).toBe(cs2);
  });

  test("different content produces different checksums", async () => {
    const f1 = join(testDir, "diff1.txt");
    const f2 = join(testDir, "diff2.txt");
    writeFileSync(f1, "aaa\nbbb\n");
    writeFileSync(f2, "aaa\nccc\n");

    const r1 = await handleRead({ file_path: f1, projectDir: testDir });
    const r2 = await handleRead({ file_path: f2, projectDir: testDir });
    const cs1 = r1.content[0].text.split("\n").find((l) => l.startsWith("checksum:"));
    const cs2 = r2.content[0].text.split("\n").find((l) => l.startsWith("checksum:"));
    expect(cs1).not.toBe(cs2);
  });

  test("line hash is deterministic across reads", async () => {
    const f = join(testDir, "deterministic.txt");
    writeFileSync(f, "hello world\n");

    const r1 = await handleRead({ file_path: f, projectDir: testDir });
    const r2 = await handleRead({ file_path: f, projectDir: testDir });
    // Extract the hash portion of the first content line
    const hash1 = r1.content[0].text.split("\n")[0].match(/^1:([a-z]{2})/)?.[1];
    const hash2 = r2.content[0].text.split("\n")[0].match(/^1:([a-z]{2})/)?.[1];
    expect(hash1).toBe(hash2);
  });
});

// =============================================================================
// Long lines and large content
// =============================================================================

describe("long lines", () => {
  test("very long line (10KB)", async () => {
    const f = join(testDir, "long-line.txt");
    const longLine = "x".repeat(10_000);
    writeFileSync(f, longLine + "\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(longLine);
  });

  test("many short lines (1000)", async () => {
    const f = join(testDir, "many-lines.txt");
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(f, lines.join("\n") + "\n");

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const contentLines = result.content[0].text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(contentLines).toHaveLength(1000);
    // Verify line numbering at boundaries
    expect(contentLines[0]).toMatch(/^1:/);
    expect(contentLines[999]).toMatch(/^1000:/);
  });
});

// =============================================================================
// Filesystem edge cases
// =============================================================================

describe("filesystem edge cases", () => {
  test("symlink to a file within project is readable", async () => {
    const target = join(testDir, "symlink-target.txt");
    const link = join(testDir, "symlink-link.txt");
    writeFileSync(target, "target content\n");
    try {
      symlinkSync(target, link);
    } catch {
      /* may fail on some OS */
    }

    const result = await handleRead({ file_path: link, projectDir: testDir });
    // Should succeed and read the target content
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("target content");
  });

  test("file outside project directory is rejected", async () => {
    // Create a file in a sibling directory
    const otherDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-other-")));
    const otherFile = join(otherDir, "secret.txt");
    writeFileSync(otherFile, "secret\n");

    try {
      const result = await handleRead({ file_path: otherFile, projectDir: testDir });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("outside");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("directory path is rejected", async () => {
    const d = join(testDir, "subdir");
    mkdirSync(d, { recursive: true });

    const result = await handleRead({ file_path: d, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a regular file");
  });
});
