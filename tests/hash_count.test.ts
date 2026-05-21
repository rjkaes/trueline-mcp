import { test, expect, describe } from "bun:test";
import { hashToLetters, fnv1aHash } from "../src/hash.ts";

test("hashToLetters produces exactly 100 unique values (curated BPE bigrams)", () => {
  const seen = new Set<string>();
  // Iterate through enough inputs to cover all possible modular outputs.
  for (let i = 0; i < 65536; i++) {
    seen.add(hashToLetters(i));
  }

  // 100 curated bigrams in HASH_PREFIXES.
  expect(seen.size).toBe(100);
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
    // 100 curated bigrams; XOR-fold achieves full coverage.
    expect(seen.size).toBeGreaterThan(90);
  });

  test("max collision count stays reasonable", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10000; i++) {
      const tag = hashToLetters(fnv1aHash(`  const variable_${i} = getValue(${i});`));
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const max = Math.max(...counts.values());
    // 100 buckets, 10000 inputs: expected ~100 per bucket; allow 2x headroom.
    expect(max).toBeLessThan(200);
  });
});
