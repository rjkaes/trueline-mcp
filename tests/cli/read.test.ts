import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, scratch, trueline } from "./helpers.ts";

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

  test("nonexistent file exits 2", () => {
    const { exitCode } = run(tmpDir, "read", join(tmpDir, "missing.txt"));
    expect(exitCode).toBe(2);
  });

  test("no file path exits 3", () => {
    const { exitCode } = run(tmpDir, "read");
    expect(exitCode).toBe(3);
  });
});

// CLAUDE_PROJECT_DIR pins the security boundary; relative arguments still mean the shell cwd.
describe("relative paths resolve against the shell cwd", () => {
  test("read: from a project subdirectory, a relative path is that directory's file", () => {
    const projectDir = scratch(tmpDir, "read-project", { "f.txt": "from-project-root\n" });
    const cwd = scratch(tmpDir, "read-project/sub", { "f.txt": "from-subdir\n" });
    const { stdout } = trueline(tmpDir, ["read", "f.txt"], { cwd, env: { CLAUDE_PROJECT_DIR: projectDir } });
    expect(stdout).toContain("from-subdir");
  });

  test("a relative path is denied, not redirected, when cwd is outside the allowed dirs", () => {
    const projectDir = scratch(tmpDir, "denied-project", { "f.txt": "from-project-dir\n" });
    const cwd = scratch(tmpDir, "denied-cwd", { "f.txt": "from-cwd\n" });
    const { stdout, stderr, exitCode } = trueline(tmpDir, ["read", "f.txt"], {
      cwd,
      env: { CLAUDE_PROJECT_DIR: projectDir, TRUELINE_ALLOWED_DIRS: projectDir },
    });
    expect(stdout + stderr).not.toContain("from-project-dir");
    expect(stdout + stderr).not.toContain("from-cwd");
    expect(exitCode).not.toBe(0);
  });
});

describe("option values", () => {
  test("repeating --ranges must not silently drop the earlier value", () => {
    const body = `${Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n")}\n`;
    const dir = scratch(tmpDir, "repeat-ranges", { "big.txt": body });
    const { stdout, exitCode } = trueline(tmpDir, [
      "read",
      join(dir, "big.txt"),
      "--ranges",
      "5-6",
      "--ranges",
      "40-41",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\trow 5$/m);
    expect(stdout).toMatch(/\trow 40$/m);
  });
});
