import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { handleDiff } from "../../src/tools/diff.ts";

let testDir: string;

// Strip inherited GIT_* env vars so git init in temp dirs
// does not pollute the parent worktree's HEAD.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function git(cmd: string) {
  execSync(`git ${cmd}`, { cwd: testDir, stdio: "pipe", env: cleanEnv });
}

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-sdiff-")));
  git("init");
  git("config user.email test@test.com");
  git("config user.name Test");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("semantic trueline_diff", () => {
  test("detects added function", async () => {
    const file = join(testDir, "test.ts");
    writeFileSync(file, "function foo() { return 1; }\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function foo() { return 1; }\nfunction bar() { return 2; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("Added");
    expect(text).toContain("bar");
  });

  test("detects removed function", async () => {
    const file = join(testDir, "test.ts");
    writeFileSync(file, "function foo() { return 1; }\nfunction bar() { return 2; }\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function foo() { return 1; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("Removed");
    expect(text).toContain("bar");
  });

  test("detects logic modification", async () => {
    const file = join(testDir, "test.ts");
    writeFileSync(file, "function foo() {\n  return 1;\n}\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function foo() {\n  return 2;\n}\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("foo");
    expect(text).toContain("return");
  });

  test("detects rename via body hash", async () => {
    const file = join(testDir, "test.ts");
    writeFileSync(file, "function oldName() {\n  return 42;\n}\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function newName() {\n  return 42;\n}\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("Renamed");
    expect(text).toContain("oldName");
    expect(text).toContain("newName");
  });

  test("handles untracked file (all symbols are Added)", async () => {
    const file = join(testDir, "new.ts");
    writeFileSync(file, "function fresh() { return 1; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("Added");
    expect(text).toContain("fresh");
  });

  test("reports unsupported file type", async () => {
    const file = join(testDir, "data.json");
    writeFileSync(file, '{"key": "value"}\n');
    git("add data.json");
    git("commit -m init");
    writeFileSync(file, '{"key": "changed"}\n');

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("not supported");
  });

  test("star expands to all unstaged changed files", async () => {
    const f1 = join(testDir, "a.ts");
    const f2 = join(testDir, "b.ts");
    writeFileSync(f1, "function a() { return 1; }\n");
    writeFileSync(f2, "function b() { return 2; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(f1, "function a() { return 99; }\n");
    writeFileSync(f2, "function b() { return 99; }\n");

    const result = await handleDiff({
      file_paths: ["*"],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
  });

  test("no structural changes returns appropriate message", async () => {
    const file = join(testDir, "test.ts");
    writeFileSync(file, "function foo() {\n  return 1;\n}\n");
    git("add test.ts");
    git("commit -m init");
    // Only whitespace change (collapse mode)
    writeFileSync(file, "function foo() {\n  return   1;\n}\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("No structural changes");
  });
});
