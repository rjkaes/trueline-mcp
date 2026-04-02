import { transcodedLines } from "../encoding.ts";
import { fnv1aHashBytes } from "../hash.ts";
import { isBinaryError } from "./shared.ts";
import type { DecodedLine, EngineParams, FileSearchResult, SearchMatch } from "./search-types.ts";

const POST_LIMIT_SCAN_CAP = 1000;

export async function searchLineByLine(params: EngineParams): Promise<FileSearchResult> {
  const { resolvedPath, matchLine, contextLines, maxMatches } = params;

  const matches: SearchMatch[] = [];
  let totalMatches = 0;
  let matchesCaptured = 0;

  // Ring buffer for pre-context
  const ring: DecodedLine[] = new Array(contextLines > 0 ? contextLines : 0);
  let ringLen = 0;
  let ringStart = 0;

  let postRemaining = 0;
  let currentLines: DecodedLine[] | null = null;
  let done = false;
  let postLimitScanned = 0;
  let postLimitCapped = false;

  try {
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

      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const text = lineBytes.toString("utf-8");
      const isMatch = matchLine(text);
      const decoded: DecodedLine = { lineNumber, text, hash: h, isMatch };

      if (isMatch) totalMatches++;

      if (isMatch && matchesCaptured < maxMatches) {
        matchesCaptured++;

        if (currentLines === null) {
          currentLines = [];
          // Drain ring buffer as pre-context
          if (ringLen > 0) {
            const count = Math.min(ringLen, ring.length);
            for (let i = 0; i < count; i++) {
              currentLines.push(ring[(ringStart + i) % ring.length]);
            }
          }
        }

        currentLines.push(decoded);
        postRemaining = contextLines;

        if (matchesCaptured >= maxMatches && postRemaining === 0) {
          flushWindow(matches, currentLines);
          currentLines = null;
          done = true;
        }
      } else if (postRemaining > 0 && currentLines !== null) {
        currentLines.push(decoded);

        if (isMatch && matchesCaptured < maxMatches) {
          postRemaining = contextLines;
        } else {
          postRemaining--;
          if (postRemaining === 0 && matchesCaptured >= maxMatches) {
            flushWindow(matches, currentLines);
            currentLines = null;
            done = true;
          } else if (postRemaining === 0) {
            flushWindow(matches, currentLines);
            currentLines = null;
            ringLen = 0;
            ringStart = 0;
          }
        }
      } else {
        if (contextLines > 0) {
          if (ringLen < ring.length) {
            ring[(ringStart + ringLen) % ring.length] = decoded;
            ringLen++;
          } else {
            ring[ringStart] = decoded;
            ringStart = (ringStart + 1) % ring.length;
          }
        }
      }
    }
  } catch (err: unknown) {
    if (isBinaryError(err)) {
      return {
        filePath: resolvedPath,
        resolvedPath,
        matches: [],
        totalMatches: 0,
        capped: false,
        error: "binary file",
      };
    }
    throw err;
  }

  // Flush any in-progress window
  if (currentLines !== null) {
    flushWindow(matches, currentLines);
  }

  return {
    filePath: resolvedPath,
    resolvedPath,
    matches,
    totalMatches,
    capped: postLimitCapped,
  };
}

function flushWindow(matches: SearchMatch[], lines: DecodedLine[]): void {
  matches.push({
    lines: [...lines],
    firstLine: lines[0].lineNumber,
    lastLine: lines[lines.length - 1].lineNumber,
  });
}
