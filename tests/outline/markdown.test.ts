import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMarkdownOutline } from "../../src/outline/markdown.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-markdown-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeTestFile(name: string, content: string): string {
  const path = join(testDir, name);
  writeFileSync(path, content);
  return path;
}

describe("extractMarkdownOutline", () => {
  test("extracts ATX headings with correct depth", async () => {
    const file = writeTestFile(
      "headings.md",
      [
        "# Title",
        "",
        "Some intro text.",
        "",
        "## Section One",
        "",
        "Content here.",
        "",
        "### Subsection",
        "",
        "More content.",
        "",
        "## Section Two",
        "",
        "Final content.",
        "",
      ].join("\n"),
    );

    const { entries } = await extractMarkdownOutline(file);

    expect(entries).toHaveLength(4);

    expect(entries[0]).toMatchObject({ startLine: 1, depth: 0, nodeType: "h1", text: "# Title" });
    expect(entries[1]).toMatchObject({ startLine: 5, depth: 1, nodeType: "h2", text: "## Section One" });
    expect(entries[2]).toMatchObject({ startLine: 9, depth: 2, nodeType: "h3", text: "### Subsection" });
    expect(entries[3]).toMatchObject({ startLine: 13, depth: 1, nodeType: "h2", text: "## Section Two" });
  });

  test("heading endLine extends to just before the next heading", async () => {
    const file = writeTestFile(
      "endlines.md",
      ["# First", "", "content", "", "# Second", "", "more content", ""].join("\n"),
    );

    const { entries } = await extractMarkdownOutline(file);

    expect(entries).toHaveLength(2);
    expect(entries[0].endLine).toBe(4); // lines 1–4 (before "# Second" on line 5)
    expect(entries[1].endLine).toBe(7); // lines 5–7 (to EOF; trailing newline terminates line 7)
  });

  test("returns empty for file with no headings", async () => {
    const file = writeTestFile("no-headings.md", "Just some text.\nNo headings here.\n");
    const { entries } = await extractMarkdownOutline(file);
    expect(entries).toHaveLength(0);
  });

  test("ignores lines that look like headings but aren't", async () => {
    const file = writeTestFile(
      "fake-headings.md",
      [
        "# Real heading",
        "",
        "Some `#not-a-heading` in code",
        "#no-space-after-hash",
        "    # indented (not ATX)",
        "",
      ].join("\n"),
    );

    const { entries } = await extractMarkdownOutline(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("# Real heading");
  });

  test("handles all six heading levels", async () => {
    const file = writeTestFile(
      "all-levels.md",
      ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6", ""].join("\n"),
    );

    const { entries } = await extractMarkdownOutline(file);
    expect(entries).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(entries[i].depth).toBe(i);
      expect(entries[i].nodeType).toBe(`h${i + 1}`);
    }
  });

  test("returns correct totalLines", async () => {
    const file = writeTestFile("counted.md", ["# Title", "", "Some text.", ""].join("\n"));
    const { totalLines } = await extractMarkdownOutline(file);
    expect(totalLines).toBe(3); // trailing newline terminates line 3, not a separate line 4
  });
});
