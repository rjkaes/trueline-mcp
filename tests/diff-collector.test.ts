// handleEdit formats the diff after streamingEdit has already renamed the new
// file into place, so a throw here reports "Internal error" for an edit that
// landed.  Spreading a huge array into push() overflows the call stack (Node
// at ~200k entries, Bun at ~1M), which a large replace can reach.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffCollector } from "../src/diff-collector.ts";
import { handleEdit } from "../src/tools/edit.ts";
import { lineHash, setupFile } from "./helpers.ts";

describe("DiffCollector.format on very large diffs", () => {
  test("formats one huge replaced block (realign path)", () => {
    const linesPerSide = 600_000;
    const collector = new DiffCollector();
    for (let i = 0; i < linesPerSide; i++) collector.delete("removed line");
    for (let i = 0; i < linesPerSide; i++) collector.insert("added line");

    const diff = collector.format("a/generated.ts", "b/generated.ts");

    expect(
      diff.startsWith(`--- a/generated.ts\n+++ b/generated.ts\n@@ -1,${linesPerSide} +1,${linesPerSide} @@\n`),
    ).toBe(true);
    expect(diff.endsWith("+added line\n")).toBe(true);
  });

  test("formats one huge hunk of small change blocks (hunk path)", () => {
    const groups = 400_000;
    const collector = new DiffCollector();
    for (let i = 0; i < groups; i++) {
      collector.delete("removed line");
      collector.insert("added line");
      collector.context("kept line");
    }

    const diff = collector.format("a/generated.ts", "b/generated.ts");

    expect(diff.startsWith(`--- a/generated.ts\n+++ b/generated.ts\n@@ -1,${groups * 2} +1,${groups * 2} @@\n`)).toBe(
      true,
    );
    expect(diff.endsWith(" kept line\n")).toBe(true);
  });
});

// GNU unified diff anchors an empty side at the line before the hunk, so its start is 0 for a whole file.
describe("DiffCollector.format hunk header for an empty side", () => {
  test("insert into an empty file", () => {
    const one = new DiffCollector();
    one.insert("first");
    expect(one.format("a/f.txt", "b/f.txt")).toContain("@@ -0,0 +1 @@");

    const two = new DiffCollector();
    two.insert("first");
    two.insert("second");
    expect(two.format("a/f.txt", "b/f.txt")).toContain("@@ -0,0 +1,2 @@");
  });

  test("delete every line of a file", () => {
    const one = new DiffCollector();
    one.delete("first");
    expect(one.format("a/f.txt", "b/f.txt")).toContain("@@ -1 +0,0 @@");

    const two = new DiffCollector();
    two.delete("first");
    two.delete("second");
    expect(two.format("a/f.txt", "b/f.txt")).toContain("@@ -1,2 +0,0 @@");
  });
});

describe("DiffCollector through handleEdit dry_run", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-diff-collector-")));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // streaming-edit.ts once called collector.context() twice for a no-op replace.
  test("a no-op edit beside a real edit does not duplicate context lines", async () => {
    const { path, ref } = setupFile(testDir, "diff-dup.txt", "line1\nline2\nline3\nline4\nline5\n");

    const result = await handleEdit({
      file_path: path,
      dry_run: true,
      edits: [
        { ref, range: `${lineHash("line1")}1`, content: "LINE1" },
        { ref, range: `${lineHash("line3")}3`, content: "line3" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const line3Count = (result.content[0].text.match(/^ line3$/gm) || []).length;
    expect(line3Count).toBe(1);
  });
});
