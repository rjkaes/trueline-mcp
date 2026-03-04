import { describe, expect, test } from "bun:test";
import {
  fnv1aHash,
  lineHash,
  rangeChecksum,
  formatTruelinesFromArray,
  formatTruelinesWithHashes,
  rangeChecksumFromHashes,
  parseLineHash,
  parseRange,
  parseChecksum,
  verifyChecksum,
  verifyHashes,
  applyEdits,
} from "../src/trueline.ts";

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
    expect(rangeChecksum(lines1, 1, 3)).not.toBe(
      rangeChecksum(lines2, 1, 3),
    );
  });

  test("clamps endLine to file length", () => {
    const lines = ["a", "b"];
    const cs = rangeChecksum(lines, 1, 10);
    expect(cs).toMatch(/^1-2:[0-9a-f]{8}$/);
    expect(cs).toBe(rangeChecksum(lines, 1, 2));
  });
});

describe("formatTruelinesFromArray", () => {
  test("formats array of lines", () => {
    const result = formatTruelinesFromArray(["a", "b"], 1);
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|a$/);
    expect(lines[1]).toMatch(/^2:[a-z]{2}\|b$/);
  });

  test("returns empty for empty array", () => {
    expect(formatTruelinesFromArray([])).toBe("");
  });
});

describe("parseLineHash", () => {
  test("parses valid reference", () => {
    const ref = parseLineHash("4:mp");
    expect(ref).toEqual({ line: 4, hash: "mp" });
  });

  test("parses zero-line insert reference", () => {
    const ref = parseLineHash("0:");
    expect(ref).toEqual({ line: 0, hash: "" });
  });

  test("throws when line 0 has non-empty hash", () => {
    expect(() => parseLineHash("0:ab")).toThrow("line 0 must have empty hash");
  });

  test("throws on missing colon", () => {
    expect(() => parseLineHash("4mp")).toThrow("missing colon");
  });

  test("throws on invalid hash", () => {
    expect(() => parseLineHash("4:M")).toThrow("2 lowercase letters");
  });

  test("throws on negative line", () => {
    expect(() => parseLineHash("-1:ab")).toThrow("non-negative integer");
  });

  test("throws on bare colon (empty line number)", () => {
    expect(() => parseLineHash(":")).toThrow("non-negative integer");
  });

  test("throws on whitespace before colon", () => {
    expect(() => parseLineHash(" :ab")).toThrow("non-negative integer");
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

describe("verifyChecksum", () => {
  test("returns null for valid checksum", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    expect(verifyChecksum(lines, cs)).toBeNull();
  });

  test("returns error for changed content", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    lines[1] = "changed";
    const err = verifyChecksum(lines, cs);
    expect(err).toContain("mismatch");
  });

  test("returns error when range exceeds file length", () => {
    const lines = ["only one"];
    const err = verifyChecksum(lines, "1-5:abcdabcd");
    expect(err).toContain("exceeds");
  });

  test("rejects bare hex hash with helpful message including range example", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const err = verifyChecksum(lines, "ab80afda");
    expect(err).toContain("pass the full checksum");
    expect(err).toContain("1-3:ab80afda");
  });

  test("returns error (not crash) for crafted 0-0 checksum with non-zero hash", () => {
    const err = verifyChecksum([], "0-0:abcdef01");
    expect(typeof err).toBe("string");
    expect(err).toContain("0-0");
  });
});

describe("verifyHashes", () => {
  test("returns null when all hashes match", () => {
    const lines = ["hello", "world"];
    const refs = [
      { line: 1, hash: lineHash("hello") },
      { line: 2, hash: lineHash("world") },
    ];
    expect(verifyHashes(lines, refs)).toBeNull();
  });

  test("returns error on hash mismatch", () => {
    const lines = ["hello", "world"];
    const refs = [{ line: 1, hash: "zz" }];
    const err = verifyHashes(lines, refs);
    expect(err).toContain("mismatch");
  });

  test("returns error on out-of-range line", () => {
    const lines = ["hello"];
    const refs = [{ line: 5, hash: "ab" }];
    const err = verifyHashes(lines, refs);
    expect(err).toContain("out of range");
  });

  test("allows zero-line insert ref", () => {
    expect(verifyHashes(["hello"], [{ line: 0, hash: "" }])).toBeNull();
  });
});

describe("single-pass hashing helpers", () => {
  test("formatTruelinesWithHashes matches formatTruelinesFromArray", () => {
    const lines = ["hello", "world", "foo"];
    const hashes = lines.map(fnv1aHash);
    expect(formatTruelinesWithHashes(lines, hashes, 1))
      .toBe(formatTruelinesFromArray(lines, 1));
  });

  test("rangeChecksumFromHashes matches rangeChecksum", () => {
    const lines = ["hello", "world", "foo"];
    const hashes = lines.map(fnv1aHash);
    expect(rangeChecksumFromHashes(hashes, 1, 3))
      .toBe(rangeChecksum(lines, 1, 3));
  });
});

describe("applyEdits", () => {
  test("replaces a range of lines", () => {
    const lines = ["a", "b", "c", "d"];
    const result = applyEdits(lines, [
      { startLine: 2, endLine: 3, content: ["x", "y"], insertAfter: false },
    ]);
    expect(result).toEqual(["a", "x", "y", "d"]);
  });

  test("inserts after a line", () => {
    const lines = ["a", "b", "c"];
    const result = applyEdits(lines, [
      { startLine: 1, endLine: 1, content: ["new"], insertAfter: true },
    ]);
    expect(result).toEqual(["a", "new", "b", "c"]);
  });

  test("deletes lines when content is empty", () => {
    const lines = ["a", "b", "c"];
    const result = applyEdits(lines, [
      { startLine: 2, endLine: 2, content: [], insertAfter: false },
    ]);
    expect(result).toEqual(["a", "c"]);
  });

  test("multiple insertAfter at same anchor appear in input order", () => {
    const lines = ["anchor", "next"];
    const result = applyEdits(lines, [
      { startLine: 1, endLine: 1, content: ["first"], insertAfter: true },
      { startLine: 1, endLine: 1, content: ["second"], insertAfter: true },
      { startLine: 1, endLine: 1, content: ["third"], insertAfter: true },
    ]);
    expect(result).toEqual(["anchor", "first", "second", "third", "next"]);
  });

  test("handles multiple edits in correct order", () => {
    const lines = ["a", "b", "c", "d"];
    const result = applyEdits(lines, [
      { startLine: 1, endLine: 1, content: ["A"], insertAfter: false },
      { startLine: 4, endLine: 4, content: ["D"], insertAfter: false },
    ]);
    expect(result).toEqual(["A", "b", "c", "D"]);
  });

  test("handles insertion of more than 65K lines without crashing", () => {
    const lines = ["before", "after"];
    const bigContent = Array.from({ length: 70_000 }, (_, i) => `line ${i}`);
    const result = applyEdits(lines, [
      { startLine: 1, endLine: 1, content: bigContent, insertAfter: true },
    ]);
    expect(result.length).toBe(70_002);
    expect(result[0]).toBe("before");
    expect(result[70_001]).toBe("after");
  });
});
