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
  for await (const { lineBytes, lineNumber } of transcoded.lines) {
    lines.push({ lineNumber, text: lineBytes.toString("utf-8"), bytes: lineBytes });
  }

  // Join lines and build a character-offset-to-line-index map
  const lineTexts = lines.map((l) => l.text);
  const joined = lineTexts.join("\n");

  const lineOffsets: number[] = [];
  let offset = 0;
  for (const text of lineTexts) {
    lineOffsets.push(offset);
    offset += text.length + 1; // +1 for the \n
  }

  let totalMatches = 0;
  const matches: SearchMatch[] = [];

  for (const m of joined.matchAll(regex)) {
    // A zero-length match covers no line
    if (m[0].length === 0) continue;

    // Map character offsets to line indices
    const startIdx = charOffsetToLineIndex(lineOffsets, m.index);
    const endIdx = charOffsetToLineIndex(lineOffsets, m.index + m[0].length - 1);

    // Skip matches that span more than maxMatchLines
    if (endIdx - startIdx + 1 > maxMatchLines) continue;

    totalMatches++;
    if (matches.length >= maxMatches) continue;

    const ctxStart = Math.max(0, startIdx - contextLines);
    const ctxEnd = Math.min(lines.length - 1, endIdx + contextLines);

    const windowLines: DecodedLine[] = [];
    for (let i = ctxStart; i <= ctxEnd; i++) {
      const l = lines[i];
      const h = fnv1aHashBytes(l.bytes, 0, l.bytes.length);
      windowLines.push({
        lineNumber: l.lineNumber,
        text: l.text,
        hash: h,
        isMatch: i >= startIdx && i <= endIdx,
      });
    }

    matches.push({ lines: windowLines });
  }

  return { filePath: resolvedPath, matches, totalMatches, capped: false };
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
