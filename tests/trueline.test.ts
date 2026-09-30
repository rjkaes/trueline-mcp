import { describe, expect, test } from "bun:test";
import { fnv1aHash } from "../src/hash.ts";
import { parseRange, parseChecksum } from "../src/parse.ts";

describe("fnv1aHash", () => {
  test("empty string produces FNV offset basis", () => {
    expect(fnv1aHash("")).toBe(2166136261);
  });

  test("deterministic for same input", () => {
    expect(fnv1aHash("hello")).toBe(fnv1aHash("hello"));
  });

  test("different inputs produce different hashes", () => {
    expect(fnv1aHash("hello")).not.toBe(fnv1aHash("world"));
  });

  test("handles multi-byte UTF-8", () => {
    const h = fnv1aHash("日本語");
    expect(typeof h).toBe("number");
    expect(h).toBeGreaterThan(0);
  });

  test("handles surrogate pairs (emoji)", () => {
    const h = fnv1aHash("🎉");
    expect(typeof h).toBe("number");
    expect(h).toBeGreaterThan(0);
  });
});

describe("parseRange", () => {
  test("parses single-line range", () => {
    const r = parseRange("ab5-ab5");
    expect(r.start.line).toBe(5);
    expect(r.end.line).toBe(5);
  });

  test("single-line shorthand returns independent start/end objects", () => {
    const r = parseRange("ab5");
    expect(r.start).toEqual(r.end);
    expect(r.start).not.toBe(r.end); // must be distinct objects
  });

  test("throws when start > end", () => {
    expect(() => parseRange("ab21-cd12")).toThrow("must be ≤");
  });
});

describe("parseChecksum", () => {
  test("throws on invalid hex", () => {
    expect(() => parseChecksum("1-2/ZZZZZZZZ")).toThrow("6 lowercase letters");
  });

  test("throws on too-short hex", () => {
    expect(() => parseChecksum("1-2/f7e2")).toThrow("6 lowercase letters");
  });

  test("throws on 0-5 (startLine 0 with non-zero endLine)", () => {
    expect(() => parseChecksum("0-5/aaaaaa")).toThrow("startLine 0 requires endLine 0");
  });

  test("rejects scientific notation in start line", () => {
    expect(() => parseChecksum("1e2-3/aaaaaa")).toThrow("hash prefix");
  });

  test("rejects scientific notation in end line", () => {
    expect(() => parseChecksum("1-3e1/aaaaaa")).toThrow("hash prefix");
  });

  test("rejects 0-0 sentinel with non-zero hash", () => {
    expect(() => parseChecksum("0-0/abcdef")).toThrow("empty-file sentinel must have hash aaaaaa");
  });
});
