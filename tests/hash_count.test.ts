import { test, expect } from "bun:test";
import { hashToLetters } from "../src/hash.ts";

test("hashToLetters produces exactly 676 unique values (26^2)", () => {
  const seen = new Set<string>();
  // Iterate through enough inputs to cover all possible bit combinations used
  // in hashToLetters: (h >>> 0) % 26 and ((h >>> 8) >>> 0) % 26.
  for (let i = 0; i < 65536; i++) {
    seen.add(hashToLetters(i));
  }

  // This passes now, confirming it matches the updated DESIGN.md.
  expect(seen.size).toBe(676);
});
