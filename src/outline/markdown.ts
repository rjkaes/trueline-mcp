/**
 * Streaming markdown outline extraction.
 *
 * Single-pass state machine that extracts headings, YAML frontmatter,
 * and fenced code blocks by streaming the file line-by-line through
 * splitLines. Never loads the full file into memory.
 */
import { splitLines } from "../line-splitter.ts";
import type { OutlineEntry } from "./extract.ts";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(\s*(\S+))?/;

enum State {
  NORMAL,
  IN_FRONTMATTER,
  IN_FENCE,
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

  function elementDepth(): number {
    return currentHeadingDepth >= 0 ? currentHeadingDepth + 1 : 0;
  }

  function emitHeading(level: number, text: string, lineNumber: number) {
    // Close the previous heading's range just before this line.
    if (lastHeadingIdx >= 0) entries[lastHeadingIdx].endLine = lineNumber - 1;
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

  /** Flush an unclosed fence at EOF. Extracted to a function to avoid TypeScript narrowing issues. */
  function flushOpenBlock(s: State, endLine: number) {
    if (s === State.IN_FENCE) {
      emitFence(endLine);
    }
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
        const trimmed = line.trimEnd();
        if (trimmed.length >= fenceCount && trimmed === fenceChar.repeat(trimmed.length)) {
          emitFence(lineNumber);
          state = State.NORMAL;
        }
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
        if (fenceMatch) {
          state = State.IN_FENCE;
          fenceChar = fenceMatch[1][0];
          fenceCount = fenceMatch[1].length;
          fenceStart = lineNumber;
          fenceLang = fenceMatch[3] || "";
          return;
        }

        // Heading
        const headingMatch = HEADING_RE.exec(line);
        if (headingMatch) {
          emitHeading(headingMatch[1].length, headingMatch[2].trimEnd(), lineNumber);
        }
        return;
      }
    }
  }

  // ==============================================================================
  // Main loop: stream lines
  // ==============================================================================
  for await (const { lineBytes, lineNumber } of splitLines(filePath)) {
    totalLines = lineNumber;
    processLine(lineBytes.toString("utf-8"), lineNumber);
  }

  // ==============================================================================
  // Flush EOF: emit any open fence
  // ==============================================================================
  flushOpenBlock(state, totalLines);
  // Unclosed frontmatter at EOF: don't emit (ambiguous)

  // Fix up the last heading's endLine to the actual last line
  if (lastHeadingIdx >= 0) {
    entries[lastHeadingIdx].endLine = totalLines;
  }

  return { entries, totalLines };
}
