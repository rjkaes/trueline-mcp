import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./helpers.ts";
import { execFileSync } from "node:child_process";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let tmpDir: string;
let testFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-edit-"));
});

beforeEach(() => {
  testFile = join(tmpDir, `edit-${Date.now()}.txt`);
  writeFileSync(testFile, "alpha\nbeta\ngamma\n");
});

/**
 * Read testFile via the CLI and extract the ref for a given range.
 */
function readRef(range: string): { ref: string; hashRange: string } {
  const { stdout } = run(tmpDir, "read", `${testFile}:${range}`);
  const refMatch = stdout.match(/ref:\s*(\S+)/);
  if (!refMatch) throw new Error(`No ref found in read output: ${stdout}`);
  const fullRef = refMatch[1];
  // hashRange is the part before `:` in ref, e.g. "ab.1-cd.1"
  const colonIdx = fullRef.lastIndexOf(":");
  const hashRange = fullRef.slice(0, colonIdx);
  return { ref: fullRef, hashRange };
}

describe("edit subcommand", () => {
  test("golden path via @file: edits file content", () => {
    const { ref, hashRange } = readRef("2-2");
    const editsFile = join(tmpDir, "edits.json");
    writeFileSync(editsFile, JSON.stringify([{ ref, range: hashRange, content: "BETA" }]));

    const { exitCode } = run(tmpDir, "edit", testFile, "--edits", `@${editsFile}`);
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toContain("BETA");
  });

  test("--dry-run: produces diff, does not modify file", () => {
    const { ref, hashRange } = readRef("1-1");
    const editsFile = join(tmpDir, "edits-dry.json");
    writeFileSync(editsFile, JSON.stringify([{ ref, range: hashRange, content: "ALPHA_NEW" }]));

    const { stdout, exitCode } = run(tmpDir, "edit", testFile, "--edits", `@${editsFile}`, "--dry-run");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ALPHA_NEW");
    // File unchanged
    expect(readFileSync(testFile, "utf-8")).toContain("alpha");
  });

  test("via flat flags: --ref --range --content", () => {
    const { ref, hashRange } = readRef("3-3");
    const { exitCode } = run(tmpDir, "edit", testFile, "--ref", ref, "--range", hashRange, "--content", "GAMMA_NEW");
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toContain("GAMMA_NEW");
  });

  test("via stdin: pipe edits JSON via --edits -", () => {
    const { ref, hashRange } = readRef("1-1");
    const editsJson = JSON.stringify([{ ref, range: hashRange, content: "STDIN_CONTENT" }]);

    // Use spawn directly to pipe stdin
    let exitCode = 0;
    try {
      execFileSync("bun", [CLI, "edit", testFile, "--edits", "-"], {
        input: editsJson,
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir },
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
    }
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toContain("STDIN_CONTENT");
  });

  test("--edits and flat flags are mutually exclusive (exit 3)", () => {
    const { exitCode, stderr } = run(
      tmpDir,
      "edit",
      testFile,
      "--edits",
      "[]",
      "--ref",
      "ab.1",
      "--range",
      "ab.1",
      "--content",
      "x",
    );
    expect(exitCode).toBe(3);
    expect(stderr).toContain("mutually exclusive");
  });

  test("--json shape: {ok, result}", () => {
    const { ref, hashRange } = readRef("2-2");
    const editsFile = join(tmpDir, "edits-json.json");
    writeFileSync(editsFile, JSON.stringify([{ ref, range: hashRange, content: "BETA_JSON", action: "replace" }]));

    const { stdout, exitCode } = run(tmpDir, "edit", testFile, "--edits", `@${editsFile}`, "--json");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.content[0].text).toBeTruthy();
  });
});
