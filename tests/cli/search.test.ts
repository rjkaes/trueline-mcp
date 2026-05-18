import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./helpers.ts";

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
});
