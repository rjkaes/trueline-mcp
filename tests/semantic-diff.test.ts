import { describe, expect, test } from "bun:test";
import { extractSymbols, diffSymbols, normalizeBody } from "../src/semantic-diff.ts";

describe("normalizeBody", () => {
  test("collapse mode collapses whitespace", () => {
    expect(normalizeBody("  foo   bar  \n  baz  ", "collapse")).toBe("foo bar\nbaz");
  });

  test("preserve-indent keeps leading whitespace", () => {
    expect(normalizeBody("  foo   bar  \n    baz  ", "preserve-indent")).toBe("  foo bar\n    baz");
  });
});

describe("extractSymbols", () => {
  test("extracts functions from TypeScript", async () => {
    const source = `
function hello(name: string): void {
  console.log(name);
}

function goodbye(): void {
  return;
}
`;
    const symbols = await extractSymbols(source, ".ts");
    expect(symbols.length).toBe(2);
    expect(symbols[0].name).toContain("hello");
    expect(symbols[1].name).toContain("goodbye");
    expect(symbols[0].bodyHash).not.toBe(symbols[1].bodyHash);
  });

  test("returns empty array for unsupported extension", async () => {
    const symbols = await extractSymbols("{}", ".json");
    expect(symbols).toEqual([]);
  });
});

describe("diffSymbols", () => {
  test("detects added symbol", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123 }];
    const new_ = [
      { name: "foo", signature: "function foo()", bodyHash: 123 },
      { name: "bar", signature: "function bar()", bodyHash: 456 },
    ];
    const diff = diffSymbols(old, new_);
    expect(diff.added).toEqual([new_[1]]);
  });

  test("detects removed symbol", () => {
    const old = [
      { name: "foo", signature: "function foo()", bodyHash: 123 },
      { name: "bar", signature: "function bar()", bodyHash: 456 },
    ];
    const new_ = [{ name: "foo", signature: "function foo()", bodyHash: 123 }];
    const diff = diffSymbols(old, new_);
    expect(diff.removed).toEqual([old[1]]);
  });

  test("detects renamed symbol via body hash", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123 }];
    const new_ = [{ name: "bar", signature: "function bar()", bodyHash: 123 }];
    const diff = diffSymbols(old, new_);
    expect(diff.renamed.length).toBe(1);
    expect(diff.renamed[0].oldName).toBe("foo");
    expect(diff.renamed[0].newName).toBe("bar");
  });

  test("detects signature modification", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123 }];
    const new_ = [{ name: "foo", signature: "function foo(x: number)", bodyHash: 123 }];
    const diff = diffSymbols(old, new_);
    expect(diff.signatureChanged.length).toBe(1);
  });

  test("detects logic modification", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123 }];
    const new_ = [{ name: "foo", signature: "function foo()", bodyHash: 789 }];
    const diff = diffSymbols(old, new_);
    expect(diff.logicChanged.length).toBe(1);
  });

  test("keeps a same-named symbol in removed when only its namesake is renamed", async () => {
    const oldSource = `
class Canvas {
  render(scene: Scene): void {
    this.paint(scene);
  }
}

class Printer {
  render(doc: Doc): string {
    return doc.text;
  }
}
`;
    const newSource = `
class Canvas {
  draw(scene: Scene): void {
    this.paint(scene);
  }
}

class Printer {
}
`;
    const diff = diffSymbols(await extractSymbols(oldSource, ".ts"), await extractSymbols(newSource, ".ts"));
    expect(diff.renamed).toEqual([{ oldName: "render", newName: "draw" }]);
    expect(diff.removed.map((s) => s.signature.trim())).toEqual(["render(doc: Doc): string {"]);
  });
});

describe("semantic diff symbol identity", () => {
  test.each([
    {
      ext: ".java",
      oldSource: "class Ledger {\n  public void post() {\n  }\n}\n",
      newSource: "class Ledger {\n  public void post() {\n  }\n  public void audit() {\n  }\n}\n",
      added: "public void audit() {",
    },
    {
      ext: ".go",
      oldSource: "package p\nfunc (l Ledger) Post() {\n\treturn\n}\n",
      newSource: "package p\nfunc (l Ledger) Post() {\n\treturn\n}\nfunc (l Ledger) Audit() {\n\treturn\n}\n",
      added: "func (l Ledger) Audit() {",
    },
    {
      ext: ".rs",
      oldSource: "impl Alpha {\n    fn x() {\n    }\n}\n",
      newSource: "impl Alpha {\n    fn x() {\n    }\n}\nimpl Beta {\n    fn y() {\n    }\n}\n",
      added: "impl Beta {",
    },
  ])("added $ext symbol is reported: $added", async ({ ext, oldSource, newSource, added }) => {
    const diff = diffSymbols(await extractSymbols(oldSource, ext), await extractSymbols(newSource, ext));

    expect(diff.added.map((s) => s.signature.trim())).toContain(added);
  });

  test("python body-only change is not a signature change", async () => {
    const diff = diffSymbols(
      await extractSymbols("def total(items):\n    return sum(items)\n", ".py"),
      await extractSymbols("def total(items):\n    return sum(items) + 1\n", ".py"),
    );

    expect(diff.signatureChanged).toEqual([]);
    expect(diff.logicChanged.map((s) => s.name)).toEqual(["total"]);
  });

  test("re-indenting a method is not a signature change", async () => {
    const diff = diffSymbols(
      await extractSymbols("class Ledger {\n  run(x: number) {\n    return x;\n  }\n}\n", ".ts"),
      await extractSymbols("class Ledger {\n    run(x: number) {\n        return x;\n    }\n}\n", ".ts"),
    );

    expect(diff.signatureChanged).toEqual([]);
  });

  test("adding a blank line inside a body is not a logic change", async () => {
    const diff = diffSymbols(
      await extractSymbols("function f() {\n  const a = 1;\n  return a;\n}\n", ".ts"),
      await extractSymbols("function f() {\n  const a = 1;\n\n  return a;\n}\n", ".ts"),
    );

    expect(diff.logicChanged).toEqual([]);
  });

  test("a change past column 200 of a symbol's first line is detected", async () => {
    const withLast = (type: string) =>
      `function f(${Array.from({ length: 12 }, (_, i) => `argument${i}: string`).join(", ")}, last: ${type}) {\n  return 1;\n}\n`;

    const diff = diffSymbols(
      await extractSymbols(withLast("number"), ".ts"),
      await extractSymbols(withLast("boolean"), ".ts"),
    );

    expect(diff.signatureChanged.length + diff.logicChanged.length).toBeGreaterThan(0);
  });

  // A modifier or declaration keyword is not a name: same-named fields would pair in order and misattribute.
  test.each([
    {
      ext: ".java",
      oldSource: "class Ledger {\n  private int balance = 0;\n}\n",
      newSource: 'class Ledger {\n  private String owner = "x";\n  private int balance = 1;\n}\n',
      added: 'private String owner = "x";',
      changed: "Ledger.balance",
    },
    {
      ext: ".cs",
      oldSource: "class Ledger {\n  public int Balance { get; set; }\n}\n",
      newSource: "class Ledger {\n  public string Owner { get; set; }\n  public int Balance { get; private set; }\n}\n",
      added: "public string Owner { get; set; }",
      changed: "Ledger.Balance",
    },
    {
      ext: ".kt",
      oldSource: "class Ledger {\n  val balance: Int = 0\n}\n",
      newSource: 'class Ledger {\n  val owner: String = "x"\n  val balance: Int = 1\n}\n',
      added: 'val owner: String = "x"',
      changed: "Ledger.balance",
    },
    {
      ext: ".ts",
      oldSource: "class Ledger {\n  private balance = 0;\n}\n",
      newSource: 'class Ledger {\n  private owner = "x";\n  private balance = 1;\n}\n',
      added: 'private owner = "x";',
      changed: "Ledger.balance",
    },
    {
      ext: ".ex",
      oldSource: "defmodule Ledger do\n  def total(x) do\n    x\n  end\nend\n",
      newSource:
        "defmodule Audit do\n  def check(x) do\n    x\n  end\nend\ndefmodule Ledger do\n  def total(x) do\n    x + 1\n  end\nend\n",
      added: "defmodule Audit do",
      changed: "Ledger.total",
    },
  ])(
    "$ext declaration is named by its identifier, not a modifier: $added",
    async ({ ext, oldSource, newSource, added, changed }) => {
      const diff = diffSymbols(await extractSymbols(oldSource, ext), await extractSymbols(newSource, ext));

      expect(diff.added.map((s) => s.signature.trim())).toContain(added);
      expect([...diff.signatureChanged, ...diff.logicChanged].map((s) => s.name)).toContain(changed);
    },
  );

  test("renaming a class does not unpair its members", async () => {
    const members = "  run() {\n    return 1;\n  }\n  walk() {\n    return 2;\n  }\n}\n";

    const diff = diffSymbols(
      await extractSymbols(`class Foo {\n${members}`, ".ts"),
      await extractSymbols(`class Bar {\n${members}`, ".ts"),
    );

    expect(diff.renamed).toEqual([{ oldName: "Foo", newName: "Bar" }]);
  });

  test("changing an impl header does not turn an edited member into removed plus added", async () => {
    const diff = diffSymbols(
      await extractSymbols("impl Foo {\n    fn run() {\n        1;\n    }\n}\n", ".rs"),
      await extractSymbols("impl<T> Foo<T> {\n    fn run() {\n        2;\n    }\n}\n", ".rs"),
    );

    expect([...diff.added, ...diff.removed].map((s) => s.signature.trim())).not.toContain("fn run() {");
    expect(diff.logicChanged.map((s) => s.name)).toEqual(["impl Foo.run"]);
  });

  test("a method moved between two surviving classes is still reported", async () => {
    const diff = diffSymbols(
      await extractSymbols(
        "class A {\n  run() {\n    return 1;\n  }\n}\nclass B {\n  walk() {\n    return 2;\n  }\n}\n",
        ".ts",
      ),
      await extractSymbols(
        "class A {\n  walk() {\n    return 2;\n  }\n}\nclass B {\n  run() {\n    return 1;\n  }\n}\n",
        ".ts",
      ),
    );

    expect(diff.added.length + diff.removed.length + diff.renamed.length).toBeGreaterThan(0);
  });
});
