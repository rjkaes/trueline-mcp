import { realpath, stat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  parseRange,
  parseChecksum,
  verifyChecksum,
  verifyHashes,
  parseContent,
  type EditOp,
  type ChecksumRef,
} from "../trueline.ts";
import { readToolDenyPatterns, evaluateFilePath } from "../security.ts";
import { type ToolResult } from "./types.ts";

// ==============================================================================
// Shared input type used by both edit and diff tools
// ==============================================================================

export interface EditInput {
  range: string;
  content: string[];
  checksum: string;
  insert_after?: boolean;
}

// ==============================================================================
// Path validation: resolution, deny check, stat
// ==============================================================================

type ValidatePathOk = { ok: true; resolvedPath: string; size: number; mtimeMs: number };
type ValidatePathErr = { ok: false; error: ToolResult };
export type ValidatePathResult = ValidatePathOk | ValidatePathErr;

/**
 * Validate and resolve a file path without reading its content.
 *
 * Performs symlink resolution, containment checks, deny-pattern evaluation,
 * regular-file and size-limit verification.  Used directly by the streaming
 * edit handler and read handler, and indirectly by diff via `prepareFile`.
 */
export async function validatePath(
  file_path: string,
  toolName: string,
  projectDir: string | undefined,
): Promise<ValidatePathResult> {
  const resolvedPath = file_path.startsWith("/")
    ? file_path
    : resolve(projectDir ?? process.cwd(), file_path);

  // Resolve symlinks and check containment to prevent path traversal (#4/#5).
  // realpath throws if the path doesn't exist — treat as file-not-found.
  let realPath: string;
  try {
    realPath = await realpath(resolvedPath);
  } catch {
    return {
      ok: false,
      error: {
        content: [{ type: "text", text: `Error reading file: "${file_path}" not found` }],
        isError: true,
      },
    };
  }

  // Reject directories, symlinks to directories, and special files (devices,
  // FIFOs, sockets). Only regular files are safe to read and write.
  const fileStat = await stat(realPath);
  if (!fileStat.isFile()) {
    return {
      ok: false,
      error: {
        content: [{ type: "text", text: `"${file_path}" is not a regular file` }],
        isError: true,
      },
    };
  }

  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  if (fileStat.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: {
        content: [{
          type: "text",
          text: `"${file_path}" is too large (${(fileStat.size / 1024 / 1024).toFixed(1)} MB). ` +
            `Maximum supported file size is 10 MB.`,
        }],
        isError: true,
      },
    };
  }

  // projectDir is already resolved at server startup. Fall back to
  // resolving cwd only when projectDir is not provided (e.g., tests).
  let realBase: string;
  try {
    realBase = projectDir ? projectDir : await realpath(process.cwd());
  } catch {
    return {
      ok: false,
      error: {
        content: [{ type: "text", text: "Project directory not found or inaccessible" }],
        isError: true,
      },
    };
  }
  if (realPath !== realBase && !realPath.startsWith(realBase + sep)) {
    return {
      ok: false,
      error: {
        content: [
          {
            type: "text",
            text: `Access denied: "${file_path}" is outside the project directory`,
          },
        ],
        isError: true,
      },
    };
  }

  // Evaluate deny patterns against the real path so symlinks can't bypass them.
  const denyGlobs = await readToolDenyPatterns(toolName, projectDir);
  const { denied, matchedPattern } = evaluateFilePath(realPath, denyGlobs);
  if (denied) {
    return {
      ok: false,
      error: {
        content: [
          {
            type: "text",
            text: `Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`,
          },
        ],
        isError: true,
      },
    };
  }

  return { ok: true, resolvedPath: realPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
}

// ==============================================================================
// File preparation: validate + read + parse (used by diff)
// ==============================================================================

type PrepareFileOk = { ok: true; resolvedPath: string; fileLines: string[]; hasCRLF: boolean; hasTrailingNewline: boolean; mtimeMs: number };
type PrepareFileErr = { ok: false; error: ToolResult };
type PrepareFileResult = PrepareFileOk | PrepareFileErr;

export async function prepareFile(
  file_path: string,
  toolName: string,
  projectDir: string | undefined,
): Promise<PrepareFileResult> {
  const validated = await validatePath(file_path, toolName, projectDir);
  if (!validated.ok) return validated;

  const { resolvedPath, mtimeMs } = validated;

  let content: string;
  try {
    content = await readFile(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        content: [{ type: "text", text: `Error reading file: ${msg}` }],
        isError: true,
      },
    };
  }

  // Reject binary files: null bytes indicate non-text content that would be
  // silently corrupted by line-oriented editing.
  if (content.includes("\0")) {
    return {
      ok: false,
      error: {
        content: [{ type: "text", text: `"${file_path}" appears to be a binary file` }],
        isError: true,
      },
    };
  }

  // Single-pass EOL detection + normalization + line splitting.  Determines
  // the dominant line ending (majority wins) while building the lines array,
  // avoiding three separate scans of the content.
  const { lines: fileLines, eol, hasTrailingNewline } = parseContent(content);
  const hasCRLF = eol === "\r\n";

  return { ok: true, resolvedPath, fileLines, hasCRLF, hasTrailingNewline, mtimeMs };
}

// ==============================================================================
// Edit op construction: checksum verification, hash verification, ref building
// ==============================================================================

type BuildOpsOk = { ok: true; ops: EditOp[] };
type BuildOpsErr = { ok: false; error: ToolResult };
type BuildOpsResult = BuildOpsOk | BuildOpsErr;

export function buildOps(
  fileLines: string[],
  edits: EditInput[],
): BuildOpsResult {
  const ops: EditOp[] = [];

  for (const edit of edits) {
    const checksumErr = verifyChecksum(fileLines, edit.checksum);

    const rangeRef = parseRange(edit.range);

    // line 0 is only valid as the anchor for insert_after (prepend to file).
    // A replace starting at line 0 makes no sense and would corrupt the file.
    if (rangeRef.start.line === 0 && !edit.insert_after) {
      return {
        ok: false,
        error: {
          content: [{ type: "text", text: "range starting at line 0 requires insert_after: true" }],
          isError: true,
        },
      };
    }

    if (checksumErr) {
      // Checksum failed, but check if the edit-target lines are still valid.
      // This gives the agent actionable guidance for recovery: re-read just
      // the target lines instead of the whole file.
      if (rangeRef.start.line > 0) {
        const hashErr = verifyHashes(fileLines, [rangeRef.start, rangeRef.end]);
        if (!hashErr) {
          const s = rangeRef.start.line;
          const e = rangeRef.end.line;
          return {
            ok: false,
            error: {
              content: [{
                type: "text",
                text:
                  `${checksumErr}\n\n` +
                  `However, lines ${s}-${e} appear unchanged. ` +
                  `Re-read with trueline_read(start_line=${s}, end_line=${e}) ` +
                  `to get a narrow checksum, then retry the edit.`,
              }],
              isError: true,
            },
          };
        }
      }
      // Edit-target lines also changed (or line-0 insert) — standard error
      return {
        ok: false,
        error: { content: [{ type: "text", text: checksumErr }], isError: true },
      };
    }

    // Only the range endpoints are explicitly hash-verified per the protocol —
    // the agent provides start/end hashes, not interior line hashes. Interior
    // lines are implicitly covered by the range checksum, which is verified above.
    const hashErr = verifyHashes(fileLines, [rangeRef.start, rangeRef.end]);
    if (hashErr) {
      return {
        ok: false,
        error: { content: [{ type: "text", text: hashErr }], isError: true },
      };
    }

    // Verify checksum range covers the edit target. Without this, an agent
    // could pass a valid checksum for lines 1-2 while editing line 50,
    // bypassing the staleness check on the target lines.
    if (rangeRef.start.line > 0) {
      const csRef = parseChecksum(edit.checksum);
      if (csRef.startLine > rangeRef.start.line || csRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: {
            content: [{
              type: "text",
              text: `Checksum range ${csRef.startLine}-${csRef.endLine} does not cover ` +
                `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
                `Re-read with trueline_read to get a checksum covering the target lines.`,
            }],
            isError: true,
          },
        };
      }
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      content: edit.content,
      insertAfter: edit.insert_after ?? false,
    });
  }

  // Validate that no two non-insertAfter ops target the same line. Overlapping
  // replace ranges would produce undefined output because the back-to-front
  // application in applyEdits assumes each line is covered by at most one op.
  const touchedLines = new Set<number>();
  for (const op of ops) {
    if (op.insertAfter) continue;
    for (let l = op.startLine; l <= op.endLine; l++) {
      if (touchedLines.has(l)) {
        return {
          ok: false,
          error: {
            content: [{ type: "text", text: `Overlapping ranges: line ${l} targeted by multiple edits` }],
            isError: true,
          },
        };
      }
      touchedLines.add(l);
    }
  }

  return { ok: true, ops };
}

// ==============================================================================
// Content-free edit validation (for streaming pipeline)
// ==============================================================================

// Extends EditOp with boundary hashes for streaming verification
export interface StreamEditOp extends EditOp {
  startHash: string;
  endHash: string;
  checksum: string;
}

type ValidateEditsOk = {
  ok: true;
  ops: StreamEditOp[];
  checksumRefs: ChecksumRef[];
};
type ValidateEditsErr = { ok: false; error: ToolResult };
export type ValidateEditsResult = ValidateEditsOk | ValidateEditsErr;

/**
 * Validate edit inputs without reading file content.
 *
 * Performs range parsing, line-0 constraints, checksum-range coverage,
 * and overlap detection. File-content verification (checksum match,
 * boundary hash match) is deferred to the streaming pass.
 */
export function validateEdits(edits: EditInput[]): ValidateEditsResult {
  const ops: StreamEditOp[] = [];
  const checksumRefs: ChecksumRef[] = [];
  const seenChecksums = new Set<string>();

  for (const edit of edits) {
    const rangeRef = parseRange(edit.range);

    // line 0 only valid for insert_after
    if (rangeRef.start.line === 0 && !edit.insert_after) {
      return {
        ok: false,
        error: {
          content: [{ type: "text", text: "range starting at line 0 requires insert_after: true" }],
          isError: true,
        },
      };
    }

    // Parse checksum (validates format)
    const csRef = parseChecksum(edit.checksum);

    // Verify checksum range covers edit target
    if (rangeRef.start.line > 0) {
      if (csRef.startLine > rangeRef.start.line || csRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: {
            content: [{
              type: "text",
              text: `Checksum range ${csRef.startLine}-${csRef.endLine} does not cover ` +
                `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
                `Re-read with trueline_read to get a checksum covering the target lines.`,
            }],
            isError: true,
          },
        };
      }
    }

    // Collect unique checksum refs for streaming verification
    if (!seenChecksums.has(edit.checksum)) {
      seenChecksums.add(edit.checksum);
      checksumRefs.push(csRef);
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      content: edit.content,
      insertAfter: edit.insert_after ?? false,
      startHash: rangeRef.start.hash,
      endHash: rangeRef.end.hash,
      checksum: edit.checksum,
    });
  }

  // Overlap detection (same logic as buildOps)
  const touchedLines = new Set<number>();
  for (const op of ops) {
    if (op.insertAfter) continue;
    for (let l = op.startLine; l <= op.endLine; l++) {
      if (touchedLines.has(l)) {
        return {
          ok: false,
          error: {
            content: [{ type: "text", text: `Overlapping ranges: line ${l} targeted by multiple edits` }],
            isError: true,
          },
        };
      }
      touchedLines.add(l);
    }
  }

  return { ok: true, ops, checksumRefs };
}
