/**
 * Streaming markdown outline extraction.
 *
 * Single-pass state machine that extracts headings, YAML frontmatter,
 * and fenced code blocks by streaming the file line-by-line through
 * transcodedLines. Never loads the full file into memory.
 */
import { transcodedLines } from "../encoding.ts";
import type { OutlineEntry } from "./extract.ts";

// CommonMark allows up to 3 spaces of indent before the #s.
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+)$/;
// CommonMark allows up to 3 spaces of indent on a fence, opening or closing.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(\s*(\S+))?/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
// Indented code, list items and block quotes: an underline below them is not a setext underline.
const NON_PARAGRAPH_RE = /^( {4}|\t|\s*[-*+]\s|\s*\d+[.)]\s|\s*>)/;
// CommonMark HTML block starts: the raw tags of types 1-6, or a lone tag (type 7). `<b>text</b>` is inline.
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_START_RE = new RegExp(
  `^ {0,3}(<(script|pre|style|textarea)([\\s>]|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[|</?(${HTML_BLOCK_TAGS})([\\s>]|/>|$))`,
  "i",
);
const HTML_LONE_TAG_RE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>\s*$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const HTML_COMMENT_OPEN_RE = /^ {0,3}<!--/;

enum State {
  NORMAL,
  IN_FRONTMATTER,
  IN_FENCE,
  IN_HTML_COMMENT,
}

/** Extract outline entries from a markdown file by streaming it line-by-line. */
export async function extractMarkdownOutline(
  filePath: string,
  maxDepth = Infinity,
): Promise<{
  entries: OutlineEntry[];
  totalLines: number;
}> {
  const entries: OutlineEntry[] = [];
  let totalLines = 0;

  // Widened so TS doesn't narrow `state` to NORMAL at the EOF check; processLine mutates it via closure.
  let state = State.NORMAL as State;
  let currentHeadingDepth = -1; // depth of the most recent heading (-1 = none seen)
  let lastHeadingIdx = -1; // index into entries[] of the most recent heading
  let shallowestLevel = 7; // fewest #s among the headings seen (7 = none)

  // Frontmatter state
  let frontmatterStart = 0;

  // Fence state
  let fenceChar = "";
  let fenceCount = 0;
  let fenceStart = 0;
  let fenceLang = "";

  // Paragraph being read, in case an underline below turns it into a setext heading
  let paragraphStart = 0; // 0 = not in a paragraph
  let paragraphText = "";
  // A list, quote, code or HTML block, which runs to the next blank line: an underline inside is not setext.
  // TODO: a block that starts directly under a paragraph should end it, and HTML blocks of types 1-5
  // (script, pre, style, ...) end at their closing marker rather than a blank line. Comments do: IN_HTML_COMMENT.
  let blockOpen: "" | "html" | "other" = "";

  function elementDepth(): number {
    return currentHeadingDepth >= 0 ? currentHeadingDepth + 1 : 0;
  }

  function emitHeading(level: number, text: string, lineNumber: number) {
    // Close the previous heading's range just before this line.
    if (lastHeadingIdx >= 0) entries[lastHeadingIdx].endLine = lineNumber - 1;
    currentHeadingDepth = level - 1;
    shallowestLevel = Math.min(shallowestLevel, level);
    lastHeadingIdx = entries.length; // index of the entry we're about to push
    entries.push({
      startLine: lineNumber,
      endLine: totalLines, // default: extends to EOF, updated by next heading
      depth: level - 1,
      nodeType: `h${level}`,
      text: `${"#".repeat(level)} ${text}`,
    });
  }

  function emitFence(endLine: number) {
    const lineCount = endLine - fenceStart + 1;
    const opener = fenceChar.repeat(3);
    entries.push({
      startLine: fenceStart,
      endLine,
      depth: elementDepth(),
      nodeType: "fenced_code",
      text: fenceLang ? `${opener}${fenceLang} (${lineCount} lines)` : `${opener} (${lineCount} lines)`,
    });
  }

  /** Process a single line through the state machine. */
  function processLine(line: string, lineNumber: number) {
    switch (state) {
      case State.IN_FRONTMATTER: {
        if (line === "---" || line === "...") {
          entries.push({
            startLine: frontmatterStart,
            endLine: lineNumber,
            depth: 0,
            nodeType: "frontmatter",
            text: `--- (frontmatter, ${lineNumber - frontmatterStart + 1} lines)`,
          });
          state = State.NORMAL;
        }
        return;
      }

      case State.IN_FENCE: {
        // Closing fence: same char, at least as many repeats, nothing else
        const trimmed = line.trimEnd().replace(/^ {0,3}(?=[`~])/, "");
        if (trimmed.length >= fenceCount && trimmed === fenceChar.repeat(trimmed.length)) {
          emitFence(lineNumber);
          state = State.NORMAL;
        }
        return;
      }

      case State.IN_HTML_COMMENT: {
        if (line.includes("-->")) state = State.NORMAL;
        return;
      }

      case State.NORMAL: {
        // Frontmatter: only on line 1
        if (lineNumber === 1 && line === "---") {
          state = State.IN_FRONTMATTER;
          frontmatterStart = 1;
          return;
        }

        // Fenced code block
        const fenceMatch = FENCE_OPEN_RE.exec(line);
        // A backtick fence's info string cannot contain backticks: ```code``` is inline code.
        if (fenceMatch && !(fenceMatch[1][0] === "`" && line.trimStart().includes("`", fenceMatch[1].length))) {
          state = State.IN_FENCE;
          paragraphStart = 0;
          blockOpen = "";
          fenceChar = fenceMatch[1][0];
          fenceCount = fenceMatch[1].length;
          fenceStart = lineNumber;
          fenceLang = fenceMatch[3] || "";
          return;
        }

        // An HTML comment block ends at its `-->` line, not at a blank line: nothing inside it is markdown.
        if (HTML_COMMENT_OPEN_RE.test(line) && !line.includes("-->")) {
          state = State.IN_HTML_COMMENT;
          paragraphStart = 0;
          blockOpen = "";
          return;
        }

        // Heading
        const headingMatch = HEADING_RE.exec(line);
        if (headingMatch) {
          emitHeading(headingMatch[1].length, headingMatch[2].replace(/\s+#+\s*$/, "").trimEnd(), lineNumber);
          paragraphStart = 0;
          blockOpen = "";
          return;
        }

        // Setext heading: an underline directly below a paragraph
        const underlineMatch = SETEXT_UNDERLINE_RE.exec(line);
        if (underlineMatch && paragraphStart) {
          emitHeading(underlineMatch[1][0] === "=" ? 1 : 2, paragraphText, paragraphStart);
          paragraphStart = 0;
          return;
        }

        if (!line.trim()) {
          paragraphStart = 0;
          blockOpen = "";
        } else if (THEMATIC_BREAK_RE.test(line) && blockOpen !== "html") {
          paragraphStart = 0;
          blockOpen = "";
        } else if (paragraphStart) {
          paragraphText += ` ${line.trim()}`;
        } else if (!blockOpen) {
          if (HTML_BLOCK_START_RE.test(line) || HTML_LONE_TAG_RE.test(line)) blockOpen = "html";
          else if (NON_PARAGRAPH_RE.test(line)) blockOpen = "other";
          else {
            paragraphStart = lineNumber;
            paragraphText = line.trim();
          }
        }
        return;
      }
    }
  }

  // ==============================================================================
  // Main loop: stream lines
  // ==============================================================================
  const { lines } = await transcodedLines(filePath);
  for await (const { lineBytes, lineNumber } of lines) {
    totalLines = lineNumber;
    processLine(lineBytes.toString("utf-8"), lineNumber);
  }

  // ==============================================================================
  // Flush EOF: emit any open fence
  // ==============================================================================
  if (state === State.IN_FENCE) emitFence(totalLines);
  // Unclosed frontmatter at EOF: don't emit (ambiguous)

  // Fix up the last heading's endLine to the actual last line
  if (lastHeadingIdx >= 0) {
    entries[lastHeadingIdx].endLine = totalLines;
  }

  // Depth is relative to the shallowest heading, so a document that starts at `##` has top-level entries.
  // Entries at depth 0 (frontmatter, fences before any heading) stay put.
  if (shallowestLevel > 1 && shallowestLevel < 7) {
    for (const entry of entries) if (entry.depth > 0) entry.depth -= shallowestLevel - 1;
  }

  return { entries: entries.filter((entry) => entry.depth <= maxDepth), totalLines };
}
