import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { type ChecksumRef, parseRange } from "../parse.ts";
import { refToChecksumRef, resolveRef } from "../ref-store.ts";
import { evaluateFilePath, readToolDenyPatterns } from "../security.js";
import { errorResult, type ToolResult } from "./types.ts";

// ==============================================================================
// Shared input type used by both edit and diff tools
// ==============================================================================

export interface EditInput {
  ref: string;
  range: string;
  content: string;
  action?: "replace" | "insert_after";
}

// ==============================================================================
// Path validation: resolution, deny check, stat
// ==============================================================================

type ValidatePathOk = {
  ok: true;
  resolvedPath: string;
  size: number;
  mtimeMs: number;
};
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
  // Reject wildcard — only trueline_changes supports "*" via its own handler.
  if (file_path === "*") {
    return {
      ok: false,
      error: errorResult('Wildcard "*" is only supported by trueline_changes. Pass an explicit file path.'),
    };
  }

  const resolvedPath = file_path.startsWith("/") ? file_path : resolve(projectDir ?? process.cwd(), file_path);

  // Resolve symlinks and check containment to prevent path traversal (#4/#5).
  // realpath throws if the path doesn't exist — treat as file-not-found.
  let realPath: string;
  try {
    realPath = await realpath(resolvedPath);
  } catch {
    return {
      ok: false,
      error: errorResult(`Error reading file: "${file_path}" not found`),
    };
  }

  // Reject directories, symlinks to directories, and special files (devices,
  // FIFOs, sockets). Only regular files are safe to read and write.
  const fileStat = await stat(realPath);
  if (!fileStat.isFile()) {
    return {
      ok: false,
      error: errorResult(`"${file_path}" is not a regular file`),
    };
  }
  // Build the list of allowed base directories. projectDir (or cwd) is
  // always included; additional dirs come from the caller (e.g. ~/.claude/,
  // TRUELINE_ALLOWED_DIRS).  All bases are resolved through realpath so that
  // short 8.3 names on Windows (e.g. RUNNER~1) match the realpath of the file.
  let realBase: string;
  try {
    realBase = await realpath(projectDir ? projectDir : process.cwd());
  } catch {
    return {
      ok: false,
      error: errorResult("Project directory not found or inaccessible"),
    };
  }
  // Resolve allowedDirs through realpath too, so short 8.3 names and
  // inconsistent casing (Windows drive letters) match the file's realPath.
  const resolvedAllowed = await Promise.all(
    allowedDirs.map(async (d) => {
      try {
        return await realpath(d);
      } catch {
        return d;
      }
    }),
  );
  const allBases = [realBase, ...resolvedAllowed];
  const isContained =
    process.platform === "win32"
      ? allBases.some((base) => {
          const rp = realPath.toLowerCase();
          const bp = base.toLowerCase();
          return rp === bp || rp.startsWith(bp + sep);
        })
      : allBases.some((base) => realPath === base || realPath.startsWith(base + sep));
  if (!isContained) {
    return {
      ok: false,
      error: errorResult(`Access denied: "${file_path}" is outside the project directory`),
    };
  }
  // Evaluate deny patterns against the real path so symlinks can't bypass them.
  const denyGlobs = await readToolDenyPatterns(toolName, projectDir);
  const { denied, matchedPattern } = evaluateFilePath(realPath, denyGlobs);
  if (denied) {
    return {
      ok: false,
      error: errorResult(`Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`),
    };
  }

  // Reject files over 10 MB to avoid unbounded memory/time in downstream tools.
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (fileStat.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: errorResult(
        `"${file_path}" exceeds the 10 MB size limit (${(fileStat.size / 1024 / 1024).toFixed(1)} MB)`,
      ),
    };
  }

  return {
    ok: true,
    resolvedPath: realPath,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };
}

// ==============================================================================
// Binary file detection helper
// ==============================================================================

/** Check whether an error from `splitLines` indicates a binary file. */
export function isBinaryError(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("binary");
}

/** Return a standard error result for binary file access. */
export function binaryFileError(filePath: string): ToolResult {
  return errorResult(`"${filePath}" appears to be a binary file`);
}

// ==============================================================================
// Content-free edit validation (for streaming pipeline)
// ==============================================================================

import type { StreamEditOp } from "../streaming-edit.ts";

// Re-exported for convenience since validateEdits produces StreamEditOps.
export type { StreamEditOp } from "../streaming-edit.ts";

type ValidateEditsOk = {
  ok: true;
  ops: StreamEditOp[];
  checksumRefs: ChecksumRef[];
};
type ValidateEditsErr = { ok: false; error: ToolResult };
type ValidateEditsResult = ValidateEditsOk | ValidateEditsErr;

/**
 * Validate edit inputs without reading file content.
 *
 * Performs range parsing, line-0 constraints, ref-range coverage,
 * and overlap detection. File-content verification (hash match,
 * boundary hash match) is deferred to the streaming pass.
 */
export function validateEdits(edits: EditInput[], resolvedPath?: string): ValidateEditsResult {
  const ops: StreamEditOp[] = [];
  const checksumRefMap = new Map<string, ChecksumRef>();

  for (const edit of edits) {
    let refEntry: ReturnType<typeof resolveRef>;
    try {
      refEntry = resolveRef(edit.ref);
    } catch (err) {
      return { ok: false, error: errorResult((err as Error).message) };
    }
    const checksumRef = refToChecksumRef(refEntry);
    checksumRefMap.set(edit.ref, checksumRef);

    // Cross-file check: ensure the ref was issued for the file being edited.
    // Without this, an LLM could accidentally use a ref from file A to edit file B.
    if (resolvedPath && refEntry.filePath !== resolvedPath) {
      return {
        ok: false,
        error: errorResult(
          `Ref ${edit.ref} was issued for a different file (${refEntry.filePath}), ` +
            `not the file being edited (${resolvedPath}). ` +
            `Use a ref from trueline_read or trueline_search on the target file.`,
        ),
      };
    }

    let rangeRef: ReturnType<typeof parseRange>;
    try {
      rangeRef = parseRange(edit.range);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = ` Your ref ${edit.ref} covers lines ${checksumRef.startLine}\u2013${checksumRef.endLine}.`;
      throw new Error(msg + hint);
    }

    // Explicit action field takes precedence over + prefix in range.
    // This makes intent unambiguous for LLMs that forget the + prefix.
    if (edit.action === "insert_after") {
      if (rangeRef.start.line !== rangeRef.end.line) {
        return {
          ok: false,
          error: errorResult('action "insert_after" requires a single-line range, not a multi-line range'),
        };
      }
      rangeRef.insertAfter = true;
    } else if (edit.action === "replace") {
      rangeRef.insertAfter = false;
    }
    // If action is omitted, parseRange's + prefix detection applies.

    // line 0 only valid for insert-after
    if (rangeRef.start.line === 0 && !rangeRef.insertAfter) {
      return {
        ok: false,
        error: errorResult('range starting at line 0 requires insert-after (use action: "insert_after" or +0 prefix)'),
      };
    }

    // Verify ref range covers edit target
    if (rangeRef.start.line > 0) {
      if (checksumRef.startLine > rangeRef.start.line || checksumRef.endLine < rangeRef.end.line) {
        return {
          ok: false,
          error: errorResult(
            `Ref ${edit.ref} covers lines ${checksumRef.startLine}-${checksumRef.endLine}, which does not cover ` +
              `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
              `Re-read with trueline_read to get a ref covering the target lines.`,
          ),
        };
      }
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      content: edit.content === "" ? [] : edit.content.split("\n"),
      insertAfter: rangeRef.insertAfter,
      startHash: rangeRef.start.hash,
      endHash: rangeRef.end.hash,
    });
  }

  const checksumRefs = [...checksumRefMap.values()];
  checksumRefs.sort((a, b) => a.startLine - b.startLine);

  // Overlap detection: sort by startLine, then scan for overlapping ranges.
  // O(m log m) where m = number of replace ops (insert-after ops are excluded
  // since they don't consume source lines).
  const replaceOps = ops.filter((op) => !op.insertAfter);
  replaceOps.sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < replaceOps.length; i++) {
    if (replaceOps[i].startLine <= replaceOps[i - 1].endLine) {
      return {
        ok: false,
        error: errorResult(`Overlapping ranges: line ${replaceOps[i].startLine} targeted by multiple edits`),
      };
    }
  }

  // Reject insert-after ops whose startLine falls within a replace range.
  // An insert-after inside a replace is ambiguous: the target line will be
  // deleted by the replace, so there is no anchor to insert after.
  const insertOps = ops.filter((op) => op.insertAfter);
  for (const ia of insertOps) {
    for (const rep of replaceOps) {
      if (ia.startLine >= rep.startLine && ia.startLine < rep.endLine) {
        return {
          ok: false,
          error: errorResult(
            `Insert-after at line ${ia.startLine} conflicts with replace range ` +
              `${rep.startLine}\u2013${rep.endLine}. Insert after the last line of the replace instead.`,
          ),
        };
      }
    }
  }

  return { ok: true, ops, checksumRefs };
}

// ==============================================================================
// Encoding validation
// ==============================================================================

const SUPPORTED_ENCODINGS: Record<string, BufferEncoding> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  ascii: "ascii",
  latin1: "latin1",
};

/**
 * Validate and normalize an encoding string.
 *
 * Returns a canonical `BufferEncoding` value. Defaults to `"utf-8"` when
 * the input is undefined. Throws on unsupported encodings.
 */
export function validateEncoding(encoding?: string): BufferEncoding {
  if (encoding === undefined) return "utf-8";
  const normalized = SUPPORTED_ENCODINGS[encoding.toLowerCase()];
  if (normalized === undefined) {
    throw new Error(`Unsupported encoding "${encoding}". Supported: utf-8, ascii, latin1`);
  }
  return normalized;
}
