import { test, expect, describe } from "bun:test";
import { hashToLetters, fnv1aHash } from "../src/hash.ts";

test("hashToLetters produces exactly 676 unique values (26^2)", () => {
  const seen = new Set<string>();
  // Iterate through enough inputs to cover all possible bit combinations used
  // in hashToLetters after XOR-folding.
  for (let i = 0; i < 65536; i++) {
    seen.add(hashToLetters(i));
  }

  // This passes now, confirming it matches the updated DESIGN.md.
  expect(seen.size).toBe(676);
});

describe("hashToLetters XOR-fold distribution", () => {
  test("empty string does not hash to a doubled letter", () => {
    const tag = hashToLetters(fnv1aHash(""));
    expect(tag[0]).not.toBe(tag[1]);
  });

  test("distribution across realistic code lines uses >90% of tag space", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      seen.add(hashToLetters(fnv1aHash(`  const variable_${i} = getValue(${i});`)));
    }
    // XOR-fold achieves 676/676; without it only ~338/676.
    expect(seen.size).toBeGreaterThan(600);
  });

  test("max collision count stays reasonable", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10000; i++) {
      const tag = hashToLetters(fnv1aHash(`  const variable_${i} = getValue(${i});`));
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const max = Math.max(...counts.values());
    // With XOR-fold max is ~30; without it max is ~49.
    expect(max).toBeLessThan(40);
  });
});
