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

import { open, writeFile } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DiffCollector } from "../diff-collector.ts";
import { detectBOM } from "../encoding.ts";
import { streamingEdit } from "../streaming-edit.ts";
import { fnv1aHash, fnv1aHashBytes, hashToLetters } from "../hash.ts";
import { splitLines } from "../line-splitter.ts";
import { type EditInput, type StreamEditOp, validateEdits, validateEncoding, validatePath } from "./shared.ts";
import { errorResult, type ToolResult, textResult } from "./types.ts";

interface EditParams {
  file_path: string;
  encoding?: string;
  edits: EditInput[];
  dry_run?: boolean;
  context_lines?: number;
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleEdit(params: EditParams): Promise<ToolResult> {
  const t0 = performance.now();
  const { file_path, edits, dry_run, context_lines, projectDir, allowedDirs } = params;

  // dry_run uses Read deny patterns: it's a read-only preview, same as the old trueline_changes
  const toolName = dry_run ? "Read" : "Edit";
  const validated = await validatePath(file_path, toolName, projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  let enc: BufferEncoding;
  try {
    enc = validateEncoding(params.encoding);
  } catch (err: unknown) {
    return errorResult((err as Error).message);
  }

  const { resolvedPath, mtimeMs } = validated;

  const built = validateEdits(edits, resolvedPath);
  if (!built.ok) return built.error;

  // Detect BOM to pass encoding info through to streamingEdit for round-trip fidelity
  const fd = await open(resolvedPath, "r");
  const bomBuf = Buffer.alloc(4);
  try {
    await fd.read(bomBuf, 0, 4);
  } finally {
    await fd.close();
  }
  const bomInfo = detectBOM(bomBuf);

  if (dry_run) {
    const collector = new DiffCollector();
    const result = await streamingEdit(
      resolvedPath,
      built.ops,
      built.checksumRefs,
      mtimeMs,
      true,
      enc,
      collector,
      bomInfo,
    );

    if (!result.ok) return errorResult(result.error);
    if (!result.changed) return textResult("(no changes)");

    const relPath = file_path.startsWith("/") ? relative(projectDir ?? process.cwd(), resolvedPath) : file_path;
    const diff = collector.format(`a/${relPath}`, `b/${relPath}`);

    if (result.tmpPath) {
      try {
        await unlink(result.tmpPath);
      } catch {
        /* best-effort */
      }
    }

    return textResult(diff);
  }

  const editCollector = new DiffCollector();
  const result = await streamingEdit(
    resolvedPath,
    built.ops,
    built.checksumRefs,
    mtimeMs,
    false,
    enc,
    editCollector,
    bomInfo,
  );

  if (!result.ok) {
    return errorResult(result.error);
  }

  // Write diff to temp file for PostToolUse hook display (never enters LLM context).
  if (result.changed) {
    const relPath = file_path.startsWith("/") ? relative(projectDir ?? process.cwd(), resolvedPath) : file_path;
    const diff = editCollector.format(`a/${relPath}`, `b/${relPath}`);
    if (diff) {
      const cwdHash = createHash("sha256")
        .update(`${projectDir ?? process.cwd()}\0${file_path}`)
        .digest("hex")
        .slice(0, 12);
      const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);
      await writeFile(diffPath, diff, "utf-8").catch(() => {});
    }
  }

  const newRef =
    result.newLineCount > 0
      ? `${result.newStartLetters}.1-${result.newEndLetters}.${result.newLineCount}:${result.newHash}`
      : "0-0:aaaaaa";

  const summary = editSummary(built.ops);
  const warn = built.warnings.length > 0 ? `\n\n${built.warnings.join("\n")}` : "";
  let contextBlock = "";
  const effectiveContextLines = context_lines ?? (built.ops.length >= 2 ? 2 : 0);
  if (effectiveContextLines > 0 && result.newLineCount > 0) {
    const ctx = await readEditContext(resolvedPath, built.ops, effectiveContextLines, enc);
    if (ctx) contextBlock = `\n\n${ctx}`;
  }

  if (!result.changed) {
    return textResult(
      `Edit produced no changes — file not written.\n\n${summary}\nref: ${newRef}${warn}${contextBlock}`,
    );
  }

  return textResult(
    `Edit applied. (${(performance.now() - t0).toFixed(0)}ms)\n\n${summary}\nref: ${newRef}${warn}${contextBlock}`,
  );
}

// ==============================================================================
// Per-edit summary for operator visibility
// ==============================================================================

function editSummary(ops: StreamEditOp[]): string {
  let shift = 0;
  return ops
    .map((op) => {
      const lines = op.content.length;

      if (op.insertAfter) {
        const location = op.startLine === 0 ? "at start of file" : `after line ${op.startLine}`;
        if (lines === 0) {
          // Shouldn't reach here (validateEdits rejects empty insert_after),
          // but guard against crash in case it does.
          return `inserted 0 lines ${location}`;
        }
        const newStart = op.startLine + 1 + shift;
        const newEnd = op.startLine + lines + shift;
        const rangeHint =
          lines === 1
            ? hl(op.content[0], newStart)
            : `${hl(op.content[0], newStart)}–${hl(op.content[lines - 1], newEnd)}`;
        shift += lines;
        return `inserted ${lines} ${location} → ${rangeHint}`;
      }

      const span = op.endLine - op.startLine + 1;
      const rangeStr = op.startLine === op.endLine ? `${op.startLine}` : `${op.startLine}–${op.endLine}`;

      if (lines === 0) {
        shift -= span;
        const preview = op.deletedContent ? `: ${truncatePreview(op.deletedContent)}` : "";
        return `deleted ${rangeStr} (${span})${preview}`;
      }

      const newStart = op.startLine + shift;
      const newEnd = op.startLine + lines - 1 + shift;
      const hint =
        lines === 1
          ? hl(op.content[0], newStart)
          : `${hl(op.content[0], newStart)}–${hl(op.content[lines - 1], newEnd)}`;
      shift += lines - span;
      return `replaced ${rangeStr} → ${hint} (${span}→${lines})`;
    })
    .join("\n");
}

/** Format a hash.line reference for a content string at a given line number. */
function hl(content: string, lineNumber: number): string {
  return `${hashToLetters(fnv1aHash(content))}.${lineNumber}`;
}

/** Truncated preview of deleted content for the edit summary. */
function truncatePreview(lines: string[]): string {
  const MAX = 80;
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) result += "\\n";
    const remaining = MAX - result.length;
    if (remaining <= 0) return `"${result}\u2026"`;
    result += lines[i].length <= remaining ? lines[i] : lines[i].slice(0, remaining);
  }
  return result.length > MAX ? `"${result.slice(0, MAX)}\u2026"` : `"${result}"`;
}

// ==============================================================================
// Edit context: re-read edit sites from written file for chained edits
// ==============================================================================

interface EditSite {
  /** First line of new content (or the line after deleted range for deletions). */
  newStart: number;
  /** Last line of new content (or newStart - 1 for deletions). */
  newEnd: number;
  /** Number of new content lines (0 for deletions). */
  lineCount: number;
}

/**
 * Re-reads the written file at each edit site and returns hash.line formatted
 * context. For large edits (new content > 2 * contextLines), the middle is
 * collapsed to show only the first/last contextLines of new content.
 */
async function readEditContext(
  resolvedPath: string,
  ops: StreamEditOp[],
  contextLines: number,
  encoding: BufferEncoding,
): Promise<string> {
  // Compute new line positions for each edit site (same shift logic as editSummary).
  const sites: EditSite[] = [];
  let shift = 0;
  for (const op of ops) {
    if (op.insertAfter) {
      const newStart = op.startLine + 1 + shift;
      const newEnd = op.startLine + op.content.length + shift;
      sites.push({ newStart, newEnd, lineCount: op.content.length });
      shift += op.content.length;
    } else {
      const span = op.endLine - op.startLine + 1;
      const newStart = op.startLine + shift;
      const newEnd = op.startLine + op.content.length - 1 + shift;
      sites.push({ newStart, newEnd, lineCount: op.content.length });
      shift += op.content.length - span;
    }
  }

  // Build collection ranges: [newStart - contextLines, newEnd + contextLines]
  const collectRanges = sites.map((s) => ({
    from: Math.max(1, s.newStart - contextLines),
    to: s.newEnd + contextLines, // clamped to file end naturally by iteration
  }));

  // Single pass over the file, collecting lines that fall in any range.
  const collected = new Map<number, { letters: string; content: string }>();
  const maxLine = Math.max(...collectRanges.map((r) => r.to));

  for await (const { lineBytes, lineNumber } of splitLines(resolvedPath, { detectBinary: false })) {
    if (lineNumber > maxLine) break;
    for (const range of collectRanges) {
      if (lineNumber >= range.from && lineNumber <= range.to) {
        const h = fnv1aHashBytes(lineBytes, 0, lineBytes.length);
        const letters = hashToLetters(h);
        collected.set(lineNumber, { letters, content: lineBytes.toString(encoding) });
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

    // Lines before the edit
    for (let ln = range.from; ln < site.newStart; ln++) {
      const entry = collected.get(ln);
      if (entry) lines.push(`${entry.letters}.${ln}\t${entry.content}`);
    }

    if (collapse) {
      // First contextLines of new content
      for (let ln = site.newStart; ln < site.newStart + contextLines && ln <= site.newEnd; ln++) {
        const entry = collected.get(ln);
        if (entry) lines.push(`${entry.letters}.${ln}\t${entry.content}`);
      }
      const skipped = site.lineCount - 2 * contextLines;
      lines.push(`  \u2500\u2500 ${skipped} lines \u2500\u2500`);
      // Last contextLines of new content
      for (let ln = site.newEnd - contextLines + 1; ln <= site.newEnd; ln++) {
        const entry = collected.get(ln);
        if (entry) lines.push(`${entry.letters}.${ln}\t${entry.content}`);
      }
    } else {
      // All new content lines
      for (let ln = site.newStart; ln <= site.newEnd; ln++) {
        const entry = collected.get(ln);
        if (entry) lines.push(`${entry.letters}.${ln}\t${entry.content}`);
      }
    }

    // Lines after the edit
    const afterStart = site.lineCount > 0 ? site.newEnd + 1 : site.newStart;
    for (let ln = afterStart; ln <= range.to; ln++) {
      const entry = collected.get(ln);
      if (entry) lines.push(`${entry.letters}.${ln}\t${entry.content}`);
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
