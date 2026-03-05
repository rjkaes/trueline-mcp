import { describe, expect, test } from "bun:test";
import { fnv1aHash } from "../src/hash.ts";
import { parseRange, parseChecksum } from "../src/parse.ts";
import { lineHash, rangeChecksum } from "./helpers.ts";

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

describe("lineHash", () => {
  test("returns exactly 2 lowercase letters", () => {
    const h = lineHash("console.log('hello')");
    expect(h).toMatch(/^[a-z]{2}$/);
  });

  test("deterministic", () => {
    expect(lineHash("foo")).toBe(lineHash("foo"));
  });

  test("empty line produces valid hash", () => {
    expect(lineHash("")).toMatch(/^[a-z]{2}$/);
  });
});

describe("rangeChecksum", () => {
  test("produces startLine-endLine:8hex format", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    expect(cs).toMatch(/^1-3:[0-9a-f]{8}$/);
  });

  test("deterministic for same content", () => {
    const lines = ["a", "b", "c"];
    expect(rangeChecksum(lines, 1, 3)).toBe(rangeChecksum(lines, 1, 3));
  });

  test("changes when content changes", () => {
    const lines1 = ["a", "b", "c"];
    const lines2 = ["a", "x", "c"];
    expect(rangeChecksum(lines1, 1, 3)).not.toBe(rangeChecksum(lines2, 1, 3));
  });

  test("clamps endLine to file length", () => {
    const lines = ["a", "b"];
    const cs = rangeChecksum(lines, 1, 10);
    expect(cs).toMatch(/^1-2:[0-9a-f]{8}$/);
    expect(cs).toBe(rangeChecksum(lines, 1, 2));
  });
});

describe("parseRange", () => {
  test("parses valid range", () => {
    const r = parseRange("12:gh..21:yz");
    expect(r.start).toEqual({ line: 12, hash: "gh" });
    expect(r.end).toEqual({ line: 21, hash: "yz" });
  });

  test("parses single-line range", () => {
    const r = parseRange("5:ab..5:ab");
    expect(r.start.line).toBe(5);
    expect(r.end.line).toBe(5);
  });

  test("parses single line:hash as self-range", () => {
    const r = parseRange("5:ab");
    expect(r.start).toEqual({ line: 5, hash: "ab" });
    expect(r.end).toEqual({ line: 5, hash: "ab" });
  });

  test("single-line shorthand returns independent start/end objects", () => {
    const r = parseRange("5:ab");
    expect(r.start).toEqual(r.end);
    expect(r.start).not.toBe(r.end); // must be distinct objects
  });

  test("throws on malformed range (not a valid line:hash either)", () => {
    // "12:gh-21:yz" has no ".." and the hash "gh-21:yz" is not 2 lowercase letters
    expect(() => parseRange("12:gh-21:yz")).toThrow("2 lowercase letters");
  });

  test("throws when start > end", () => {
    expect(() => parseRange("21:ab..12:cd")).toThrow("must be ≤");
  });
});

describe("parseChecksum", () => {
  test("parses valid checksum", () => {
    const cs = parseChecksum("10-25:f7e2abcd");
    expect(cs).toEqual({ startLine: 10, endLine: 25, hash: "f7e2abcd" });
  });

  test("throws on invalid hex", () => {
    expect(() => parseChecksum("1-2:ZZZZZZZZ")).toThrow("8 hex chars");
  });

  test("throws on too-short hex", () => {
    expect(() => parseChecksum("1-2:f7e2")).toThrow("8 hex chars");
  });

  test("allows 0-0 empty sentinel", () => {
    const cs = parseChecksum("0-0:00000000");
    expect(cs).toEqual({ startLine: 0, endLine: 0, hash: "00000000" });
  });

  test("throws on 0-5 (startLine 0 with non-zero endLine)", () => {
    expect(() => parseChecksum("0-5:00000000")).toThrow("startLine 0 requires endLine 0");
  });

  test("rejects scientific notation in start line", () => {
    expect(() => parseChecksum("1e2-3:00000000")).toThrow("decimal integer");
  });

  test("rejects scientific notation in end line", () => {
    expect(() => parseChecksum("1-3e1:00000000")).toThrow("decimal integer");
  });
});
