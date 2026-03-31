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

    test("maps path → file_paths (wrapped)", () => {
      expect(coerceParams({ path: "a.ts" })).toEqual({ file_paths: ["a.ts"] });
    });

    test("maps filePath → file_paths (wrapped)", () => {
      expect(coerceParams({ filePath: "a.ts" })).toEqual({ file_paths: ["a.ts"] });
    });

    test("maps filePaths → file_paths", () => {
      expect(coerceParams({ filePaths: ["a.ts"] })).toEqual({ file_paths: ["a.ts"] });
    });

    test("maps file → file_paths (wrapped)", () => {
      expect(coerceParams({ file: "a.ts" })).toEqual({ file_paths: ["a.ts"] });
    });

    test("maps file_path → file_paths (wrapped)", () => {
      expect(coerceParams({ file_path: "a.ts" })).toEqual({ file_paths: ["a.ts"] });
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
      expect(coerceParams({ file_paths: "[not json" })).toEqual({ file_paths: ["[not json"] });
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
        file_paths: ["src/server.ts"],
        ranges: ["149-173"],
      });
    });
  });

  describe("no-op when no top-level ref", () => {
    test("edits keep their own refs", () => {
      const input = {
        file_path: "foo.ts",
        edits: [{ range: "ab.10-cd.12", content: "text", ref: "R1" }],
      };
      expect(coerceParams(input)).toEqual({
        file_paths: ["foo.ts"],
        edits: [{ range: "ab.10-cd.12", content: "text", ref: "R1" }],
      });
    });
  });

  describe("range → ranges alias (#1)", () => {
    test("maps singular range string to ranges array", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], range: "10-20" })).toEqual({
        file_paths: ["foo.ts"],
        ranges: ["10-20"],
      });
    });

    test("canonical ranges wins when both provided", () => {
      expect(coerceParams({ range: "1-5", ranges: ["10-20"] })).toEqual({ ranges: ["10-20"] });
    });
  });

  describe("ranges bare string → array (#2)", () => {
    test("wraps bare ranges string in array", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], ranges: "10-20" })).toEqual({
        file_paths: ["foo.ts"],
        ranges: ["10-20"],
      });
    });
  });

  describe("ranges per-file object → flat array", () => {
    test("extracts values from per-file object", () => {
      expect(coerceParams({ file_paths: ["src/server.ts"], ranges: { "src/server.ts": "144-169" } })).toEqual({
        file_paths: ["src/server.ts"],
        ranges: ["144-169"],
      });
    });

    test("flattens array values from per-file object", () => {
      expect(coerceParams({ file_paths: ["a.ts"], ranges: { "a.ts": ["1-10", "20-30"] } })).toEqual({
        file_paths: ["a.ts"],
        ranges: ["1-10", "20-30"],
      });
    });
  });

  describe("stringified integer coercion (#3)", () => {
    test('coerces depth: "2" → 2', () => {
      expect(coerceParams({ file_paths: ["foo.ts"], depth: "2" })).toEqual({
        file_paths: ["foo.ts"],
        depth: 2,
      });
    });

    test('coerces context_lines: "5" → 5', () => {
      expect(coerceParams({ context_lines: "5" })).toEqual({ context_lines: 5 });
    });

    test('coerces max_matches: "20" → 20', () => {
      expect(coerceParams({ max_matches: "20" })).toEqual({ max_matches: 20 });
    });

    test("leaves actual numbers unchanged", () => {
      expect(coerceParams({ depth: 3 })).toEqual({ depth: 3 });
    });

    test("does not coerce context_lines: 1 to boolean true", () => {
      expect(coerceParams({ context_lines: 1 })).toEqual({ context_lines: 1 });
    });

    test("does not coerce max_matches: 0 to boolean false", () => {
      expect(coerceParams({ max_matches: 0 })).toEqual({ max_matches: 0 });
    });

    test("leaves non-integer strings unchanged", () => {
      expect(coerceParams({ depth: "abc" })).toEqual({ depth: "abc" });
    });

    test("leaves float strings unchanged", () => {
      expect(coerceParams({ depth: "2.5" })).toEqual({ depth: "2.5" });
    });
  });

  describe("pattern aliases (#4)", () => {
    test("maps query → pattern", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], query: "hello" })).toEqual({
        file_paths: ["foo.ts"],
        pattern: "hello",
      });
    });

    test("maps search → pattern", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], search: "hello" })).toEqual({
        file_paths: ["foo.ts"],
        pattern: "hello",
      });
    });

    test("canonical pattern wins when both provided", () => {
      expect(coerceParams({ query: "wrong", pattern: "right" })).toEqual({ pattern: "right" });
    });
  });

  describe("context_lines alias (#5)", () => {
    test("maps context → context_lines", () => {
      expect(coerceParams({ context: 3 })).toEqual({ context_lines: 3 });
    });
  });

  describe("max_matches alias (#6)", () => {
    test("maps limit → max_matches", () => {
      expect(coerceParams({ limit: 5 })).toEqual({ max_matches: 5 });
    });
  });

  describe("dry_run aliases (#7)", () => {
    test("maps dryRun → dry_run", () => {
      expect(coerceParams({ dryRun: true })).toEqual({ dry_run: true });
    });

    test("maps dry-run → dry_run", () => {
      expect(coerceParams({ "dry-run": true })).toEqual({ dry_run: true });
    });

    test("canonical dry_run wins when both provided", () => {
      expect(coerceParams({ dryRun: false, dry_run: true })).toEqual({ dry_run: true });
    });
  });

  describe("extended boolean coercion (#8)", () => {
    test('coerces "yes" → true', () => {
      expect(coerceParams({ case_insensitive: "yes" })).toEqual({ case_insensitive: true });
    });

    test('coerces "no" → false', () => {
      expect(coerceParams({ case_insensitive: "no" })).toEqual({ case_insensitive: false });
    });

    test("coerces 1 → true", () => {
      expect(coerceParams({ regex: 1 })).toEqual({ regex: true });
    });

    test("coerces 0 → false", () => {
      expect(coerceParams({ regex: 0 })).toEqual({ regex: false });
    });
  });

  describe("refs bare string → array (#9)", () => {
    test("wraps bare refs string in array", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], refs: "R1" })).toEqual({
        file_paths: ["foo.ts"],
        refs: ["R1"],
      });
    });
  });

  describe("edits bare object → array (#10)", () => {
    test("wraps single edit object in array", () => {
      const edit = { range: "ab.10-cd.12", content: "new", ref: "R1" };
      expect(coerceParams({ file_path: "foo.ts", edits: edit })).toEqual({
        file_paths: ["foo.ts"],
        edits: [edit],
      });
    });

    test("leaves edit array unchanged", () => {
      const edit = { range: "ab.10-cd.12", content: "new", ref: "R1" };
      expect(coerceParams({ file_path: "foo.ts", edits: [edit] })).toEqual({
        file_paths: ["foo.ts"],
        edits: [edit],
      });
    });
  });

  describe("camelCase aliases for snake_case params", () => {
    test("maps contextLines → context_lines", () => {
      expect(coerceParams({ contextLines: 3 })).toEqual({ context_lines: 3 });
    });

    test("maps maxMatches → max_matches", () => {
      expect(coerceParams({ maxMatches: 10 })).toEqual({ max_matches: 10 });
    });

    test("maps max_results → max_matches", () => {
      expect(coerceParams({ max_results: 10 })).toEqual({ max_matches: 10 });
    });

    test("maps maxResults → max_matches", () => {
      expect(coerceParams({ maxResults: 10 })).toEqual({ max_matches: 10 });
    });

    test("maps caseInsensitive → case_insensitive", () => {
      expect(coerceParams({ caseInsensitive: true })).toEqual({ case_insensitive: true });
    });

    test("maps ignoreCase → case_insensitive", () => {
      expect(coerceParams({ ignoreCase: true })).toEqual({ case_insensitive: true });
    });

    test("maps ignore_case → case_insensitive", () => {
      expect(coerceParams({ ignore_case: true })).toEqual({ case_insensitive: true });
    });

    test("maps compareAgainst → compare_against", () => {
      expect(coerceParams({ compareAgainst: "HEAD~1" })).toEqual({ compare_against: "HEAD~1" });
    });
  });

  describe("content array → string in edits", () => {
    test("joins content array with newlines", () => {
      expect(
        coerceParams({
          file_path: "foo.ts",
          edits: [{ range: "ab.10-cd.12", ref: "R1", content: ["line1", "line2", "line3"] }],
        }),
      ).toEqual({
        file_paths: ["foo.ts"],
        edits: [{ range: "ab.10-cd.12", ref: "R1", content: "line1\nline2\nline3" }],
      });
    });

    test("leaves string content unchanged", () => {
      expect(
        coerceParams({
          file_path: "foo.ts",
          edits: [{ range: "ab.10", ref: "R1", content: "single line" }],
        }),
      ).toEqual({
        file_paths: ["foo.ts"],
        edits: [{ range: "ab.10", ref: "R1", content: "single line" }],
      });
    });

    test("stringifies non-string array elements", () => {
      expect(
        coerceParams({
          file_path: "foo.ts",
          edits: [{ range: "ab.10", ref: "R1", content: [42, true, "text"] }],
        }),
      ).toEqual({
        file_paths: ["foo.ts"],
        edits: [{ range: "ab.10", ref: "R1", content: "42\ntrue\ntext" }],
      });
    });
  });

  describe("ranges with numbers instead of strings", () => {
    test("coerces single number to string array", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], ranges: 10 })).toEqual({
        file_paths: ["foo.ts"],
        ranges: ["10"],
      });
    });

    test("coerces number elements in ranges array", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], ranges: [10, 20] })).toEqual({
        file_paths: ["foo.ts"],
        ranges: ["10", "20"],
      });
    });

    test("leaves string elements unchanged in mixed array", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], ranges: ["1-50", 100] })).toEqual({
        file_paths: ["foo.ts"],
        ranges: ["1-50", "100"],
      });
    });
  });

  describe("compare_against aliases (#11)", () => {
    test("maps base → compare_against", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], base: "main" })).toEqual({
        file_paths: ["foo.ts"],
        compare_against: "main",
      });
    });

    test("maps branch → compare_against", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], branch: "develop" })).toEqual({
        file_paths: ["foo.ts"],
        compare_against: "develop",
      });
    });

    test("maps git_ref → compare_against", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], git_ref: "HEAD~2" })).toEqual({
        file_paths: ["foo.ts"],
        compare_against: "HEAD~2",
      });
    });

    test("maps gitRef → compare_against", () => {
      expect(coerceParams({ file_paths: ["foo.ts"], gitRef: "v1.0" })).toEqual({
        file_paths: ["foo.ts"],
        compare_against: "v1.0",
      });
    });

    test("canonical compare_against wins", () => {
      expect(coerceParams({ base: "wrong", compare_against: "right" })).toEqual({
        compare_against: "right",
      });
    });
  });

  describe("combined coercions", () => {
    test("alias + JSON coercion together", () => {
      expect(coerceParams({ paths: '["a.ts"]' })).toEqual({ file_paths: ["a.ts"] });
    });

    test("alias + boolean coercion together", () => {
      expect(coerceParams({ path: "a.ts", dry_run: "false" })).toEqual({ file_paths: ["a.ts"], dry_run: false });
    });

    test("realistic trueline_outline call with paths alias", () => {
      expect(coerceParams({ paths: '["src/server.ts","src/coerce.ts"]' })).toEqual({
        file_paths: ["src/server.ts", "src/coerce.ts"],
      });
    });

    test("realistic trueline_changes call with ref alias", () => {
      expect(coerceParams({ file_paths: ["src/server.ts"], ref: "HEAD~1" })).toEqual({
        file_paths: ["src/server.ts"],
        compare_against: "HEAD~1",
      });
    });
  });

  // ===========================================================================
  // Whitespace stripping in ranges and refs
  // ===========================================================================

  describe("whitespace stripping", () => {
    test("strips whitespace from range strings", () => {
      expect(coerceParams({ ranges: ["10 - 25"] })).toEqual({ ranges: ["10-25"] });
    });

    test("strips whitespace around dash in range", () => {
      expect(coerceParams({ ranges: [" 10 - 25 "] })).toEqual({ ranges: ["10-25"] });
    });

    test("strips whitespace from bare range string", () => {
      expect(coerceParams({ range: " 10-25 " })).toEqual({ ranges: ["10-25"] });
    });

    test("strips whitespace from edit range", () => {
      expect(
        coerceParams({
          edits: [{ range: "ab.10 - cd.20", ref: "R1", content: "x" }],
        }),
      ).toEqual({
        edits: [{ range: "ab.10-cd.20", ref: "R1", content: "x" }],
      });
    });

    test("strips whitespace from edit ref", () => {
      expect(
        coerceParams({
          edits: [{ range: "ab.10-cd.20", ref: "  R1  ", content: "x" }],
        }),
      ).toEqual({
        edits: [{ range: "ab.10-cd.20", ref: "R1", content: "x" }],
      });
    });
  });

  // ===========================================================================
  // Null/undefined content in edits
  // ===========================================================================

  describe("null/undefined content in edits", () => {
    test("coerces null content to empty string", () => {
      expect(
        coerceParams({
          edits: [{ range: "ab.10-cd.20", ref: "R1", content: null }],
        }),
      ).toEqual({
        edits: [{ range: "ab.10-cd.20", ref: "R1", content: "" }],
      });
    });

    test("coerces undefined content to empty string", () => {
      expect(
        coerceParams({
          edits: [{ range: "ab.10-cd.20", ref: "R1", content: undefined }],
        }),
      ).toEqual({
        edits: [{ range: "ab.10-cd.20", ref: "R1", content: "" }],
      });
    });

    test("does not coerce empty string content", () => {
      expect(
        coerceParams({
          edits: [{ range: "ab.10", ref: "R1", content: "" }],
        }),
      ).toEqual({
        edits: [{ range: "ab.10", ref: "R1", content: "" }],
      });
    });
  });

  // ===========================================================================
  // Built-in Edit tool shape detection
  // ===========================================================================

  describe("old_string/new_string detection", () => {
    test("throws when edit has old_string but no range", () => {
      expect(() =>
        coerceParams({
          edits: [{ old_string: "foo", new_string: "bar" }],
        }),
      ).toThrow("old_string/new_string");
    });

    test("throws when edit has only old_string", () => {
      expect(() =>
        coerceParams({
          edits: [{ old_string: "foo" }],
        }),
      ).toThrow("old_string/new_string");
    });

    test("throws when edit has only new_string", () => {
      expect(() =>
        coerceParams({
          edits: [{ new_string: "bar" }],
        }),
      ).toThrow("old_string/new_string");
    });

    test("does not throw when edit has range alongside old_string", () => {
      // Weird but not the confused-tool-shape case — Zod will strip old_string
      expect(() =>
        coerceParams({
          edits: [{ range: "ab.10", ref: "R1", content: "x", old_string: "foo" }],
        }),
      ).not.toThrow();
    });

    test("error message mentions trueline_search", () => {
      expect(() =>
        coerceParams({
          edits: [{ old_string: "foo", new_string: "bar" }],
        }),
      ).toThrow("trueline_search");
    });
  });
});
