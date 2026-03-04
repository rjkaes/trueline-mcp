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
import { validatePath, validateEdits, type EditInput, type StreamEditOp } from "./shared.ts";
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

  const summary = editSummary(built.ops);

  if (!result.changed) {
    return textResult(`Edit produced no changes \u2014 file not written.\n\n${summary}\nchecksum: ${result.newChecksum}`);
  }

  return textResult(`Edit applied successfully. (${(performance.now() - t0).toFixed(0)}ms)\n\n${summary}\nchecksum: ${result.newChecksum}`);
}

// ==============================================================================
// Per-edit summary for operator visibility
// ==============================================================================

function editSummary(ops: StreamEditOp[]): string {
  return ops.map(op => {
    const lines = op.content.length;

    if (op.insertAfter) {
      const location = op.startLine === 0
        ? "at start of file"
        : `after line ${op.startLine}`;
      return `inserted ${lines} line${lines !== 1 ? "s" : ""} ${location}`;
    }

    const span = op.endLine - op.startLine + 1;
    const rangeStr = op.startLine === op.endLine
      ? `line ${op.startLine}`
      : `lines ${op.startLine}\u2013${op.endLine}`;

    if (lines === 0) {
      return `deleted ${rangeStr} (${span} line${span !== 1 ? "s" : ""})`;
    }

    const delta = lines - span;
    const sign = delta > 0 ? "+" : delta < 0 ? "" : "\u00b1";
    return `replaced ${rangeStr} (${span} \u2192 ${lines} line${lines !== 1 ? "s" : ""}, ${sign}${delta})`;
  }).join("\n");
}
