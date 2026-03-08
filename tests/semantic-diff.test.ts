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
    const symbols = await extractSymbols(source, "ts");
    expect(symbols.length).toBe(2);
    expect(symbols[0].name).toContain("hello");
    expect(symbols[1].name).toContain("goodbye");
    expect(symbols[0].bodyHash).not.toBe(symbols[1].bodyHash);
  });

  test("returns empty array for unsupported extension", async () => {
    const symbols = await extractSymbols("{}", "json");
    expect(symbols).toEqual([]);
  });
});

describe("diffSymbols", () => {
  test("detects added symbol", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" }];
    const new_ = [
      { name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" },
      { name: "bar", signature: "function bar()", bodyHash: 456, nodeType: "function_declaration" },
    ];
    const diff = diffSymbols(old, new_);
    expect(diff.added).toEqual([new_[1]]);
  });

  test("detects removed symbol", () => {
    const old = [
      { name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" },
      { name: "bar", signature: "function bar()", bodyHash: 456, nodeType: "function_declaration" },
    ];
    const new_ = [{ name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" }];
    const diff = diffSymbols(old, new_);
    expect(diff.removed).toEqual([old[1]]);
  });

  test("detects renamed symbol via body hash", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" }];
    const new_ = [{ name: "bar", signature: "function bar()", bodyHash: 123, nodeType: "function_declaration" }];
    const diff = diffSymbols(old, new_);
    expect(diff.renamed.length).toBe(1);
    expect(diff.renamed[0].oldName).toBe("foo");
    expect(diff.renamed[0].newName).toBe("bar");
  });

  test("detects signature modification", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" }];
    const new_ = [
      { name: "foo", signature: "function foo(x: number)", bodyHash: 123, nodeType: "function_declaration" },
    ];
    const diff = diffSymbols(old, new_);
    expect(diff.signatureChanged.length).toBe(1);
  });

  test("detects logic modification", () => {
    const old = [{ name: "foo", signature: "function foo()", bodyHash: 123, nodeType: "function_declaration" }];
    const new_ = [{ name: "foo", signature: "function foo()", bodyHash: 789, nodeType: "function_declaration" }];
    const diff = diffSymbols(old, new_);
    expect(diff.logicChanged.length).toBe(1);
  });
});
