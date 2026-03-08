import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-search-test-")));
  testFile = join(testDir, "sample.ts");
  writeFileSync(
    testFile,
    [
      "const a = 1;",
      "const b = 2;",
      "function hello() {",
      '  console.log("hello");',
      "}",
      "",
      "function world() {",
      '  console.log("world");',
      "}",
      "const c = 3;",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function getText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe("trueline_search", () => {
  test("finds matching lines with context", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "console.log",
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    // Should find both console.log lines
    expect(text).toContain("hello");
    expect(text).toContain("world");
    // Should have checksums
    expect(text).toContain("checksum:");
    // Should have per-line hashes
    expect(text).toMatch(/\d+:[a-z2-7]{2}\|/);
  });

  test("respects context_lines parameter", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "console.log",
      context_lines: 0,
      projectDir: testDir,
    });
    const text = getText(result);
    // With 0 context, should only have the matching lines
    expect(text).toContain("console.log");
    expect(text).not.toContain("const a");
  });

  test("merges overlapping context windows", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "console.log",
      context_lines: 5,
      projectDir: testDir,
    });
    const text = getText(result);
    // With context_lines=5, the two matches (lines 4 and 8) overlap — should be one block
    const checksumMatches = text.match(/checksum:/g);
    expect(checksumMatches?.length).toBe(1);
  });

  test("respects max_matches", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "const",
      max_matches: 1,
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("const a");
    // Should indicate truncation
    expect(text).toContain("(showing 1 of");
  });

  test("returns no-matches message for zero hits", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "nonexistent_xyz",
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("No matches");
  });

  test("handles regex patterns", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "function \\w+",
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("function hello");
    expect(text).toContain("function world");
  });

  test("rejects invalid regex", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "[invalid",
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Invalid regex");
  });

  test("case_insensitive matches case-insensitively", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "HELLO",
      case_insensitive: true,
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("hello");
    expect(text).toContain("checksum:");
  });

  test("case_insensitive false (default) does not match wrong case", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "HELLO",
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("No matches");
  });

  test("fixed_string matches literal metacharacters", async () => {
    // The test file has 'console.log("hello")' — the dot and parens are regex metacharacters
    const result = await handleSearch({
      file_path: testFile,
      pattern: "console.log(",
      fixed_string: true,
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("console.log");
    expect(text).toContain("checksum:");
  });

  test("fixed_string does not treat pattern as regex", async () => {
    // Without fixed_string, '(' would be an invalid regex
    const result = await handleSearch({
      file_path: testFile,
      pattern: "hello(",
      fixed_string: true,
      projectDir: testDir,
    });
    const text = getText(result);
    // Should not error — the bare '(' is escaped
    expect(result.isError).toBeUndefined();
  });
  test("validates file path", async () => {
    const result = await handleSearch({
      file_path: "/etc/passwd",
      pattern: "root",
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });
});
