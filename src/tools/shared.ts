import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  parseRange,
  parseChecksum,
  type ChecksumRef,
} from "../parse.ts";
import { readToolDenyPatterns, evaluateFilePath } from "../security.ts";
import { type ToolResult, errorResult } from "./types.ts";

// ==============================================================================
// Shared input type used by both edit and diff tools
// ==============================================================================

export interface EditInput {
  range: string;
  content: string[];
}

// ==============================================================================
// Path validation: resolution, deny check, stat
// ==============================================================================

type ValidatePathOk = { ok: true; resolvedPath: string; size: number; mtimeMs: number };
type ValidatePathErr = { ok: false; error: ToolResult };
type ValidatePathResult = ValidatePathOk | ValidatePathErr;

/**
 * Validate and resolve a file path without reading its content.
 *
 * Performs symlink resolution, containment checks, deny-pattern evaluation,
 * edit handler, read handler, and diff handler.
 */
export async function validatePath(
  file_path: string,
  toolName: string,
  projectDir: string | undefined,
  allowedDirs: string[] = [],
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
    return { ok: false, error: errorResult(`Error reading file: "${file_path}" not found`) };
  }

  // Reject directories, symlinks to directories, and special files (devices,
  // FIFOs, sockets). Only regular files are safe to read and write.
  const fileStat = await stat(realPath);
  if (!fileStat.isFile()) {
    return { ok: false, error: errorResult(`"${file_path}" is not a regular file`) };
  }

  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  if (fileStat.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: errorResult(
        `"${file_path}" is too large (${(fileStat.size / 1024 / 1024).toFixed(1)} MB). ` +
        `Maximum supported file size is 10 MB.`,
      ),
    };
  }
  // Build the list of allowed base directories. projectDir (or cwd) is
  // always included; additional dirs come from the caller (e.g. ~/.claude/,
  // TRUELINE_ALLOWED_DIRS).
  let realBase: string;
  try {
    realBase = projectDir ? projectDir : await realpath(process.cwd());
  } catch {
    return { ok: false, error: errorResult("Project directory not found or inaccessible") };
  }
  const allBases = [realBase, ...allowedDirs];
  const isContained = allBases.some(
    base => realPath === base || realPath.startsWith(base + sep),
  );
  if (!isContained) {
    return { ok: false, error: errorResult(`Access denied: "${file_path}" is outside the project directory`) };
  }
  // Evaluate deny patterns against the real path so symlinks can't bypass them.
  const denyGlobs = await readToolDenyPatterns(toolName, projectDir);
  const { denied, matchedPattern } = evaluateFilePath(realPath, denyGlobs);
  if (denied) {
    return { ok: false, error: errorResult(`Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`) };
  }

  return { ok: true, resolvedPath: realPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
}


// ==============================================================================
// Content-free edit validation (for streaming pipeline)
// ==============================================================================

export interface StreamEditOp {
  startLine: number;
  endLine: number;
  content: string[];
  insertAfter: boolean;
  startHash: string;
  endHash: string;
}

type ValidateEditsOk = {
  ok: true;
  ops: StreamEditOp[];
  checksumRef: ChecksumRef;
};
type ValidateEditsErr = { ok: false; error: ToolResult };
type ValidateEditsResult = ValidateEditsOk | ValidateEditsErr;

/**
 * Validate edit inputs without reading file content.
 *
 * Performs range parsing, line-0 constraints, checksum-range coverage,
 * and overlap detection. File-content verification (checksum match,
 * boundary hash match) is deferred to the streaming pass.
 */
export function validateEdits(edits: EditInput[], checksum: string): ValidateEditsResult {
  const ops: StreamEditOp[] = [];

  // Parse the single top-level checksum once
  const checksumRef = parseChecksum(checksum);

  for (const edit of edits) {
    const rangeRef = parseRange(edit.range);

    // line 0 only valid for insert-after (encoded as + prefix in range)
    if (rangeRef.start.line === 0 && !rangeRef.insertAfter) {
      return { ok: false, error: errorResult("range starting at line 0 requires insert-after (use +0: prefix)") };
    }

    // Verify checksum range covers edit target
    if (rangeRef.start.line > 0) {
      if (checksumRef.startLine > rangeRef.start.line || checksumRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: errorResult(
            `Checksum range ${checksumRef.startLine}-${checksumRef.endLine} does not cover ` +
            `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
            `Re-read with trueline_read to get a checksum covering the target lines.`,
          ),
        };
      }
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      content: edit.content,
      insertAfter: rangeRef.insertAfter,
      startHash: rangeRef.start.hash,
      endHash: rangeRef.end.hash,
    });
  }

  // Overlap detection
  const touchedLines = new Set<number>();
  for (const op of ops) {
    if (op.insertAfter) continue;
    for (let l = op.startLine; l <= op.endLine; l++) {
      if (touchedLines.has(l)) {
        return { ok: false, error: errorResult(`Overlapping ranges: line ${l} targeted by multiple edits`) };
      }
      touchedLines.add(l);
    }
  }

  return { ok: true, ops, checksumRef };
}
