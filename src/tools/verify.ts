// ==============================================================================
// trueline_verify handler
//
// Streaming ref verifier — checks whether held refs are still valid without a
// full trueline_read roundtrip. Returns "valid" or "stale" per ref for
// near-zero tokens.
//
// Performance: mirrors handleRead's streaming loop exactly, but produces no
// output buffer — strictly cheaper than a read.
// ==============================================================================

import { splitLines } from "../line-splitter.ts";
import { FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash } from "../hash.ts";
import { resolveRef, type RefEntry } from "../ref-store.ts";
import { binaryFileError, isBinaryError, validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface VerifyParams {
  refs: string[];
  projectDir?: string;
  allowedDirs?: string[];
}

interface Accumulator {
  refId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  expected: string;
  hash: number;
}

export async function handleVerify(params: VerifyParams): Promise<ToolResult> {
  const { refs, projectDir, allowedDirs } = params;

  if (!refs || refs.length === 0) {
    return errorResult("No refs provided");
  }

  // Resolve all refs and group by file path.
  const accsPerFile = new Map<string, Accumulator[]>();
  for (const refId of refs) {
    let entry: RefEntry;
    try {
      entry = resolveRef(refId);
    } catch (err: unknown) {
      return errorResult((err as Error).message);
    }

    const validated = await validatePath(entry.filePath, "Read", projectDir, allowedDirs);
    if (!validated.ok) return validated.error;

    const acc: Accumulator = {
      refId,
      filePath: validated.resolvedPath,
      startLine: entry.startLine,
      endLine: entry.endLine,
      expected: entry.hash,
      hash: FNV_OFFSET_BASIS,
    };

    const existing = accsPerFile.get(validated.resolvedPath);
    if (existing) {
      existing.push(acc);
    } else {
      accsPerFile.set(validated.resolvedPath, [acc]);
    }
  }

  const results: string[] = [];
  let allValid = true;

  for (const [resolvedPath, accs] of accsPerFile) {
    accs.sort((a, b) => a.startLine - b.startLine);

    let totalLines = 0;

    try {
      let accIdx = 0;
      for await (const { lineBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: true })) {
        totalLines = lineNumber;

        // Skip empty-file sentinels at the front (startLine === 0)
        while (accIdx < accs.length && accs[accIdx].startLine === 0) accIdx++;
        if (accIdx >= accs.length) break;

        if (lineNumber < accs[accIdx].startLine) continue;

        while (accIdx < accs.length && accs[accIdx].startLine > 0 && lineNumber > accs[accIdx].endLine) accIdx++;
        if (accIdx >= accs.length) break;
        if (accs[accIdx].startLine > 0 && lineNumber < accs[accIdx].startLine) continue;

        const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);

        // Fold into all active accumulators covering this line
        for (let i = accIdx; i < accs.length && accs[i].startLine <= lineNumber; i++) {
          if (accs[i].startLine > 0 && lineNumber <= accs[i].endLine) {
            accs[i].hash = foldHash(accs[i].hash, h);
          }
        }
      }
    } catch (err: unknown) {
      if (isBinaryError(err)) return binaryFileError(accs[0].filePath);
      throw err;
    }

    for (const acc of accs) {
      // Empty-file sentinel
      if (acc.startLine === 0 && acc.endLine === 0) {
        if (totalLines === 0 && acc.expected === "00000000") {
          results.push(`valid: ${acc.refId}`);
        } else {
          allValid = false;
          results.push(`stale: ${acc.refId} (file now has ${totalLines} lines)`);
        }
        continue;
      }

      // Range extends past EOF
      if (acc.startLine > totalLines || acc.endLine > totalLines) {
        allValid = false;
        results.push(`stale: ${acc.refId} (range past EOF, file has ${totalLines} lines)`);
        continue;
      }

      const actualHash = acc.hash.toString(16).padStart(8, "0");
      if (actualHash === acc.expected) {
        results.push(`valid: ${acc.refId}`);
      } else {
        allValid = false;
        results.push(`stale: ${acc.refId} (lines ${acc.startLine}-${acc.endLine} changed)`);
      }
    }
  }

  if (allValid) return textResult("all refs valid");
  return textResult(results.join("\n"));
}
