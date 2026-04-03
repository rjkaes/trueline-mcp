import { describe, test, expect, beforeEach } from "bun:test";
import { issueRef, resolveRef, refStoreSize, resetRefStore } from "../src/ref-store.ts";

beforeEach(() => resetRefStore());

describe("ref-store eviction", () => {
  test("evicts oldest refs when exceeding MAX_REFS (500)", () => {
    const refs: string[] = [];
    for (let i = 0; i < 510; i++) {
      refs.push(issueRef(`/tmp/file${i}.ts`, 1, 10, "abcdef01"));
    }
    expect(refStoreSize()).toBe(500);
    // First 10 refs should be evicted
    expect(() => resolveRef(refs[0])).toThrow();
    expect(() => resolveRef(refs[9])).toThrow();
    // Recent refs still valid
    expect(resolveRef(refs[510 - 1])).toBeDefined();
    expect(resolveRef(refs[10])).toBeDefined();
  });

  test("resolveRef touches entry for LRU freshness", () => {
    const refs: string[] = [];
    for (let i = 0; i < 500; i++) {
      refs.push(issueRef(`/tmp/file${i}.ts`, 1, 10, "abcdef01"));
    }
    // Touch the first ref (moves to end of Map iteration order)
    resolveRef(refs[0]);
    // Issue 10 more — should evict refs[1]..refs[10], not refs[0]
    for (let i = 0; i < 10; i++) {
      issueRef(`/tmp/extra${i}.ts`, 1, 10, "abcdef01");
    }
    expect(refStoreSize()).toBe(500);
    expect(resolveRef(refs[0])).toBeDefined(); // survived due to LRU touch
    expect(() => resolveRef(refs[1])).toThrow(); // evicted (was oldest untouched)
    expect(() => resolveRef(refs[10])).toThrow(); // evicted
  });

  test("store stays at MAX_REFS after burst of issues", () => {
    for (let i = 0; i < 1000; i++) {
      issueRef(`/tmp/burst${i}.ts`, 1, 1, "00000000");
    }
    expect(refStoreSize()).toBe(500);
  });
});
