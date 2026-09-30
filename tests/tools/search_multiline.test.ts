import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";
import { getText } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-multiline-test-")));
  testFile = join(testDir, "multiline.ts");
  writeFileSync(
    testFile,
    [
      "function processData(",
      "  input: string,",
      "  options: Options",
      "): Result {",
      '  console.log("processing");',
      "  return transform(input);",
      "}",
      "",
      "function simpleHelper(): void {",
      '  console.log("helper");',
      "}",
      "",
      "function anotherMultiline(",
      "  first: number,",
      "  second: number",
      "): number {",
      "  return first + second;",
      "}",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {});

describe("multiline search", () => {
  test("matches pattern spanning multiple lines", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "function processData\\([\\s\\S]*?\\): Result",
      multiline: true,
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("function processData(");
    expect(text).toContain("): Result {");
    expect(text).toContain("->");
    expect(text).toMatch(/ref: \S+/);
  });

  test("multiline implies regex", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "function \\w+\\(",
      multiline: true,
      regex: false,
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("function processData(");
  });

  test("respects max_matches with multiline", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "function \\w+\\([\\s\\S]*?\\)",
      multiline: true,
      max_matches: 1,
      projectDir: testDir,
    });
    const text = getText(result);
    const matchBlocks = text.match(/ref: \S+/g);
    expect(matchBlocks?.length).toBe(1);
    expect(text).toContain("showing 1 of");
  });

  test("respects context_lines with multiline", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "function simpleHelper\\(\\): void",
      multiline: true,
      context_lines: 1,
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("simpleHelper");
  });

  test("rejects empty pattern in multiline mode", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "",
      multiline: true,
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("multiline search works across multiple files", async () => {
    const testFile2 = join(testDir, "other.ts");
    writeFileSync(
      testFile2,
      ["class Foo {", "  bar(", "    x: number", "  ): string {", '    return "";', "  }", "}"].join("\n"),
    );

    const result = await handleSearch({
      file_paths: [testFile, testFile2],
      pattern: "\\w+\\([\\s\\S]*?\\): \\w+",
      multiline: true,
      max_matches: 5,
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("multiline.ts:");
    expect(text).toContain("other.ts:");
  });
});

function write(name: string, content: string | Buffer): string {
  const path = join(testDir, name);
  writeFileSync(path, content);
  return path;
}

describe("multiline search windows and anchors", () => {
  // search.ts formatResults: `matchesEmitted` counts marked *lines*, but in
  // multiline mode max_matches counts *windows*, so a multi-line match loses
  // its `->` markers once the marked-line count reaches max_matches.
  test("marks every line of each returned match", async () => {
    const file = write(
      "invoice-blocks.txt",
      ["BEGIN invoice-1", "END invoice-1", "spacer", "BEGIN invoice-2", "END invoice-2"].join("\n"),
    );

    const result = await handleSearch({
      file_paths: [file],
      pattern: "BEGIN invoice-\\d\\nEND invoice-\\d",
      multiline: true,
      max_matches: 2,
      context_lines: 0,
      projectDir: testDir,
    });

    const marked = getText(result)
      .split("\n")
      .filter((line) => line.startsWith("->"));
    expect(marked).toHaveLength(4);
  });

  // search.ts:85 builds the regex with flags "gs" (no "m"), so ^ and $ match
  // only at the start/end of the whole file, unlike line-mode regex search
  // where ^ anchors every line.
  test("^ anchors at line starts, as in line-mode regex search", async () => {
    const file = write("anchors.txt", ["alpha", "beta", "gamma", ""].join("\n"));

    const lineMode = await handleSearch({ file_paths: [file], pattern: "^beta$", regex: true, projectDir: testDir });
    expect(getText(lineMode)).toContain("beta");

    const result = await handleSearch({
      file_paths: [file],
      pattern: "^beta\\ngamma",
      multiline: true,
      projectDir: testDir,
    });
    expect(getText(result)).not.toContain("No matches");
  });

  // search-multiline.ts:55 drops matches longer than max_match_lines without
  // counting or mentioning them, so the caller is told "No matches" for a
  // pattern that does occur in the file.
  test("does not claim 'No matches' when every match exceeds max_match_lines", async () => {
    const body = Array.from({ length: 60 }, (_, i) => `  step ${i};`);
    const file = write("long-block.txt", ["begin {", ...body, "}"].join("\n"));

    const result = await handleSearch({
      file_paths: [file],
      pattern: "begin \\{[\\s\\S]*?\\}",
      multiline: true,
      projectDir: testDir,
    });

    expect(getText(result)).not.toMatch(/^No matches/);
  });

  // search-multiline.ts:60-75 builds one window per match, so nearby matches
  // repeat lines and emit overlapping refs. Line mode merges these windows.
  test("does not repeat lines when context windows of nearby matches overlap", async () => {
    const file = write(
      "nearby-blocks.txt",
      ["one", "BEGIN a", "END a", "BEGIN b", "END b", "six", "seven", "eight"].join("\n"),
    );

    const result = await handleSearch({
      file_paths: [file],
      pattern: "BEGIN \\w\\nEND \\w",
      multiline: true,
      context_lines: 2,
      projectDir: testDir,
    });

    const lineNumbers = [...getText(result).matchAll(/^(?:->)?[a-z]{2}(\d+)\t/gm)].map((m) => Number(m[1]));
    expect(lineNumbers).toEqual([...new Set(lineNumbers)]);
  });

  // Only max_matches hits become windows. Without the cap every match is returned
  // and marked while the trailing notice still says "showing 2".
  test("returns at most max_matches windows", async () => {
    const file = write(
      "five-blocks.txt",
      Array.from({ length: 5 }, () => ["BEGIN", "END", "gap"])
        .flat()
        .join("\n"),
    );

    const result = await handleSearch({
      file_paths: [file],
      pattern: "BEGIN\\nEND",
      multiline: true,
      max_matches: 2,
      context_lines: 0,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text.split("\n").filter((line) => line.startsWith("->"))).toHaveLength(4);
    expect(text).toContain("showing 2 of 5 matches");
  });
});
