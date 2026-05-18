import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./helpers.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-changes-"));
});

describe("changes subcommand (alias: diff)", () => {
  test("no paths: defaults to * (runs without usage error)", () => {
    // Point CLAUDE_PROJECT_DIR at an empty non-git dir so getChangedFiles
    // returns [] immediately — avoids scanning the whole working tree.
    const { exitCode } = run(tmpDir, { CLAUDE_PROJECT_DIR: tmpDir }, "changes");
    expect(exitCode).not.toBe(3);
  });

  test("diff alias: same behavior as changes", () => {
    const { exitCode } = run(tmpDir, { CLAUDE_PROJECT_DIR: tmpDir }, "diff");
    expect(exitCode).not.toBe(3);
  });

  test("--json shape: {ok, result} even on empty diff", () => {
    const { stdout, exitCode } = run(tmpDir, { CLAUDE_PROJECT_DIR: tmpDir }, "changes", "--against", "HEAD", "--json");
    // May be ok:true (no changes) or ok:false (git error in non-git dir) — must be valid JSON.
    expect(exitCode).not.toBe(3);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.ok).toBe("boolean");
    expect(parsed.result).toBeDefined();
  });

  test("--against flag accepted", () => {
    const { exitCode } = run(tmpDir, { CLAUDE_PROJECT_DIR: tmpDir }, "changes", "--against", "HEAD");
    expect(exitCode).not.toBe(3);
  });
});
