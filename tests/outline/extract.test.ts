import { describe, expect, test } from "bun:test";
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
