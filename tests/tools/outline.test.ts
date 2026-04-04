import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOutline, clearOutlineCache } from "../../src/tools/outline.ts";
import { getText, writeTestFile as _writeTestFile } from "../helpers.ts";

let testDir: string;
const writeTestFile = (name: string, content: string) => _writeTestFile(testDir, name, content);

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-outline-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("trueline_outline", () => {
  test("extracts TypeScript functions and classes", async () => {
    const file = writeTestFile(
      "example.ts",
      [
        'import { foo } from "bar";',
        "",
        "const VERSION = 1;",
        "",
        "interface Config {",
        "  port: number;",
        "  host: string;",
        "}",
        "",
        "export function startServer(config: Config): void {",
        '  console.log("starting");',
        "  // lots of implementation",
        "  // ...",
        "}",
        "",
        "class MyClass {",
        "  private field: string;",
        "  constructor() {",
        '    this.field = "";',
        "  }",
        "  method(): void {}",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = getText(result);

    // Should include the const, interface, function, class
    expect(text).toContain("const VERSION = 1;");
    expect(text).toContain("interface Config {");
    expect(text).toContain("export function startServer(config: Config): void {");
    expect(text).toContain("class MyClass {");

    // Should NOT include imports or implementation details
    expect(text).not.toContain('from "bar"');
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("lots of implementation");
  });

  test("shows class members at depth 1", async () => {
    const file = writeTestFile(
      "class.ts",
      [
        "class Greeter {",
        "  name: string;",
        "  constructor(name: string) {",
        "    this.name = name;",
        "  }",
        "  greet(): string {",
        "    return 'Hello, ' + this.name;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // Class should be at depth 0, members indented
    expect(text).toMatch(/^\d.*class Greeter/m);
    expect(text).toMatch(/^ {2}\d.*constructor/m);
    expect(text).toMatch(/^ {2}\d.*greet/m);
  });

  test("extracts Python functions and classes", async () => {
    const file = writeTestFile(
      "example.py",
      [
        "import os",
        "from pathlib import Path",
        "",
        "FOO = 42",
        "",
        "def greet(name: str) -> None:",
        "    print(f'Hello {name}')",
        "",
        "class MyClass:",
        "    def __init__(self):",
        "        self.value = 0",
        "    def method(self):",
        "        pass",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = getText(result);

    expect(text).toContain("FOO = 42");
    expect(text).toContain("def greet(name: str) -> None:");
    expect(text).toContain("class MyClass:");
    // Should not include imports
    expect(text).not.toContain("import os");
    expect(text).not.toContain("from pathlib");
  });

  test("extracts Go functions and types", async () => {
    const file = writeTestFile(
      "example.go",
      [
        "package main",
        "",
        'import "fmt"',
        "",
        "const Version = 1",
        "",
        "type Config struct {",
        "  Port int",
        "}",
        "",
        "func main() {",
        '  fmt.Println("hello")',
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = getText(result);

    expect(text).toContain("const Version = 1");
    expect(text).toContain("type Config struct {");
    expect(text).toContain("func main() {");
    expect(text).not.toContain('import "fmt"');
  });

  test("extracts Rust items", async () => {
    const file = writeTestFile(
      "example.rs",
      [
        "use std::io;",
        "",
        "const FOO: i32 = 1;",
        "",
        'fn greet(name: &str) { println!("Hi {}", name); }',
        "",
        "struct MyStruct {",
        "    field: String,",
        "}",
        "",
        "impl MyStruct {",
        "    fn new() -> Self { Self { field: String::new() } }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = getText(result);

    expect(text).toContain("const FOO: i32 = 1;");
    expect(text).toContain("fn greet(name: &str)");
    expect(text).toContain("struct MyStruct {");
    expect(text).toContain("impl MyStruct {");
    expect(text).not.toContain("use std::io");
  });

  test("returns guidance for unsupported file type", async () => {
    const file = writeTestFile("data.csv", "a,b,c\n1,2,3\n");

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("No outline support");
    expect(getText(result)).toContain("trueline_read");
  });

  test("returns error for nonexistent file", async () => {
    const result = await handleOutline({
      file_paths: [join(testDir, "nope.ts")],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("not found");
  });

  test("handles empty file", async () => {
    const file = writeTestFile("empty.ts", "");

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("no outline entries");
  });

  test("reports symbol count and source lines", async () => {
    const file = writeTestFile("counted.ts", ["function a() {}", "function b() {}", "function c() {}", ""].join("\n"));

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("3 symbols");
    expect(text).toContain("4 source lines");
  });

  test("expression_statement only at top level for TypeScript", async () => {
    const file = writeTestFile(
      "toplevel.ts",
      [
        "server.registerTool();",
        "try {",
        '  console.log("inside try");',
        "} catch (e) {",
        "  process.exit(1);",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // Top-level expression_statement should be included
    expect(text).toContain("server.registerTool()");
    // Nested expression_statements should NOT
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("process.exit");
  });

  test("collapses skipped imports into a summary with line range", async () => {
    const file = writeTestFile(
      "imports.ts",
      [
        'import { foo } from "foo";',
        'import { bar } from "bar";',
        'import { baz } from "baz";',
        "",
        "function main() {}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // Should show collapsed imports with line range
    expect(text).toContain("1-3: (3 imports)");
    // Should still show the function
    expect(text).toContain("function main() {}");
  });

  test("all entries use start-end line range format", async () => {
    const file = writeTestFile("ranges.ts", ["const x = 1;", "function foo() {", "  return 1;", "}", ""].join("\n"));

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // Single-line entries should still use start-end format
    expect(text).toMatch(/^1-1: const x = 1;/m);
    // Multi-line entries should use start-end format
    expect(text).toMatch(/^2-4: function foo\(\)/m);
  });

  test("shows full multi-line function signature", async () => {
    const file = writeTestFile(
      "multiline-sig.ts",
      [
        "export async function createServer(",
        "  name: string,",
        "  port: number,",
        "  options: ServerOptions,",
        "): Promise<Server> {",
        "  return new Server(name, port, options);",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);
    // Should show the full signature, not just the first line
    expect(text).toContain("createServer(name: string, port: number, options: ServerOptions): Promise<Server>");
  });

  test("single-line signatures stay unchanged", async () => {
    const file = writeTestFile(
      "single-sig.ts",
      ["function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("function add(a: number, b: number): number {");
  });

  test("depth: 0 returns only top-level declarations", async () => {
    const file = writeTestFile(
      "depth0.ts",
      [
        "class MyClass {",
        "  name: string;",
        "  constructor(name: string) {",
        "    this.name = name;",
        "  }",
        "  greet(): string {",
        "    return this.name;",
        "  }",
        "}",
        "",
        "function topLevel() {",
        "  return 42;",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], depth: 0, projectDir: testDir });
    const text = getText(result);
    // Top-level class and function should appear
    expect(text).toContain("class MyClass");
    expect(text).toContain("function topLevel()");
    // Class members should NOT appear at depth 0
    expect(text).not.toContain("constructor");
    expect(text).not.toContain("greet");
  });

  test("depth: 1 includes class members", async () => {
    const file = writeTestFile(
      "depth1.ts",
      [
        "class MyClass {",
        "  constructor(name: string) {",
        "    this.name = name;",
        "  }",
        "  greet(): string {",
        "    return this.name;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], depth: 1, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("class MyClass");
    expect(text).toContain("constructor");
    expect(text).toContain("greet");
  });

  test("no depth param returns all levels (same as unlimited)", async () => {
    const file = writeTestFile(
      "depth-default.ts",
      ["class MyClass {", "  greet(): string {", "    return 'hello';", "  }", "}", ""].join("\n"),
    );

    const withoutDepth = await handleOutline({ file_paths: [file], projectDir: testDir });
    clearOutlineCache();
    const withInfinity = await handleOutline({ file_paths: [file], depth: undefined, projectDir: testDir });
    expect(getText(withoutDepth)).toEqual(getText(withInfinity));
    // Both should include members
    expect(getText(withoutDepth)).toContain("greet");
  });

  test("file_paths outlines multiple files in one call", async () => {
    const tsFile = writeTestFile("multi-a.ts", ["function alpha() {}", "function beta() {}", ""].join("\n"));
    const pyFile = writeTestFile("multi-b.py", ["def gamma():", "    pass", "def delta():", "    pass", ""].join("\n"));

    const result = await handleOutline({ file_paths: [tsFile, pyFile], projectDir: testDir });
    const text = getText(result);

    // Each file gets a header
    expect(text).toContain("--- multi-a.ts ---");
    expect(text).toContain("--- multi-b.py ---");
    // Symbols from both files appear
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("gamma");
    expect(text).toContain("delta");
    // Aggregate summary at the end
    expect(text).toMatch(/\d+ symbols, \d+ source lines across 2 files/);
  });

  test("file_paths with mixed supported/unsupported files includes both", async () => {
    const tsFile = writeTestFile("mixed-ok.ts", ["function hello() {}", ""].join("\n"));
    const txtFile = writeTestFile("mixed-nope.xyz", "just plain text\n");

    const result = await handleOutline({ file_paths: [tsFile, txtFile], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("--- mixed-ok.ts ---");
    expect(text).toContain("hello");
    expect(text).toContain("--- mixed-nope.xyz ---");
    expect(text).toContain("No outline support");
  });

  test("extracts markdown headings", async () => {
    const file = writeTestFile(
      "doc.md",
      [
        "# Title",
        "",
        "Intro paragraph.",
        "",
        "## Setup",
        "",
        "Instructions.",
        "",
        "### Prerequisites",
        "",
        "Details.",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = getText(result);

    expect(text).toContain("# Title");
    expect(text).toContain("## Setup");
    expect(text).toContain("### Prerequisites");
    expect(text).toContain("3 symbols");
    expect(text).toContain("11 source lines"); // streaming counts actual lines (trailing newline terminates line 11)
  });

  test("markdown with no headings reports no entries", async () => {
    const file = writeTestFile("no-headings.md", "Just plain text.\nNo headings here.\n");

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("no outline entries");
  });

  test("errors when file_paths is empty", async () => {
    const result = await handleOutline({ file_paths: [], projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Provide at least one file path");
  });
});

describe("outline caching", () => {
  test("second call to unchanged file returns compact stub", async () => {
    const file = writeTestFile(
      "cache-test.ts",
      'export function greet(name: string): string {\n  return "hello";\n}\n',
    );
    clearOutlineCache();

    const first = await handleOutline({ file_paths: [file], projectDir: testDir });
    const t1 = getText(first);
    expect(t1).toContain("greet");
    expect(t1).not.toContain("unchanged");

    const second = await handleOutline({ file_paths: [file], projectDir: testDir });
    const t2 = getText(second);
    expect(t2).toContain("outline unchanged");
    expect(t2).not.toContain("greet");
  });

  test("returns fresh outline after file modification", async () => {
    const file = writeTestFile("cache-modify.ts", "export function alpha(): void {}\n");
    clearOutlineCache();

    await handleOutline({ file_paths: [file], projectDir: testDir });

    // Write new content and force a different mtime (some filesystems have 1s granularity)
    const { writeFileSync, utimesSync } = require("node:fs");
    writeFileSync(file, "export function beta(): void {}\n");
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("beta");
    expect(text).not.toContain("unchanged");
  });

  test("different depth does not return cached result", async () => {
    const file = writeTestFile("cache-depth.ts", "export class Foo {\n  bar(): void {}\n}\n");
    clearOutlineCache();

    const first = await handleOutline({ file_paths: [file], depth: 0, projectDir: testDir });
    expect(getText(first)).toContain("Foo");

    // Same file, different depth -- must not return cached stub
    const second = await handleOutline({ file_paths: [file], depth: 1, projectDir: testDir });
    const t2 = getText(second);
    expect(t2).not.toContain("unchanged");
    expect(t2).toContain("Foo");
  });

  test("clearOutlineCache forces fresh outline", async () => {
    const file = writeTestFile("cache-clear.ts", "export const X = 1;\n");
    clearOutlineCache();

    await handleOutline({ file_paths: [file], projectDir: testDir });
    clearOutlineCache();

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(getText(result)).not.toContain("unchanged");
  });

  test("multi-file call caches per file independently", async () => {
    const file1 = writeTestFile("cache-multi1.ts", "export function one(): void {}\n");
    const file2 = writeTestFile("cache-multi2.ts", "export function two(): void {}\n");
    clearOutlineCache();

    // First call populates cache for both
    await handleOutline({ file_paths: [file1, file2], projectDir: testDir });

    // Second call: both should be cached
    const result = await handleOutline({ file_paths: [file1, file2], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("outline unchanged");
    // Both files should show as unchanged
    expect(text.match(/outline unchanged/g)?.length).toBe(2);
  });
});
