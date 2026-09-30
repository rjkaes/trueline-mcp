import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractOutline } from "../src/outline/extract.ts";
import { getLanguageConfig } from "../src/outline/languages.ts";
import { extractMarkdownOutline } from "../src/outline/markdown.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { getText, useTestDir } from "./helpers.ts";

const testDir = useTestDir("trueline-bughunt2-outline-");

function writeFixture(name: string, content: string | Buffer): string {
  const path = join(testDir(), name);
  writeFileSync(path, content);
  return path;
}

async function outlineEntries(ext: string, source: string) {
  const config = getLanguageConfig(ext);
  if (!config) throw new Error(`no config for ${ext}`);
  return extractOutline(source, config);
}

async function outlineTexts(ext: string, source: string): Promise<string[]> {
  return (await outlineEntries(ext, source)).map((e) => e.text.trim());
}

describe("signature text of body-less or body-field-less declarations", () => {
  // extract.ts: `bodyOnFirstLine = body ? ... : fl.includes("{")` reads the `{` in an
  // annotation's path template as the declaration's brace, so the annotation becomes the text.
  test("bug: Java interface method with a braced path annotation lists the method, not the annotation", async () => {
    const texts = await outlineTexts(
      ".java",
      [
        "public interface OrderClient {",
        '    @GetMapping("/orders/{id}")',
        "    Order get(@PathVariable Long id);",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts.some((t) => t.includes("Order get("))).toBe(true);
  });

  test("bug: C# interface method with a braced route attribute lists the method, not the attribute", async () => {
    const texts = await outlineTexts(
      ".cs",
      ["public interface IOrderApi", "{", '    [HttpGet("orders/{id}")]', "    Order Get(int id);", "}", ""].join("\n"),
    );
    expect(texts.some((t) => t.includes("Order Get("))).toBe(true);
  });

  test("bug: PHP interface method with a braced route attribute lists the method, not the attribute", async () => {
    const texts = await outlineTexts(
      ".php",
      [
        "<?php",
        "interface Orders",
        "{",
        "    #[Route('/orders/{id}')]",
        "    public function get(int $id);",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts.some((t) => t.includes("function get("))).toBe(true);
  });

  // Kotlin's grammar has no `body` field, so findBody() finds nothing and the same
  // first-line `{` test runs even though the function has a real body.
  test("bug: Kotlin function with a braced path annotation lists the function, not the annotation", async () => {
    const texts = await outlineTexts(
      ".kt",
      [
        "class OrderController {",
        '    @GetMapping("/orders/{id}")',
        "    fun getOrder(@PathVariable id: Long): Order {",
        "        return Order(id)",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts.some((t) => t.includes("fun getOrder("))).toBe(true);
  });

  // No body node: the multi-line join runs to the end of the node, so `end` joins the signature.
  test("bug: Ruby empty method and class signatures do not swallow their end keyword", async () => {
    const texts = await outlineTexts(".rb", ["class Empty", "end", "", "def call", "end", ""].join("\n"));
    expect(texts).toEqual(["class Empty", "def call"]);
  });

  // No body node and a `{` inside the group cuts the join mid-declaration.
  test("bug: Go grouped type and const declarations start with their opening line", async () => {
    const texts = await outlineTexts(
      ".go",
      [
        "package billing",
        "",
        "type (",
        "\tInvoiceID int",
        "\tLine struct {",
        "\t\tqty int",
        "\t}",
        ")",
        "",
        "const (",
        "\tStatusActive = 1",
        "\tStatusClosed = 2",
        ")",
        "",
      ].join("\n"),
    );
    expect(texts).toContain("type (");
    expect(texts).toContain("const (");
  });

  // OutlineEntry.text is documented as "First line of source for this node, trimmed"
  // but only trimEnd() is applied, so members carry their source indentation.
  test("bug: member entry text is trimmed as documented", async () => {
    const entries = await outlineEntries(
      ".ts",
      ["class Greeter {", "  name: string;", "  greet(): string {", "    return this.name;", "  }", "}", ""].join("\n"),
    );
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) expect(entry.text).toBe(entry.text.trim());
  });

  // extract.ts:107 slices the line from column 0, not from the node's own start column.
  test("bug: head of a member sharing its line with the class starts at the member", async () => {
    const entries = await outlineEntries(".ts", "class A { m(x: number) { return x; } }\n");
    const member = entries.find((e) => e.depth === 1);
    expect(member?.head).toBe("m(x: number)");
  });
});

describe("line ranges", () => {
  // Dart's function_signature node ends at the signature; the body is a sibling function_body.
  test("bug: Dart function and method ranges cover the body", async () => {
    const entries = await outlineEntries(
      ".dart",
      [
        "void main() {",
        "  print('hi');",
        "}",
        "",
        "class Cart {",
        "  void add(int x) {",
        "    print(x);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const main = entries.find((e) => e.text.startsWith("void main"));
    const add = entries.find((e) => e.text.trim().startsWith("void add"));
    expect(main?.endLine).toBe(3);
    expect(add?.endLine).toBe(8);
  });

  // tools/outline.ts:117 uses source.split("\n").length, which counts the phantom empty
  // line after a trailing newline. trueline_read, the markdown and XML outlines report 3.
  test("bug: source line count of a code file ignores the trailing newline", async () => {
    const file = writeFixture(
      "three.ts",
      ["export function a() {}", "export function b() {}", "export const c = 1;", ""].join("\n"),
    );
    const text = getText(await handleOutline({ file_paths: [file], projectDir: testDir() }));
    expect(text).toContain("3 source lines");
  });
});

describe("extension mapping", () => {
  // .h is mapped to the C grammar, which misparses a C++ class as a function_definition.
  test("bug: C++ class in a .h header keeps its member declarations", async () => {
    const texts = await outlineTexts(".h", ["class Cart {", "public:", "    void add(int id);", "};", ""].join("\n"));
    expect(texts).toContain("void add(int id);");
  });

  test("bug: .hxx maps to the C++ config like .cxx", () => {
    expect(getLanguageConfig(".cxx")).toBeDefined();
    expect(getLanguageConfig(".hxx")).toBeDefined();
  });

  test("bug: common XML file types are outlined as XML", async () => {
    for (const name of ["schema.xsd", "Info.plist", "Strings.resx"]) {
      const file = writeFixture(name, "<root>\n  <child/>\n</root>\n");
      const text = getText(await handleOutline({ file_paths: [file], projectDir: testDir() }));
      expect(text).not.toContain("No outline support");
    }
  });
});

describe("markdown edge cases", () => {
  async function headings(name: string, content: string): Promise<string[]> {
    const { entries } = await extractMarkdownOutline(writeFixture(name, content));
    return entries.filter((e) => /^h\d$/.test(e.nodeType)).map((e) => e.text);
  }

  // markdown.ts:11 HEADING_RE has no leading-space allowance; CommonMark allows 0-3.
  test("bug: ATX heading indented by up to three spaces is a heading", async () => {
    expect(await headings("indented.md", ["   ## Install", "", "text", ""].join("\n"))).toEqual(["## Install"]);
  });

  // Headings are matched before any HTML-block state, so a multi-line comment's
  // contents are outlined. The TODO in markdown.ts covers only the setext side.
  test("bug: heading inside a multi-line HTML comment is not outlined", async () => {
    const found = await headings(
      "commented.md",
      ["# Guide", "", "<!--", "## Draft section", "-->", "", "## Usage", ""].join("\n"),
    );
    expect(found).toEqual(["# Guide", "## Usage"]);
  });

  // Heading depth is level - 1, so a document that starts at `##` has no depth-0 entries.
  test("bug: depth 0 lists the top-level headings of a document without an h1", async () => {
    const file = writeFixture("docs.md", ["## Install", "", "### Linux", "", "## Usage", ""].join("\n"));
    const text = getText(await handleOutline({ file_paths: [file], depth: 0, projectDir: testDir() }));
    expect(text).toContain("## Install");
    expect(text).toContain("## Usage");
    expect(text).not.toContain("### Linux");
  });

  // State stays IN_FRONTMATTER to EOF, so a leading thematic break hides every heading.
  // intentional per markdown.ts:196 comment
  test.failing("bug: leading --- without a closing delimiter does not hide the headings", async () => {
    expect(await headings("no-close.md", ["---", "", "# Title", "", "## Section", ""].join("\n"))).toEqual([
      "# Title",
      "## Section",
    ]);
  });
});
