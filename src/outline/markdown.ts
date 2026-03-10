/**
 * Markdown outline extraction.
 *
 * Parses ATX headings (# through ######) into outline entries.
 * No tree-sitter grammar needed — markdown heading structure is trivially regular.
 */
import type { OutlineEntry } from "./extract.ts";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** Extract outline entries from markdown source. */
export function extractMarkdownOutline(source: string): OutlineEntry[] {
  const lines = source.split("\n");
  const entries: OutlineEntry[] = [];

  // Track the line range each heading "owns" (from its line to just before the next heading).
  // We fill in endLine retroactively when we encounter the next heading.
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;

    const level = match[1].length; // 1–6
    const text = match[2].trimEnd();
    const line = i + 1; // 1-based

    // Close the previous entry's range
    if (entries.length > 0) {
      entries[entries.length - 1].endLine = line - 1;
    }

    entries.push({
      startLine: line,
      endLine: lines.length, // default: extends to EOF, updated by next heading
      depth: level - 1, // h1=0, h2=1, …
      nodeType: `h${level}`,
      text: `${"#".repeat(level)} ${text}`,
    });
  }

  return entries;
}
