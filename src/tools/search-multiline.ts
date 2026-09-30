import { transcodedLines } from "../encoding.ts";
import { fnv1aHashBytes } from "../hash.ts";
import type { DecodedLine, FileSearchResult, SearchMatch } from "./search-types.ts";

export interface MultilineEngineParams {
  resolvedPath: string;
  regex: RegExp; // must carry the g flag (matchAll)
  contextLines: number;
  maxMatches: number;
  maxMatchLines: number;
}

interface BufferedLine {
  lineNumber: number;
  text: string;
  bytes: Buffer;
}

export async function searchMultiline(params: MultilineEngineParams): Promise<FileSearchResult> {
  const { resolvedPath, regex, contextLines, maxMatches, maxMatchLines } = params;

  // Read all lines. Multiline regex requires the joined text, so the full
  // file must be in memory. The maxMatchLines parameter limits how large
  // individual matches can be, not the file size.
  const lines: BufferedLine[] = [];

  const transcoded = await transcodedLines(resolvedPath, { detectBinary: true });
  let endsWithEol = false;
  for await (const { lineBytes, eolBytes, lineNumber } of transcoded.lines) {
    lines.push({ lineNumber, text: lineBytes.toString("utf-8"), bytes: lineBytes });
    endsWithEol = eolBytes.length > 0;
  }

  // Join lines and build a character-offset-to-line-index map
  const lineTexts = lines.map((l) => l.text);
  // The last line's EOL stays, or a pattern like `\}\n` cannot match at EOF. Its offset
  // belongs to that last line, so lineOffsets needs no extra entry.
  const joined = `${lineTexts.join("\n")}${endsWithEol ? "\n" : ""}`;

  const lineOffsets: number[] = [];
  let offset = 0;
  for (const text of lineTexts) {
    lineOffsets.push(offset);
    offset += text.length + 1; // +1 for the \n
  }

  let totalMatches = 0;
  let oversizeMatches = 0;
  const hits: { startIdx: number; endIdx: number }[] = [];

  for (const m of joined.matchAll(regex)) {
    // A zero-length match covers no line
    if (m[0].length === 0) continue;

    // Map character offsets to line indices
    const startIdx = charOffsetToLineIndex(lineOffsets, m.index);
    const endIdx = charOffsetToLineIndex(lineOffsets, m.index + m[0].length - 1);

    // Skip matches that span more than maxMatchLines, but count them so the
    // caller is told instead of seeing "No matches".
    if (endIdx - startIdx + 1 > maxMatchLines) {
      oversizeMatches++;
      continue;
    }

    totalMatches++;
    if (hits.length < maxMatches) hits.push({ startIdx, endIdx });
  }

  // One window per run of hits whose context touches or overlaps, as in line
  // mode, so no line or ref repeats.
  const matches: SearchMatch[] = [];
  let first = 0;
  while (first < hits.length) {
    const ctxStart = Math.max(0, hits[first].startIdx - contextLines);
    let ctxEnd = Math.min(lines.length - 1, hits[first].endIdx + contextLines);
    let next = first + 1;
    while (next < hits.length && hits[next].startIdx - contextLines <= ctxEnd + 1) {
      ctxEnd = Math.min(lines.length - 1, hits[next].endIdx + contextLines);
      next++;
    }

    const windowLines: DecodedLine[] = [];
    for (let i = ctxStart; i <= ctxEnd; i++) {
      const l = lines[i];
      windowLines.push({ lineNumber: l.lineNumber, text: l.text, hash: fnv1aHashBytes(l.bytes), isMatch: false });
    }
    for (const hit of hits.slice(first, next)) {
      for (let i = hit.startIdx; i <= hit.endIdx; i++) windowLines[i - ctxStart].isMatch = true;
    }

    matches.push({ lines: windowLines });
    first = next;
  }

  return { filePath: resolvedPath, matches, totalMatches, capped: false, oversizeMatches };
}

// Binary search for the line index containing a character offset.
function charOffsetToLineIndex(lineOffsets: number[], charOffset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineOffsets[mid] <= charOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
