import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead, handleReadMulti } from "../../src/tools/read.ts";
import { LINE_PATTERN, getText, writeTestFile } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {});

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-read-test-")));
  testFile = join(testDir, "sample.ts");
  writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  // Create .claude/settings.json with a deny pattern
  const claudeDir = join(testDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      permissions: { deny: ["Read(.env)", "Read(**/*.secret)"] },
    }),
  );

  // Create a denied file
  writeFileSync(join(testDir, ".env"), "SECRET=abc\n");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleRead", () => {
  test("returns trueline-formatted content", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter(Boolean);
    // Should have 3 content lines + blank + checksum line
    expect(lines[0]).toMatch(/^[a-z]{2}1\tconst a = 1;$/);
    expect(lines[1]).toMatch(/^[a-z]{2}2\tconst b = 2;$/);
    expect(lines[2]).toMatch(/^[a-z]{2}3\tconst c = 3;$/);
  });

  test("returns ref in result", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    // Should contain a ref line
    expect(text).toMatch(/ref: \S+/);
  });

  test("supports ranges param", async () => {
    const result = await handleRead({
      file_path: testFile,
      ranges: ["2"],
      projectDir: testDir,
    });
    const text = result.content[0].text;
    const contentLines = text.split("\n").filter((l) => l.match(LINE_PATTERN));
    // Expanded by 1 on each side: line 2 → lines 1-3 (whole file)
    expect(contentLines).toHaveLength(3);
    expect(contentLines[1]).toMatch(/^[a-z]{2}2\tconst b = 2;$/);
  });

  test("denies reading .env file", async () => {
    const result = await handleRead({
      file_path: join(testDir, ".env"),
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied");
  });

  test("returns error for nonexistent file", async () => {
    const result = await handleRead({
      file_path: join(testDir, "nope.ts"),
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("reads multiple disjoint ranges with separate checksums", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const multiFile = writeTestFile(testDir, "multi.txt", `${lines.join("\n")}\n`);

    const result = await handleRead({
      file_path: multiFile,
      ranges: ["3-5", "15-17"],
      projectDir: testDir,
    });

    const text = result.content[0].text;

    // Should have two ref lines
    const refMatches = text.match(/^ref: [a-z]{2}\d+-[a-z]{2}\d+\/[a-z]{6}$/gm);
    expect(refMatches).toHaveLength(2);

    // Should contain lines 3-5 and 15-17 but not lines 6-14
    // Expanded: 3-5 → 2-6, 15-17 → 14-18
    expect(text).toMatch(/^[a-z]{2}2\t/m);
    expect(text).toMatch(/^[a-z]{2}6\t/m);
    expect(text).toMatch(/^[a-z]{2}14\t/m);
    expect(text).toMatch(/^[a-z]{2}18\t/m);
    // Lines 7-13 should NOT be present (gap between expanded ranges)
    expect(text).not.toMatch(/^[a-z]{2}7\t/m);
    expect(text).not.toMatch(/^[a-z]{2}13\t/m);
  });

  test("reads whole file when ranges omitted", async () => {
    const wholeFile = writeTestFile(testDir, "whole.txt", "a\nb\nc\n");
    const result = await handleRead({
      file_path: wholeFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    expect(text).toMatch(/^[a-z]{2}1\t/m);
    expect(text).toMatch(/^[a-z]{2}3\t/m);
    const refMatches = text.match(/^ref:/gm);
    expect(refMatches).toHaveLength(1);
  });

  test("merges overlapping ranges", async () => {
    const overlapFile = writeTestFile(testDir, "overlap.txt", "a\nb\nc\nd\n");
    const result = await handleRead({
      file_path: overlapFile,
      ranges: ["1-3", "2-4"],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/^[a-z]{2}1\t/m);
    expect(text).toMatch(/^[a-z]{2}4\t/m);
    expect(text).toMatch(/ref: \S+/);
  });

  test("hash is based on raw file bytes, not decoded string", async () => {
    // Latin-1 file: 0xe9 = é in latin1, but 0xc3 0xa9 in UTF-8
    // If we hash raw bytes, the hash should be based on the single 0xe9 byte
    const latin1File = join(testDir, "latin1.txt");
    writeFileSync(latin1File, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café\n"

    const result = await handleRead({
      file_path: latin1File,
      encoding: "latin1",
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // The decoded content should show "café"
    expect(text).toContain("café");
    // And the hash should be present
    expect(text).toMatch(/^[a-z]{2}1\tcafé$/m);
  });

  test("truncates output at 2000 lines", async () => {
    // Generate a file with 3000 lines
    const bigFile = join(testDir, "big.ts");
    const lines = Array.from({ length: 3000 }, (_, i) => `const x${i} = ${i};`);
    writeFileSync(bigFile, `${lines.join("\n")}\n`);

    const result = await handleRead({ file_path: bigFile, allowedDirs: [testDir] });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;

    // Should have a ref covering only the returned lines
    expect(text).toMatch(/ref: \S+/);
    // Should include truncation notice
    expect(text).toContain("truncated");
    expect(text).toContain("2000 line limit");
    // Should NOT contain line 2001
    expect(text).not.toMatch(/\b2001\t/);
  });

  test("does not truncate when ranges stay under limit", async () => {
    // Same big file, but read only 100 lines
    const bigFile = join(testDir, "big.ts");
    const result = await handleRead({
      file_path: bigFile,
      ranges: ["100-199"],
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("truncated");
    expect(text).toMatch(/ref: \S+/);
  });

  test("output lines include per-line hashes", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    // Format should be hashLineNumber\tcontent
    expect(text.split("\n")[0]).toMatch(/^[a-z]{2}1\t/);
  });

  test("multi-file read returns all files with headers", async () => {
    const file2 = writeTestFile(testDir, "second.ts", "export const x = 42;\n");
    const result = await handleReadMulti({
      file_paths: [testFile, file2],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("--- sample.ts ---");
    expect(text).toContain("--- second.ts ---");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("export const x = 42;");
    // Each file section should have its own ref
    const refs = text.match(/ref: \S+/g);
    expect(refs).toHaveLength(2);
  });

  test("single-file via handleReadMulti delegates to handleRead", async () => {
    const single = await handleReadMulti({
      file_paths: [testFile],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    // The second read hits the cache, so it returns a stub — just verify
    // the multi wrapper returns the same structure as a direct read.
    expect(single.isError).toBeUndefined();
    const text = single.content[0].text;
    expect(text).toMatch(/^[a-z]{2}1\tconst a = 1;$/m);
    expect(text).toMatch(/ref: \S+/);
  });

  test("inline range syntax reads specific lines per file", async () => {
    const shortFile = writeTestFile(testDir, "short.ts", "line1\nline2\nline3\n");
    const longFile = writeTestFile(
      testDir,
      "long.ts",
      `${Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
    );

    const result = await handleReadMulti({
      file_paths: [`${longFile}:40-45`, `${shortFile}:2-3`],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line40");
    expect(text).toContain("line45");
    // line 39 appears as context (expandRanges adds 1-line padding)
    expect(text).not.toContain("line38");
    expect(text).toContain("line2");
    expect(text).toContain("line3");
    // Short file ref should cover lines 1-3 (range 2-3 + 1-line context expansion)
    expect(text).toMatch(/ref: \S+/);
  });

  test("inline range with multiple ranges per file", async () => {
    const file = writeTestFile(
      testDir,
      "multi-range.ts",
      `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
    );

    const result = await handleReadMulti({
      file_paths: [`${file}:1-3,18-20`],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line1");
    expect(text).toContain("line3");
    expect(text).toContain("line18");
    expect(text).toContain("line20");
    expect(text).not.toContain("line10");
  });

  test("top-level ranges still work for single file", async () => {
    const file = writeTestFile(
      testDir,
      "compat.ts",
      `${Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
    );

    const result = await handleReadMulti({
      file_paths: [file],
      ranges: ["3-5"],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line3");
    expect(text).toContain("line5");
    // Context expansion adds 1 line padding, so line2 appears
    expect(text).not.toContain("line1");
  });

  test("top-level ranges with multiple files returns error", async () => {
    const file2 = writeTestFile(testDir, "second2.ts", "x\n");

    const result = await handleReadMulti({
      file_paths: [testFile, file2],
      ranges: ["1-5"],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("inline range syntax");
  });

  test("file_path without colon range reads whole file", async () => {
    const result = await handleReadMulti({
      file_paths: [testFile],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("const a = 1;");
    expect(text).toContain("const c = 3;");
  });
});

describe("read range handling", () => {
  // read.ts:168-169 validates against the boundary-expanded range, so the
  // error names start-1 instead of the line the caller asked for.
  test("out-of-range error names the requested start line", async () => {
    const file = writeTestFile(testDir, "five-lines.txt", "a\nb\nc\nd\ne\n");

    const result = await handleRead({ file_path: file, ranges: ["50-60"], projectDir: testDir });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("start_line 50 ");
  });

  // Same root cause: the +/-1 boundary expansion runs before the EOF check, so
  // a range starting one line past EOF is served as the last line instead of
  // the "out of range" error that line 7 (or "100-") gets.
  test("range starting one line past EOF is an error", async () => {
    const file = writeTestFile(testDir, "five-lines-eof.txt", "a\nb\nc\nd\ne\n");

    const result = await handleRead({ file_path: file, ranges: ["6"], projectDir: testDir });

    expect(result.isError).toBe(true);
  });

  // Graceful degradation: valid ranges are served and each out-of-range one is
  // named, so one bad range does not discard the rest. Error only when none is valid.
  test("a later range past EOF is skipped with a note, valid ranges are still served", async () => {
    const file = writeTestFile(testDir, "two-ranges.txt", "a\nb\nc\nd\ne\n");

    const result = await handleRead({ file_path: file, ranges: ["1-2", "9"], projectDir: testDir });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toMatch(/\ta$/m);
    expect(text).toMatch(/\tb$/m);
    expect(text).toContain("range 9 skipped");
    expect(text).toContain("file has 5 lines");
    expect(text).not.toContain("range 1-2 skipped");
  });

  test("the note names each out-of-range range", async () => {
    const file = writeTestFile(testDir, "three-bad-ranges.txt", "a\nb\nc\nd\ne\n");

    const result = await handleRead({ file_path: file, ranges: ["1-2", "9", "20-30", "40-"], projectDir: testDir });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain("range 9 skipped");
    expect(text).toContain("range 20-30 skipped");
    expect(text).toContain("range 40- skipped");
  });

  test("every range out of range is still an error", async () => {
    const file = writeTestFile(testDir, "all-bad-ranges.txt", "a\nb\nc\nd\ne\n");

    const result = await handleRead({ file_path: file, ranges: ["9", "20-30"], projectDir: testDir });

    expect(result.isError).toBe(true);
    expect(getText(result)).toBe("start_line 9 out of range (file has 5 lines)");
  });

  // read.ts:182/190 append em-dash notices as UTF-8 bytes into a buffer that is
  // then decoded with the caller's encoding, garbling them under latin1.
  test("truncation notice is intact under encoding=latin1", async () => {
    const file = writeTestFile(testDir, "long.txt", Array.from({ length: 2100 }, (_, i) => `row ${i + 1}`).join("\n"));

    const result = await handleRead({ file_path: file, encoding: "latin1", projectDir: testDir });

    expect(getText(result)).toContain("(truncated at 2000 line limit — use ranges");
  });
});

describe("read multi-file batch", () => {
  // read.ts:226/244: the multi-file guard counts only absolute entries, and the
  // multi-file branch then drops top-level `ranges`, returning the full file.
  test("top-level ranges are not silently ignored when a relative sibling is rejected", async () => {
    const file = writeTestFile(testDir, "ranged.txt", Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n"));

    const result = await handleReadMulti({
      file_paths: ["relative/sibling.txt", file],
      ranges: ["2-3"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });

    expect(getText(result)).not.toContain("row 10");
  });

  // handleReadMulti re-parses glob-expanded real paths for inline ranges, so a
  // matched file named "snapshot:5" is split into "snapshot" plus range 5.
  test.skipIf(process.platform === "win32")("glob match ending in :<digits> is read as a filename", async () => {
    writeTestFile(testDir, "snapshot:5", Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n"));

    const result = await handleReadMulti({ file_paths: [join(testDir, "snapshot*")], projectDir: testDir });

    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("row 10");
  });
});
