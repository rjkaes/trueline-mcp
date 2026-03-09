import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { rangeChecksum } from "../helpers.ts";
import { EMPTY_FILE_CHECKSUM } from "../../src/hash.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-summary-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function setupFile(name: string, content: string) {
  const f = join(testDir, name);
  writeFileSync(f, content);
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const cs = lines.length > 0 ? rangeChecksum(lines, 1, lines.length) : EMPTY_FILE_CHECKSUM;
  return { path: f, lines, cs };
}

function edit(params: { file_path: string; edits: { checksum: string; range: string; content: string }[] }) {
  return handleEdit({ ...params, projectDir: testDir });
}

// =============================================================================
// Per-edit summary lines
// =============================================================================

describe("edit summary", () => {
  test("single-line replace shows line number and delta", async () => {
    const { path, cs } = setupFile("a.txt", "aaa\nbbb\nccc\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "xxx\nyyy\nzzz" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced line 2 (1\u21923 lines, +2)");
  });

  test("multi-line replace shows range and delta", async () => {
    const { path, cs } = setupFile("b.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2-4`, content: "xxx" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced lines 2\u20134 (3\u21921 line, -2)");
  });

  test("replace with same line count shows \u00b10", async () => {
    const { path, cs } = setupFile("c.txt", "aaa\nbbb\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1`, content: "xxx" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced line 1 (1\u21921 line, \u00b10)");
  });

  test("deletion shows deleted with line count", async () => {
    const { path, cs } = setupFile("d.txt", "aaa\nbbb\nccc\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1-2`, content: "" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("deleted lines 1\u20132 (2 lines)");
  });

  test("single-line deletion", async () => {
    const { path, cs } = setupFile("e.txt", "aaa\nbbb\nccc\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `2`, content: "" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("deleted line 2 (1 line)");
  });

  test("insert-after shows line and count", async () => {
    const { path, cs } = setupFile("f.txt", "aaa\nbbb\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `+1`, content: "xxx\nyyy\nzzz" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("inserted 3 lines after line 1");
  });

  test("prepend (insert at start of file) shows location", async () => {
    const { path, cs } = setupFile("g.txt", "aaa\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: "+0", content: "xxx\nyyy" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("inserted 2 lines at start of file");
  });

  test("no-op edit includes summary", async () => {
    const { path, cs } = setupFile("h.txt", "aaa\nbbb\n");
    const result = await edit({
      file_path: path,
      edits: [{ checksum: cs, range: `1`, content: "aaa" }],
    });

    const text = result.content[0].text;
    expect(text).toContain("no changes");
    expect(text).toContain("replaced line 1 (1\u21921 line, \u00b10)");
  });

  test("batch edit shows one summary line per op", async () => {
    const { path, cs } = setupFile("i.txt", "aaa\nbbb\nccc\nddd\neee\n");
    const result = await edit({
      file_path: path,
      edits: [
        { checksum: cs, range: `1`, content: "xxx" },
        { checksum: cs, range: `+3`, content: "yyy" },
      ],
    });

    const text = result.content[0].text;
    expect(text).toContain("replaced line 1");
    expect(text).toContain("inserted 1 line after line 3");
  });
});
