import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTestFile } from "./helpers.ts";

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
// is paid once rather than inside the test body.
beforeAll(
  () => {
    tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-"));
    testFile = join(tmpDir, "test.txt");
    writeFileSync(testFile, "line one\nline two\nline three\n");
    const tsFile = writeTestFile(tmpDir, "example.ts", "export function hello(): string { return 'hi'; }\n");
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

  // Names that exist on Object.prototype must not resolve to a subcommand loader.
  test.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "%s is reported as an unknown command",
    (name) => {
      const unknown = run("nosuchcmd");
      const { stdout, stderr, exitCode } = run(name);
      expect(stderr).toBe(`Unknown command ${name}\n`);
      expect(stdout).toBe(unknown.stdout);
      expect(exitCode).toBe(unknown.exitCode);
    },
  );

  test("constructor --help falls back to root usage", () => {
    const { stdout, exitCode } = run("constructor", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toBe(run("--help").stdout);
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

interface Invocation {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

// Unlike run() this supports cwd and stdin, and strips an inherited
// CLAUDE_PROJECT_DIR so results do not depend on the shell the suite runs from.
function trueline(args: string[], opts: Invocation = {}) {
  const env: Record<string, string | undefined> = { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir, ...opts.env };
  if (opts.env?.CLAUDE_PROJECT_DIR === undefined) delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync("bun", [CLI, ...args], {
    cwd: opts.cwd ?? tmpDir,
    env,
    input: opts.input ?? "",
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? -1 };
}

function scratch(name: string, files: Record<string, string>): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) writeFileSync(join(dir, fileName), content);
  return dir;
}

describe("argv scanning in cli.ts", () => {
  test("`--` protects a literal --help pattern from the help shortcut", () => {
    const dir = scratch("dashdash-help", { "flags.txt": "--help is a flag\nother\n" });
    const { stdout, exitCode } = trueline(["search", "--", "--help", join(dir, "flags.txt")]);
    expect(stdout).not.toContain("Usage:");
    expect(stdout).toContain("--help is a flag");
    expect(exitCode).toBe(0);
  });
});
