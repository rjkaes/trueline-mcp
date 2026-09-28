/**
 * Streaming markdown outline extraction.
 *
 * Single-pass state machine that extracts headings, YAML frontmatter,
 * fenced code blocks, tables, HTML comment blocks, and blockquotes
 * by streaming the file line-by-line through splitLines.
 * Never loads the full file into memory.
 */
import { splitLines } from "../line-splitter.ts";
import type { OutlineEntry } from "./extract.ts";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(\s*(\S+))?/;
const TABLE_ROW_RE = /^\|(.+\|)+\s*$/;
const TABLE_SEP_RE = /^\|[\s:.-]*-+[\s:.-]*(\|[\s:.-]*-+[\s:.-]*)+\|?\s*$/;

enum State {
  NORMAL,
  IN_FRONTMATTER,
  IN_FENCE,
  IN_TABLE,
  IN_HTML_COMMENT,
  IN_BLOCKQUOTE,
}

/** Extract outline entries from a markdown file by streaming it line-by-line. */
export async function extractMarkdownOutline(filePath: string): Promise<{
  entries: OutlineEntry[];
  totalLines: number;
}> {
  const entries: OutlineEntry[] = [];
  let totalLines = 0;

  let state: State = State.NORMAL;
  let currentHeadingDepth = -1; // depth of the most recent heading (-1 = none seen)
  let lastHeadingIdx = -1; // index into entries[] of the most recent heading

  // Frontmatter state
  let frontmatterStart = 0;

  // Fence state
  let fenceChar = "";
  let fenceCount = 0;
  let fenceStart = 0;
  let fenceLang = "";

  // Table state
  let tableStart = 0;
  let tableHeaderText = "";
  let tableCols = 0;
  let tableRows = 0;

  // HTML comment state
  let htmlCommentStart = 0;

  // Blockquote state
  let blockquoteStart = 0;
  let blockquoteFirstLine = "";

  // Table lookahead: buffer one line to detect header + separator pairs.
  let bufferedLine: string | null = null;
  let bufferedLineNumber = 0;

  function elementDepth(): number {
    return currentHeadingDepth >= 0 ? currentHeadingDepth + 1 : 0;
  }

  /** Close the range of the last heading entry to just before `lineNumber`. */
  function closeLastHeadingRange(lineNumber: number) {
    if (lastHeadingIdx >= 0) {
      entries[lastHeadingIdx].endLine = lineNumber - 1;
    }
  }

  function emitHeading(level: number, text: string, lineNumber: number) {
    closeLastHeadingRange(lineNumber);
    currentHeadingDepth = level - 1;
    lastHeadingIdx = entries.length; // index of the entry we're about to push
    entries.push({
      startLine: lineNumber,
      endLine: totalLines, // default: extends to EOF, updated by next heading
      depth: level - 1,
      nodeType: `h${level}`,
      text: `${"#".repeat(level)} ${text}`,
    });
  }

  function emitFrontmatter(endLine: number) {
    const lineCount = endLine - frontmatterStart + 1;
    entries.push({
      startLine: frontmatterStart,
      endLine,
      depth: 0,
      nodeType: "frontmatter",
      text: `--- (frontmatter, ${lineCount} lines)`,
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

  function emitTable(endLine: number) {
    entries.push({
      startLine: tableStart,
      endLine,
      depth: elementDepth(),
      nodeType: "table",
      text: `${truncate(tableHeaderText, 80)} (${tableRows} rows, ${tableCols} cols)`,
    });
  }

  function emitHtmlComment(endLine: number) {
    const lineCount = endLine - htmlCommentStart + 1;
    if (lineCount < 3) return;
    entries.push({
      startLine: htmlCommentStart,
      endLine,
      depth: elementDepth(),
      nodeType: "html_comment",
      text: `<!-- ... --> (${lineCount} lines)`,
    });
  }

  function emitBlockquote(endLine: number) {
    const lineCount = endLine - blockquoteStart + 1;
    if (lineCount < 3) return;
    const alertMatch = /^>\s*\[!(\w+)]/.exec(blockquoteFirstLine);
    const displayText = alertMatch ? `> [!${alertMatch[1]}]` : `> ${truncateInner(blockquoteFirstLine, 60)}`;
    entries.push({
      startLine: blockquoteStart,
      endLine,
      depth: elementDepth(),
      nodeType: "blockquote",
      text: `${displayText} (${lineCount} lines)`,
    });
  }

  /** Flush any open block at EOF. Extracted to a function to avoid TypeScript narrowing issues. */
  function flushOpenBlock(s: State, endLine: number) {
    if (s === State.IN_FENCE) {
      emitFence(endLine);
    } else if (s === State.IN_TABLE) {
      emitTable(endLine);
    } else if (s === State.IN_HTML_COMMENT) {
      emitHtmlComment(endLine);
    } else if (s === State.IN_BLOCKQUOTE) {
      emitBlockquote(endLine);
    }
  }

  /** Process a single line through the state machine. Returns true if consumed, false to reprocess. */
  function processLine(line: string, lineNumber: number): boolean {
    switch (state) {
      case State.IN_FRONTMATTER: {
        if (line === "---" || line === "...") {
          emitFrontmatter(lineNumber);
          state = State.NORMAL;
        }
        return true;
      }

      case State.IN_FENCE: {
        // Closing fence: same char, at least as many repeats, nothing else
        const trimmed = line.trimEnd();
        if (trimmed.length >= fenceCount) {
          let allSame = true;
          for (let i = 0; i < trimmed.length; i++) {
            if (trimmed[i] !== fenceChar) {
              allSame = false;
              break;
            }
          }
          if (allSame) {
            emitFence(lineNumber);
            state = State.NORMAL;
          }
        }
        return true;
      }

      case State.IN_TABLE: {
        if (TABLE_ROW_RE.test(line)) {
          tableRows++;
          return true;
        }
        emitTable(lineNumber - 1);
        state = State.NORMAL;
        return false; // reprocess this line in NORMAL
      }

      case State.IN_HTML_COMMENT: {
        if (line.includes("-->")) {
          emitHtmlComment(lineNumber);
          state = State.NORMAL;
        }
        return true;
      }

      case State.IN_BLOCKQUOTE: {
        if (line.startsWith("> ") || line === ">") {
          return true;
        }
        emitBlockquote(lineNumber - 1);
        state = State.NORMAL;
        return false; // reprocess this line in NORMAL
      }

      case State.NORMAL: {
        // Frontmatter: only on line 1
        if (lineNumber === 1 && line === "---") {
          state = State.IN_FRONTMATTER;
          frontmatterStart = 1;
          return true;
        }

        // Fenced code block
        const fenceMatch = FENCE_OPEN_RE.exec(line);
        if (fenceMatch) {
          state = State.IN_FENCE;
          fenceChar = fenceMatch[1][0];
          fenceCount = fenceMatch[1].length;
          fenceStart = lineNumber;
          fenceLang = fenceMatch[3] || "";
          return true;
        }

        // HTML comment (multi-line only)
        if (line.includes("<!--") && !line.includes("-->")) {
          state = State.IN_HTML_COMMENT;
          htmlCommentStart = lineNumber;
          return true;
        }

        // Blockquote
        if (line.startsWith("> ") || line === ">") {
          state = State.IN_BLOCKQUOTE;
          blockquoteStart = lineNumber;
          blockquoteFirstLine = line;
          return true;
        }

        // Heading
        const headingMatch = HEADING_RE.exec(line);
        if (headingMatch) {
          emitHeading(headingMatch[1].length, headingMatch[2].trimEnd(), lineNumber);
          return true;
        }

        return true;
      }
    }
  }

  // ==============================================================================
  // Main loop: stream lines with one-line lookahead for table detection
  // ==============================================================================
  for await (const { lineBytes, lineNumber } of splitLines(filePath)) {
    totalLines = lineNumber;
    const line = lineBytes.toString("utf-8");

    // Inside a block: skip the lookahead buffer logic
    if (state !== State.NORMAL) {
      if (bufferedLine !== null) {
        const buf = bufferedLine;
        const bufNum = bufferedLineNumber;
        bufferedLine = null;
        while (!processLine(buf, bufNum));
      }
      while (!processLine(line, lineNumber));
      continue;
    }

    // NORMAL state: use lookahead buffer for table detection
    if (bufferedLine !== null) {
      if (TABLE_ROW_RE.test(bufferedLine) && TABLE_SEP_RE.test(line)) {
        state = State.IN_TABLE;
        tableStart = bufferedLineNumber;
        tableHeaderText = bufferedLine.trim();
        tableCols = (line.match(/\|/g) || []).length - 1;
        tableRows = 2; // header row + separator row
        bufferedLine = null;
        continue;
      }

      // Not a table start: process the buffered line normally
      const buf = bufferedLine;
      const bufNum = bufferedLineNumber;
      bufferedLine = null;
      while (!processLine(buf, bufNum));
    }

    // Buffer potential table header for lookahead
    if (state === State.NORMAL && TABLE_ROW_RE.test(line)) {
      bufferedLine = line;
      bufferedLineNumber = lineNumber;
      continue;
    }

    while (!processLine(line, lineNumber));
  }

  // ==============================================================================
  // Flush EOF: emit any open blocks or buffered lines
  // ==============================================================================
  if (bufferedLine !== null) {
    while (!processLine(bufferedLine, bufferedLineNumber));
  }

  flushOpenBlock(state, totalLines);
  // Unclosed frontmatter at EOF: don't emit (ambiguous)

  // Fix up the last heading's endLine to the actual last line
  if (lastHeadingIdx >= 0) {
    entries[lastHeadingIdx].endLine = totalLines;
  }

  return { entries, totalLines };
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}\u2026`;
}

function truncateInner(s: string, maxLen: number): string {
  const inner = s.startsWith("> ") ? s.slice(2) : s.startsWith(">") ? s.slice(1) : s;
  return truncate(inner.trimEnd(), maxLen);
}
