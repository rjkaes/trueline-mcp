import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as semanticDiff from "../src/semantic-diff.ts";
import { diffSymbols, extractSymbols } from "../src/semantic-diff.ts";
import { handleDiff } from "../src/tools/diff.ts";
import { makeGitRepo } from "./helpers.ts";

let scratch: string[] = [];

function makeRepo(prefix = "trueline-bughunt3-changes-") {
  const repo = makeGitRepo(prefix);
  scratch.push(repo.dir);
  return repo;
}

async function changes(params: Parameters<typeof handleDiff>[0]) {
  const result = await handleDiff(params);
  return { text: result.content.map((c) => (c as { text: string }).text).join(""), isError: !!result.isError };
}

async function symbolNames(ext: string, source: string) {
  return (await extractSymbols(source, ext)).map((s) => s.name);
}

async function symbolDiff(ext: string, oldSource: string, newSource: string) {
  return diffSymbols(await extractSymbols(oldSource, ext), await extractSymbols(newSource, ext));
}

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

// extractName strips Java/TS `@Annotation(...)` prefixes but not C# `[Attribute(...)]` lists, so the
// first `identifier(` it finds is the attribute's, and every attributed member shares one name.
describe("C# attributed members", () => {
  // src/semantic-diff.ts:178 — methodMatch takes the attribute's `Name(` before the member's own name
  test("a member preceded by an attribute with arguments is named by the attribute, not its identifier", async () => {
    const source =
      'public class Order\n{\n    [JsonPropertyName("id")]\n    public string Id { get; set; }\n\n    [HttpGet("{id}")]\n    public IActionResult Get(int id)\n    {\n        return Ok();\n    }\n}\n';

    expect(await symbolNames(".cs", source)).toEqual(["Order", "Id", "Get"]);
  });

  // src/semantic-diff.ts:178 — the shared attribute name pairs the renamed property with its old self
  test("renaming an attributed property is a rename, not a signature change of the attribute's name", async () => {
    const property = (name: string) =>
      `public class Order\n{\n    [JsonPropertyName("total")]\n    public decimal ${name} { get; set; }\n}\n`;

    const diff = await symbolDiff(".cs", property("Total"), property("GrandTotal"));

    expect(diff.renamed).toEqual([{ oldName: "Total", newName: "GrandTotal" }]);
  });
});

describe("C# tuple return types", () => {
  // src/semantic-diff.ts:178 — `public (` reads as a call of `public`
  test("a method returning a tuple is named by its identifier, not its modifier", async () => {
    const source =
      "public class Parser\n{\n    public (int Line, int Column) Locate()\n    {\n        return (1, 2);\n    }\n\n    public static (string Name, int Age) Split(string text)\n    {\n        return (text, 1);\n    }\n}\n";

    expect(await symbolNames(".cs", source)).toEqual(["Parser", "Locate", "Split"]);
  });
});

describe("C++ class and function templates", () => {
  const template = (name: string) =>
    `template <class T>\nclass ${name} {\n public:\n  void put(T item) {\n    last = item;\n  }\n};\n\ntemplate <class T>\nvoid swap_items(T& a, T& b) {\n  a = b;\n}\n`;

  // src/semantic-diff.ts:146 — DECLARED_NAME reads the `class T` inside the template parameter list as the declaration
  test("a `template <class T>` declaration is named by what it declares, not by its parameter T", async () => {
    expect(await symbolNames(".cpp", template("Box"))).toEqual(["Box", "put", "swap_items"]);
  });

  // src/semantic-diff.ts:146 — every `template <class T>` symbol is named `T`, so a rename pairs by that shared name
  test("renaming a `template <class T>` class is a rename, not a signature change of `T`", async () => {
    const diff = await symbolDiff(".cpp", template("Box"), template("Crate"));

    expect(diff.renamed).toEqual([{ oldName: "Box", newName: "Crate" }]);
  });
});

describe("C function prefixes", () => {
  // src/semantic-diff.ts:178 — `__declspec(` / `__attribute__((` is taken for the function's own `name(`
  test.each([
    {
      label: "__declspec(dllexport)",
      source: "__declspec(dllexport) int api_call(int x) {\n  return x;\n}\n",
      name: "api_call",
    },
    {
      label: "__attribute__((noreturn))",
      source: "__attribute__((noreturn)) void die(const char *msg) {\n  abort();\n}\n",
      name: "die",
    },
  ])("a function prefixed by $label is named by its identifier, not the macro", async ({ source, name }) => {
    expect(await symbolNames(".c", source)).toEqual([name]);
  });
});

describe("per-file failures", () => {
  // src/tools/diff.ts:190 — extractSymbols is not guarded, so one file the parser cannot handle rejects the whole call.
  // The parser failure is injected (a real trigger gets fixed): handleDiff must still answer for every other file,
  // as it does for unreadable or binary ones, and must not leak the parser's message.
  test("a file the parser throws on does not discard the sections of the other files", async () => {
    const { dir, git } = makeRepo();
    const script = join(dir, "legacy.py");
    const source = join(dir, "invoice.ts");
    writeFileSync(script, 'def discount():\n    return "trigger-parse-failure"\n');
    writeFileSync(source, "function total() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(script, 'def discount():\n    return "trigger-parse-failure!"\n');
    writeFileSync(source, "function total() {\n  return 1;\n}\nfunction tax() {\n  return 2;\n}\n");

    const realExtract = semanticDiff.extractSymbols;
    const extraction = spyOn(semanticDiff, "extractSymbols").mockImplementation(async (text, ext) => {
      if (text.includes("trigger-parse-failure")) throw new Error("resolved is not a function");
      return realExtract(text, ext);
    });
    try {
      const outcome = await changes({ file_paths: [script, source], projectDir: dir, allowedDirs: [dir] }).catch(
        (err: Error) => ({ text: `threw: ${err.message}`, isError: true }),
      );

      expect(outcome.text).toContain("tax");
      expect(outcome.text).toContain("## legacy.py");
      expect(outcome.text).not.toContain("resolved is not a function");
    } finally {
      extraction.mockRestore();
    }
  });
});

describe("text encodings", () => {
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const before = "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n";

  // src/tools/diff.ts:138 — readTextNoFollow treats any NUL byte as binary, so a BOM-marked UTF-16 file (which
  // trueline_read, trueline_edit and trueline_outline decode) is "Binary file, not diffed."
  test("a UTF-16 source file with a BOM is diffed, not reported as binary", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "ledger.ts");
    writeFileSync(file, utf16(before));
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(file, utf16(before.replace("return 2", "return 22")));

    const { text } = await changes({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).not.toContain("Binary file");
    expect(text).toContain("beta");
  });

  // src/tools/diff.ts:269 — only the disk side is checked for binary content; a NUL-bearing ref blob is decoded
  // as UTF-8 and parsed, so its NUL-laced "symbols" are reported as removed
  test("a ref version with NUL bytes is not parsed as source text", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "ledger.ts");
    writeFileSync(file, utf16(before));
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(file, before);

    const { text } = await changes({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text.includes("\u0000")).toBe(false);
  });
});
