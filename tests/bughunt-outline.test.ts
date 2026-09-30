import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOutline } from "../src/outline/extract.ts";
import { getLanguageConfig } from "../src/outline/languages.ts";
import { extractMarkdownOutline } from "../src/outline/markdown.ts";
import { extractXmlOutline } from "../src/outline/xml.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { getText } from "./helpers.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-bughunt-outline-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string | Buffer): string {
  const path = join(testDir, name);
  writeFileSync(path, content);
  return path;
}

async function outlineTexts(ext: string, source: string): Promise<string[]> {
  const config = getLanguageConfig(ext);
  if (!config) throw new Error(`no config for ${ext}`);
  const entries = await extractOutline(source, config);
  return entries.map((e) => e.text.trim());
}

describe("extractSignature ends the signature at the body brace, not at any '{'", () => {
  test("decorator with an object argument keeps the TS class name", async () => {
    const texts = await outlineTexts(
      ".ts",
      [
        "@Component({",
        '  selector: "app-root",',
        '  templateUrl: "./app.component.html",',
        "})",
        "export class AppComponent {",
        '  title = "shop";',
        "}",
        "",
      ].join("\n"),
    );
    expect(texts[0]).toContain("class AppComponent");
  });

  test("decorator with a braced route keeps the Python function name", async () => {
    const texts = await outlineTexts(
      ".py",
      [
        '@app.get("/invoices/{invoice_id}")',
        "async def read_invoice(invoice_id: int):",
        '    return {"id": invoice_id}',
        "",
      ].join("\n"),
    );
    expect(texts[0]).toContain("def read_invoice");
  });

  test("object type inside a wrapped parameter list keeps the full signature", async () => {
    const texts = await outlineTexts(
      ".ts",
      [
        "export function createUser(",
        "  name: string,",
        "  options: { admin: boolean },",
        "): User {",
        "  return new User(name);",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts[0]).toContain("): User");
  });

  test("arrow function with a braced parameter type keeps the full signature", async () => {
    const texts = await outlineTexts(
      ".ts",
      [
        "export const handler = async (",
        "  event: { id: string },",
        "  ctx: Context,",
        "): Promise<void> => {",
        "  return;",
        "};",
        "",
      ].join("\n"),
    );
    expect(texts[0]).toBe("export const handler = async (event: { id: string }, ctx: Context): Promise<void> =>");
  });
});

describe("language configs outline mainstream constructs", () => {
  test('C header behind an extern "C" guard yields the function declaration inside it', async () => {
    const texts = await outlineTexts(
      ".h",
      [
        "#ifndef SHOP_H",
        "#define SHOP_H",
        "",
        "#ifdef __cplusplus",
        'extern "C" {',
        "#endif",
        "",
        "int shop_total(int a);",
        "",
        "#ifdef __cplusplus",
        "}",
        "#endif",
        "",
        "#endif",
        "",
      ].join("\n"),
    );
    expect(texts).toContain("int shop_total(int a);");
  });

  test("TypeScript interface members appear at depth 1", async () => {
    const file = writeFixture(
      "order.ts",
      ["export interface Order {", "  id: string;", "  total(): number;", "}", ""].join("\n"),
    );
    const text = getText(await handleOutline({ file_paths: [file], depth: 1, projectDir: testDir }));
    expect(text).toContain("total(): number;");
  });

  test("TypeScript ambient declarations are outlined", async () => {
    const texts = await outlineTexts(
      ".ts",
      [
        'declare module "express" {',
        "  interface Request { user?: User }",
        "}",
        "declare function greet(name: string): void;",
        "",
      ].join("\n"),
    );
    expect(texts).toContain('declare module "express" {');
    expect(texts).toContain("declare function greet(name: string): void;");
  });

  test("C++ member function declarations are outlined", async () => {
    const texts = await outlineTexts(
      ".hpp",
      ["class Cart {", "public:", "    Cart();", "    void add(int id);", "};", ""].join("\n"),
    );
    expect(texts).toContain("void add(int id);");
  });

  test("C++ data members stay out of the outline, pointer and reference returns stay in", async () => {
    const texts = await outlineTexts(
      ".hpp",
      ["class Cart {", "public:", "    int count;", "    Item* find(int id) const;", "    int &ref();", "};", ""].join(
        "\n",
      ),
    );
    expect(texts).not.toContain("int count;");
    expect(texts).toContain("Item* find(int id) const;");
    expect(texts).toContain("int &ref();");
  });

  test("C++ function-pointer data members are fields, not member functions", async () => {
    const texts = await outlineTexts(
      ".hpp",
      [
        "class Hooks {",
        "public:",
        "    int (*cb)(int);",
        "    void (*handler)(int);",
        "    Foo* make();",
        "    const Bar& get() const;",
        "    bool operator==(const Hooks& other) const;",
        "    int (*callback())(int);",
        "};",
        "",
      ].join("\n"),
    );
    expect(texts).not.toContain("int (*cb)(int);");
    expect(texts).not.toContain("void (*handler)(int);");
    expect(texts).toContain("Foo* make();");
    expect(texts).toContain("const Bar& get() const;");
    expect(texts).toContain("bool operator==(const Hooks& other) const;");
    expect(texts).toContain("int (*callback())(int);");
  });

  test("Swift initializers are outlined", async () => {
    const texts = await outlineTexts(
      ".swift",
      ["struct Point {", "    var x: Int", "    init(x: Int) {", "        self.x = x", "    }", "}", ""].join("\n"),
    );
    expect(texts).toContain("init(x: Int) {");
  });

  test("Swift enum and protocol members are outlined", async () => {
    const texts = await outlineTexts(
      ".swift",
      [
        "enum Direction {",
        "    case north",
        "    func flip() -> Direction { .north }",
        "}",
        "protocol Shape {",
        "    func area() -> Double",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts).toContain("func flip() -> Direction { .north }");
    expect(texts).toContain("func area() -> Double");
  });

  test("Kotlin companion object members are outlined", async () => {
    const texts = await outlineTexts(
      ".kt",
      [
        "class Order(val id: Long) {",
        "    companion object {",
        "        fun create(): Order = Order(1)",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts.some((t) => t.includes("fun create()"))).toBe(true);
  });

  test("Scala abstract trait members are outlined", async () => {
    const texts = await outlineTexts(
      ".scala",
      ["trait Repository {", "  def find(id: Long): Option[String]", "  val name: String", "}", ""].join("\n"),
    );
    expect(texts).toContain("def find(id: Long): Option[String]");
    expect(texts).toContain("val name: String");
  });

  test("PHP enums are outlined", async () => {
    const texts = await outlineTexts(
      ".php",
      ["<?php", "", "enum Status: string", "{", "    case Active = 'active';", "}", ""].join("\n"),
    );
    expect(texts).toContain("enum Status: string");
  });

  test("Java enum methods are outlined", async () => {
    const texts = await outlineTexts(
      ".java",
      [
        "public enum Status {",
        "    ACTIVE, CLOSED;",
        "",
        "    public String label() {",
        "        return name();",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts).toContain("public String label() {");
  });
});

describe("XML outline ordering", () => {
  test("same-line sibling is listed after an earlier element's children", async () => {
    const file = writeFixture(
      "icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><g id="icon"><path d="M0 0"/></g><circle r="4"/></svg>\n',
    );
    const { entries } = await extractXmlOutline(file);
    expect(entries.map((e) => `${e.depth}:${e.text}`)).toEqual([
      '0:<svg xmlns="http://www.w3.org/2000/svg">',
      '1:<g id="icon">',
      '2:<path d="M0 0" />',
      '1:<circle r="4" />',
    ]);
  });
});

describe("markdown outline", () => {
  test("depth parameter limits markdown headings", async () => {
    const file = writeFixture("guide.md", ["# Billing", "", "## Invoices", "", "### Refunds", ""].join("\n"));
    const text = getText(await handleOutline({ file_paths: [file], depth: 0, projectDir: testDir }));
    expect(text).toContain("# Billing");
    expect(text).not.toContain("## Invoices");
  });

  test("fence indented inside a list item is recognized, so its content yields no headings", async () => {
    const file = writeFixture(
      "config.md",
      ["- Config example:", "", "  ```yaml", "  name: shop", "  ---", "  name: billing", "  ```", ""].join("\n"),
    );
    const { entries } = await extractMarkdownOutline(file);
    expect(entries.filter((e) => /^h\d$/.test(e.nodeType))).toEqual([]);
    expect(entries.map((e) => e.nodeType)).toContain("fenced_code");
  });

  test("UTF-16 markdown reports its headings", async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(["# Billing", "", "## Invoices", ""].join("\n"), "utf16le"),
    ]);
    const file = writeFixture("utf16.md", utf16);
    const text = getText(await handleOutline({ file_paths: [file], projectDir: testDir }));
    expect(text).toContain("# Billing");
  });
});

describe("UTF-16 sources and XML", () => {
  const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

  test("a UTF-16 source file is outlined, not rejected as binary", async () => {
    const file = writeFixture("order.ts", utf16le("export function total(): number {\n  return 1;\n}\n"));
    const text = getText(await handleOutline({ file_paths: [file], projectDir: testDir }));
    expect(text).toContain("export function total(): number {");
  });

  test("a UTF-16 XML file is outlined", async () => {
    const file = writeFixture("pom.xml", utf16le("<project>\n  <name>shop</name>\n</project>\n"));
    const { entries } = await extractXmlOutline(file);
    expect(entries.map((e) => e.text)).toEqual(["<project>", "<name>"]);
  });

  test("a source file with null bytes and no BOM is still binary", async () => {
    const file = writeFixture("blob.ts", Buffer.from([0x65, 0x00, 0x66, 0x0a]));
    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(getText(result)).toContain("appears to be a binary file");
  });
});
