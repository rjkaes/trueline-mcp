import { describe, expect, test, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, scratch, trueline } from "./helpers.ts";

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

// Zod enforces these minimums for the MCP tools; the CLI skips zod, so io.ts does.
describe("numeric flags", () => {
  test.each(["1x", "-1", "1e3"])("outline --depth %s exits 3", (value) => {
    const dir = scratch(tmpDir, "outline-depth", { "m.ts": "export function a() {}\n" });
    const { exitCode, stderr } = trueline(tmpDir, ["outline", join(dir, "m.ts"), "--depth", value]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("--depth");
  });
});
