import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI, run } from "./helpers.ts";

let tmpDir: string;
let tsFile: string;

// A single subprocess invocation covers all assertions that require tree-sitter
// WASM, so its startup is paid once in beforeAll rather than once per test.
let jsonResult: ReturnType<typeof run>;
let outlineElapsedMs: number;

beforeAll(
  () => {
    tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-outline-"));
    tsFile = join(tmpDir, "sample.ts");
    writeFileSync(tsFile, "export function greet(name: string): string { return 'Hello ' + name; }\n");
    // --json --depth 0: JSON output, depth-limited, one subprocess call.
    const started = performance.now();
    jsonResult = run(tmpDir, "outline", tsFile, "--json", "--depth", "0");
    outlineElapsedMs = performance.now() - started;
  },
  { timeout: 30_000 },
);

describe("outline subcommand", () => {
  test("golden path: returns function name (exit 0)", () => {
    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stdout).toContain("greet");
  });

  test("--json shape: {ok: true, result.content[0].text contains symbol}", () => {
    expect(jsonResult.exitCode).toBe(0);
    const parsed = JSON.parse(jsonResult.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.content[0].text).toContain("greet");
  });

  test("no paths exits 3", () => {
    const { exitCode, stderr } = run(tmpDir, "outline");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("requires at least one");
  });

  test("--depth flag accepted", () => {
    // --depth 0 was used in the shared beforeAll invocation.
    expect(jsonResult.exitCode).toBe(0);
  });

  test("exits promptly once output is written", () => {
    // A pending WASM-init timeout timer once held the process open for 10 s.
    expect(outlineElapsedMs).toBeLessThan(5_000);
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

// Zod enforces these minimums for the MCP tools; the CLI skips zod, so io.ts does.
describe("numeric flags", () => {
  test.each(["1x", "-1", "1e3"])("outline --depth %s exits 3", (value) => {
    const dir = scratch("outline-depth", { "m.ts": "export function a() {}\n" });
    const { exitCode, stderr } = trueline(["outline", join(dir, "m.ts"), "--depth", value]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("--depth");
  });
});
