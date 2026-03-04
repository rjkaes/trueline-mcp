// ==============================================================================
// trueline_edit handler
//
// Pipeline: validatePath → validateEdits → streamingEdit
//
// `validatePath` does security and stat checks.  `validateEdits` parses ranges
// and checksums without reading the file (structural validation).  `streamingEdit`
// streams the file byte-by-byte, verifying hashes and checksums inline, and
// writes the result to a temp file that is atomically renamed over the original.
// The file is never loaded into memory as a whole.
// ==============================================================================

import { type ToolResult, errorResult, textResult } from "./types.ts";
import { validatePath, validateEdits, type EditInput } from "./shared.ts";
import { streamingEdit } from "../streaming-edit.ts";

interface EditParams {
  file_path: string;
  checksum: string;
  edits: EditInput[];
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleEdit(params: EditParams): Promise<ToolResult> {
  const t0 = performance.now();
  const { file_path, checksum, edits, projectDir, allowedDirs } = params;

  const validated = await validatePath(file_path, "Edit", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath, mtimeMs } = validated;

  const built = validateEdits(edits, checksum);
  if (!built.ok) return built.error;

  const result = await streamingEdit(resolvedPath, built.ops, built.checksumRef, mtimeMs);

  if (!result.ok) {
    return errorResult(result.error);
  }

  if (!result.changed) {
    return textResult(`Edit produced no changes \u2014 file not written.\n\nchecksum: ${result.newChecksum}`);
  }

  return textResult(`Edit applied successfully. (${(performance.now() - t0).toFixed(0)}ms)\n\nchecksum: ${result.newChecksum}`);
}
