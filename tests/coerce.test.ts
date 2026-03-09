import { describe, expect, test } from "bun:test";
import { coerceParams } from "../src/coerce.ts";

describe("coerceParams", () => {
  test("passes through non-objects unchanged", () => {
    expect(coerceParams(null)).toBe(null);
    expect(coerceParams(undefined)).toBe(undefined);
    expect(coerceParams("hello")).toBe("hello");
    expect(coerceParams(42)).toBe(42);
  });

  describe("alias mapping", () => {
    test("maps paths → file_paths", () => {
      expect(coerceParams({ paths: ["a.ts", "b.ts"] })).toEqual({ file_paths: ["a.ts", "b.ts"] });
    });

    test("maps path → file_path", () => {
      expect(coerceParams({ path: "a.ts" })).toEqual({ file_path: "a.ts" });
    });

    test("maps filePath → file_path", () => {
      expect(coerceParams({ filePath: "a.ts" })).toEqual({ file_path: "a.ts" });
    });

    test("maps filePaths → file_paths", () => {
      expect(coerceParams({ filePaths: ["a.ts"] })).toEqual({ file_paths: ["a.ts"] });
    });

    test("maps file → file_path", () => {
      expect(coerceParams({ file: "a.ts" })).toEqual({ file_path: "a.ts" });
    });

    test("maps files → file_paths", () => {
      expect(coerceParams({ files: ["a.ts"] })).toEqual({ file_paths: ["a.ts"] });
    });

    test("maps ref → compare_against", () => {
      expect(coerceParams({ ref: "HEAD~1" })).toEqual({ compare_against: "HEAD~1" });
    });

    test("canonical key wins when both provided", () => {
      expect(coerceParams({ paths: ["wrong.ts"], file_paths: ["right.ts"] })).toEqual({
        file_paths: ["right.ts"],
      });
    });

    test("preserves non-aliased keys", () => {
      expect(coerceParams({ pattern: "foo", regex: true })).toEqual({ pattern: "foo", regex: true });
    });
  });

  describe("stringified JSON coercion", () => {
    test("coerces stringified arrays", () => {
      expect(coerceParams({ file_paths: '["a.ts","b.ts"]' })).toEqual({ file_paths: ["a.ts", "b.ts"] });
    });

    test("coerces stringified string arrays", () => {
      expect(coerceParams({ ranges: '["1-10","20-30"]' })).toEqual({ ranges: ["1-10", "20-30"] });
    });

    test("leaves invalid JSON strings as-is", () => {
      expect(coerceParams({ file_path: "[not json" })).toEqual({ file_path: "[not json" });
    });
  });

  describe("boolean coercion", () => {
    test('coerces "true" → true', () => {
      expect(coerceParams({ dry_run: "true" })).toEqual({ dry_run: true });
    });

    test('coerces "false" → false', () => {
      expect(coerceParams({ dry_run: "false" })).toEqual({ dry_run: false });
    });

    test("leaves actual booleans unchanged", () => {
      expect(coerceParams({ dry_run: true })).toEqual({ dry_run: true });
      expect(coerceParams({ dry_run: false })).toEqual({ dry_run: false });
    });
  });

  describe("ranges pass-through", () => {
    test("string ranges are passed through unchanged", () => {
      expect(coerceParams({ ranges: ["10-20"] })).toEqual({ ranges: ["10-20"] });
    });

    test("single-line range string is passed through", () => {
      expect(coerceParams({ ranges: ["10"] })).toEqual({ ranges: ["10"] });
    });

    test("multiple range strings are passed through", () => {
      expect(coerceParams({ ranges: ["1-50", "100-200"] })).toEqual({
        ranges: ["1-50", "100-200"],
      });
    });

    test("realistic trueline_read call with string ranges", () => {
      expect(coerceParams({ file_path: "src/server.ts", ranges: ["149-173"] })).toEqual({
        file_path: "src/server.ts",
        ranges: ["149-173"],
      });
    });
  });

  describe("combined coercions", () => {
    test("alias + JSON coercion together", () => {
      expect(coerceParams({ paths: '["a.ts"]' })).toEqual({ file_paths: ["a.ts"] });
    });

    test("alias + boolean coercion together", () => {
      expect(coerceParams({ path: "a.ts", dry_run: "false" })).toEqual({ file_path: "a.ts", dry_run: false });
    });

    test("realistic trueline_outline call with paths alias", () => {
      expect(coerceParams({ paths: '["src/server.ts","src/coerce.ts"]' })).toEqual({
        file_paths: ["src/server.ts", "src/coerce.ts"],
      });
    });

    test("realistic trueline_diff call with ref alias", () => {
      expect(coerceParams({ file_paths: ["src/server.ts"], ref: "HEAD~1" })).toEqual({
        file_paths: ["src/server.ts"],
        compare_against: "HEAD~1",
      });
    });
  });
});
