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

import { type ToolResult } from "./types.ts";
import { validatePath, validateEdits, type EditInput } from "./shared.ts";
import { streamingEdit } from "../streaming-edit.ts";

interface EditParams {
  file_path: string;
  edits: EditInput[];
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleEdit(params: EditParams): Promise<ToolResult> {
  const { file_path, edits, projectDir, allowedDirs } = params;

  const validated = await validatePath(file_path, "Edit", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath, mtimeMs } = validated;

  const built = validateEdits(edits);
  if (!built.ok) return built.error;

  const result = await streamingEdit(resolvedPath, built.ops, built.checksumRefs, mtimeMs);

  if (!result.ok) {
    return {
      content: [{ type: "text", text: result.error }],
      isError: true,
    };
  }

  if (!result.changed) {
    return {
      content: [{
        type: "text",
        text: `Edit produced no changes \u2014 file not written.\n\nchecksum: ${result.newChecksum}`,
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: `Edit applied successfully.\n\nchecksum: ${result.newChecksum}`,
    }],
  };
}
