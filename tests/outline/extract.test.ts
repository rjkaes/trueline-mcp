import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { extractOutline } from "../../src/outline/extract.ts";
import { getLanguageConfig } from "../../src/outline/languages.ts";

// ~2000 lines: big enough that a leaked tree is several MB of WASM heap.
const source = Array.from(
  { length: 400 },
  (_, i) => `export function postInvoice${i}(customerId: string, cents: number): number {
  const fee = Math.round(cents * 0.029);
  return ledger.post(customerId, cents - fee);
}
`,
).join("\n");

describe("extractOutline", () => {
  test("releases WASM memory between calls", async () => {
    const config = getLanguageConfig(".ts")!;
    // Warm up past the high-water mark: WASM init, grammar load, and early
    // allocations grow memory for ~60 calls under bun test, then a
    // non-leaking run plateaus.
    for (let i = 0; i < 80; i++) await extractOutline(source, config);
    Bun.gc(true);
    const rssBefore = process.memoryUsage().rss;

    for (let i = 0; i < 60; i++) {
      expect(await extractOutline(source, config)).toHaveLength(400);
    }

    Bun.gc(true);
    const growthMb = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
    // web-tree-sitter 0.24 has no finalizers; undeleted trees pile up in
    // the WASM heap until it aborts, which kills outline until restart.
    expect(growthMb).toBeLessThan(30);
  });
});

// Language cache state is process-global and other tests already load grammars,
// so each scenario runs in a fresh child.
function runInFreshProcess<T>(script: string): T {
  const child = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, PARSER_URL: new URL("../../src/outline/parser.ts", import.meta.url).href },
    encoding: "utf-8",
  });
  if (child.status !== 0) throw new Error(`child exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout) as T;
}

const CONCURRENT_LOADS_IN_CHILD = `
const { createParser } = await import(process.env.PARSER_URL);
const concurrent = await Promise.all([createParser("typescript"), createParser("typescript"), createParser("typescript")]);
const later = await createParser("typescript");
const parsers = [...concurrent, later];
const distinctLanguages = new Set(parsers.map((parser) => parser.language)).size;
for (const parser of parsers) parser.delete();
console.log(JSON.stringify({ distinctLanguages }));
`;

const RETRY_AFTER_REJECTED_LOAD_IN_CHILD = `
const { createParser } = await import(process.env.PARSER_URL);
const { Language } = await import("web-tree-sitter");
// Warm up so the patched load below only sees typescript.
(await createParser("javascript")).delete();
const realLoad = Language.load;
let loadCalls = 0;
Language.load = (path) =>
  ++loadCalls === 1 ? Promise.reject(new Error("transient load failure")) : realLoad(path);
const attempt = () => createParser("typescript").then((parser) => ({ parser }), (err) => ({ error: err.message }));
const first = await attempt();
const second = await attempt();
let rootType;
if (second.parser) {
  const tree = second.parser.parse("const total = 1;");
  rootType = tree.rootNode.type;
  tree.delete();
  second.parser.delete();
}
console.log(JSON.stringify({ firstError: first.error, secondError: second.error, loadCalls, rootType }));
`;

describe("createParser", () => {
  // Each concurrent first caller used to load its own copy of the grammar into the
  // shared WASM runtime; the losers are never freed.
  test("concurrent first calls for a grammar share one Language", () => {
    const outcome = runInFreshProcess<{ distinctLanguages: number }>(CONCURRENT_LOADS_IN_CHILD);

    expect(outcome.distinctLanguages).toBe(1);
  });

  test("retries after a rejected grammar load", () => {
    const outcome = runInFreshProcess(RETRY_AFTER_REJECTED_LOAD_IN_CHILD);

    expect(outcome).toEqual({ firstError: "transient load failure", loadCalls: 2, rootType: "program" });
  });
});

describe("extractSignature for brace-less languages", () => {
  test("python signature is the def line, not the joined body", async () => {
    const source = [
      "def post_invoice(customer_id, cents):",
      "    fee = round(cents * 0.029)",
      "    return ledger.post(customer_id, cents - fee)",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".py")!);

    expect(entries[0].text).toBe("def post_invoice(customer_id, cents):");
  });

  test("ruby signature is the def line, not the joined body", async () => {
    const source = ["def post_invoice(customer_id, cents)", "  fee = (cents * 0.029).round", "  fee", "end", ""].join(
      "\n",
    );

    const entries = await extractOutline(source, getLanguageConfig(".rb")!);

    expect(entries[0].text).toBe("def post_invoice(customer_id, cents)");
  });

  test("ruby signature drops a trailing comment", async () => {
    const source = ["def bar(a, b) # keep the total", "  a", "end", ""].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".rb")!);

    expect(entries[0].text).toBe("def bar(a, b)");
  });

  test("ruby signature drops a comment after a wrapped parameter list", async () => {
    const source = ["def bar(a,", "        b) # keep the total", "  a", "end", ""].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".rb")!);

    expect(entries[0].text).toBe("def bar(a, b)");
  });

  test("python signature drops comments inside and after the parameter list", async () => {
    const source = ["def build(first,  # note", "          second):  # inner comment", "    return first", ""].join(
      "\n",
    );

    const entries = await extractOutline(source, getLanguageConfig(".py")!);

    expect(entries[0].text).toBe("def build(first, second):");
  });

  test("typescript signature drops comments between wrapped parameters", async () => {
    const source = [
      "function post(",
      "  // amount in cents",
      "  cents: number, /* minor units */",
      "  fee: number,",
      "): void {",
      "  return;",
      "}",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".ts")!);

    expect(entries[0].text).toBe("function post(cents: number, fee: number): void");
  });

  test("typescript abstract signature drops a comment after its last line", async () => {
    const source = [
      "abstract class Shape {",
      "  abstract scale(",
      "    factor: number,",
      "  ): void; // shrink or grow",
      "}",
      "",
    ].join("\n");

    const entries = await extractOutline(source, getLanguageConfig(".ts")!);
    const scale = entries.find((e) => e.nodeType === "abstract_method_signature");

    expect(scale?.text.trim()).toBe("abstract scale(factor: number): void;");
  });
});
