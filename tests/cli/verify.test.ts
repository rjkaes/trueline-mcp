import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI, run } from "./helpers.ts";

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

/** Per-line hashLines (e.g. "ab1") and the whole-file ref from `trueline read <file>`. */
function holdRefs(file: string) {
  const { stdout } = trueline(["read", file]);
  const hashLines = [...stdout.matchAll(/^([a-z]{2}\d+)\t/gm)].map((m) => m[1]);
  const ref = /^ref: (\S+)$/m.exec(stdout)?.[1];
  if (!ref || hashLines.length === 0) throw new Error(`setup: could not parse read output:\n${stdout}`);
  return { hashLines, ref };
}

function scratch(name: string, files: Record<string, string>): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) writeFileSync(join(dir, fileName), content);
  return dir;
}

describe("verify flag combinations", () => {
  test("verify with two path arguments is rejected instead of ignoring the second", () => {
    const dir = scratch("verify-two-paths", { "a.txt": "one\ntwo\n", "b.txt": "uno\ndos\n" });
    const first = join(dir, "a.txt");
    const { ref } = holdRefs(first);
    const { exitCode } = trueline(["verify", first, join(dir, "b.txt"), "--refs", ref]);
    expect(exitCode).not.toBe(0);
  });
});
