// ==============================================================================
// trueline_verify handler
//
// Stateless ref verifier — checks inline refs by recomputing checksums from
// the file. No ref store needed: the checksum is encoded in the ref itself.
// Returns "valid" or "stale" per ref, near-zero tokens.
// ==============================================================================

import { splitLines } from "../line-splitter.ts";
import { checksumToLetters, FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash } from "../hash.ts";
import { parseInlineRef } from "../parse.ts";
import { binaryFileError, isBinaryError, validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface VerifyParams {
  file_path: string;
  refs: string[];
  projectDir?: string;
  allowedDirs?: string[];
}

interface RefAcc {
  rawRef: string;
  startLine: number;
  endLine: number;
  expected: string;
  hash: number;
}

export async function handleVerify(params: VerifyParams): Promise<ToolResult> {
  const { file_path, refs, projectDir, allowedDirs } = params;

  if (!refs || refs.length === 0) {
    return errorResult("No refs provided");
  }

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const accs: RefAcc[] = [];
  for (const rawRef of refs) {
    let parsed: ReturnType<typeof parseInlineRef>;
    try {
      parsed = parseInlineRef(rawRef);
    } catch (err: unknown) {
      return errorResult((err as Error).message);
    }
    accs.push({
      rawRef,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      expected: parsed.hash,
      hash: FNV_OFFSET_BASIS,
    });
  }

  accs.sort((a, b) => a.startLine - b.startLine);

  const results: string[] = [];
  let allValid = true;
  let totalLines = 0;

  try {
    let accIdx = 0;
    for await (const { lineBytes, lineNumber } of splitLines(validated.resolvedPath, { detectBinary: true })) {
      totalLines = lineNumber;

      // Skip empty-file sentinel refs
      while (accIdx < accs.length && accs[accIdx].startLine === 0) accIdx++;
      if (accIdx >= accs.length) break;

      if (lineNumber < accs[accIdx].startLine) continue;

      while (accIdx < accs.length && accs[accIdx].startLine > 0 && lineNumber > accs[accIdx].endLine) accIdx++;
      if (accIdx >= accs.length) break;
      if (accs[accIdx].startLine > 0 && lineNumber < accs[accIdx].startLine) continue;

      const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);

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

  for (const acc of accs) {
    // Empty-file sentinel
    if (acc.startLine === 0 && acc.endLine === 0) {
      if (totalLines === 0 && acc.expected === "aaaaaa") {
        results.push(`valid: ${acc.rawRef}`);
      } else {
        allValid = false;
        results.push(`stale: ${acc.rawRef} (file now has ${totalLines} lines)`);
      }
      continue;
    }

    // Range extends past EOF
    if (acc.startLine > totalLines || acc.endLine > totalLines) {
      allValid = false;
      results.push(`stale: ${acc.rawRef} (range past EOF, file has ${totalLines} lines)`);
      continue;
    }

    const actual = checksumToLetters(acc.hash);
    if (actual === acc.expected) {
      results.push(`valid: ${acc.rawRef}`);
    } else {
      allValid = false;
      results.push(`stale: ${acc.rawRef} (checksum mismatch)`);
    }
  }

  if (allValid) return textResult("all refs valid");
  return textResult(results.join("\n"));
}
