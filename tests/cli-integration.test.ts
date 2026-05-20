import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tmpDir: string;
let testFile: string;
let outlineResult: { stdout: string; stderr: string; exitCode: number };

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number };
function run(extraEnv: Record<string, string>, ...args: string[]): { stdout: string; stderr: string; exitCode: number };
function run(...rest: unknown[]): { stdout: string; stderr: string; exitCode: number } {
  let extraEnv: Record<string, string> = {};
  let args: string[];
  if (rest.length > 0 && typeof rest[0] === "object" && rest[0] !== null) {
    extraEnv = rest[0] as Record<string, string>;
    args = rest.slice(1) as string[];
  } else {
    args = rest as string[];
  }
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir, ...extraEnv },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

// Run the outline subprocess in beforeAll so the tree-sitter WASM cold-start
// (~10 s) is paid once rather than inside the test body.
beforeAll(
  () => {
    tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-"));
    testFile = join(tmpDir, "test.txt");
    writeFileSync(testFile, "line one\nline two\nline three\n");
    const tsFile = join(tmpDir, "example.ts");
    writeFileSync(tsFile, "export function hello(): string { return 'hi'; }\n");
    outlineResult = run("outline", tsFile);
  },
  { timeout: 30_000 },
);
describe("CLI integration", () => {
  test("read prints file with hashes", () => {
    const { stdout, exitCode } = run("read", testFile);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
    // Should contain ref line
    expect(stdout).toMatch(/ref:/);
  });

  test("read with --ranges", () => {
    const { stdout, exitCode } = run("read", testFile, "--ranges", "1-2");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
    // Context expansion adds line 3
    expect(stdout).toContain("line three");
  });

  test("search finds matches (exit 0)", () => {
    const { stdout, exitCode } = run("search", "two", testFile);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line two");
  });

  test("search with no matches exits 1", () => {
    const { exitCode } = run("search", "NOPE_NEVER_MATCHES", testFile);
    expect(exitCode).toBe(1);
  });

  test("search bad regex exits 2", () => {
    const { exitCode } = run("search", "[", testFile, "--regex");
    expect(exitCode).toBe(2);
  });

  test("search with no paths exits 3", () => {
    const { exitCode, stderr } = run("search", "PATTERN");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("paths required");
  });

  // outline subprocess was run in beforeAll to amortise the tree-sitter WASM cold-start.
  test("outline works on TypeScript file", () => {
    expect(outlineResult.exitCode).toBe(0);
    expect(outlineResult.stdout).toContain("hello");
  });

  test("--help prints usage and exits 0", () => {
    const { stdout, exitCode } = run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("trueline");
  });

  test("unknown command exits non-zero", () => {
    const { exitCode } = run("bogus");
    expect(exitCode).not.toBe(0);
  });

  test("read nonexistent file exits 2", () => {
    const { exitCode } = run("read", "/nonexistent/file.txt");
    expect(exitCode).toBe(2);
  });

  test("verify with unknown ref reports error (exit 2)", () => {
    const { stdout, stderr, exitCode } = run("verify", testFile, "--refs", "BOGUS");
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("Invalid checksum");
  });

  // Precedence error: inline range + --ranges (exit 3)
  test("read with inline range and --ranges exits 3", () => {
    const { exitCode, stderr } = run("read", `${testFile}:1-10`, "--ranges", "20-30");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("ambiguous ranges");
  });

  // Precedence error: --edits + flat flags (exit 3)
  test("edit --edits and flat flags exits 3", () => {
    const { exitCode, stderr } = run(
      "edit",
      testFile,
      "--edits",
      "@nonexistent",
      "--ref",
      "ab1",
      "--range",
      "ab1",
      "--content",
      "x",
    );
    expect(exitCode).toBe(3);
    expect(stderr).toContain("mutually exclusive");
  });

  // changes with no paths defaults to * — point at an empty non-git dir so
  // getChangedFiles returns [] immediately rather than scanning the whole tree.
  test("changes with no paths runs without usage error", () => {
    const { exitCode } = run({ CLAUDE_PROJECT_DIR: tmpDir }, "changes");
    // May exit 0 (no changes) or 2 (git error in non-git dir), but never 3 (usage error)
    expect(exitCode).not.toBe(3);
  });
});
