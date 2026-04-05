import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";
import { getText, resetRefStore } from "../helpers.ts";

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

beforeEach(() => {
  resetRefStore();
});

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
    expect(text).toContain("\u2190 match");
    expect(text).toMatch(/ref:R\d+/);
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
    const matchBlocks = text.match(/ref:R\d+/g);
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
    expect(text).toContain(`--- ${testFile.replaceAll("\\", "/")} ---`);
    expect(text).toContain(`--- ${testFile2.replaceAll("\\", "/")} ---`);
  });
});
