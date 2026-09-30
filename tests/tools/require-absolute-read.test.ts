import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead, handleReadMulti } from "../../src/tools/read.ts";
import { handleOutline } from "../../src/tools/outline.ts";
import { handleSearch } from "../../src/tools/search.ts";
import { handleVerify } from "../../src/tools/verify.ts";
import { handleDiff } from "../../src/tools/diff.ts";
import { isAbsolutePathArg } from "../../src/tools/shared.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { getText, issueTestRef, makeGitRepo, writeTestFile } from "../helpers.ts";

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
  test.each([
    ["relative path is not absolute", "foo.ts", false],
    ["absolute path is absolute", "/abs/foo.ts", true],
    ["relative path with inline range is not absolute", "foo.ts:10-25", false],
    ["absolute path with inline range is absolute", "/abs/foo.ts:10-25", true],
    ["relative glob is not absolute", "src/*.ts", false],
    ["absolute glob is absolute", "/abs/src/*.ts", true],
  ])("%s", (_name, input, expected) => {
    expect(isAbsolutePathArg(input)).toBe(expected);
  });
});

const MCP_MODE = { requireAbsolutePath: true } as const;

interface GuardedTool {
  name: string;
  call: (filePaths: string[], opts?: typeof MCP_MODE) => Promise<ToolResult>;
  // Text a successful call over target.ts must contain; outline finds no symbols in it.
  targetText?: string;
}

const readTool: GuardedTool = {
  name: "trueline_read",
  call: (file_paths, opts) => handleReadMulti({ file_paths, projectDir: testDir, ...opts }),
  targetText: "line 1",
};

const outlineTool: GuardedTool = {
  name: "trueline_outline",
  call: (file_paths, opts) => handleOutline({ file_paths, projectDir: testDir, ...opts }),
};

const searchTool: GuardedTool = {
  name: "trueline_search",
  call: (file_paths, opts) => handleSearch({ file_paths, pattern: "line", projectDir: testDir, ...opts }),
  targetText: "line 1",
};

describe.each([readTool, outlineTool, searchTool])("$name requireAbsolutePath guard", ({ call, targetText }) => {
  test("MCP mode rejects a relative file_path", async () => {
    const result = await call(["target.ts"], MCP_MODE);
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("MCP mode accepts an absolute file_path", async () => {
    const result = await call([testFile], MCP_MODE);
    expect(result.isError).toBeUndefined();
    if (targetText) expect(getText(result)).toContain(targetText);
  });

  test("CLI mode (flag omitted) still accepts a relative file_path", async () => {
    const result = await call(["target.ts"]);
    expect(result.isError).toBeUndefined();
    if (targetText) expect(getText(result)).toContain(targetText);
  });

  test("relative sibling errors but an absolute sibling still succeeds (graceful degradation)", async () => {
    const result = await call([testFile, "sibling.ts"], MCP_MODE);
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("absolute");
    if (targetText) expect(text).toContain(targetText);
  });
});

// trueline_search has no glob cases here; adding them would be new coverage, not a fold.
describe.each([readTool, outlineTool])("$name requireAbsolutePath guard (globs)", ({ call }) => {
  test("rejects a relative glob", async () => {
    const result = await call(["src/*.ts"], MCP_MODE);
    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");
  });

  test("an absolute glob still expands", async () => {
    const result = await call([`${join(testDir, "src")}/*.ts`], MCP_MODE);
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("alpha");
  });
});

describe("trueline_verify requireAbsolutePath guard", () => {
  test("MCP mode rejects a relative file_path", async () => {
    const ref = issueTestRef(LINES, 1, 3);
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
    const ref = issueTestRef(LINES, 1, 3);
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
    const ref = issueTestRef(LINES, 1, 3);
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
  let git: ReturnType<typeof makeGitRepo>["git"];

  beforeEach(() => {
    ({ dir: diffDir, git } = makeGitRepo("trueline-require-absolute-diff-"));
  });

  afterEach(() => {
    rmSync(diffDir, { recursive: true, force: true });
  });

  test('MCP mode: wildcard "*" still works (not treated as a relative path)', async () => {
    const file = writeTestFile(diffDir, "a.ts", "function a() { return 1; }\n");
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
    const file = writeTestFile(diffDir, "b.ts", "function b() { return 1; }\n");
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
    const file = writeTestFile(diffDir, "c.ts", "function c() { return 1; }\n");
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
    const file = writeTestFile(diffDir, "d.ts", "function d() { return 1; }\n");
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
