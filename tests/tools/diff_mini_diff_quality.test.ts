import { test, expect } from "bun:test";
import { computeMiniDiff } from "../../src/tools/diff.ts";

test("computeMiniDiff should produce concise diff for single line addition", () => {
  const oldBody = "line A\nline B\nline C";
  const newBody = "line X\nline A\nline B\nline C";

  const diff = computeMiniDiff(oldBody, newBody);

  // FAIL: Currently returns null because it thinks 7 lines changed (3 removed, 4 added)
  expect(diff).not.toBeNull();
  expect(diff).toContain("+ line X");
  expect(diff).not.toContain("- line A");
});
