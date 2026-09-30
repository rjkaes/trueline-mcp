import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isContained } from "../allowed-dirs.js";
import { type ChecksumRef, parseChecksum, parseFilePathWithRanges, parseRange } from "../parse.ts";
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
// Shared param fields for path resolution/validation, used across tool handlers
// ==============================================================================

export interface ToolContext {
  projectDir?: string;
  allowedDirs?: string[];
  requireAbsolutePath?: boolean;
}

// ==============================================================================
// Absolute path enforcement (MCP-only; the CLI keeps relative resolution
// since its projectDir is the real shell cwd, not a value pinned at server
// startup that can go stale when the caller is working in a git worktree)
// ==============================================================================

/**
 * Whether the path portion of a file_path/file_paths entry is absolute,
 * ignoring any inline ":range" suffix (e.g. "/abs/foo.ts:10-25" -> true,
 * "foo.ts:10-25" -> false). Globs are just paths for this check.
 */
export function isAbsolutePathArg(fp: string): boolean {
  return isAbsolute(parseFilePathWithRanges(fp).path);
}

/**
 * Actionable error for a relative file_path under requireAbsolutePath.
 * Wording matches the trueline_edit guard so agents recognize the same
 * failure mode across tools.
 */
export function relativePathError(fp: string): ToolResult {
  return errorResult(
    `file_path must be an absolute path, got "${fp}". ` +
      "Relative paths resolve against the session project root, which can differ from your working directory " +
      "(e.g. a git worktree under .claude/worktrees/), so trueline could operate on the wrong file. " +
      "Pass the absolute path.",
  );
}

/**
 * Split entries into absolute-path candidates and formatted rejections for
 * requireAbsolutePath guards. Callers supply formatRejection to reproduce
 * their existing output shape byte-for-byte.
 */
export function filterAbsolutePaths(
  entries: string[],
  requireAbsolutePath: boolean | undefined,
  formatRejection: (entry: string, errorText: string) => string,
): { candidates: string[]; rejectedSections: string[] } {
  if (!requireAbsolutePath) return { candidates: entries, rejectedSections: [] };
  const rejectedSections: string[] = [];
  const candidates = entries.filter((entry) => {
    if (isAbsolutePathArg(entry)) return true;
    const errorText = (relativePathError(entry).content[0] as { text: string }).text;
    rejectedSections.push(formatRejection(entry, errorText));
    return false;
  });
  return { candidates, rejectedSections };
}

// ==============================================================================
// Path validation: resolution, deny check, stat
// ==============================================================================

// Shared ok/error result shape for validatePath and validateEdits.
type Result<T> = ({ ok: true } & T) | { ok: false; error: ToolResult };

const failed = (msg: string) => ({ ok: false as const, error: errorResult(msg) });

// The one answer for a path outside the boundary, whatever exists there.
const outsideBoundary = (file_path: string) => failed(`Access denied: "${file_path}" is outside the project directory`);

type ValidatePathResult = Result<{ resolvedPath: string }>;

/**
 * Containment and deny-pattern gate for a resolved path. validatePath and the
 * deleted-file branch of trueline_changes both go through it, so a boundary
 * change lands in both. Reads no file content.
 *
 * `resolvedPath` is the requested absolute path (symlinks unresolved);
 * `realPath` is its canonical form, or for a file gone from disk the nearest
 * existing ancestor's realpath plus the missing tail.
 */
export async function checkPathBoundary(
  file_path: string,
  resolvedPath: string,
  realPath: string,
  toolName: string,
  projectDir: string | undefined,
  allowedDirs: string[] = [],
): Promise<Result<unknown>> {
  // Build the list of allowed base directories. projectDir (or cwd) is
  // always included; additional dirs come from the caller (e.g. ~/.claude/,
  // TRUELINE_ALLOWED_DIRS).  All bases are resolved through realpath so that
  // short 8.3 names on Windows (e.g. RUNNER~1) match the realpath of the file.
  let realBase: string;
  try {
    realBase = await realpath(projectDir ? projectDir : process.cwd());
  } catch {
    return failed("Project directory not found or inaccessible");
  }
  // Resolve allowedDirs through realpath too, so short 8.3 names and
  // inconsistent casing (Windows drive letters) match the file's realPath.
  const resolvedAllowed = await Promise.all(allowedDirs.map((d) => realpath(d).catch(() => d)));
  const allBases = [realBase, ...resolvedAllowed];
  if (!isContained(realPath, allBases)) {
    return outsideBoundary(file_path);
  }
  // Deny rules match the requested path and the file it resolves to, so a rule that names
  // a symlink (`vault/**`) applies as well as one that names its target.
  const denyGlobs = await readToolDenyPatterns(toolName, projectDir);
  for (const candidate of new Set([realPath, resolve(resolvedPath)])) {
    const { denied, matchedPattern } = evaluateFilePath(candidate, denyGlobs);
    if (denied) {
      return failed(`Access denied: "${file_path}" matched deny pattern "${matchedPattern}"`);
    }
  }
  return { ok: true };
}

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
    return failed('Wildcard "*" is only supported by trueline_changes. Pass an explicit file path.');
  }

  // Normalized even when absolute: ".." is taken lexically, as the missing-path walk below
  // does, so realpath never walks ".." through a symlink to somewhere the walk cannot see.
  const resolvedPath = resolve(projectDir ?? process.cwd(), file_path);

  // Check the boundary before reporting "not found" or "not a regular file": otherwise those
  // answers reveal what exists outside it. A missing path is placed by its nearest existing
  // ancestor's realpath, so a symlink out of the project, or a symlinked project spelling
  // (macOS /var -> /private/var), is judged by where it leads.
  let realPath = await realpath(resolvedPath).catch(() => null);
  const missing = realPath === null;
  let ancestor = resolvedPath;
  while (realPath === null) {
    // Present but unresolvable (a dangling or looping symlink): where it leads is unknown.
    const present = await lstat(ancestor).then(
      () => true,
      () => false,
    );
    if (present || dirname(ancestor) === ancestor) return outsideBoundary(file_path);
    ancestor = dirname(ancestor);
    const realAncestor = await realpath(ancestor).catch(() => null);
    if (realAncestor !== null) realPath = join(realAncestor, relative(ancestor, resolvedPath));
  }
  const boundary = await checkPathBoundary(file_path, resolvedPath, realPath, toolName, projectDir, allowedDirs);
  if (!boundary.ok) return boundary;
  if (missing) return failed(`Error reading file: "${file_path}" not found`);

  // Reject directories, symlinks to directories, and special files (devices,
  // FIFOs, sockets). Only regular files are safe to read and write.
  const fileStat = await stat(realPath);
  if (!fileStat.isFile()) {
    return failed(`"${file_path}" is not a regular file`);
  }

  // Reject files over 10 MB to avoid unbounded memory/time in downstream tools.
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (fileStat.size > MAX_FILE_SIZE) {
    return failed(`"${file_path}" exceeds the 10 MB size limit (${(fileStat.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  return { ok: true, resolvedPath: realPath };
}

// ==============================================================================
// Binary file detection helper
// ==============================================================================

/** Check whether an error from `transcodedLines` indicates a binary file. */
export function isBinaryError(err: unknown): err is Error {
  // Anchored to the splitter's and encoding's own messages: an fs error (EACCES) quotes the
  // path, and a path can contain "binary".
  return err instanceof Error && /^(File appears to be binary|UTF-32 is not supported)/.test(err.message);
}

/** Return a standard error result for binary file access. */
export function binaryFileError(filePath: string): ToolResult {
  return errorResult(`"${filePath}" appears to be a binary file`);
}

// ==============================================================================
// Content-free edit validation (for streaming pipeline)
// ==============================================================================

import type { StreamEditOp } from "../streaming-edit.ts";

type ValidateEditsResult = Result<{ ops: StreamEditOp[]; checksumRefs: ChecksumRef[]; warnings: string[] }>;

/**
 * Validate edit inputs without reading file content.
 *
 * Performs range parsing, line-0 constraints, ref-range coverage,
 * and overlap detection. File-content verification (hash match,
 * boundary hash match) is deferred to the streaming pass.
 */
export function validateEdits(edits: EditInput[]): ValidateEditsResult {
  const ops: StreamEditOp[] = [];
  const checksumRefMap = new Map<string, ChecksumRef>();
  const warnings: string[] = [];

  for (const edit of edits) {
    let checksumRef: ChecksumRef;
    try {
      checksumRef = parseChecksum(edit.ref);
    } catch (err) {
      return failed((err as Error).message);
    }
    checksumRefMap.set(edit.ref, checksumRef);
    let rangeRef: ReturnType<typeof parseRange>;
    try {
      rangeRef = parseRange(edit.range);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = ` Your ref ${edit.ref} covers lines ${checksumRef.startLine}\u2013${checksumRef.endLine}.`;
      return failed(msg + hint);
    }

    // Explicit action field takes precedence over + prefix in range.
    // This makes intent unambiguous for LLMs that forget the + prefix.
    if (edit.action === "insert_after") {
      if (rangeRef.start.line !== rangeRef.end.line) {
        return failed(
          'action "insert_after" requires a single-line range (e.g. "ab10"), not a multi-line range. To insert new lines after line 10, use range "ab10" with action "insert_after".',
        );
      }
      rangeRef.insertAfter = true;
    } else if (edit.action === "replace") {
      rangeRef.insertAfter = false;
    }
    // If action is omitted, parseRange's + prefix detection applies.

    // line 0 only valid for insert-after
    if (rangeRef.start.line === 0 && !rangeRef.insertAfter) {
      return failed('range starting at line 0 requires insert-after (use action: "insert_after" or +0 prefix)');
    }

    // Verify ref range covers edit target
    if (rangeRef.start.line > 0) {
      if (checksumRef.startLine > rangeRef.start.line || checksumRef.endLine < rangeRef.end.line) {
        return failed(
          `Ref ${edit.ref} covers lines ${checksumRef.startLine}-${checksumRef.endLine}, which does not cover ` +
            `edit range ${rangeRef.start.line}-${rangeRef.end.line}. ` +
            `Re-read with trueline_read to get a ref covering the target lines.`,
        );
      }
    }

    // trueline refuses to read, search or edit a file holding a NUL byte, so writing one
    // would leave the file out of reach of every trueline tool.
    if (edit.content.includes("\0")) {
      return failed(
        `Edit content for range ${edit.range} contains a NUL character (U+0000). ` +
          `Files with NUL bytes count as binary and could no longer be read or edited with trueline. ` +
          `Remove the NUL character and retry.`,
      );
    }

    // Detect hashLine identifiers leaked into content.  LLMs sometimes confuse
    // the addressing syntax ("zm82") shown in trueline_read output with actual
    // file content, writing it into the replacement text and corrupting the file.
    // A line that is *only* a hashLine token is almost certainly a mistake.
    // Warn rather than reject: the pattern can match legitimate content (e.g.
    // "vs20" as a version string), so we surface it as a post-edit warning.
    if (edit.content !== "") {
      const HASH_LINE_RE = /^[a-z]{2}\d+$/;
      const contentLines = edit.content.split("\n");
      const suspect = contentLines.filter((l) => HASH_LINE_RE.test(l.trim()));
      if (suspect.length > 0) {
        warnings.push(
          `WARNING: content contains what looks like hashLine identifiers from trueline_read output: ` +
            `${suspect.map((s) => `"${s.trim()}"`).join(", ")}. ` +
            `These are addressing tags, not file content. ` +
            `If this was unintentional, undo the edit and retry with only the actual text.`,
        );
      }
    }

    ops.push({
      startLine: rangeRef.start.line,
      endLine: rangeRef.end.line,
      // "" deletes, except insert_after where it means one blank line. Otherwise
      // one trailing line break is a terminator: "\n" is one blank line, not a delete.
      // CRLF and CR split lines as they do when a file is read; the write side
      // supplies the file's own EOL.
      content:
        edit.content === "" && !rangeRef.insertAfter
          ? []
          : edit.content.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/),
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
      return failed(`Overlapping ranges: line ${replaceOps[i].startLine} targeted by multiple edits`);
    }
  }

  // Reject insert-after ops whose startLine falls within a replace range.
  // An insert-after inside a replace is ambiguous: the target line will be
  // deleted by the replace, so there is no anchor to insert after.
  const insertOps = ops.filter((op) => op.insertAfter);
  for (const ia of insertOps) {
    for (const rep of replaceOps) {
      if (ia.startLine >= rep.startLine && ia.startLine < rep.endLine) {
        return failed(
          `Insert-after at line ${ia.startLine} conflicts with replace range ` +
            `${rep.startLine}\u2013${rep.endLine}. Insert after the last line of the replace instead.`,
        );
      }
    }
  }

  return { ok: true, ops, checksumRefs, warnings };
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
  const key = encoding.toLowerCase();
  const normalized = Object.hasOwn(SUPPORTED_ENCODINGS, key) ? SUPPORTED_ENCODINGS[key] : undefined;
  if (normalized === undefined) {
    throw new Error(`Unsupported encoding "${encoding}". Supported: utf-8, ascii, latin1`);
  }
  return normalized;
}

import { glob } from "node:fs/promises";
import { execFile } from "node:child_process";
import { matchesGlob, parse, relative } from "node:path";

const GLOB_CHARS = /[*?{[]/;
const RECURSIVE_GLOB = /\*\*/;

// Directories excluded when git is unavailable and a recursive glob is used.
const FALLBACK_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "vendor",
  "target",
]);

// A glob's leading literal directory and the pattern below it, split at the
// first wildcard segment: "/repo/src/*.ts" -> "/repo/src" + "*.ts". A project or
// allowed directory the pattern starts with is `literalRoot`: its name is taken
// whole, since "/work/client [staging]" is a directory, not a character class.
function splitGlob(pattern: string, literalRoot?: string): { prefix: string; remainder: string } {
  const head = literalRoot ?? parse(pattern).root;
  const segments = pattern.slice(head.length).split("/");
  const firstWildcard = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  return {
    prefix: `${head}${segments.slice(0, firstWildcard).join("/")}` || ".",
    remainder: segments.slice(firstWildcard).join("/"),
  };
}

interface GlobRoot {
  // The caller's spelling, kept for returned paths so displayPath still strips projectDir.
  label: string;
  real: string;
}

/**
 * Expand glob patterns in a file_paths array.
 *
 * Entries without glob characters pass through unchanged, as does one that
 * names an existing path, with or without an inline ":range". A pattern with
 * brackets that matches nothing is retried with them literal, so Next.js
 * "app/[id]/*.tsx" works. Globs only ever list projectDir and allowedDirs: a
 * name outside them is never returned, because validatePath denying the read
 * would not undo the listing.
 * Recursive globs (containing `**`) use `git ls-files` to respect .gitignore,
 * falling back to Node glob with common directory exclusions. Non-recursive
 * globs use Node glob directly (they don't descend into problem directories).
 */
export async function expandGlobs(
  filePaths: string[],
  projectDir: string | undefined,
  allowedDirs: string[] = [],
): Promise<string[]> {
  const baseDir = projectDir ?? process.cwd();
  const paths = new Set<string>();
  let roots: GlobRoot[] | undefined;

  function add(rawPath: string): void {
    // A backslash is a filename character on POSIX.
    paths.add(process.platform === "win32" ? rawPath.replaceAll("\\", "/") : rawPath);
  }

  // Async realpath, like validatePath: sync and async disagree on Windows 8.3 names.
  async function globRoots(): Promise<GlobRoot[]> {
    roots ??= (
      await Promise.all(
        [baseDir, ...allowedDirs].map(async (label) => ({ label, real: await realpath(label).catch(() => null) })),
      )
    ).filter((root): root is GlobRoot => root.real !== null);
    return roots;
  }

  // Node glob follows `..` inside braces and symlinked literal dirs, so vet each match.
  async function isInAllowedDir(path: string): Promise<boolean> {
    const real = await realpath(path).catch(() => null);
    const bases = (await globRoots()).map((root) => root.real);
    return real !== null && isContained(real, bases);
  }

  // Inside the boundary only: an outside name with glob characters is dropped like a missing
  // one. Passing it on would have validatePath answer "Access denied" only when it exists.
  async function existsInside(path: string): Promise<boolean> {
    const absolute = resolve(baseDir, path);
    return (await stat(absolute).catch(() => null)) !== null && (await isInAllowedDir(absolute));
  }

  for (const entry of filePaths) {
    // An existing literal path wins over glob syntax, e.g. Next.js "app/[id]/page.tsx",
    // whether or not it carries an inline ":range" (handlers split that off later).
    if (
      !GLOB_CHARS.test(entry) ||
      (await existsInside(entry)) ||
      (await existsInside(parseFilePathWithRanges(entry).path))
    ) {
      add(entry);
      continue;
    }

    const pattern = process.platform === "win32" ? entry.replaceAll("\\", "/") : entry;
    const literalRoot = [baseDir, ...allowedDirs]
      .map((dir) => (process.platform === "win32" ? dir.replaceAll("\\", "/") : dir))
      .find((dir) => pattern.startsWith(`${dir}/`));
    const { prefix, remainder } = splitGlob(pattern, literalRoot);
    // Pick the root by the canonical literal prefix, so aliases and 8.3 names still match it.
    const literalDir = await realpath(resolve(baseDir, prefix)).catch(() => null);
    const root = literalDir === null ? undefined : (await globRoots()).find((r) => isContained(literalDir, [r.real]));
    if (literalDir === null || root === undefined) continue;

    const below = relative(root.real, literalDir).replaceAll("\\", "/");
    const localPattern = below ? `${below}/${remainder}` : remainder;
    // Relative patterns keep relative results; anything else is absolute for validatePath.
    const output = (match: string) =>
      isAbsolute(pattern) || root.label !== baseDir ? resolve(root.label, match) : match;

    // Node glob also matches directories; the git branch lists files only, and so must this one.
    const isAllowedFile = async (path: string): Promise<boolean> =>
      (await isInAllowedDir(path)) && ((await stat(path).catch(() => null))?.isFile() ?? false);

    const listMatches = async (localGlob: string): Promise<string[]> => {
      const matches: string[] = [];
      if (RECURSIVE_GLOB.test(pattern)) {
        // Recursive glob: use git ls-files to respect .gitignore
        const gitFiles = await gitListFiles(root.real);
        if (gitFiles) {
          // git paths are relative to root, so matching them against localGlob cannot escape it.
          for (const f of gitFiles) {
            if (matchesGlob(f, localGlob)) matches.push(output(f));
          }
        } else {
          // Fallback: Node glob with common exclusions
          for await (const match of glob(localGlob, {
            cwd: root.real,
            exclude: (name) => FALLBACK_EXCLUDE_DIRS.has(name),
          })) {
            if (await isAllowedFile(resolve(root.real, match))) matches.push(output(match));
          }
        }
      } else {
        // Non-recursive glob: Node glob is safe (won't descend into node_modules)
        for await (const match of glob(localGlob, { cwd: root.real })) {
          if (await isAllowedFile(resolve(root.real, match))) matches.push(output(match));
        }
      }
      return matches;
    };

    let matched = await listMatches(localPattern);
    // "[id]" reads as a character class, so "app/[id]/*.tsx" finds nothing. Retry with
    // the brackets literal; "[[]" is the escape Node and Bun globs both honor, "\[" is not.
    if (matched.length === 0 && localPattern.includes("[")) {
      matched = await listMatches(localPattern.replace(/[[\]]/g, (bracket) => `[${bracket}]`));
    }
    for (const match of matched) add(match);
  }

  return [...paths].sort();
}

const execFileAsync = promisify(execFile);

// Strip inherited GIT_* env vars so git discovers the repo from cwd,
// not from a parent worktree or other inherited context.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

export async function gitExec(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

// Bytes, not a string: a UTF-16 blob does not survive UTF-8 decoding.
export async function gitExecBytes(args: string[], cwd: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: gitEnv,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout;
}

async function gitListFiles(cwd: string): Promise<string[] | null> {
  try {
    // --cached lists a tracked file deleted from the working tree; git has no flag to omit it.
    const [listed, deleted] = await Promise.all([
      gitExec(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd),
      gitExec(["ls-files", "--deleted", "-z"], cwd),
    ]);
    const gone = new Set(deleted.split("\0"));
    const files = listed.split("\0").filter((file) => file && !gone.has(file));
    // A parent repo that ignores the project directory lists nothing, which is no answer:
    // null sends the caller to the filesystem glob. A project with any listed file keeps
    // its .gitignore; one whose files are all ignored falls back too, a trade-off accepted.
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * Convert a file path to a display-friendly form for tool output headers.
 * Strips the projectDir prefix when the path is under it, so the LLM sees
 * relative paths even when absolute paths were provided as input.
 */
export function displayPath(filePath: string, projectDir: string | undefined): string {
  // A backslash is a filename character on POSIX.
  const slashes = (path: string) => (process.platform === "win32" ? path.replaceAll("\\", "/") : path);
  const normalized = slashes(filePath);
  const normalizedProjectDir = projectDir === undefined ? undefined : slashes(projectDir);
  if (normalizedProjectDir && normalized.startsWith(`${normalizedProjectDir}/`)) {
    return normalized.slice(normalizedProjectDir.length + 1);
  }
  return normalized;
}
