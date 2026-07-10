import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead, handleReadMulti } from "../../src/tools/read.ts";
import { handleOutline } from "../../src/tools/outline.ts";
import { handleSearch } from "../../src/tools/search.ts";
import { handleVerify } from "../../src/tools/verify.ts";
import { handleDiff } from "../../src/tools/diff.ts";
import { isAbsolutePathArg } from "../../src/tools/shared.ts";
import { getText, issueTestRef } from "../helpers.ts";

// Regression coverage for: extending the trueline_edit requireAbsolutePath
// guard (see edit-relative-path.test.ts) to the read-side MCP tools
// (trueline_read, trueline_outline, trueline_search, trueline_verify,
// trueline_changes). The long-lived MCP server pins `projectDir` once at
// startup; a relative file_path silently resolves against that stale root
// when the caller is actually working in a git worktree. These tools are
// non-destructive, but reading/searching/outlining/diffing the wrong file
// still misleads the agent. The CLI does not set `requireAbsolutePath`,
// since its projectDir is the real shell cwd.

let testDir: string;
let testFile: string;

const LINES = ["line 1", "line 2", "line 3"];

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-require-absolute-test-")));
  testFile = join(testDir, "target.ts");
  writeFileSync(testFile, `${LINES.join("\n")}\n`);
  writeFileSync(join(testDir, "sibling.ts"), "sibling 1\nsibling 2\n");
  mkdirSync(join(testDir, "src"), { recursive: true });
  writeFileSync(join(testDir, "src", "alpha.ts"), "export function alpha() {}\n");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("isAbsolutePathArg", () => {
  test("relative path is not absolute", () => {
    expect(isAbsolutePathArg("foo.ts")).toBe(false);
  });

  test("absolute path is absolute", () => {
    expect(isAbsolutePathArg("/abs/foo.ts")).toBe(true);
  });

  test("relative path with inline range is not absolute", () => {
    expect(isAbsolutePathArg("foo.ts:10-25")).toBe(false);
  });

  test("absolute path with inline range is absolute", () => {
    expect(isAbsolutePathArg("/abs/foo.ts:10-25")).toBe(true);
  });

  test("relative glob is not absolute", () => {
    expect(isAbsolutePathArg("src/*.ts")).toBe(false);
  });

  test("absolute glob is absolute", () => {
    expect(isAbsolutePathArg("/abs/src/*.ts")).toBe(true);
  });
});

describe("trueline_read requireAbsolutePath guard", () => {
  test("MCP mode rejects a relative file_path", async () => {
    const result = await handleReadMulti({
      file_paths: ["target.ts"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("MCP mode accepts an absolute file_path", async () => {
    const result = await handleReadMulti({
      file_paths: [testFile],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("line 1");
  });

  test("CLI mode (flag omitted) still accepts a relative file_path", async () => {
    const result = await handleReadMulti({
      file_paths: ["target.ts"],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("line 1");
  });

  test("relative sibling errors but an absolute sibling still succeeds (graceful degradation)", async () => {
    const result = await handleReadMulti({
      file_paths: [testFile, "sibling.ts"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("line 1");
    expect(text).toContain("absolute");
  });

  test("rejects a relative glob", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.ts"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("an absolute glob still expands", async () => {
    const result = await handleReadMulti({
      file_paths: [`${join(testDir, "src")}/*.ts`],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("alpha");
  });
});

describe("trueline_outline requireAbsolutePath guard", () => {
  test("MCP mode rejects a relative file_path", async () => {
    const result = await handleOutline({
      file_paths: ["target.ts"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("MCP mode accepts an absolute file_path", async () => {
    const result = await handleOutline({
      file_paths: [testFile],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
  });

  test("CLI mode (flag omitted) still accepts a relative file_path", async () => {
    const result = await handleOutline({
      file_paths: ["target.ts"],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
  });

  test("relative sibling errors but an absolute sibling still succeeds (graceful degradation)", async () => {
    const result = await handleOutline({
      file_paths: [testFile, "sibling.ts"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("absolute");
  });

  test("rejects a relative glob", async () => {
    const result = await handleOutline({
      file_paths: ["src/*.ts"],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("an absolute glob still expands", async () => {
    const result = await handleOutline({
      file_paths: [`${join(testDir, "src")}/*.ts`],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("alpha");
  });
});

describe("trueline_search requireAbsolutePath guard", () => {
  test("MCP mode rejects a relative file_path", async () => {
    const result = await handleSearch({
      file_path: "target.ts",
      pattern: "line",
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("MCP mode accepts an absolute file_path", async () => {
    const result = await handleSearch({
      file_path: testFile,
      pattern: "line",
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("line 1");
  });

  test("CLI mode (flag omitted) still accepts a relative file_path", async () => {
    const result = await handleSearch({
      file_path: "target.ts",
      pattern: "line",
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("line 1");
  });

  test("relative sibling errors but an absolute sibling still succeeds (graceful degradation)", async () => {
    const result = await handleSearch({
      file_paths: [testFile, "sibling.ts"],
      pattern: "line",
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("absolute");
    expect(text).toContain("line 1");
  });
});

describe("trueline_verify requireAbsolutePath guard", () => {
  test("MCP mode rejects a relative file_path", async () => {
    const ref = issueTestRef(testFile, LINES, 1, 3);
    const result = await handleVerify({
      file_path: "target.ts",
      refs: [ref],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("MCP mode accepts an absolute file_path", async () => {
    const ref = issueTestRef(testFile, LINES, 1, 3);
    const result = await handleVerify({
      file_path: testFile,
      refs: [ref],
      projectDir: testDir,
      requireAbsolutePath: true,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toBe("all refs valid");
  });

  test("CLI mode (flag omitted) still accepts a relative file_path", async () => {
    const ref = issueTestRef(testFile, LINES, 1, 3);
    const result = await handleVerify({
      file_path: "target.ts",
      refs: [ref],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toBe("all refs valid");
  });
});

describe("trueline_changes requireAbsolutePath guard", () => {
  let diffDir: string;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

  function git(cmd: string) {
    execSync(`git ${cmd}`, { cwd: diffDir, stdio: "pipe", env: cleanEnv });
  }

  beforeEach(() => {
    diffDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-require-absolute-diff-")));
    git("init");
    git("config user.email test@test.com");
    git("config user.name Test");
  });

  afterEach(() => {
    rmSync(diffDir, { recursive: true, force: true });
  });

  test('MCP mode: wildcard "*" still works (not treated as a relative path)', async () => {
    const file = join(diffDir, "a.ts");
    writeFileSync(file, "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function a() { return 2; }\n");

    const result = await handleDiff({
      file_paths: ["*"],
      projectDir: diffDir,
      allowedDirs: [diffDir],
      requireAbsolutePath: true,
    });
    expect(getText(result)).toContain("a.ts");
  });

  test("MCP mode rejects an explicit relative file_path", async () => {
    const file = join(diffDir, "b.ts");
    writeFileSync(file, "function b() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function b() { return 2; }\n");

    const result = await handleDiff({
      file_paths: ["b.ts"],
      projectDir: diffDir,
      allowedDirs: [diffDir],
      requireAbsolutePath: true,
    });
    expect(getText(result)).toContain("absolute");
  });

  test("MCP mode accepts an absolute file_path", async () => {
    const file = join(diffDir, "c.ts");
    writeFileSync(file, "function c() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function c() { return 2; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: diffDir,
      allowedDirs: [diffDir],
      requireAbsolutePath: true,
    });
    expect(getText(result)).toContain("c.ts");
  });

  test("CLI mode (flag omitted) still accepts a relative file_path", async () => {
    const file = join(diffDir, "d.ts");
    writeFileSync(file, "function d() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function d() { return 2; }\n");

    const result = await handleDiff({
      file_paths: ["d.ts"],
      projectDir: diffDir,
      allowedDirs: [diffDir],
    });
    expect(getText(result)).toContain("d.ts");
  });
});

// Sanity: handleRead (singular, internal to handleReadMulti) is untouched by
// this work — it has no requireAbsolutePath field of its own.
describe("handleRead (singular) is unaffected", () => {
  test("still reads a relative file_path with no flag support", async () => {
    const result = await handleRead({ file_path: "target.ts", projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("line 1");
  });
});
