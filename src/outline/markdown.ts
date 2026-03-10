/**
 * Streaming markdown outline extraction.
 *
 * Parses ATX headings (# through ######) into outline entries by streaming
 * the file line-by-line through splitLines. Never loads the full file into memory.
 */
import { splitLines } from "../line-splitter.ts";
import type { OutlineEntry } from "./extract.ts";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** Extract outline entries from a markdown file by streaming it line-by-line. */
export async function extractMarkdownOutline(filePath: string): Promise<{
  entries: OutlineEntry[];
  totalLines: number;
}> {
  const entries: OutlineEntry[] = [];
  let totalLines = 0;

  // Track the line range each heading "owns" (from its line to just before the next heading).
  // We fill in endLine retroactively when we encounter the next heading.
  for await (const { lineBytes, lineNumber } of splitLines(filePath)) {
    totalLines = lineNumber;
    const line = lineBytes.toString("utf-8");

    const match = HEADING_RE.exec(line);
    if (!match) continue;

    const level = match[1].length; // 1–6
    const text = match[2].trimEnd();

    // Close the previous entry's range
    if (entries.length > 0) {
      entries[entries.length - 1].endLine = lineNumber - 1;
    }

    entries.push({
      startLine: lineNumber,
      endLine: totalLines, // default: extends to EOF, updated by next heading
      depth: level - 1, // h1=0, h2=1, …
      nodeType: `h${level}`,
      text: `${"#".repeat(level)} ${text}`,
    });
  }

  // Fix up the last entry's endLine to the actual last line
  if (entries.length > 0) {
    entries[entries.length - 1].endLine = totalLines;
  }

  return { entries, totalLines };
}
