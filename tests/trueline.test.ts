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
  test("produces startLine-endLine:6letter format", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    expect(cs).toMatch(/^[a-z]{2}\.1-[a-z]{2}\.3:[a-z]{6}$/);
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
    expect(cs).toMatch(/^[a-z]{2}\.1-[a-z]{2}\.2:[a-z]{6}$/);
    expect(cs).toBe(rangeChecksum(lines, 1, 2));
  });
});

describe("parseRange", () => {
  test("parses valid range", () => {
    const r = parseRange("gh.12-yz.21");
    expect(r.start).toEqual({ line: 12, hash: "gh" });
    expect(r.end).toEqual({ line: 21, hash: "yz" });
  });

  test("parses single-line range", () => {
    const r = parseRange("ab.5-ab.5");
    expect(r.start.line).toBe(5);
    expect(r.end.line).toBe(5);
  });

  test("parses single hash.line as self-range", () => {
    const r = parseRange("ab.5");
    expect(r.start).toEqual({ line: 5, hash: "ab" });
    expect(r.end).toEqual({ line: 5, hash: "ab" });
  });

  test("single-line shorthand returns independent start/end objects", () => {
    const r = parseRange("ab.5");
    expect(r.start).toEqual(r.end);
    expect(r.start).not.toBe(r.end); // must be distinct objects
  });

  test("parses dash-separated range", () => {
    const r = parseRange("gh.12-yz.21");
    expect(r.start).toEqual({ line: 12, hash: "gh" });
    expect(r.end).toEqual({ line: 21, hash: "yz" });
  });

  test("throws when start > end", () => {
    expect(() => parseRange("ab.21-cd.12")).toThrow("must be ≤");
  });
});

describe("parseChecksum", () => {
  test("parses valid checksum", () => {
    const cs = parseChecksum("10-25:abcdef");
    expect(cs).toEqual({ startLine: 10, endLine: 25, hash: "abcdef" });
  });

  test("throws on invalid hex", () => {
    expect(() => parseChecksum("1-2:ZZZZZZZZ")).toThrow("6 lowercase letters");
  });

  test("throws on too-short hex", () => {
    expect(() => parseChecksum("1-2:f7e2")).toThrow("6 lowercase letters");
  });

  test("allows 0-0 empty sentinel", () => {
    const cs = parseChecksum("0-0:aaaaaa");
    expect(cs).toEqual({ startLine: 0, endLine: 0, hash: "aaaaaa" });
  });

  test("throws on 0-5 (startLine 0 with non-zero endLine)", () => {
    expect(() => parseChecksum("0-5:aaaaaa")).toThrow("startLine 0 requires endLine 0");
  });

  test("rejects scientific notation in start line", () => {
    expect(() => parseChecksum("1e2-3:aaaaaa")).toThrow("decimal integer");
  });

  test("rejects scientific notation in end line", () => {
    expect(() => parseChecksum("1-3e1:aaaaaa")).toThrow("decimal integer");
  });

  test("rejects 0-0 sentinel with non-zero hash", () => {
    expect(() => parseChecksum("0-0:abcdef")).toThrow("empty-file sentinel must have hash aaaaaa");
  });
});
