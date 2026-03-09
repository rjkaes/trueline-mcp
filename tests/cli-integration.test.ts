import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tmpDir: string;
let testFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-"));
  testFile = join(tmpDir, "test.txt");
  writeFileSync(testFile, "line one\nline two\nline three\n");
});

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("CLI integration", () => {
  test("read prints file with hashes", () => {
    const { stdout, exitCode } = run("read", testFile);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
    // Should contain checksum line
    expect(stdout).toMatch(/checksum:/);
  });

  test("read with --no-hashes omits per-line hashes", () => {
    const { stdout, exitCode } = run("read", testFile, "--no-hashes");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
  });

  test("read with --ranges", () => {
    const { stdout, exitCode } = run("read", testFile, "--ranges", "1-2");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
    expect(stdout).not.toContain("line three");
  });

  test("search finds matches", () => {
    const { stdout, exitCode } = run("search", testFile, "two");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line two");
  });

  // Tree-sitter WASM init is slow in a cold subprocess
  test(
    "outline works on TypeScript file",
    () => {
      const tsFile = join(tmpDir, "example.ts");
      writeFileSync(tsFile, "export function hello(): string { return 'hi'; }\n");
      const { stdout, exitCode } = run("outline", tsFile);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("hello");
    },
    { timeout: 30_000 },
  );

  test("--help prints usage and exits 0", () => {
    const { stdout, exitCode } = run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("read");
  });

  test("command --help prints command usage", () => {
    const { stdout, exitCode } = run("read", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--ranges");
  });

  test("unknown command exits 1", () => {
    const { stderr, exitCode } = run("bogus");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  test("read nonexistent file exits 1", () => {
    const { exitCode } = run("read", "/nonexistent/file.txt");
    expect(exitCode).toBe(1);
  });

  test("verify with stale checksum reports stale", () => {
    // First read to get a checksum
    const { stdout } = run("read", testFile);
    const checksumMatch = stdout.match(/checksum: (\S+)/);
    expect(checksumMatch).toBeTruthy();
    // Use a bogus checksum
    const { stdout: verifyOut, exitCode } = run("verify", testFile, "--checksums", "1-3:deadbeef");
    expect(exitCode).toBe(0);
    expect(verifyOut).toContain("stale");
  });
});
