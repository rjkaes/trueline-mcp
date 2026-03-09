import { describe, expect, test } from "bun:test";
import { parseRange, parseRanges } from "../src/parse.ts";

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
    const result = parseRange("16-17");
    expect(result.start).toBe(16);
    expect(result.end).toBe(17);
    expect(result.insertAfter).toBe(false);
  });

  test("parses single line reference", () => {
    const result = parseRange("5");
    expect(result.start).toBe(5);
    expect(result.end).toBe(5);
  });

  test("parses insert-after prefix", () => {
    const result = parseRange("+10");
    expect(result.insertAfter).toBe(true);
    expect(result.start).toBe(10);
  });

  test("rejects insert-after with range", () => {
    expect(() => parseRange("+10-20")).toThrow(/insert-after/);
  });
});
