import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOutline } from "../../src/outline/extract.ts";
import { getLanguageConfig } from "../../src/outline/languages.ts";
import { handleOutline } from "../../src/tools/outline.ts";
import { getText, writeTestFile } from "../helpers.ts";

describe("LanguageConfig whitespace mode", () => {
  test("python uses preserve-indent", () => {
    const config = getLanguageConfig(".py");
    expect(config?.whitespaceMode).toBe("preserve-indent");
  });

  test("typescript uses collapse (default)", () => {
    const config = getLanguageConfig(".ts");
    expect(config?.whitespaceMode ?? "collapse").toBe("collapse");
  });
});

// The MCP server is long-lived: every outline call after the first reuses one WASM heap.
describe("repeated grammar use in one process", () => {
  const luaSource = [
    "local M = {}",
    "function M.post(cents)",
    "  return cents",
    "end",
    "local function fee(cents)",
    "  return cents * 3",
    "end",
    "",
  ].join("\n");
  const pythonSource = ["def post(cents):", "    return cents", ""].join("\n");

  // Known upstream bug, no local fix: tree-sitter-lua 2.1.3 (bundled in tree-sitter-wasms
  // 0.1.13) mallocs its scanner state without zeroing it and ignores empty deserialize, so
  // only the process's first Lua parse sees clean state. Loading another grammar is not
  // the trigger. Expected values, not before/after equality: an already-corrupted first
  // parse would make equality pass. Drop `.failing` once the grammar is fixed.
  test.failing("lua parses keep every function after other parses in the same process", async () => {
    const lua = getLanguageConfig(".lua");
    const python = getLanguageConfig(".py");
    if (!lua || !python) throw new Error("lua and python configs must exist");

    for (let round = 0; round < 2; round++) {
      const texts = (await extractOutline(luaSource, lua)).map((entry) => entry.text);
      expect(texts).toContain("function M.post(cents)");
      expect(texts).toContain("local function fee(cents)");
      await extractOutline(pythonSource, python);
    }
  });
});

describe("dart outline", () => {
  // Members sit in `declaration` / `method_signature` wrappers, not directly in the body.
  test("lists members, accessors, constructors and extension types", async () => {
    const source = [
      "class Ledger {",
      "  Ledger(this.balance);",
      "  factory Ledger.empty() => Ledger(0);",
      "  final int balance;",
      "  int get total => balance;",
      "  set limit(int cents) {}",
      "  void post(int cents) {",
      "    print(cents);",
      "  }",
      "}",
      "",
      "extension type Cents(int value) {}",
      "",
    ].join("\n");
    const config = getLanguageConfig(".dart");
    if (!config) throw new Error("dart config must exist");

    const entries = await extractOutline(source, config);

    expect(entries.map((entry) => `${entry.depth}:${entry.text.trim()}`)).toEqual([
      "0:class Ledger {",
      "1:Ledger(this.balance);",
      "1:factory Ledger.empty() => Ledger(0);",
      "1:int get total => balance;",
      "1:set limit(int cents) {}",
      "1:void post(int cents) {",
      "0:extension type Cents(int value) {}",
    ]);
  });
});

const outlineDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-languages-test-")));

afterAll(() => {
  rmSync(outlineDir, { recursive: true, force: true });
});

async function outline(name: string, source: string): Promise<{ text: string; isError: boolean }> {
  const file = writeTestFile(outlineDir, name, source);
  const result = await handleOutline({ file_paths: [file], projectDir: outlineDir });
  return { text: getText(result), isError: result.isError === true };
}

// WASM grammar state is process-global and a failed load poisons later ones,
// so grammar-order scenarios run in a fresh child.
function outlineInFreshProcess(files: string[]): Array<{ text: string; isError: boolean }> {
  const script = `
    const { handleOutline } = await import(process.env.OUTLINE_URL);
    const out = [];
    for (const file of JSON.parse(process.env.OUTLINE_FILES)) {
      const result = await handleOutline({ file_paths: [file], projectDir: process.env.OUTLINE_DIR });
      out.push({ text: result.content[0].text, isError: result.isError === true });
    }
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      OUTLINE_URL: new URL("../../src/tools/outline.ts", import.meta.url).href,
      OUTLINE_FILES: JSON.stringify(files),
      OUTLINE_DIR: outlineDir,
    },
    encoding: "utf-8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  if (child.status !== 0) throw new Error(`child exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

describe("language configs vs installed grammars", () => {
  test("lua outline lists function definitions", () => {
    const file = writeTestFile(
      outlineDir,
      "module.lua",
      [
        "local M = {}",
        "function M.post(cents)",
        "  return cents",
        "end",
        "local function fee(cents)",
        "  return cents * 3",
        "end",
        "function audit()",
        "  return true",
        "end",
        "",
      ].join("\n"),
    );

    const [result] = outlineInFreshProcess([file]);

    expect(result.text).toContain("function M.post(cents)");
    expect(result.text).toContain("local function fee(cents)");
    expect(result.text).toContain("function audit()");
  });

  test("zig outline lists declarations", async () => {
    const { text } = await outline(
      "ledger.zig",
      [
        "pub fn post(cents: i64) i64 {",
        "    return cents;",
        "}",
        "",
        "const Fee = struct {",
        "    rate: u8,",
        "};",
        "",
      ].join("\n"),
    );

    expect(text).toContain("pub fn post(cents: i64) i64 {");
  });

  test("dart grammar loads and outlines a class", async () => {
    const { text, isError } = await outline(
      "greeter.dart",
      ["class Greeter {", "  void hello() {", "    print('hi');", "  }", "}", ""].join("\n"),
    );

    expect(text).toContain("class Greeter");
    expect(isError).toBe(false);
  });

  test("csharp file-scoped namespace members are outlined", async () => {
    const { text } = await outline(
      "InvoiceService.cs",
      [
        "namespace Billing;",
        "",
        "public class InvoiceService",
        "{",
        "    public void Post()",
        "    {",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    expect(text).toContain("class InvoiceService");
  });

  test("csharp record declarations are outlined", async () => {
    const { text } = await outline(
      "Person.cs",
      [
        "public record Person(string Name)",
        "{",
        "    public string Greet()",
        "    {",
        "        return Name;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    expect(text).toContain("record Person");
  });

  test("java record declarations are outlined", async () => {
    const { text } = await outline(
      "Point.java",
      ["public record Point(int x, int y) {", "  public int sum() {", "    return x + y;", "  }", "}", ""].join("\n"),
    );

    expect(text).toContain("record Point");
  });

  test("java interface members are outlined", async () => {
    const { text } = await outline(
      "Ledger.java",
      [
        "public interface Ledger {",
        "  void post(int cents);",
        "",
        "  default int balance() {",
        "    return 0;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    expect(text).toContain("void post(int cents);");
  });

  test("rust trait methods without a body are outlined", async () => {
    const { text } = await outline(
      "ledger.rs",
      [
        "trait Ledger {",
        "    fn post(&mut self, cents: i64);",
        "",
        "    fn balance(&self) -> i64 {",
        "        0",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    expect(text).toContain("fn post(&mut self, cents: i64);");
  });

  test("C header behind an include guard is outlined", async () => {
    const { text } = await outline(
      "ledger.h",
      [
        "#ifndef LEDGER_H",
        "#define LEDGER_H",
        "",
        "static inline int ledger_fee(int cents) {",
        "  return cents / 30;",
        "}",
        "",
        "#endif",
        "",
      ].join("\n"),
    );

    expect(text).toContain("ledger_fee");
  });

  test("typescript abstract class is outlined", async () => {
    const { text } = await outline(
      "base.ts",
      [
        "abstract class LedgerBase {",
        "  abstract post(cents: number): void;",
        "",
        "  audit(): void {",
        '    console.log("audit");',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    expect(text).toContain("abstract class LedgerBase");
  });

  test("elixir module members are outlined", async () => {
    const source = [
      "defmodule Billing.Invoice do",
      "  def total(items) do",
      "    Enum.sum(items)",
      "  end",
      "",
      "  defp fee(cents) do",
      "    cents * 3",
      "  end",
      "end",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".ex")!);

    expect(entries.map((e) => e.startLine)).toEqual(expect.arrayContaining([2, 6]));
  });

  test("python function locals are not outline symbols", async () => {
    const source = [
      "def post_invoice(customer_id, cents):",
      "    fee = round(cents * 0.029)",
      "    ledger.post(customer_id, cents - fee)",
      "    return fee",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".py")!);

    expect(entries.filter((e) => e.depth > 0).map((e) => e.text.trim())).toEqual([]);
  });

  test("kotlin import list ends on its last import line", async () => {
    const source = [
      "package billing",
      "",
      "import billing.ledger.Ledger",
      "import billing.ledger.Fee",
      "",
      "val VERSION = 1",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".kt")!);
    const imports = entries.find((e) => e.text.includes("import"));

    expect(imports?.startLine).toBe(3);
    expect(imports?.endLine).toBe(4);
  });

  test("typescript module extensions .mts and .cts are mapped", () => {
    expect(getLanguageConfig(".mts")).toBeDefined();
    expect(getLanguageConfig(".cts")).toBeDefined();
  });

  test("typescript abstract method signatures are outlined", async () => {
    const source = [
      "abstract class Shape {",
      "  abstract area(): number;",
      "  perimeter(): number {",
      "    return 0;",
      "  }",
      "}",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".ts")!);

    expect(entries.map((e) => e.text.trim())).toContain("abstract area(): number;");
  });

  test("ruby singleton methods are outlined", async () => {
    const source = [
      "def self.boot",
      "  1",
      "end",
      "",
      "class Ledger",
      "  def self.open(path)",
      "    path",
      "  end",
      "end",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".rb")!);

    expect(entries.map((e) => e.text.trim())).toEqual(expect.arrayContaining(["def self.boot", "def self.open(path)"]));
  });
});
