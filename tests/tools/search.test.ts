import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";
import { getText, resetRefStore } from "../helpers.ts";

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

beforeEach(() => {
  resetRefStore();
});

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
    // Should have refs
    expect(text).toMatch(/ref: R\d+ \(lines \d+-\d+\)/);
    // Should have per-line hashes
    expect(text).toMatch(/^[a-z]{2}\.\d+\t/m);
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
    const refMatches = text.match(/ref: R\d+/g);
    expect(refMatches?.length).toBe(1);
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

  test("regex mode matches regex patterns", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "function \\w+",
      regex: true,
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("function hello");
    expect(text).toContain("function world");
  });

  test("regex mode rejects invalid regex", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "[invalid",
      regex: true,
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Invalid regex");
  });

  test("literal mode does not reject regex metacharacters", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "[invalid",
      projectDir: testDir,
    });
    // Should not error — treated as literal
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("No matches");
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
    expect(text).toMatch(/ref: R\d+ \(lines \d+-\d+\)/);
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

  test("literal mode matches metacharacters without escaping", async () => {
    // The test file has 'console.log("hello")' — the dot and parens are regex metacharacters
    const result = await handleSearch({
      file_path: testFile,
      pattern: "console.log(",
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("console.log");
    expect(text).toMatch(/ref: R\d+ \(lines \d+-\d+\)/);
  });

  test("literal mode treats bare parens as literal text", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "hello(",
      projectDir: testDir,
    });
    // Should not error — literal match, not regex
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
  test("rejects pattern with embedded newlines", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "hello\nworld",
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("line-by-line");
  });
  test("rejects regex pattern with embedded newlines", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "hello\nworld",
      regex: true,
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("line-by-line");
  });
});
