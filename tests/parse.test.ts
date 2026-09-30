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
    const result = parseRange("kq16-yx17");
    expect(result.start).toEqual({ line: 16, hash: "kq" });
    expect(result.end).toEqual({ line: 17, hash: "yx" });
    expect(result.insertAfter).toBe(false);
  });

  test("parses single line reference", () => {
    const result = parseRange("ab5");
    expect(result.start).toEqual({ line: 5, hash: "ab" });
    expect(result.end).toEqual({ line: 5, hash: "ab" });
  });

  test("parses insert-after prefix", () => {
    const result = parseRange("+cd10");
    expect(result.insertAfter).toBe(true);
    expect(result.start).toEqual({ line: 10, hash: "cd" });
  });

  test("rejects insert-after with range", () => {
    expect(() => parseRange("+cd10-ef20")).toThrow(/insert-after/);
  });
});

describe("parseChecksum", () => {
  test("decimal format (existing behavior)", () => {
    const result = parseChecksum("9-10/abcdef");
    expect(result).toEqual({ startLine: 9, endLine: 10, hash: "abcdef" });
  });

  test("hashLine format", () => {
    const result = parseChecksum("aj9-na10/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("single hashLine (no dash, start = end)", () => {
    const result = parseChecksum("aj9/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(9);
    expect(result.hash).toBe("abcdef");
  });

  test("single decimal (no dash, start = end)", () => {
    const result = parseChecksum("9/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(9);
    expect(result.hash).toBe("abcdef");
  });

  test("strips 'checksum: ' label prefix", () => {
    const result = parseChecksum("checksum: 9-10/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("strips 'checksum:' label prefix without space", () => {
    const result = parseChecksum("checksum:9-10/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("strips label with hashLine format", () => {
    const result = parseChecksum("checksum: aj9-na10/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("trims whitespace", () => {
    const result = parseChecksum("  9-10/abcdef  ");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("mixed format: hash prefix on start only", () => {
    const result = parseChecksum("aj9-10/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("mixed format: hash prefix on end only", () => {
    const result = parseChecksum("9-na10/abcdef");
    expect(result.startLine).toBe(9);
    expect(result.endLine).toBe(10);
    expect(result.hash).toBe("abcdef");
  });

  test("preserves empty-file sentinel 0-0/aaaaaa", () => {
    const result = parseChecksum("0-0/aaaaaa");
    expect(result).toEqual({ startLine: 0, endLine: 0, hash: "aaaaaa" });
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

// The trueline_edit JSON schema (src/server.ts) shows range/ref examples in its
// description text for LLM consumption. server.ts can't be imported directly here
// (starts listening as a side effect - see tests/tools-list-schema.test.ts), so these
// are hardcoded copies of that example. Keep them in sync with src/server.ts by hand;
// this test only guards against the dotted "ab.10-cd.20"/"ab.10-cd.20:efghij" format
// the parser has never accepted regressing back into the docs.
describe("docs examples match the real hashLine/checksum format", () => {
  test("trueline_edit schema's range example parses", () => {
    expect(() => parseRange("ab10-cd20")).not.toThrow();
  });

  test("trueline_edit schema's ref example parses", () => {
    expect(() => parseChecksum("ab10-cd20/efghij")).not.toThrow();
  });
});

describe("parseFilePathWithRanges only splits on valid range syntax", () => {
  test.each([
    "logs/2024-01-01T10:30:00.log",
    "notes 12:30.md",
    "file:2.txt",
    "/var/log/app:12abc",
    "src/a.ts:10:abc",
    "src/a.ts:10,",
    "src/a.ts:10-20-30",
    "src/a.ts:1,,2",
  ])("%p is a plain path", (entry) => {
    expect(parseFilePathWithRanges(entry)).toEqual({ path: entry, rangeSpecs: undefined });
  });

  test("valid tails still split", () => {
    expect(parseFilePathWithRanges("src/a.ts:10")).toEqual({ path: "src/a.ts", rangeSpecs: ["10"] });
    expect(parseFilePathWithRanges("src/a.ts:10-")).toEqual({ path: "src/a.ts", rangeSpecs: ["10-"] });
    expect(parseFilePathWithRanges("src/a.ts:1-5, 7")).toEqual({ path: "src/a.ts", rangeSpecs: ["1-5", "7"] });
    expect(parseFilePathWithRanges("/tmp/a:b:3")).toEqual({ path: "/tmp/a:b", rangeSpecs: ["3"] });
  });

  test("a well-formed but out-of-range tail still splits, so parseRanges can explain it", () => {
    expect(parseFilePathWithRanges("src/a.ts:0")).toEqual({ path: "src/a.ts", rangeSpecs: ["0"] });
  });
});

describe("parseRanges accepts plain decimal integers only", () => {
  test.each(["0x10", "1e1", "10.0", "10-Infinity", "10-0x20", "1e3-2e3", "+5", "10-20.5"])("rejects %p", (range) => {
    expect(() => parseRanges([range])).toThrow(/Invalid range/);
  });

  test("rejects integers beyond the safe range", () => {
    expect(() => parseRanges(["9007199254740993"])).toThrow(/Invalid range/);
    expect(() => parseRanges(["10-9007199254740993"])).toThrow(/Invalid range/);
  });

  test("a 400-digit end is an error, not an open-ended range", () => {
    expect(() => parseRanges([`10-${"9".repeat(400)}`])).toThrow(/Invalid range/);
  });

  test("a 400-digit start is an error", () => {
    expect(() => parseRanges(["9".repeat(400)])).toThrow(/Invalid range/);
  });

  test("valid forms still parse", () => {
    expect(parseRanges(["10"])).toEqual([{ start: 10, end: 10 }]);
    expect(parseRanges(["10-20"])).toEqual([{ start: 10, end: 20 }]);
    expect(parseRanges(["10-"])).toEqual([{ start: 10, end: Infinity }]);
    expect(parseRanges(["-20"])).toEqual([{ start: 1, end: 20 }]);
    expect(parseRanges(["007"])).toEqual([{ start: 7, end: 7 }]);
    expect(parseRanges([`1-${Number.MAX_SAFE_INTEGER}`])).toEqual([{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
  });

  test("whitespace around the dash is still tolerated", () => {
    expect(parseRanges(["10 - 20"])).toEqual([{ start: 10, end: 20 }]);
  });
});

describe("line numbers beyond the safe integer range", () => {
  const huge = "9".repeat(30);

  test.each([huge, `ab${huge}`, `ab10-cd${huge}`, `${huge}-ab5`, `+ab${huge}`, "9007199254740993"])(
    "parseRange rejects %p with a clear error",
    (range) => {
      expect(() => parseRange(range)).toThrow(/too large/);
    },
  );

  test.each([`ab1-cd${huge}/abcdef`, `1-${huge}/abcdef`, `ab${huge}/abcdef`, `${huge}/abcdef`])(
    "parseChecksum rejects %p with a clear error",
    (checksum) => {
      expect(() => parseChecksum(checksum)).toThrow(/too large/);
    },
  );

  test("the largest safe line number still parses", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(parseRange(`ab${max}`).start.line).toBe(max);
    expect(parseChecksum(`ab1-cd${max}/abcdef`).endLine).toBe(max);
  });
});
