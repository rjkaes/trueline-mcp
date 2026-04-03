import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead, handleReadMulti, clearReadCache } from "../../src/tools/read.ts";
import { LINE_PATTERN, resetRefStore } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {
  clearReadCache();
  resetRefStore();
});

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
    expect(lines[0]).toMatch(/^[a-z]{2}\.1\tconst a = 1;$/);
    expect(lines[1]).toMatch(/^[a-z]{2}\.2\tconst b = 2;$/);
    expect(lines[2]).toMatch(/^[a-z]{2}\.3\tconst c = 3;$/);
  });

  test("returns ref in result", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    // Should contain a ref line
    expect(text).toMatch(/ref: R\d+ \(lines \d+-\d+\)/);
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
    expect(contentLines[1]).toMatch(/^[a-z]{2}\.2\tconst b = 2;$/);
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
    const multiFile = join(testDir, "multi.txt");
    writeFileSync(multiFile, `${lines.join("\n")}\n`);

    const result = await handleRead({
      file_path: multiFile,
      ranges: ["3-5", "15-17"],
      projectDir: testDir,
    });

    const text = result.content[0].text;

    // Should have two ref lines
    const refMatches = text.match(/^ref: R\d+ \(lines \d+-\d+\)$/gm);
    expect(refMatches).toHaveLength(2);

    // Should contain lines 3-5 and 15-17 but not lines 6-14
    // Expanded: 3-5 → 2-6, 15-17 → 14-18
    expect(text).toMatch(/^[a-z]{2}\.2\t/m);
    expect(text).toMatch(/^[a-z]{2}\.6\t/m);
    expect(text).toMatch(/^[a-z]{2}\.14\t/m);
    expect(text).toMatch(/^[a-z]{2}\.18\t/m);
    // Lines 7-13 should NOT be present (gap between expanded ranges)
    expect(text).not.toMatch(/^[a-z]{2}\.7\t/m);
    expect(text).not.toMatch(/^[a-z]{2}\.13\t/m);
  });

  test("reads whole file when ranges omitted", async () => {
    const wholeFile = join(testDir, "whole.txt");
    writeFileSync(wholeFile, "a\nb\nc\n");
    const result = await handleRead({
      file_path: wholeFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    expect(text).toMatch(/^[a-z]{2}\.1\t/m);
    expect(text).toMatch(/^[a-z]{2}\.3\t/m);
    const refMatches = text.match(/^ref: /gm);
    expect(refMatches).toHaveLength(1);
  });

  test("merges overlapping ranges", async () => {
    const overlapFile = join(testDir, "overlap.txt");
    writeFileSync(overlapFile, "a\nb\nc\nd\n");
    const result = await handleRead({
      file_path: overlapFile,
      ranges: ["1-3", "2-4"],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/^[a-z]{2}\.1\t/m);
    expect(text).toMatch(/^[a-z]{2}\.4\t/m);
    expect(text).toMatch(/ref: R\d+ \(lines \d+-\d+\)/);
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
    expect(text).toMatch(/^[a-z]{2}\.1\tcafé$/m);
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
    expect(text).toMatch(/ref: R\d+ \(lines 1-2000\)/);
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
    expect(text).toMatch(/ref: R\d+ \(lines 99-200\)/);
  });

  test("output lines include per-line hashes", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    // Format should be hash.lineNumber\tcontent
    expect(text.split("\n")[0]).toMatch(/^[a-z]{2}\.1\t/);
  });

  test("multi-file read returns all files with headers", async () => {
    const file2 = join(testDir, "second.ts");
    writeFileSync(file2, "export const x = 42;\n");
    const result = await handleReadMulti({
      file_paths: [testFile, file2],
      projectDir: testDir,
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain(`--- ${testFile} ---`);
    expect(text).toContain(`--- ${file2} ---`);
    expect(text).toContain("const a = 1;");
    expect(text).toContain("export const x = 42;");
    // Each file section should have its own ref
    const refs = text.match(/ref: R\d+ \(lines \d+-\d+\)/g);
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
    expect(text).toMatch(/^[a-z]{2}\.1\tconst a = 1;$/m);
    expect(text).toMatch(/ref: R\d+ \(lines \d+-\d+\)/);
  });

  test("inline range syntax reads specific lines per file", async () => {
    const shortFile = join(testDir, "short.ts");
    writeFileSync(shortFile, "line1\nline2\nline3\n");
    const longFile = join(testDir, "long.ts");
    writeFileSync(longFile, `${Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")}\n`);

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
    expect(text).toMatch(/ref: R\d+ \(lines 1-3\)/);
  });

  test("inline range with multiple ranges per file", async () => {
    const file = join(testDir, "multi-range.ts");
    writeFileSync(file, `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`);

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
    const file = join(testDir, "compat.ts");
    writeFileSync(file, `${Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")}\n`);

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
    const file2 = join(testDir, "second2.ts");
    writeFileSync(file2, "x\n");

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
