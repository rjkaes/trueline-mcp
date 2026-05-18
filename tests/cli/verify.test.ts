import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./helpers.ts";

let tmpDir: string;
let testFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-verify-"));
  testFile = join(tmpDir, "verify.txt");
  writeFileSync(testFile, "row one\nrow two\nrow three\n");
});

/**
 * Read a range from testFile and extract its ref string.
 */
function readRef(range: string): string {
  const { stdout } = run(tmpDir, "read", `${testFile}:${range}`);
  const m = stdout.match(/ref:\s*(\S+)/);
  if (!m) throw new Error(`No ref found: ${stdout}`);
  return m[1];
}

describe("verify subcommand", () => {
  test("golden path: valid ref returns success (exit 0)", () => {
    const ref = readRef("1-2");
    const { stdout, exitCode } = run(tmpDir, "verify", testFile, "--refs", ref);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid");
  });

  test("--json shape: {ok: true}", () => {
    const ref = readRef("1-3");
    const { stdout, exitCode } = run(tmpDir, "verify", testFile, "--refs", ref, "--json");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.content[0].text).toBeTruthy();
  });

  test("bogus ref exits 2 and reports Invalid checksum", () => {
    const { stdout, stderr, exitCode } = run(tmpDir, "verify", testFile, "--refs", "BOGUS");
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("Invalid checksum");
  });

  test("no --refs exits 3", () => {
    const { exitCode, stderr } = run(tmpDir, "verify", testFile);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("--refs is required");
  });

  test("no file path exits 3", () => {
    const { exitCode } = run(tmpDir, "verify");
    expect(exitCode).toBe(3);
  });

  test("repeatable --refs: multiple refs", () => {
    const ref1 = readRef("1-1");
    const ref2 = readRef("2-2");
    const { stdout, exitCode } = run(tmpDir, "verify", testFile, "--refs", ref1, "--refs", ref2);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid");
  });

  test("mixed @file and plain --refs exits 3", () => {
    const { exitCode, stderr } = run(tmpDir, "verify", testFile, "--refs", "@somefile", "--refs", "plain");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("cannot be combined");
  });
});
