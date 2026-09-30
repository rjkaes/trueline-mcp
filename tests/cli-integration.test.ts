import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, scratch } from "./cli/helpers.ts";
import { writeTestFile } from "./helpers.ts";

let tmpDir: string;
let testFile: string;
let outlineResult: { stdout: string; stderr: string; exitCode: number };

// Run the outline subprocess in beforeAll so the tree-sitter WASM cold-start
// is paid once rather than inside the test body.
beforeAll(
  () => {
    tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-"));
    testFile = join(tmpDir, "test.txt");
    writeFileSync(testFile, "line one\nline two\nline three\n");
    const tsFile = writeTestFile(tmpDir, "example.ts", "export function hello(): string { return 'hi'; }\n");
    outlineResult = run(tmpDir, "outline", tsFile);
  },
  { timeout: 30_000 },
);
describe("CLI integration", () => {
  test("read with --ranges", () => {
    const { stdout, exitCode } = run(tmpDir, "read", testFile, "--ranges", "1-2");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
    // Context expansion adds line 3
    expect(stdout).toContain("line three");
  });

  // outline subprocess was run in beforeAll to amortise the tree-sitter WASM cold-start.
  test("outline works on TypeScript file", () => {
    expect(outlineResult.exitCode).toBe(0);
    expect(outlineResult.stdout).toContain("hello");
  });

  test("--help prints usage and exits 0", () => {
    const { stdout, exitCode } = run(tmpDir, "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("trueline");
  });

  test("unknown command exits non-zero", () => {
    const { exitCode } = run(tmpDir, "bogus");
    expect(exitCode).not.toBe(0);
  });

  // Names that exist on Object.prototype must not resolve to a subcommand loader.
  test.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "%s is reported as an unknown command",
    (name) => {
      const unknown = run(tmpDir, "nosuchcmd");
      const { stdout, stderr, exitCode } = run(tmpDir, name);
      expect(stderr).toBe(`Unknown command ${name}\n`);
      expect(stdout).toBe(unknown.stdout);
      expect(exitCode).toBe(unknown.exitCode);
    },
  );

  test("constructor --help falls back to root usage", () => {
    const { stdout, exitCode } = run(tmpDir, "constructor", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toBe(run(tmpDir, "--help").stdout);
  });

  test("read nonexistent file exits 2", () => {
    const { exitCode } = run(tmpDir, "read", "/nonexistent/file.txt");
    expect(exitCode).toBe(2);
  });

  // Precedence error: --edits + flat flags (exit 3)
  test("edit --edits and flat flags exits 3", () => {
    const { exitCode, stderr } = run(
      tmpDir,
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
});

describe("argv scanning in cli.ts", () => {
  test("`--` protects a literal --help pattern from the help shortcut", () => {
    const dir = scratch(tmpDir, "dashdash-help", { "flags.txt": "--help is a flag\nother\n" });
    const { stdout, exitCode } = run(tmpDir, "search", "--", "--help", join(dir, "flags.txt"));
    expect(stdout).not.toContain("Usage:");
    expect(stdout).toContain("--help is a flag");
    expect(exitCode).toBe(0);
  });
});
