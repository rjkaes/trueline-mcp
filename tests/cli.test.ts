import { describe, expect, test } from "bun:test";
import { HelpRequested, parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("read with file path", () => {
    const result = parseArgs(["read", "src/foo.ts"]);
    expect(result).toEqual({
      command: "read",
      params: { file_path: "src/foo.ts" },
    });
  });

  test("read with ranges and no-hashes", () => {
    const result = parseArgs(["read", "src/foo.ts", "--ranges", "10-25", "200-220", "--no-hashes"]);
    expect(result).toEqual({
      command: "read",
      params: { file_path: "src/foo.ts", ranges: ["10-25", "200-220"], hashes: false },
    });
  });

  test("read with encoding", () => {
    const result = parseArgs(["read", "src/foo.ts", "--encoding", "latin1"]);
    expect(result).toEqual({
      command: "read",
      params: { file_path: "src/foo.ts", encoding: "latin1" },
    });
  });

  test("edit with edits JSON and dry-run", () => {
    const edits = JSON.stringify([{ checksum: "1-5:abcdef01", range: "1:ab-5:cd", content: "hello" }]);
    const result = parseArgs(["edit", "src/foo.ts", "--edits", edits, "--dry-run"]);
    expect(result).toEqual({
      command: "edit",
      params: {
        file_path: "src/foo.ts",
        edits: [{ checksum: "1-5:abcdef01", range: "1:ab-5:cd", content: "hello" }],
        dry_run: true,
      },
    });
  });

  test("outline with multiple files and depth", () => {
    const result = parseArgs(["outline", "src/a.ts", "src/b.ts", "--depth", "1"]);
    expect(result).toEqual({
      command: "outline",
      params: { file_paths: ["src/a.ts", "src/b.ts"], depth: 1 },
    });
  });

  test("search with pattern and flags", () => {
    const result = parseArgs(["search", "src/foo.ts", "handleRead", "--context", "3", "--regex", "--case-insensitive"]);
    expect(result).toEqual({
      command: "search",
      params: {
        file_path: "src/foo.ts",
        pattern: "handleRead",
        context_lines: 3,
        regex: true,
        case_insensitive: true,
      },
    });
  });

  test("search with max-matches", () => {
    const result = parseArgs(["search", "src/foo.ts", "TODO", "--max-matches", "5"]);
    expect(result).toEqual({
      command: "search",
      params: { file_path: "src/foo.ts", pattern: "TODO", max_matches: 5 },
    });
  });

  test("diff with files and ref", () => {
    const result = parseArgs(["diff", "src/a.ts", "src/b.ts", "--ref", "main"]);
    expect(result).toEqual({
      command: "diff",
      params: { file_paths: ["src/a.ts", "src/b.ts"], compare_against: "main" },
    });
  });

  test("diff with no files defaults to all changed", () => {
    const result = parseArgs(["diff"]);
    expect(result).toEqual({
      command: "diff",
      params: { file_paths: ["*"] },
    });
  });

  test("verify with refs", () => {
    const result = parseArgs(["verify", "src/foo.ts", "--refs", "R1", "R2"]);
    expect(result).toEqual({
      command: "verify",
      params: { file_path: "src/foo.ts", refs: ["R1", "R2"] },
    });
  });

  test("verify with --checksums backwards compat", () => {
    const result = parseArgs(["verify", "src/foo.ts", "--checksums", "R1"]);
    expect(result).toEqual({
      command: "verify",
      params: { file_path: "src/foo.ts", refs: ["R1"] },
    });
  });

  test("--help returns top-level usage", () => {
    const result = parseArgs(["--help"]);
    expect(result).toBeInstanceOf(HelpRequested);
    expect((result as HelpRequested).text).toContain("Commands:");
  });

  test("no args returns top-level usage", () => {
    const result = parseArgs([]);
    expect(result).toBeInstanceOf(HelpRequested);
  });

  test("command --help returns command usage", () => {
    const result = parseArgs(["read", "--help"]);
    expect(result).toBeInstanceOf(HelpRequested);
    expect((result as HelpRequested).text).toContain("--ranges");
  });

  test("-h works as alias for --help", () => {
    expect(parseArgs(["-h"])).toBeInstanceOf(HelpRequested);
    expect(parseArgs(["search", "-h"])).toBeInstanceOf(HelpRequested);
  });

  test("unknown command errors", () => {
    expect(() => parseArgs(["bogus"])).toThrow();
  });

  test("missing file_path errors", () => {
    expect(() => parseArgs(["read"])).toThrow();
  });

  test("search missing pattern errors", () => {
    expect(() => parseArgs(["search", "src/foo.ts"])).toThrow();
  });
});
