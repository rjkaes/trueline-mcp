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

import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DiffCollector } from "../diff-collector.ts";
import { streamingEdit, type StreamEditOp } from "../streaming-edit.ts";
import { fnv1aHashBytes, hashToLetters } from "../hash.ts";
import { transcodedLines } from "../encoding.ts";
import {
  type EditInput,
  relativePathError,
  type ToolContext,
  validateEdits,
  validateEncoding,
  validatePath,
} from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

interface EditParams extends ToolContext {
  file_path: string;
  encoding?: string;
  edits: EditInput[];
  dry_run?: boolean;
  context_lines?: number;
}

// Two streaming edits on one file would each pass the mtime check before either renames, and the
// second rename would silently discard the first. Edits queue per canonical path instead.
const fileQueues = new Map<string, Promise<void>>();

async function runExclusive<T>(resolvedPath: string, task: () => Promise<T>): Promise<T> {
  const ahead = fileQueues.get(resolvedPath);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileQueues.set(resolvedPath, turn);
  try {
    await ahead;
    return await task();
  } finally {
    release();
    if (fileQueues.get(resolvedPath) === turn) fileQueues.delete(resolvedPath);
  }
}

export async function handleEdit(params: EditParams): Promise<ToolResult> {
  const t0 = performance.now();
  const { file_path, edits, dry_run, context_lines, projectDir, allowedDirs } = params;

  if (params.requireAbsolutePath && !isAbsolute(file_path)) {
    return relativePathError(file_path);
  }

  // A real edit also reads the file (a hash mismatch echoes its lines), so Read deny rules apply to it too.
  // dry_run is a read-only preview, same as the old trueline_changes: Read rules only.
  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;
  if (!dry_run) {
    const editable = await validatePath(file_path, "Edit", projectDir, allowedDirs);
    if (!editable.ok) return editable.error;
  }

  let enc: BufferEncoding;
  try {
    enc = validateEncoding(params.encoding);
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  const { resolvedPath } = validated;

  const built = validateEdits(edits);
  if (!built.ok) return built.error;

  const collector = new DiffCollector();
  const result = await runExclusive(resolvedPath, async () => {
    // Read under the lock: an edit queued behind another must not see that edit's rename as a foreign write.
    const { mtimeMs } = await stat(resolvedPath);
    return streamingEdit(resolvedPath, built.ops, built.checksumRefs, mtimeMs, dry_run, enc, collector);
  });
  if (!result.ok) return errorResult(result.error);

  // resolvedPath is canonical, so the base must be too: an aliased projectDir yields ../ headers.
  const relPath = isAbsolute(file_path)
    ? relative(await realpath(projectDir ?? process.cwd()), resolvedPath)
    : file_path;
  const diff = result.changed ? collector.format(`a/${relPath}`, `b/${relPath}`) : "";

  if (dry_run) return textResult(result.changed ? diff : "(no changes)");

  // Write diff to temp file for PostToolUse hook display (never enters LLM context).
  if (diff) {
    const cwdHash = createHash("sha256")
      .update(`${projectDir ?? process.cwd()}\0${file_path}`)
      .digest("hex")
      .slice(0, 12);
    const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);
    // The name is predictable and tmpdir may be shared: O_NOFOLLOW refuses a planted symlink, and
    // fchmod before truncating pins 0600 on a pre-existing file (or fails on one we do not own,
    // leaving it untouched).
    try {
      const handoff = await open(diffPath, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handoff.chmod(0o600);
        await handoff.truncate();
        await handoff.writeFile(diff, "utf-8");
      } finally {
        await handoff.close();
      }
    } catch {
      /* best-effort: the hook shows nothing */
    }
  }

  const newRef =
    result.newLineCount > 0
      ? `${result.newStartLetters}1-${result.newEndLetters}${result.newLineCount}/${result.newHash}`
      : "0-0/aaaaaa";

  const summary = editSummary(built.ops, result.textEncoding);
  const warn = built.warnings.length > 0 ? `\n\n${built.warnings.join("\n")}` : "";
  let contextBlock = "";
  const effectiveContextLines = context_lines ?? (built.ops.length >= 2 ? 2 : 0);
  if (effectiveContextLines > 0 && result.newLineCount > 0) {
    const ctx = await readEditContext(resolvedPath, built.ops, effectiveContextLines, result.textEncoding);
    if (ctx) contextBlock = `\n\n${ctx}`;
  }

  const status = result.changed ? `(${(performance.now() - t0).toFixed(0)}ms)` : "(no changes)";
  return textResult(`${status}\n${summary}\nref: ${newRef}${warn}${contextBlock}`);
}

// ==============================================================================
// Shift math: new line positions after edits are applied, in application order
// ==============================================================================

interface EditSite {
  /** First line of new content (or the line after deleted range for deletions). */
  newStart: number;
  /** Last line of new content (or newStart - 1 for deletions). */
  newEnd: number;
  /** Number of new content lines (0 for deletions). */
  lineCount: number;
}

function computeEditSites(ops: StreamEditOp[]): EditSite[] {
  const sites = new Array<EditSite>(ops.length);
  let shift = 0;
  // Shifts accumulate in file order, whatever order the caller listed the edits in.
  // On a shared line the replace comes first: an insert_after is emitted after it.
  const inFileOrder = ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) => a.op.startLine - b.op.startLine || Number(a.op.insertAfter) - Number(b.op.insertAfter));
  for (const { op, index } of inFileOrder) {
    if (op.insertAfter) {
      const newStart = op.startLine + 1 + shift;
      const newEnd = op.startLine + op.content.length + shift;
      sites[index] = { newStart, newEnd, lineCount: op.content.length };
      shift += op.content.length;
    } else {
      const span = op.endLine - op.startLine + 1;
      const newStart = op.startLine + shift;
      const newEnd = op.startLine + op.content.length - 1 + shift;
      sites[index] = { newStart, newEnd, lineCount: op.content.length };
      shift += op.content.length - span;
    }
  }
  return sites;
}

// ==============================================================================
// Per-edit summary for operator visibility
// ==============================================================================

function editSummary(ops: StreamEditOp[], textEncoding: BufferEncoding): string {
  const sites = computeEditSites(ops);
  return ops
    .map((op, i) => {
      const { newStart, newEnd, lineCount: lines } = sites[i];

      const span = op.endLine - op.startLine + 1;
      const rangeStr = op.startLine === op.endLine ? `${op.startLine}` : `${op.startLine}-${op.endLine}`;

      if (lines === 0) {
        const joined = op.deletedContent?.join("\\n");
        // Half a surrogate pair serialises as a lone JSON escape that strict consumers reject.
        const clipped = joined?.slice(0, 80).replace(/[\uD800-\uDBFF]$/, "");
        const preview = joined === undefined ? "" : `: "${joined.length > 80 ? `${clipped}…` : joined}"`;
        return `-${rangeStr} (${span})${preview}`;
      }

      const hint =
        lines === 1
          ? hl(op.content[0], newStart, textEncoding)
          : `${hl(op.content[0], newStart, textEncoding)}-${hl(op.content[lines - 1], newEnd, textEncoding)}`;

      if (op.insertAfter) {
        const location = op.startLine === 0 ? "@start" : `@${op.startLine}`;
        return `+${lines} ${location} -> ${hint}`;
      }

      return `~${rangeStr} -> ${hint} (${span}->${lines})`;
    })
    .join("\n");
}

/**
 * Format a hash.line reference for a content string at a given line number.
 * Hashes the bytes trueline_read hashes: the file's own encoding, or UTF-8 for UTF-16 files.
 */
function hl(content: string, lineNumber: number, textEncoding: BufferEncoding): string {
  return `${hashToLetters(fnv1aHashBytes(Buffer.from(content, textEncoding)))}${lineNumber}`;
}

// ==============================================================================
// Edit context: re-read edit sites from written file for chained edits
// ==============================================================================

/**
 * Re-reads the written file at each edit site and returns hash.line formatted
 * context. For large edits (new content > 2 * contextLines), the middle is
 * collapsed to show only the first/last contextLines of new content.
 */
async function readEditContext(
  resolvedPath: string,
  ops: StreamEditOp[],
  contextLines: number,
  textEncoding: BufferEncoding,
): Promise<string> {
  const sites = computeEditSites(ops);

  // Build collection ranges: [newStart - contextLines, newEnd + contextLines]
  const collectRanges = sites.map((s) => ({
    from: Math.max(1, s.newStart - contextLines),
    to: s.newEnd + contextLines, // clamped to file end naturally by iteration
  }));

  // Single pass over the file, collecting lines that fall in any range.
  const collected = new Map<number, string>();
  const maxLine = Math.max(...collectRanges.map((r) => r.to));

  const { lines } = await transcodedLines(resolvedPath, { detectBinary: false });
  for await (const { lineBytes, lineNumber } of lines) {
    if (lineNumber > maxLine) break;
    for (const range of collectRanges) {
      if (lineNumber >= range.from && lineNumber <= range.to) {
        const h = fnv1aHashBytes(lineBytes);
        const letters = hashToLetters(h);
        collected.set(lineNumber, `${letters}${lineNumber}\t${lineBytes.toString(textEncoding)}`);
        break;
      }
    }
  }

  // Format output blocks.
  const blocks: string[] = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const range = collectRanges[i];
    const collapse = site.lineCount > 2 * contextLines;

    const loc =
      site.lineCount <= 1 || site.newStart === site.newEnd
        ? `line ${site.newStart}`
        : `lines ${site.newStart}-${site.newEnd}`;
    const lines: string[] = [`context near ${loc}:`];

    const emit = (from: number, to: number) => {
      for (let ln = from; ln <= to; ln++) {
        const entry = collected.get(ln);
        if (entry) lines.push(entry);
      }
    };

    // Lines before the edit
    emit(range.from, site.newStart - 1);

    if (collapse) {
      // First contextLines of new content
      emit(site.newStart, Math.min(site.newStart + contextLines - 1, site.newEnd));
      const skipped = site.lineCount - 2 * contextLines;
      lines.push(`  \u2500\u2500 ${skipped} lines \u2500\u2500`);
      // Last contextLines of new content
      emit(site.newEnd - contextLines + 1, site.newEnd);
    } else {
      // All new content lines
      emit(site.newStart, site.newEnd);
    }

    // Lines after the edit
    const afterStart = site.lineCount > 0 ? site.newEnd + 1 : site.newStart;
    emit(afterStart, range.to);

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
