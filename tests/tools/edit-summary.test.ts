import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, issueTestRef, resetRefStore } from "../helpers.ts";
import { issueRef } from "../../src/ref-store.ts";

let testDir: string;

beforeEach(() => {
  resetRefStore();
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-summary-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  resetRefStore();
});

function setupFile(name: string, content: string) {
  const f = join(testDir, name);
  writeFileSync(f, content);
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const ref = lines.length > 0 ? issueTestRef(f, lines, 1, lines.length) : issueRef(f, 0, 0, "00000000");
  return { path: f, lines, ref };
}

function edit(params: { file_path: string; edits: { ref: string; range: string; content: string }[] }) {
  return handleEdit({ ...params, projectDir: testDir });
}

// =============================================================================
// Per-edit summary lines
// =============================================================================

describe("edit summary", () => {
  test("single-line replace shows line number and delta", async () => {
    const { path, ref } = setupFile("a.txt", "aaa\nbbb\nccc\n");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${lineHash("bbb")}.2`, content: "xxx\nyyy\nzzz" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced line 2 (1\u21923 lines, +2)");
  });

  test("multi-line replace shows range and delta", async () => {
    const { path, ref } = setupFile("b.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const h2 = lineHash("bbb");
    const h4 = lineHash("ddd");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h2}.2-${h4}.4`, content: "xxx" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced lines 2\u20134 (3\u21921 line, -2)");
  });

  test("replace with same line count shows \u00b10", async () => {
    const { path, ref } = setupFile("c.txt", "aaa\nbbb\n");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${lineHash("aaa")}.1`, content: "xxx" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced line 1 (1\u21921 line, \u00b10)");
  });

  test("deletion shows deleted with line count", async () => {
    const { path, ref } = setupFile("d.txt", "aaa\nbbb\nccc\n");
    const h1 = lineHash("aaa");
    const h2 = lineHash("bbb");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${h1}.1-${h2}.2`, content: "" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("deleted lines 1\u20132 (2 lines)");
  });

  test("single-line deletion", async () => {
    const { path, ref } = setupFile("e.txt", "aaa\nbbb\nccc\n");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${lineHash("bbb")}.2`, content: "" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("deleted line 2 (1 line)");
  });

  test("insert-after shows line and count", async () => {
    const { path, ref } = setupFile("f.txt", "aaa\nbbb\n");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `+${lineHash("aaa")}.1`, content: "xxx\nyyy\nzzz" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("inserted 3 lines after line 1");
  });

  test("prepend (insert at start of file) shows location", async () => {
    const { path, ref } = setupFile("g.txt", "aaa\n");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: "+0", content: "xxx\nyyy" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("inserted 2 lines at start of file");
  });

  test("no-op edit includes summary", async () => {
    const { path, ref } = setupFile("h.txt", "aaa\nbbb\n");
    const result = await edit({
      file_path: path,
      edits: [{ ref, range: `${lineHash("aaa")}.1`, content: "aaa" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("no changes");
    expect(text).toContain("replaced line 1 (1\u21921 line, \u00b10)");
  });

  test("batch edit shows one summary line per op", async () => {
    const { path, ref } = setupFile("i.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const h1 = lineHash("aaa");
    const h3 = lineHash("ccc");
    const result = await edit({
      file_path: path,
      edits: [
        { ref, range: `${h1}.1`, content: "xxx" },
        { ref, range: `+${h3}.3`, content: "yyy" },
      ],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced line 1");
    expect(text).toContain("inserted 1 line after line 3");
  });
});
