// ==============================================================================
// trueline_verify handler
//
// Stateless ref verifier — checks inline refs by recomputing checksums from
// the file. No ref store needed: the checksum is encoded in the ref itself.
// Returns "valid" or "stale" per ref, near-zero tokens.
// ==============================================================================

import { splitLines } from "../line-splitter.ts";
import { checksumToLetters, FNV_OFFSET_BASIS, fnv1aHashBytes, foldHash } from "../hash.ts";
import { type ChecksumRef, parseChecksum } from "../parse.ts";
import {
  binaryFileError,
  isAbsolutePathArg,
  isBinaryError,
  relativePathError,
  type ToolContext,
  validatePath,
} from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface VerifyParams extends ToolContext {
  file_path: string;
  refs: string[];
}

export async function handleVerify(params: VerifyParams): Promise<ToolResult> {
  const { file_path, refs, projectDir, allowedDirs } = params;

  if (params.requireAbsolutePath && !isAbsolutePathArg(file_path)) {
    return relativePathError(file_path);
  }

  if (!refs || refs.length === 0) {
    return errorResult("No refs provided");
  }

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  let accs: Array<ChecksumRef & { rawRef: string; acc: number }>;
  try {
    accs = refs.map((rawRef) => ({ rawRef, ...parseChecksum(rawRef), acc: FNV_OFFSET_BASIS }));
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  accs.sort((a, b) => a.startLine - b.startLine);

  const results: string[] = [];
  let allValid = true;
  let totalLines = 0;

  try {
    let accIdx = 0;
    // Skip empty-file sentinel refs (startLine 0 sorts first)
    while (accIdx < accs.length && accs[accIdx].startLine === 0) accIdx++;
    for await (const { lineBytes, lineNumber } of splitLines(validated.resolvedPath, { detectBinary: true })) {
      totalLines = lineNumber;

      if (accIdx >= accs.length) break;

      if (lineNumber < accs[accIdx].startLine) continue;

      while (accIdx < accs.length && lineNumber > accs[accIdx].endLine) accIdx++;
      if (accIdx >= accs.length) break;
      if (lineNumber < accs[accIdx].startLine) continue;

      const h = fnv1aHashBytes(lineBytes);

      for (let i = accIdx; i < accs.length && accs[i].startLine <= lineNumber; i++) {
        if (lineNumber <= accs[i].endLine) {
          accs[i].acc = foldHash(accs[i].acc, h);
        }
      }
    }
  } catch (err: unknown) {
    if (isBinaryError(err)) return binaryFileError(file_path);
    throw err;
  }

  for (const entry of accs) {
    // Empty-file sentinel
    if (entry.startLine === 0 && entry.endLine === 0) {
      if (totalLines === 0 && entry.hash === "aaaaaa") {
        results.push(`+ ${entry.rawRef}`);
      } else {
        allValid = false;
        results.push(`- ${entry.rawRef} (file now has ${totalLines} lines)`);
      }
      continue;
    }

    // Range extends past EOF
    if (entry.startLine > totalLines || entry.endLine > totalLines) {
      allValid = false;
      results.push(`- ${entry.rawRef} (range past EOF, file has ${totalLines} lines)`);
      continue;
    }

    const actual = checksumToLetters(entry.acc);
    if (actual === entry.hash) {
      results.push(`+ ${entry.rawRef}`);
    } else {
      allValid = false;
      results.push(`- ${entry.rawRef} (checksum mismatch)`);
    }
  }

  if (allValid) return textResult("all refs valid");
  return textResult(results.join("\n"));
}
