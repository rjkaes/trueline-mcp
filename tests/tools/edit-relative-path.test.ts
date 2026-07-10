import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, issueTestRef, getText } from "../helpers.ts";

// Regression coverage for: MCP trueline_edit with a relative file_path can
// silently edit the wrong file. The long-lived MCP server pins `projectDir`
// once at startup; when the caller is actually working in a git worktree,
// a relative file_path still resolves against the server's stale projectDir
// (main), not the worktree. Content-based ref verification doesn't catch
// this because a fresh worktree file can be byte-identical to main.
//
// Fix: `requireAbsolutePath` (set true only by the MCP registration in
// src/server.ts) rejects relative file_path before any file access happens.
// The CLI (src/cli/edit.ts) does not set this flag, since its projectDir is
// the real shell cwd and relative paths are safe there.

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-relpath-test-")));
  testFile = join(testDir, "target.ts");
  writeFileSync(testFile, "line 1\nline 2\nline 3\n");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleEdit requireAbsolutePath guard", () => {
  test("MCP edit rejects a relative file_path", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const ref = issueTestRef(testFile, lines, 1, 3);
    const range = `${lineHash("line 1")}1`;

    const result = await handleEdit({
      file_path: "target.ts",
      edits: [{ ref, range, content: "CHANGED" }],
      projectDir: testDir,
      requireAbsolutePath: true,
    });

    expect(result.isError).toBeTruthy();
    expect(getText(result)).toContain("absolute");

    const written = readFileSync(testFile, "utf-8");
    expect(written.startsWith("line 1")).toBe(true);
  });

  test("MCP edit accepts an absolute file_path", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const ref = issueTestRef(testFile, lines, 1, 3);
    const range = `${lineHash("line 1")}1`;

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range, content: "CHANGED" }],
      projectDir: testDir,
      requireAbsolutePath: true,
    });

    expect(result.isError).toBeUndefined();

    const written = readFileSync(testFile, "utf-8");
    expect(written.startsWith("CHANGED")).toBe(true);
  });

  test("regression: relative path in a worktree scenario silently targets the wrong tree without the guard", async () => {
    const mainDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-relpath-main-")));
    const worktreeDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-relpath-worktree-")));

    try {
      const mainFile = join(mainDir, "app.ts");
      const worktreeFile = join(worktreeDir, "app.ts");
      writeFileSync(mainFile, "AAA\nBBB\n");
      writeFileSync(worktreeFile, "AAA\nBBB\n");

      const lines = ["AAA", "BBB"];
      const ref = issueTestRef(mainFile, lines, 1, 2);
      const range = `${lineHash("AAA")}1`;
      const call = {
        file_path: "app.ts",
        edits: [{ ref, range, content: "ZZZ" }],
        projectDir: mainDir,
      };

      // CLI mode (no requireAbsolutePath): relative file_path silently
      // resolves against projectDir (main), not the worktree the caller
      // intended to edit.
      const unguardedResult = await handleEdit(call);

      expect(unguardedResult.isError).toBeUndefined();
      expect(readFileSync(mainFile, "utf-8").startsWith("ZZZ")).toBe(true);
      expect(readFileSync(worktreeFile, "utf-8").startsWith("AAA")).toBe(true);

      // Same call, MCP mode (requireAbsolutePath: true): rejected before any
      // file access, leaving both trees unchanged (the guard fires before
      // checksum verification, so the already-mutated mainFile doesn't matter).
      const guardedResult = await handleEdit({ ...call, requireAbsolutePath: true });

      // Must fail specifically on the absolute-path guard (fired before any
      // content/checksum verification), not on an incidental stale-checksum
      // mismatch from reusing the now-outdated ref.
      expect(guardedResult.isError).toBeTruthy();
      expect(getText(guardedResult)).toContain("absolute");
      expect(readFileSync(mainFile, "utf-8").startsWith("ZZZ")).toBe(true);
      expect(readFileSync(worktreeFile, "utf-8").startsWith("AAA")).toBe(true);
    } finally {
      rmSync(mainDir, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});
