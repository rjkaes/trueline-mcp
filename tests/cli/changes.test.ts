import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI, run } from "./helpers.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-changes-"));
});

describe("changes subcommand", () => {
  test("no paths: defaults to * (runs without usage error)", () => {
    // Point CLAUDE_PROJECT_DIR at an empty non-git dir so getChangedFiles
    // returns [] immediately — avoids scanning the whole working tree.
    const { exitCode } = run(tmpDir, { CLAUDE_PROJECT_DIR: tmpDir }, "changes");
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

describe("changes from a repo subdirectory", () => {
  test("no-path `changes` finds tracked edits when cwd is below the repo root", () => {
    const repo = scratch("changes-repo", {});
    mkdirSync(join(repo, "pkg"), { recursive: true });
    writeFileSync(join(repo, "pkg", "m.ts"), "export function a() { return 1; }\n");
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        encoding: "utf-8",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "pkg", "m.ts"), "export function a() { return 2; }\nexport function extra() {}\n");

    const { stdout } = trueline(["changes"], { cwd: join(repo, "pkg") });
    expect(stdout).not.toContain("Access denied");
    expect(stdout).toContain("extra");
  });

  // An explicit "*" must reach handleDiff as the sentinel; resolved against cwd it
  // becomes a glob that matches no changed file.
  test("`changes '*'` diffs all changed files, not a cwd-relative glob", () => {
    const repo = scratch("changes-star-repo", {});
    mkdirSync(join(repo, "pkg"), { recursive: true });
    writeFileSync(join(repo, "pkg", "m.ts"), "export function a() { return 1; }\n");
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        encoding: "utf-8",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "pkg", "m.ts"), "export function a() { return 2; }\nexport function extra() {}\n");

    const { stdout, exitCode } = trueline(["changes", "*"], { cwd: repo });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("extra");
  });
});
