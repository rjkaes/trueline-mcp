import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";
import { getText, resetRefStore } from "../helpers.ts";

let testDir: string;
let testFile: string;
let testFile2: string;

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
  testFile2 = join(testDir, "other.ts");
  writeFileSync(
    testFile2,
    ["import { hello } from './sample';", "const greeting = hello();", "console.log(greeting);"].join("\n"),
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
    expect(text).toMatch(/ref:R\d+/);
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
    const refMatches = text.match(/ref:R\d+/g);
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
    expect(text).toMatch(/ref:R\d+/);
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
    expect(text).toMatch(/ref:R\d+/);
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

test("allows regex pattern with newlines when multiline=true", async () => {
  const result = await handleSearch({
    file_paths: [testFile],
    pattern: "hello\\(\\).*\\n.*console",
    multiline: true,
    projectDir: testDir,
  });
  expect(result.isError).toBeUndefined();
});

test("still rejects literal newlines when multiline=false", async () => {
  const result = await handleSearch({
    file_paths: [testFile],
    pattern: "hello\nworld",
    projectDir: testDir,
  });
  expect(result.isError).toBe(true);
  expect(getText(result)).toContain("multiline");
});

describe("multi-file search", () => {
  test("searches multiple files in one call", async () => {
    const result = await handleSearch({
      file_paths: [testFile, testFile2],
      pattern: "console.log",
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain(`--- ${testFile} ---`);
    expect(text).toContain(`--- ${testFile2} ---`);
    expect(text).toContain('"hello"');
    expect(text).toContain("greeting");
    const refs = text.match(/ref:R\d+/g);
    expect(refs!.length).toBeGreaterThanOrEqual(2);
  });

  test("global max_matches applies across files", async () => {
    const result = await handleSearch({
      file_paths: [testFile, testFile2],
      pattern: "console.log",
      max_matches: 1,
      projectDir: testDir,
    });
    const text = getText(result);
    const matchMarkers = text.match(/\u2190 match/g);
    expect(matchMarkers?.length).toBe(1);
    expect(text).toContain("showing 1 of");
  });

  test("per-file errors don't abort other files", async () => {
    const result = await handleSearch({
      file_paths: ["/nonexistent/file.ts", testFile],
      pattern: "console.log",
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("error:");
    expect(text).toContain("console.log");
    expect(text).toMatch(/ref:R\d+/);
  });

  test("single file_paths omits file header", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "console.log",
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).not.toContain("---");
    expect(text).toContain("console.log");
    expect(text).toMatch(/ref:R\d+/);
  });

  test("file_path string alias still works", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "console.log",
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("console.log");
  });

  test("empty file_paths returns error", async () => {
    const result = await handleSearch({
      file_paths: [],
      pattern: "console.log",
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("no matches across multiple files shows combined message", async () => {
    const result = await handleSearch({
      file_paths: [testFile, testFile2],
      pattern: "nonexistent_xyz",
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("No matches");
    expect(text).toContain("2 files");
  });
});

describe("search ref stores resolved path", () => {
  test("ref from relative-path search contains the absolute resolved path", async () => {
    const { resolveRef } = await import("../../src/ref-store.ts");

    // Search using a relative path constructed from the testDir basename
    const relative = join(".", "sample.ts");
    const result = await handleSearch({
      file_path: relative,
      pattern: "hello",
      context_lines: 0,
      projectDir: testDir,
    });

    const text = getText(result);
    // Extract ref ID from output like "ref:R1"
    const refMatch = text.match(/ref:(R\d+)/);
    expect(refMatch).not.toBeNull();

    const entry = resolveRef(refMatch![1]);
    // The stored filePath must be the absolute resolved path, not the relative input
    expect(entry.filePath).toBe(await realpath(join(testDir, "sample.ts")));
  });
});

describe("context_lines=0 non-adjacent matches", () => {
  test("produces separate refs for non-adjacent matches", async () => {
    // Lines 1-11: match on 1 and 11, gap of 9 non-matching lines between.
    // With context_lines=0, each match must flush as its own window so the
    // ref checksum covers only contiguous lines.  Before the fix, the two
    // matches merged into one sparse window whose checksum excluded lines
    // 2-10, causing a guaranteed mismatch in streamingEdit.
    const lines = [
      "MATCH_A",
      "filler 2",
      "filler 3",
      "filler 4",
      "filler 5",
      "filler 6",
      "filler 7",
      "filler 8",
      "filler 9",
      "filler 10",
      "MATCH_B",
    ];
    writeFileSync(testFile, `${lines.join("\n")}\n`);

    const result = await handleSearch({
      file_path: testFile,
      pattern: "MATCH_",
      context_lines: 0,
      projectDir: testDir,
    });
    const text = getText(result);

    // Should have two separate refs, one per match
    const refs = [...text.matchAll(/ref:(R\d+)/g)];
    expect(refs.length).toBe(2);

    // Each ref should cover a single line, not a sparse range
    const { resolveRef } = await import("../../src/ref-store.ts");
    const ref1 = resolveRef(refs[0][1]);
    const ref2 = resolveRef(refs[1][1]);
    expect(ref1.startLine).toBe(1);
    expect(ref1.endLine).toBe(1);
    expect(ref2.startLine).toBe(11);
    expect(ref2.endLine).toBe(11);
  });
});
