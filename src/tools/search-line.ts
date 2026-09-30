import { transcodedLines } from "../encoding.ts";
import { fnv1aHashBytes } from "../hash.ts";
import type { DecodedLine, EngineParams, FileSearchResult } from "./search-types.ts";

const POST_LIMIT_SCAN_CAP = 1000;

export async function searchLineByLine(params: EngineParams): Promise<FileSearchResult> {
  const { resolvedPath, matchLine, contextLines, maxMatches } = params;

  const matches: DecodedLine[][] = [];
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
    if (currentLines !== null) matches.push(currentLines);
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

      // Gap lines since the last window join it (there are at most contextLines of
      // them, or it was flushed), so windows with touching context merge as in
      // multiline mode.
      currentLines ??= [];
      currentLines.push(...pre.splice(0), decoded);
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
      }
    } else {
      // The window stays open while a next match could still merge into it. Once the
      // gap outgrows contextLines it cannot, and merging across it would leave a
      // sparse window whose checksum excludes the lines between, failing edit verification.
      pre.push(decoded);
      if (pre.length > contextLines) {
        flush();
        pre.shift();
      }
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
