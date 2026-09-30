import { describe, expect, test } from "bun:test";
import { extractOutline } from "../src/outline/extract.ts";
import { getLanguageConfig } from "../src/outline/languages.ts";
import { extractXmlOutline } from "../src/outline/xml.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { getText, useTestDir, writeTestFile } from "./helpers.ts";

const testDir = useTestDir("trueline-bughunt3-outline-");

async function outlineEntries(ext: string, source: string) {
  const config = getLanguageConfig(ext);
  if (!config) throw new Error(`no config for ${ext}`);
  return extractOutline(source, config);
}

async function outlineTexts(ext: string, source: string): Promise<string[]> {
  return (await outlineEntries(ext, source)).map((e) => e.text.trim());
}

describe("declarations missing from the outline", () => {
  // src/outline/languages.ts:37 — typescript outline omits generator_function_declaration, so `function*` vanishes
  test("bug: TypeScript top-level generator functions are outlined", async () => {
    const texts = await outlineTexts(
      ".ts",
      [
        "function* watchCheckout() {",
        "  yield 1;",
        "}",
        "async function* pageThroughInvoices() {}",
        "export function total() {}",
        "",
      ].join("\n"),
    );
    expect(texts).toContain("function* watchCheckout() {");
    expect(texts).toContain("async function* pageThroughInvoices() {}");
  });

  // src/outline/languages.ts:66 — javascript outline omits generator_function_declaration, so `function*` vanishes
  test("bug: JavaScript top-level generator functions are outlined", async () => {
    const texts = await outlineTexts(
      ".js",
      ["function* watchCheckout() {", "  yield 1;", "}", "export function total() {}", ""].join("\n"),
    );
    expect(texts).toContain("function* watchCheckout() {");
  });

  // src/outline/languages.ts:197 — `include` drops every non-function field_declaration, which also hides nested types
  test("bug: C++ nested class, struct and enum inside a class are outlined", async () => {
    const texts = await outlineTexts(
      ".hpp",
      [
        "class Cart {",
        "public:",
        "  class Line {",
        "  public:",
        "    void total();",
        "  };",
        "  enum class State { Open, Paid };",
        "  void add(int id);",
        "};",
        "",
      ].join("\n"),
    );
    expect(texts).toEqual(
      expect.arrayContaining(["class Line {", "void total();", "enum class State { Open, Paid };"]),
    );
  });

  // src/outline/languages.ts:143 — `class << self` is a singleton_class node, outside outline/recurse, so its methods vanish
  test("bug: Ruby methods inside `class << self` are outlined", async () => {
    const texts = await outlineTexts(
      ".rb",
      ["class Gateway", "  class << self", "    def connect(url)", "      url", "    end", "  end", "end", ""].join(
        "\n",
      ),
    );
    expect(texts).toContain("def connect(url)");
  });

  // src/outline/languages.ts:268 — php has no namespace_definition entry, so a braced namespace yields an empty outline
  test("bug: PHP classes inside a braced namespace are outlined", async () => {
    const texts = await outlineTexts(
      ".php",
      ["<?php", "namespace Billing {", "  class Invoice {", "    public function total() {}", "  }", "}", ""].join(
        "\n",
      ),
    );
    expect(texts).toContain("class Invoice {");
  });

  // src/outline/languages.ts:219 — csharp outline lists methods and properties but not operators, indexers or delegates
  test("bug: C# operator, indexer and delegate declarations are outlined", async () => {
    const texts = await outlineTexts(
      ".cs",
      [
        "public class Money",
        "{",
        "    public static Money operator +(Money a, Money b) { return a; }",
        "    public int this[int index] { get { return index; } }",
        "    public delegate void Settled(int cents);",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts).toEqual(
      expect.arrayContaining([
        "public static Money operator +(Money a, Money b) { return a; }",
        "public int this[int index] { get { return index; } }",
        "public delegate void Settled(int cents);",
      ]),
    );
  });

  // src/outline/languages.ts:239 — kotlin outline omits type_alias and secondary_constructor
  test("bug: Kotlin typealias and secondary constructors are outlined", async () => {
    const texts = await outlineTexts(
      ".kt",
      [
        "typealias InvoiceId = Long",
        "",
        "class Invoice(val id: InvoiceId) {",
        "    constructor(raw: String) : this(raw.toLong())",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts).toEqual(
      expect.arrayContaining(["typealias InvoiceId = Long", "constructor(raw: String) : this(raw.toLong())"]),
    );
  });

  // src/outline/languages.ts:253 — swift outline has init_declaration but not subscript, deinit or typealias
  test("bug: Swift subscript, deinit and typealias declarations are outlined", async () => {
    const texts = await outlineTexts(
      ".swift",
      [
        "typealias Cents = Int",
        "",
        "final class Ledger {",
        "    subscript(index: Int) -> Cents { return index }",
        "    deinit {}",
        "}",
        "",
      ].join("\n"),
    );
    expect(texts).toEqual(
      expect.arrayContaining(["typealias Cents = Int", "subscript(index: Int) -> Cents { return index }", "deinit {}"]),
    );
  });

  // src/outline/languages.ts:202 — c outline has struct_specifier and enum_specifier but not union_specifier
  test("bug: C union definitions are outlined", async () => {
    const texts = await outlineTexts(
      ".c",
      ["union Number {", "    int whole;", "    double fractional;", "};", "", "int total(int a);", ""].join("\n"),
    );
    expect(texts).toContain("union Number {");
  });

  // src/outline/languages.ts:319 — dart outline has constructor_signature but not constant_constructor_signature
  test("bug: Dart const constructors are outlined", async () => {
    const texts = await outlineTexts(
      ".dart",
      ["class PriceTag {", "  const PriceTag(this.cents);", "  final int cents;", "}", ""].join("\n"),
    );
    expect(texts).toContain("const PriceTag(this.cents);");
  });
});

describe("signature text of wrapped declarations", () => {
  // src/outline/extract.ts:176 — kotlin has no `body` field, so a `{` in a default parameter ends the signature join
  test("bug: Kotlin wrapped signature with a lambda default keeps its later parameters", async () => {
    const entries = await outlineEntries(
      ".kt",
      [
        "class Retry {",
        "    fun run(",
        "        onDone: () -> Unit = {},",
        "        attempts: Int,",
        "    ): Int {",
        "        return attempts",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    const run = entries.find((e) => e.text.includes("fun run("));
    expect(run?.text).toBe("fun run(onDone: () -> Unit = {}, attempts: Int): Int");
  });

  // src/outline/extract.ts:103 — dart has no `body` field, so the `{` of named parameters is taken as the body brace
  test("bug: Dart signature with wrapped named parameters keeps the parameter list", async () => {
    const entries = await outlineEntries(
      ".dart",
      ["void configure({", "  required String host,", "  int port = 80,", "}) {", "  print(host);", "}", ""].join("\n"),
    );
    expect(entries[0].text).toContain("int port = 80");
  });
});

describe("line ranges", () => {
  // src/outline/extract.ts:244 — TS grammar makes method decorators siblings of method_definition, so startLine skips them
  test("bug: TypeScript decorated method range starts at its decorator, as a decorated field's does", async () => {
    const entries = await outlineEntries(
      ".ts",
      [
        "export class OrderController {",
        "  @Input()",
        "  status: string;",
        "",
        '  @Get(":id")',
        "  find(id: string) {",
        "    return id;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const field = entries.find((e) => e.text.includes("status: string"));
    const method = entries.find((e) => e.text.includes("find(id: string)"));
    expect(field?.startLine).toBe(2);
    expect(method?.startLine).toBe(5);
  });

  // src/outline/extract.ts:244 — Rust attribute_item nodes are siblings of the item, so startLine skips `#[derive]`/`#[test]`
  test("bug: Rust item range starts at its outer attribute", async () => {
    const entries = await outlineEntries(
      ".rs",
      ["#[derive(Debug, Clone)]", "pub struct Invoice {", "    cents: i64,", "}", ""].join("\n"),
    );
    expect(entries[0].startLine).toBe(1);
  });

  // src/outline/extract.ts:244 — Dart member annotations are siblings of the signature, so startLine skips `@override`
  test("bug: Dart member range starts at its annotation", async () => {
    const entries = await outlineEntries(
      ".dart",
      ["class Ledger {", "  @override", "  void post() {}", "}", ""].join("\n"),
    );
    const post = entries.find((e) => e.text.includes("void post()"));
    expect(post?.startLine).toBe(2);
  });

  // src/tools/outline.ts:121 — split("\n").length is 1 for "", so an empty code file reports one line; markdown and XML report 0
  test("bug: empty code file reports zero source lines", async () => {
    const file = writeTestFile(testDir(), "empty.ts", "");
    const text = getText(await handleOutline({ file_paths: [file], projectDir: testDir() }));
    expect(text).toContain("0-line file");
  });
});

describe("XML outline", () => {
  // src/outline/xml.ts:199 — a `]` inside a comment in the DOCTYPE subset ends the subset, so the next `>` ends the DOCTYPE
  test("bug: DOCTYPE internal subset with a bracket in a comment does not leak declarations as elements", async () => {
    const file = writeTestFile(
      testDir(),
      "note.xml",
      [
        '<?xml version="1.0"?>',
        "<!DOCTYPE note [",
        "<!-- content model, see [1] -->",
        "<!ELEMENT note (#PCDATA)>",
        "]>",
        "<note>hi</note>",
        "",
      ].join("\n"),
    );
    const { entries } = await extractXmlOutline(file);
    expect(entries.map((e) => e.text)).toEqual(['<?xml version="1.0"?>', "<note>"]);
  });
});

describe("Bash outline", () => {
  // src/outline/parser.ts — tree-sitter-bash's scanner calls an unresolved WASM import on `==` in a test
  test("bug: a script with `==` inside `[ ]` is outlined, not an extraction failure", async () => {
    const texts = await outlineTexts(
      ".sh",
      ['if [ "$(uname -s)" == "Linux" ]; then', "  echo linux", "fi", "", "build() {", "  make all", "}", ""].join(
        "\n",
      ),
    );
    expect(texts).toContain("build() {");
  });
});
