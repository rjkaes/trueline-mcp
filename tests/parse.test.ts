import { describe, expect, test } from "bun:test";
import { parseChecksum, parseFilePathWithRanges, parseRange, parseRanges } from "../src/parse.ts";

describe("parseRanges", () => {
  test("returns whole-file sentinel for undefined input", () => {
    const result = parseRanges(undefined);
    expect(result).toEqual([{ start: 1, end: Infinity }]);
  });

  test("returns whole-file sentinel for empty array", () => {
    const result = parseRanges([]);
    expect(result).toEqual([{ start: 1, end: Infinity }]);
  });

  test('parses "10-20" range', () => {
    const result = parseRanges(["10-20"]);
    expect(result).toEqual([{ start: 10, end: 20 }]);
  });

  test('parses "10" as single line', () => {
    const result = parseRanges(["10"]);
    expect(result).toEqual([{ start: 10, end: 10 }]);
  });

  test('parses "10-" as line to EOF', () => {
    const result = parseRanges(["10-"]);
    expect(result).toEqual([{ start: 10, end: Infinity }]);
  });

  test('parses "-20" as start to line 20', () => {
    const result = parseRanges(["-20"]);
    expect(result).toEqual([{ start: 1, end: 20 }]);
  });

  test("sorts ranges by start", () => {
    const result = parseRanges(["50-60", "10-20"]);
    expect(result).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ]);
  });

  test("merges overlapping ranges", () => {
    const result = parseRanges(["1-20", "15-30"]);
    expect(result).toEqual([{ start: 1, end: 30 }]);
  });

  test("merges adjacent ranges", () => {
    const result = parseRanges(["1-20", "21-30"]);
    expect(result).toEqual([{ start: 1, end: 30 }]);
  });

  test("throws on start < 1", () => {
    expect(() => parseRanges(["0-10"])).toThrow(/start/i);
  });

  test("throws on start > end", () => {
    expect(() => parseRanges(["20-10"])).toThrow(/start.*end/i);
  });

  test("throws on non-numeric input", () => {
    expect(() => parseRanges(["abc"])).toThrow(/start/i);
  });

  test("allows non-adjacent ranges", () => {
    const result = parseRanges(["1-10", "20-30"]);
    expect(result).toEqual([
      { start: 1, end: 10 },
      { start: 20, end: 30 },
    ]);
  });
});

describe("parseRange", () => {
  test("parses dash-separated range", () => {
    const result = parseRange("kq.16-yx.17");
    expect(result.start).toEqual({ line: 16, hash: "kq" });
    expect(result.end).toEqual({ line: 17, hash: "yx" });
    expect(result.insertAfter).toBe(false);
  });

  test("parses single line reference", () => {
    const result = parseRange("ab.5");
    expect(result.start).toEqual({ line: 5, hash: "ab" });
    expect(result.end).toEqual({ line: 5, hash: "ab" });
  });

  test("parses insert-after prefix", () => {
    const result = parseRange("+cd.10");
    expect(result.insertAfter).toBe(true);
    expect(result.start).toEqual({ line: 10, hash: "cd" });
  });

  test("rejects insert-after with range", () => {
    expect(() => parseRange("+cd.10-ef.20")).toThrow(/insert-after/);
  });
});

describe("parseChecksum", () => {
  test("decimal format (existing behavior)", () => {
    const result = parseChecksum("9-10:abcdef01");
    expect(result).toEqual({ startLine: 9, endLine: 10, hash: "abcdef01" });
  });

  test("hash.line format", () => {
    const result = parseChecksum("aj.9-na.10:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("single hash.line (no dash, start = end)", () => {
    const result = parseChecksum("aj.9:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(9);
    expect(result.hash).toBe("abcdef01");
  });

  test("single decimal (no dash, start = end)", () => {
    const result = parseChecksum("9:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(9);
    expect(result.hash).toBe("abcdef01");
  });

  test("strips 'checksum: ' label prefix", () => {
    const result = parseChecksum("checksum: 9-10:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("strips 'checksum:' label prefix without space", () => {
    const result = parseChecksum("checksum:9-10:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("strips label with hash.line format", () => {
    const result = parseChecksum("checksum: aj.9-na.10:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("trims whitespace", () => {
    const result = parseChecksum("  9-10:abcdef01  ");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("mixed format: hash prefix on start only", () => {
    const result = parseChecksum("aj.9-10:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("mixed format: hash prefix on end only", () => {
    const result = parseChecksum("9-na.10:abcdef01");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef01");
  });

  test("preserves empty-file sentinel 0-0:00000000", () => {
    const result = parseChecksum("0-0:00000000");
    expect(result).toEqual({ startLine: 0, endLine: 0, hash: "00000000" });
  });

  test("rejects missing hash (no colon)", () => {
    expect(() => parseChecksum("9-10")).toThrow();
  });

  test("rejects garbage input", () => {
    expect(() => parseChecksum("notachecksum")).toThrow();
  });
});

describe("parseFilePathWithRanges", () => {
  test("plain path returns no ranges", () => {
    const result = parseFilePathWithRanges("src/foo.ts");
    expect(result.path).toBe("src/foo.ts");
    expect(result.rangeSpecs).toBeUndefined();
  });

  test("single range", () => {
    const result = parseFilePathWithRanges("src/foo.ts:10-25");
    expect(result.path).toBe("src/foo.ts");
    expect(result.rangeSpecs).toEqual(["10-25"]);
  });

  test("multiple comma-separated ranges", () => {
    const result = parseFilePathWithRanges("src/foo.ts:1-20,200-220");
    expect(result.path).toBe("src/foo.ts");
    expect(result.rangeSpecs).toEqual(["1-20", "200-220"]);
  });

  test("single line", () => {
    const result = parseFilePathWithRanges("src/foo.ts:42");
    expect(result.path).toBe("src/foo.ts");
    expect(result.rangeSpecs).toEqual(["42"]);
  });

  test("open-ended range", () => {
    const result = parseFilePathWithRanges("src/foo.ts:10-");
    expect(result.path).toBe("src/foo.ts");
    expect(result.rangeSpecs).toEqual(["10-"]);
  });

  test("absolute path", () => {
    const result = parseFilePathWithRanges("/Users/dev/project/src/foo.ts:10-25");
    expect(result.path).toBe("/Users/dev/project/src/foo.ts");
    expect(result.rangeSpecs).toEqual(["10-25"]);
  });

  test("path with no range suffix treats trailing digits as path", () => {
    const result = parseFilePathWithRanges("src/file123.ts");
    expect(result.path).toBe("src/file123.ts");
    expect(result.rangeSpecs).toBeUndefined();
  });

  test("Windows drive letter is not split", () => {
    const result = parseFilePathWithRanges("C:\\src\\foo.ts");
    expect(result.path).toBe("C:\\src\\foo.ts");
    expect(result.rangeSpecs).toBeUndefined();
  });
});
