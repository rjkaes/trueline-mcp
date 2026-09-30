import { describe, expect, test } from "bun:test";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, setupFile, useTestDir } from "../helpers.ts";

const testDir = useTestDir("trueline-edit-summary-");

function edit(params: { file_path: string; edits: { ref: string; range: string; content: string }[] }) {
  return handleEdit({ ...params, projectDir: testDir() });
}

// =============================================================================
// Per-edit summary lines
// =============================================================================

interface SummaryCase {
  name: string;
  content: string;
  edits: { range: string; content: string }[];
  contains: string[];
  matches?: RegExp;
}

describe("edit summary", () => {
  test.each<SummaryCase>([
    {
      name: "single-line replace shows line number and delta",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "xxx\nyyy\nzzz" }],
      contains: ["~2 ->", "(1->3)"],
    },
    {
      name: "multi-line replace shows range and delta",
      content: "aaa\nbbb\nccc\nddd\neee\n",
      edits: [{ range: `${lineHash("bbb")}2-${lineHash("ddd")}4`, content: "xxx" }],
      contains: ["~2-4 ->", "(3->1)"],
    },
    {
      name: "replace with same line count shows ±0",
      content: "aaa\nbbb\n",
      edits: [{ range: `${lineHash("aaa")}1`, content: "xxx" }],
      contains: ["~1 ->", "(1->1)"],
    },
    {
      name: "deletion shows deleted with line count",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("aaa")}1-${lineHash("bbb")}2`, content: "" }],
      contains: ["-1-2 (2)", '"aaa\\nbbb"'],
    },
    {
      name: "single-line deletion",
      content: "aaa\nbbb\nccc\n",
      edits: [{ range: `${lineHash("bbb")}2`, content: "" }],
      contains: ["-2 (1)", '"bbb"'],
    },
    {
      name: "insert-after shows line and count",
      content: "aaa\nbbb\n",
      edits: [{ range: `+${lineHash("aaa")}1`, content: "xxx\nyyy\nzzz" }],
      contains: ["+3 @1 ->"],
      matches: /[a-z]{2}[0-9]/,
    },
    {
      name: "prepend (insert at start of file) shows location",
      content: "aaa\n",
      edits: [{ range: "+0", content: "xxx\nyyy" }],
      contains: ["+2 @start ->"],
      matches: /[a-z]{2}[0-9]/,
    },
    {
      name: "no-op edit includes summary",
      content: "aaa\nbbb\n",
      edits: [{ range: `${lineHash("aaa")}1`, content: "aaa" }],
      contains: ["no changes", "~1 ->", "(1->1)"],
    },
    {
      name: "batch edit shows one summary line per op",
      content: "aaa\nbbb\nccc\nddd\neee\n",
      edits: [
        { range: `${lineHash("aaa")}1`, content: "xxx" },
        { range: `+${lineHash("ccc")}3`, content: "yyy" },
      ],
      contains: ["~1 ->", "+1 @3"],
    },
  ])("$name", async ({ content, edits, contains, matches }) => {
    const { path, ref } = setupFile(testDir(), "summary.txt", content);

    const result = await edit({ file_path: path, edits: edits.map((e) => ({ ref, ...e })) });

    const text = result.content[0].text;
    for (const fragment of contains) expect(text).toContain(fragment);
    if (matches) expect(text).toMatch(matches);
  });
});
