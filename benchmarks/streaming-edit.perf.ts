import { describe, expect, test } from "bun:test";
import type { E2ESpeedups } from "./e2e-scenarios.ts";
import { runUnderNode } from "./perf-helpers.ts";

const BASELINE = "4b168b5";

describe("dry-run edit skips fsync", () => {
  // Node's fd.sync() on macOS costs ~4.6 ms (libuv issues F_FULLFSYNC);
  // Bun's costs ~0.07 ms, so only Node is expected to move.
  test("under Node, dry-run edit at least 1.3x faster than baseline", () => {
    const speedups = runUnderNode<E2ESpeedups>("benchmarks/e2e-scenarios.ts", [BASELINE]);
    expect(speedups.editDryRun).toBeGreaterThanOrEqual(1.3);
  }, 120_000);
});
