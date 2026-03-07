/**
 * trueline_search tool handler.
 *
 * Searches a file by regex and returns matching lines with context,
 * per-line hashes, and checksums — ready for immediate editing.
 *
 * Uses a single-pass sliding window so memory is O(contextLines) instead
 * of O(file_size). Decodes each line to a string exactly once.
 */
import { splitLines } from "../line-splitter.ts";
import { fnv1aHashBytes, hashToLetters, foldHash, FNV_OFFSET_BASIS, formatChecksum } from "../hash.ts";
import { validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface SearchParams {
  file_path: string;
  pattern: string;
  context_lines?: number;
  max_matches?: number;
  projectDir?: string;
  allowedDirs?: string[];
}

// A decoded line with its hash, ready for output.
interface DecodedLine {
  lineNumber: number;
  text: string;
  hash: number;
  isMatch: boolean;
}

// A contiguous window of lines to emit (one or more matches with context).
interface OutputWindow {
  lines: DecodedLine[];
}

export async function handleSearch(params: SearchParams): Promise<ToolResult> {
  const { file_path, pattern, projectDir, allowedDirs } = params;
  const contextLines = params.context_lines ?? 2;
  const maxMatches = params.max_matches ?? 10;

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  // Validate regex
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return errorResult(`Invalid regex pattern: "${pattern}"`);
  }

  const { resolvedPath } = validated;

  // ===========================================================================
  // Single-pass sliding window
  //
  // We maintain a ring buffer of the last `contextLines` decoded lines for
  // pre-context. When a match is found, we flush the ring buffer as pre-context
  // and switch to collecting post-context. Overlapping windows are merged by
  // extending the current window instead of starting a new one.
  // ===========================================================================

  const windows: OutputWindow[] = [];
  let totalMatches = 0;
  let matchesCaptured = 0;

  // Ring buffer for pre-context (last `contextLines` non-matched lines)
  const ring: DecodedLine[] = new Array(contextLines > 0 ? contextLines : 0);
  let ringLen = 0; // how many valid entries in ring
  let ringStart = 0; // oldest entry index

  // Post-context state: when > 0, we're collecting post-context lines
  let postRemaining = 0;

  // Current window being built
  let currentWindow: OutputWindow | null = null;

  // Whether we've captured enough matches and finished all post-context
  let done = false;

  try {
    for await (const { lineBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: true })) {
      if (done) {
        // We still need to count remaining matches for the truncation notice,
        // but only check — don't decode or store.
        // Optimization: decode only to test regex
        const text = lineBytes.toString("utf-8");
        if (regex.test(text)) totalMatches++;
        continue;
      }

      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const text = lineBytes.toString("utf-8");
      const isMatch = regex.test(text);
      const decoded: DecodedLine = { lineNumber, text, hash: h, isMatch };

      if (isMatch) totalMatches++;

      if (isMatch && matchesCaptured < maxMatches) {
        matchesCaptured++;

        if (currentWindow === null) {
          // Start a new window: flush ring buffer as pre-context
          currentWindow = { lines: [] };

          // Drain ring buffer in order (oldest to newest)
          if (ringLen > 0) {
            const count = Math.min(ringLen, ring.length);
            for (let i = 0; i < count; i++) {
              currentWindow.lines.push(ring[(ringStart + i) % ring.length]);
            }
          }
        }

        currentWindow.lines.push(decoded);
        postRemaining = contextLines; // reset post-context counter
      } else if (postRemaining > 0 && currentWindow !== null) {
        // Collecting post-context
        currentWindow.lines.push(decoded);

        if (isMatch) {
          // Another match within post-context range — extend the window
          // (matchesCaptured was already incremented above if under limit)
          postRemaining = contextLines; // reset
        } else {
          postRemaining--;
          if (postRemaining === 0 && matchesCaptured >= maxMatches) {
            // Done collecting post-context for the last captured match
            windows.push(currentWindow);
            currentWindow = null;
            done = true;
          } else if (postRemaining === 0) {
            // Finished this window's post-context, but more matches may come
            windows.push(currentWindow);
            currentWindow = null;
            // Reset ring buffer
            ringLen = 0;
            ringStart = 0;
          }
        }
      } else {
        // Not in a window — add to ring buffer for future pre-context
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
    if (err instanceof Error && err.message.includes("binary")) {
      return errorResult(`"${file_path}" appears to be a binary file`);
    }
    throw err;
  }

  // Flush any in-progress window
  if (currentWindow !== null) {
    windows.push(currentWindow);
  }

  if (totalMatches === 0) {
    return textResult(`No matches for pattern "${pattern}" in ${file_path}`);
  }

  // ===========================================================================
  // Format output with hashes and checksums
  // ===========================================================================

  const parts: string[] = [];

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    let checksumHash = FNV_OFFSET_BASIS;
    let firstLine = 0;
    let lastLine = 0;

    if (i > 0) parts.push("");

    for (const line of window.lines) {
      if (firstLine === 0) firstLine = line.lineNumber;
      lastLine = line.lineNumber;
      checksumHash = foldHash(checksumHash, line.hash);

      const marker = line.isMatch ? "  ← match" : "";
      parts.push(`${line.lineNumber}:${hashToLetters(line.hash)}|${line.text}${marker}`);
    }

    parts.push("");
    parts.push(`checksum: ${formatChecksum(firstLine, lastLine, checksumHash)}`);
  }

  // Truncation notice
  if (totalMatches > maxMatches) {
    parts.push("");
    parts.push(`(showing ${maxMatches} of ${totalMatches} matches — increase max_matches to see more)`);
  }

  return textResult(parts.join("\n"));
}
