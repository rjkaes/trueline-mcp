import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./helpers.ts";

let tmpDir: string;
let testFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-read-"));
  testFile = join(tmpDir, "test.txt");
  writeFileSync(testFile, "line one\nline two\nline three\n");
});

describe("read subcommand", () => {
  test("golden path: prints all lines with hashes (exit 0)", () => {
    const { stdout, exitCode } = run(tmpDir, "read", testFile);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
    expect(stdout).toContain("line three");
    expect(stdout).toMatch(/ref:/);
  });

  test("--json shape: {ok: true, result.content[0].text matches human form}", () => {
    const { stdout: humanOut } = run(tmpDir, "read", testFile);
    const { stdout, exitCode } = run(tmpDir, "read", testFile, "--json");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.content[0].text).toBe(humanOut.trimEnd());
  });

  test("--ranges limits output to requested lines", () => {
    const { stdout, exitCode } = run(tmpDir, "read", testFile, "--ranges", "1-1");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
  });

  test("inline range syntax: path:1-2", () => {
    const { stdout, exitCode } = run(tmpDir, "read", `${testFile}:1-2`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
  });

  test("inline range + --ranges exits 3 (ambiguous)", () => {
    const { exitCode, stderr } = run(tmpDir, "read", `${testFile}:1-10`, "--ranges", "20-30");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("ambiguous ranges");
  });

  test("nonexistent file exits 2", () => {
    const { exitCode } = run(tmpDir, "read", join(tmpDir, "missing.txt"));
    expect(exitCode).toBe(2);
  });

  test("no file path exits 3", () => {
    const { exitCode } = run(tmpDir, "read");
    expect(exitCode).toBe(3);
  });
});
