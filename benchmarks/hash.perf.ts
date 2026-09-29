import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as current from "../src/hash.ts";
import type { E2ESpeedups } from "./e2e-scenarios.ts";
import { importBaseline, runUnderNode } from "./perf-helpers.ts";

const BASELINE = "0e5b9c9";
const baseline = await importBaseline<typeof current>(BASELINE, "src/hash.ts");

describe("FNV hashing under Node", () => {
  // Edit and search hash every line of the file; ranged reads hash only
  // the lines they return, so they are not expected to move.
  test("dry-run edit and search at least 1.2x faster than baseline", () => {
    const speedups = runUnderNode<E2ESpeedups>("benchmarks/e2e-scenarios.ts", [BASELINE]);
    expect(speedups.editDryRun).toBeGreaterThanOrEqual(1.2);
    expect(speedups.search).toBeGreaterThanOrEqual(1.2);
  }, 120_000);
});

describe("FNV hashing matches baseline", () => {
  test("for random bytes and accumulators", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.nat({ max: 0xffffffff }), (bytes, acc) => {
        const buf = Buffer.from(bytes);
        const h = current.fnv1aHashBytes(buf);
        expect(h).toBe(baseline.fnv1aHashBytes(buf));
        expect(current.foldHash(acc, h)).toBe(baseline.foldHash(acc, h));
      }),
      { numRuns: 5000 },
    );
  });
});
