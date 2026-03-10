import { test, expect } from "bun:test";
import { computeMiniDiff } from "../../src/tools/diff.ts";

test("computeMiniDiff performance with large bodies", () => {
  // Create two 5000-line bodies.
  // This will create a 5000x5000 DP table (25 million elements).
  const lines1 = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const lines2 = Array.from({ length: 5000 }, (_, i) => (i === 0 ? "new line" : `line ${i}`));

  const body1 = lines1.join("\n");
  const body2 = lines2.join("\n");

  const t0 = performance.now();
  const diff = computeMiniDiff(body1, body2);
  const duration = performance.now() - t0;

  console.log(`computeMiniDiff for 5000x5000 took ${duration.toFixed(2)}ms`);

  expect(diff).not.toBeNull();
  expect(duration).toBeLessThan(100); // Expect it to be reasonably fast
});
