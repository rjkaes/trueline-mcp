import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMarkdownOutline } from "../../src/outline/markdown.ts";
import { handleOutline } from "../../src/tools/outline.ts";
import { getText } from "../helpers.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-markdown-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

let fileCounter = 0;
function writeTestFile(name: string, content: string): string {
  const path = join(testDir, `${fileCounter++}-${name}`);
  writeFileSync(path, content);
  return path;
}

// ==============================================================================
// Headings (regression: identical behavior to previous implementation)
// ==============================================================================
describe("headings", () => {
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
    expect(entries[0].endLine).toBe(4); // lines 1-4 (before "# Second" on line 5)
    expect(entries[1].endLine).toBe(7); // lines 5-7 (to EOF; trailing newline terminates line 7)
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

// ==============================================================================
// YAML Frontmatter
// ==============================================================================
describe("frontmatter", () => {
  test("detects frontmatter at line 1 closed with ---", async () => {
    const file = writeTestFile(
      "fm-dash.md",
      ["---", "title: My Doc", "date: 2024-01-01", "---", "", "# Content", ""].join("\n"),
    );
    const { entries } = await extractMarkdownOutline(file);

    expect(entries[0]).toMatchObject({
      startLine: 1,
      endLine: 4,
      depth: 0,
      nodeType: "frontmatter",
      text: "--- (frontmatter, 4 lines)",
    });
    expect(entries[1]).toMatchObject({ nodeType: "h1", text: "# Content" });
  });

  test("detects frontmatter closed with ...", async () => {
    const file = writeTestFile("fm-dots.md", ["---", "title: Doc", "...", "", "# Heading", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries[0]).toMatchObject({
      endLine: 3,
      nodeType: "frontmatter",
      text: "--- (frontmatter, 3 lines)",
    });
  });

  test("--- on line 3 is NOT frontmatter (thematic break)", async () => {
    const file = writeTestFile("thematic-break.md", ["# Title", "", "---", "", "More text.", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries.every((e) => e.nodeType !== "frontmatter")).toBe(true);
  });

  test("file with only frontmatter", async () => {
    const file = writeTestFile("only-fm.md", ["---", "key: value", "---", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].nodeType).toBe("frontmatter");
  });

  test("unclosed frontmatter at EOF is not emitted", async () => {
    const file = writeTestFile("unclosed-fm.md", ["---", "key: value", "another: thing"].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries).toHaveLength(0);
  });
});

// ==============================================================================
// Fenced Code Blocks
// ==============================================================================
describe("fenced code blocks", () => {
  test("backtick fence with language tag", async () => {
    const file = writeTestFile(
      "fence-lang.md",
      ["# Setup", "", "```bash", "npm install", "npm run build", "```", ""].join("\n"),
    );
    const { entries } = await extractMarkdownOutline(file);
    const fence = entries.find((e) => e.nodeType === "fenced_code");
    expect(fence).toMatchObject({
      startLine: 3,
      endLine: 6,
      depth: 1, // nested under h1 (depth 0)
      nodeType: "fenced_code",
      text: "```bash (4 lines)",
    });
  });

  test("backtick fence without language tag", async () => {
    const file = writeTestFile("fence-no-lang.md", ["```", "some code", "```", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries[0]).toMatchObject({
      nodeType: "fenced_code",
      text: "``` (3 lines)",
    });
  });

  test("tilde fence", async () => {
    const file = writeTestFile("fence-tilde.md", ["~~~python", "print('hello')", "~~~", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries[0]).toMatchObject({
      nodeType: "fenced_code",
      text: "~~~python (3 lines)",
    });
  });

  test("nested fences: 4-backtick containing 3-backtick", async () => {
    const file = writeTestFile("nested-fence.md", ["````markdown", "```js", "code", "```", "````", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    // Single fenced_code entry from ```` to ````
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      startLine: 1,
      endLine: 5,
      nodeType: "fenced_code",
    });
  });

  test("unclosed fence extends to EOF", async () => {
    const file = writeTestFile(
      "unclosed-fence.md",
      ["# Heading", "", "```js", "const x = 1;", "// no closing fence"].join("\n"),
    );
    const { entries } = await extractMarkdownOutline(file);
    const fence = entries.find((e) => e.nodeType === "fenced_code");
    expect(fence).toMatchObject({
      startLine: 3,
      endLine: 5,
      nodeType: "fenced_code",
      text: "```js (3 lines)",
    });
  });

  test("heading inside fenced code block is NOT emitted", async () => {
    const file = writeTestFile(
      "heading-in-fence.md",
      ["# Real Heading", "", "```", "# Not a heading", "## Also not", "```", "", "## Real Section", ""].join("\n"),
    );
    const { entries } = await extractMarkdownOutline(file);
    const headings = entries.filter((e) => e.nodeType.startsWith("h"));
    expect(headings).toHaveLength(2);
    expect(headings[0].text).toBe("# Real Heading");
    expect(headings[1].text).toBe("## Real Section");
  });
});

// ==============================================================================
// Depth assignment for non-heading elements
// ==============================================================================
describe("depth assignment", () => {
  test("elements before any heading get depth 0", async () => {
    const file = writeTestFile("no-heading-depth.md", ["```js", "code", "```", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    expect(entries[0].depth).toBe(0);
  });

  test("elements after h2 get depth 2 (h2 depth 1 + 1)", async () => {
    const file = writeTestFile("depth-after-h2.md", ["## Section", "", "```js", "code", "```", ""].join("\n"));
    const { entries } = await extractMarkdownOutline(file);
    const fence = entries.find((e) => e.nodeType === "fenced_code");
    expect(fence!.depth).toBe(2);
  });
});

// ==============================================================================
// Mixed document (spec example)
// ==============================================================================
describe("mixed document", () => {
  test("all element types interleaved", async () => {
    const file = writeTestFile(
      "mixed.md",
      [
        "---",
        "title: My Doc",
        "---",
        "",
        "# Introduction",
        "",
        "Some text here.",
        "",
        "## Setup",
        "",
        "```bash",
        "npm install",
        "npm run build",
        "```",
        "",
        "## API Reference",
        "",
        "### Authentication",
        "",
        "Auth details here.",
        "",
      ].join("\n"),
    );

    const { entries, totalLines } = await extractMarkdownOutline(file);

    expect(entries[0]).toMatchObject({ startLine: 1, endLine: 3, nodeType: "frontmatter" });
    expect(entries[1]).toMatchObject({ startLine: 5, nodeType: "h1" });
    expect(entries[2]).toMatchObject({ startLine: 9, nodeType: "h2" });
    expect(entries[3]).toMatchObject({ startLine: 11, endLine: 14, nodeType: "fenced_code" });
    expect(entries[4]).toMatchObject({ startLine: 16, nodeType: "h2" });
    expect(entries[5]).toMatchObject({ startLine: 18, nodeType: "h3" });

    expect(entries).toHaveLength(6);
    expect(totalLines).toBe(20);
  });
});

// ==============================================================================
// Edge cases
// ==============================================================================
describe("edge cases", () => {
  test("empty file", async () => {
    const file = writeTestFile("empty.md", "");
    const { entries, totalLines } = await extractMarkdownOutline(file);
    expect(entries).toHaveLength(0);
    expect(totalLines).toBe(0);
  });

  test("heading range is not closed by non-heading entries", async () => {
    const file = writeTestFile(
      "heading-range.md",
      ["# Title", "", "```js", "code", "```", "", "# Second", ""].join("\n"),
    );
    const { entries } = await extractMarkdownOutline(file);
    const h1 = entries.find((e) => e.text === "# Title");
    // First heading's range should extend to line 6 (just before # Second on line 7)
    expect(h1!.endLine).toBe(6);
  });
});

async function outline(name: string, source: string): Promise<{ text: string; isError: boolean }> {
  const file = writeTestFile(name, source);
  const result = await handleOutline({ file_paths: [file], projectDir: testDir });
  return { text: getText(result), isError: result.isError === true };
}

describe("heading and front matter recognition", () => {
  test("heading on line 1 of a BOM-prefixed file is found", async () => {
    const { text } = await outline("bom.md", "\uFEFF# Invoice Guide\n\nBody text.\n");

    expect(text).toContain("# Invoice Guide");
  });

  test("setext headings are found", async () => {
    const { text } = await outline(
      "setext.md",
      ["Invoice Guide", "=============", "", "Setup", "-----", "", "Body.", ""].join("\n"),
    );

    expect(text).toContain("# Invoice Guide");
    expect(text).toContain("## Setup");
  });

  test("closing hashes are not part of the heading text", async () => {
    const file = writeTestFile("closed.md", "# Invoice Guide #\n\nBody.\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries[0].text).toBe("# Invoice Guide");
  });

  test("triple backticks in a line's inline code do not open a fence", async () => {
    const file = writeTestFile("inline-fence.md", "```code``` is inline, not a fence.\n\n# Real Heading\n\nBody.\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries.map((e) => e.text)).toContain("# Real Heading");
  });

  test("an underline below a list item continuation is a thematic break", async () => {
    const file = writeTestFile("list-rule.md", "# Guide\n\n- item\n  continued\n---\n\nBody.\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries.map((e) => e.text)).toEqual(["# Guide"]);
  });

  test("an underline below an HTML block is not a setext underline", async () => {
    const file = writeTestFile("html-rule.md", "# Guide\n\n<div>\nfoo\n</div>\n---\n\nBody.\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries.map((e) => e.text)).toEqual(["# Guide"]);
  });

  test("a paragraph after a thematic break can still be a setext heading", async () => {
    const file = writeTestFile("rule-then-setext.md", "- item\n---\nSetup\n-----\n\nBody.\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries.map((e) => e.text)).toEqual(["## Setup"]);
  });

  test("a paragraph opening with an inline tag can still be a setext heading", async () => {
    const file = writeTestFile("inline-tag.md", "<b>Setup</b> notes\n-----\n\nBody.\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries.map((e) => e.text)).toEqual(["## <b>Setup</b> notes"]);
  });

  test("front matter is still outlined", async () => {
    const file = writeTestFile("front.md", "---\ntitle: Guide\n---\n\n# Guide\n");

    const { entries } = await extractMarkdownOutline(file);

    expect(entries.map((e) => e.nodeType)).toEqual(["frontmatter", "h1"]);
  });
});
