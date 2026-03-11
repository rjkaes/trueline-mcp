// ==============================================================================
// trueline_verify handler
//
// Streaming checksum verifier — checks whether held checksums are still valid
// without a full trueline_read roundtrip.  Returns "valid" or "stale" per
// checksum for near-zero tokens.
//
// Performance: mirrors handleRead's streaming loop exactly, but produces no
// output buffer — strictly cheaper than a read.
// ==============================================================================

import { splitLines } from "../line-splitter.ts";
import { FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash, formatChecksum } from "../hash.ts";
import { parseChecksum } from "../parse.ts";
import { binaryFileError, isBinaryError, validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface VerifyParams {
  file_path: string;
  checksums: string[];
  projectDir?: string;
  allowedDirs?: string[];
}

interface Accumulator {
  startLine: number;
  endLine: number;
  expected: string;
  hash: number;
}

export async function handleVerify(params: VerifyParams): Promise<ToolResult> {
  const { file_path, checksums, projectDir, allowedDirs } = params;

  if (!checksums || checksums.length === 0) {
    return errorResult("No checksums provided");
  }

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath } = validated;

  // Parse and sort accumulators by startLine
  const accs: Accumulator[] = [];
  for (const cs of checksums) {
    let parsed: ReturnType<typeof parseChecksum>;
    try {
      parsed = parseChecksum(cs);
    } catch (err: unknown) {
      return errorResult((err as Error).message);
    }
    accs.push({
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      expected: parsed.hash,
      hash: FNV_OFFSET_BASIS,
    });
  }

  accs.sort((a, b) => a.startLine - b.startLine);

  // Handle empty-file sentinel: 0-0:00000000
  // These are always "valid" if the file is empty, checked after streaming.

  let totalLines = 0;

  try {
    let accIdx = 0;
    for await (const { lineBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: true })) {
      totalLines = lineNumber;

      // Skip empty-file sentinels at the front (startLine === 0)
      while (accIdx < accs.length && accs[accIdx].startLine === 0) accIdx++;
      if (accIdx >= accs.length) break;

      // Skip lines before current accumulator's range
      if (lineNumber < accs[accIdx].startLine) continue;

      // Advance past completed accumulators
      while (accIdx < accs.length && accs[accIdx].startLine > 0 && lineNumber > accs[accIdx].endLine) accIdx++;
      if (accIdx >= accs.length) break;
      if (accs[accIdx].startLine > 0 && lineNumber < accs[accIdx].startLine) continue;

      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);

      // Fold into all active accumulators covering this line (handles overlapping ranges)
      for (let i = accIdx; i < accs.length && accs[i].startLine <= lineNumber; i++) {
        if (accs[i].startLine > 0 && lineNumber <= accs[i].endLine) {
          accs[i].hash = foldHash(accs[i].hash, h);
        }
      }
    }
  } catch (err: unknown) {
    if (isBinaryError(err)) return binaryFileError(file_path);
    throw err;
  }

  // Build results
  const results: string[] = [];
  let allValid = true;

  for (const acc of accs) {
    // Empty-file sentinel
    if (acc.startLine === 0 && acc.endLine === 0) {
      if (totalLines === 0 && acc.expected === "00000000") {
        results.push(`valid: 0-0:00000000`);
      } else {
        allValid = false;
        if (totalLines === 0) {
          results.push(`stale: 0-0:${acc.expected}`);
        } else {
          results.push(`stale: 0-0:${acc.expected} (file now has ${totalLines} lines)`);
        }
      }
      continue;
    }

    // Range extends past EOF
    if (acc.startLine > totalLines || acc.endLine > totalLines) {
      allValid = false;
      const actual =
        acc.startLine > totalLines
          ? `range past EOF (file has ${totalLines} lines)`
          : `actual: ${formatChecksum(acc.startLine, Math.min(acc.endLine, totalLines), acc.hash)}`;
      results.push(`stale: ${acc.startLine}-${acc.endLine}:${acc.expected} (${actual})`);
      continue;
    }

    const actualHash = acc.hash.toString(16).padStart(8, "0");
    if (actualHash === acc.expected) {
      results.push(`valid: ${formatChecksum(acc.startLine, acc.endLine, acc.hash)}`);
    } else {
      allValid = false;
      results.push(
        `stale: ${acc.startLine}-${acc.endLine}:${acc.expected} (actual: ${formatChecksum(acc.startLine, acc.endLine, acc.hash)})`,
      );
    }
  }

  if (allValid) return textResult("all checksums valid");
  return textResult(results.join("\n"));
}
