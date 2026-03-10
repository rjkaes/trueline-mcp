import { describe, expect, test } from "bun:test";
import { extractMarkdownOutline } from "../../src/outline/markdown.ts";

describe("extractMarkdownOutline", () => {
  test("extracts ATX headings with correct depth", () => {
    const source = [
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
    ].join("\n");

    const entries = extractMarkdownOutline(source);

    expect(entries).toHaveLength(4);

    expect(entries[0]).toMatchObject({ startLine: 1, depth: 0, nodeType: "h1", text: "# Title" });
    expect(entries[1]).toMatchObject({ startLine: 5, depth: 1, nodeType: "h2", text: "## Section One" });
    expect(entries[2]).toMatchObject({ startLine: 9, depth: 2, nodeType: "h3", text: "### Subsection" });
    expect(entries[3]).toMatchObject({ startLine: 13, depth: 1, nodeType: "h2", text: "## Section Two" });
  });

  test("heading endLine extends to just before the next heading", () => {
    const source = ["# First", "", "content", "", "# Second", "", "more content", ""].join("\n");

    const entries = extractMarkdownOutline(source);

    expect(entries).toHaveLength(2);
    expect(entries[0].endLine).toBe(4); // lines 1–4 (before "# Second" on line 5)
    expect(entries[1].endLine).toBe(8); // lines 5–8 (to EOF)
  });

  test("returns empty for file with no headings", () => {
    const source = "Just some text.\nNo headings here.\n";
    const entries = extractMarkdownOutline(source);
    expect(entries).toHaveLength(0);
  });

  test("ignores lines that look like headings but aren't", () => {
    const source = [
      "# Real heading",
      "",
      "Some `#not-a-heading` in code",
      "#no-space-after-hash",
      "    # indented (not ATX)",
      "",
    ].join("\n");

    const entries = extractMarkdownOutline(source);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("# Real heading");
  });

  test("handles all six heading levels", () => {
    const source = ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6", ""].join("\n");

    const entries = extractMarkdownOutline(source);
    expect(entries).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(entries[i].depth).toBe(i);
      expect(entries[i].nodeType).toBe(`h${i + 1}`);
    }
  });
});
