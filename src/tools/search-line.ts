import { transcodedLines } from "../encoding.ts";
import { fnv1aHashBytes } from "../hash.ts";
import type { DecodedLine, EngineParams, FileSearchResult, SearchMatch } from "./search-types.ts";

const POST_LIMIT_SCAN_CAP = 1000;

export async function searchLineByLine(params: EngineParams): Promise<FileSearchResult> {
  const { resolvedPath, matchLine, contextLines, maxMatches } = params;

  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let matchesCaptured = 0;

  // Last contextLines lines seen outside any window, oldest first (pre-context)
  const pre: DecodedLine[] = [];

  let postRemaining = 0;
  let currentLines: DecodedLine[] | null = null;
  let done = false;
  let postLimitScanned = 0;
  let postLimitCapped = false;

  const flush = (): void => {
    if (currentLines !== null) matches.push({ lines: currentLines });
    currentLines = null;
  };

  const transcoded = await transcodedLines(resolvedPath, { detectBinary: true });
  for await (const { lineBytes, lineNumber } of transcoded.lines) {
    if (done) {
      postLimitScanned++;
      if (postLimitScanned > POST_LIMIT_SCAN_CAP) {
        postLimitCapped = true;
        break;
      }
      const text = lineBytes.toString("utf-8");
      if (matchLine(text)) totalMatches++;
      continue;
    }

    const h = fnv1aHashBytes(lineBytes);
    const text = lineBytes.toString("utf-8");
    const isMatch = matchLine(text);
    if (isMatch) totalMatches++;

    // Only captured matches are marked; a later match inside trailing context is not.
    const captured = isMatch && matchesCaptured < maxMatches;
    const decoded: DecodedLine = { lineNumber, text, hash: h, isMatch: captured };

    if (captured) {
      matchesCaptured++;

      if (currentLines === null) {
        // Drain pre-context into the new window
        currentLines = pre.splice(0);
      }

      currentLines.push(decoded);
      postRemaining = contextLines;

      if (matchesCaptured >= maxMatches && postRemaining === 0) {
        flush();
        done = true;
      }
    } else if (postRemaining > 0 && currentLines !== null) {
      currentLines.push(decoded);
      postRemaining--;
      if (postRemaining === 0 && matchesCaptured >= maxMatches) {
        flush();
        done = true;
      } else if (postRemaining === 0) {
        flush();
      }
    } else {
      // context_lines=0: a non-match line arrives while currentLines is open but
      // postRemaining is already 0.  Flush now so the next match starts a fresh
      // window -- otherwise non-adjacent matches merge into one sparse window
      // whose checksum excludes intermediate lines, causing edit verification to fail.
      flush();
      pre.push(decoded);
      if (pre.length > contextLines) pre.shift();
    }
  }

  // Flush any in-progress window
  flush();

  return {
    filePath: resolvedPath,
    matches,
    totalMatches,
    capped: postLimitCapped,
  };
}
