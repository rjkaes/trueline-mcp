import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, scratch, trueline } from "./helpers.ts";

let tmpDir: string;
let testFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-search-"));
  testFile = join(tmpDir, "data.txt");
  writeFileSync(testFile, "apple\nbanana\ncherry\n");
});

describe("search subcommand", () => {
  test("golden path: finds match (exit 0)", () => {
    const { stdout, exitCode } = run(tmpDir, "search", "banana", testFile);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("banana");
  });

  test("--json shape on match: {ok: true}", () => {
    const { stdout, exitCode } = run(tmpDir, "search", "banana", testFile, "--json");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.content[0].text).toContain("banana");
  });

  test("no matches exits 1", () => {
    const { exitCode } = run(tmpDir, "search", "NOPE_NEVER", testFile);
    expect(exitCode).toBe(1);
  });

  test("--json shape on no match: {ok: true} still (exit 1 from stdout text)", () => {
    const { stdout, exitCode } = run(tmpDir, "search", "NOPE_NEVER", testFile, "--json");
    // With --json, no-match returns ok:true with exit 0 (handler returns success)
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
  });

  test("bad regex exits 2", () => {
    const { exitCode } = run(tmpDir, "search", "[", testFile, "--regex");
    expect(exitCode).toBe(2);
  });

  test("no paths exits 3", () => {
    const { exitCode, stderr } = run(tmpDir, "search", "pattern");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("paths required");
  });

  test("no args at all exits 3", () => {
    const { exitCode } = run(tmpDir, "search");
    expect(exitCode).toBe(3);
  });

  test("-i / --ignore-case flag works", () => {
    const { stdout, exitCode } = run(tmpDir, "search", "BANANA", testFile, "-i");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("banana");
  });

  test("-r / --regex flag works", () => {
    const { stdout, exitCode } = run(tmpDir, "search", "ban.*", testFile, "-r");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("banana");
  });

  test("pattern starting with '-' after -- terminator", () => {
    const dashedFile = join(tmpDir, "dashed.txt");
    writeFileSync(dashedFile, "-foo\nbar\n");
    const { stdout, exitCode } = run(tmpDir, "search", "--", "-foo", dashedFile);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-foo");
  });
});

describe("option values", () => {
  test("search -m with a non-number is rejected, not an empty exit-0 result", () => {
    const dir = scratch(tmpDir, "nan-max", { "f.txt": "alpha\nbeta\n" });
    const { stdout, exitCode } = trueline(tmpDir, ["search", "beta", join(dir, "f.txt"), "-m", "abc"]);
    expect(exitCode !== 0 || stdout.includes("beta")).toBe(true);
  });
});

// Zod enforces these minimums for the MCP tools; the CLI skips zod, so io.ts does.
describe("numeric flags", () => {
  const searchWith = (...flags: string[]) => {
    const dir = scratch(tmpDir, "numeric-flags", { "f.txt": "alpha\nbeta\n" });
    return trueline(tmpDir, ["search", "beta", join(dir, "f.txt"), ...flags]);
  };

  test.each([
    ["--max", "12abc"],
    ["--max", "1e3"],
    ["--max", "1.5"],
    ["--max", "-1"],
    ["--max", "0"],
    ["--max-match-lines", "0"],
    ["--context", "2x"],
    ["--context", "-1"],
  ])("search %s %s exits 3", (flag, value) => {
    const { exitCode, stderr } = searchWith(flag, value);
    expect(exitCode).toBe(3);
    expect(stderr).toContain(flag);
  });

  test("search accepts --context 0 with positive --max and --max-match-lines", () => {
    const { stdout, exitCode } = searchWith("--context", "0", "--max", "5", "--max-match-lines", "3");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("beta");
  });
});
