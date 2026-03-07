/**
 * trueline_search tool handler.
 *
 * Searches a file by regex and returns matching lines with context,
 * per-line hashes, and checksums — ready for immediate editing.
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

interface LineBuf {
  lineNumber: number;
  content: Buffer;
  hash: number;
  isMatch: boolean;
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
  // Pass 1: Collect all lines and find matches
  // ===========================================================================

  const allLines: LineBuf[] = [];
  const matchIndices: number[] = [];

  try {
    for await (const { lineBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: true })) {
      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
      const text = lineBytes.toString("utf-8");
      const isMatch = regex.test(text);
      allLines.push({ lineNumber, content: lineBytes, hash: h, isMatch });
      if (isMatch) matchIndices.push(allLines.length - 1);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("binary")) {
      return errorResult(`"${file_path}" appears to be a binary file`);
    }
    throw err;
  }

  if (matchIndices.length === 0) {
    return textResult(`No matches for pattern "${pattern}" in ${file_path}`);
  }

  // ===========================================================================
  // Build context windows and merge overlapping ranges
  // ===========================================================================

  const totalMatches = matchIndices.length;
  const cappedIndices = matchIndices.slice(0, maxMatches);

  type Range = { start: number; end: number };
  const ranges: Range[] = [];

  for (const idx of cappedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(allLines.length - 1, idx + contextLines);

    // Merge with previous range if overlapping
    if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
      ranges[ranges.length - 1].end = end;
    } else {
      ranges.push({ start, end });
    }
  }

  // ===========================================================================
  // Format output with hashes and checksums
  // ===========================================================================

  const parts: string[] = [];

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    let checksumHash = FNV_OFFSET_BASIS;
    let firstLine = 0;
    let lastLine = 0;

    if (i > 0) parts.push("");

    for (let idx = range.start; idx <= range.end; idx++) {
      const line = allLines[idx];
      if (firstLine === 0) firstLine = line.lineNumber;
      lastLine = line.lineNumber;
      checksumHash = foldHash(checksumHash, line.hash);

      const marker = line.isMatch ? "  ← match" : "";
      parts.push(`${line.lineNumber}:${hashToLetters(line.hash)}|${line.content.toString("utf-8")}${marker}`);
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
