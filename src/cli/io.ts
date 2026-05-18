// Shared I/O helpers for the trueline CLI subcommands.
//
// Three concerns live here:
//   1. stdin reading (sync, TTY detection)
//   2. @file / - / literal value dispatch
//   3. Result formatting (human-readable vs --json envelope)

import { readFileSync } from "node:fs";
import { parseFilePathWithRanges } from "../parse.ts";
import type { EditInput } from "../tools/shared.ts";
import type { ToolResult } from "../tools/types.ts";

// ---------------------------------------------------------------------------
// User-facing errors that map to exit code 3 (usage / parse error)
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// stdin helpers
// ---------------------------------------------------------------------------

export function isStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Read all stdin synchronously. Blocks until EOF.
 *
 * Must only be called when stdin is not a TTY; callers are responsible for
 * checking isStdinTTY() first and raising UsageError if appropriate.
 */
export function readStdinSync(): string {
  // Node/Bun: fd 0 is stdin; readFileSync on fd 0 reads until EOF.
  return readFileSync("/dev/stdin", "utf-8");
}

// ---------------------------------------------------------------------------
// @file / - / literal dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve a CLI value that may be:
 *   "@path"   — read the file at `path`
 *   "-"       — read stdin (raises UsageError if stdin is a TTY)
 *   anything else — return as-is (literal string)
 *
 * When `kind === "json"`, the resolved string is JSON.parsed before return.
 */
export function loadAtOrDashOrLiteral(value: string, kind: "json" | "text"): unknown {
  let raw: string;

  if (value.startsWith("@")) {
    const filePath = value.slice(1);
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UsageError(`cannot read ${filePath}: ${msg}`);
    }
  } else if (value === "-") {
    if (isStdinTTY()) {
      throw new UsageError("stdin is a TTY; pipe data in or use @file");
    }
    raw = readStdinSync();
  } else {
    raw = value;
  }

  if (kind === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`invalid JSON: ${raw.slice(0, 80)}`);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Edit argument parsing
// ---------------------------------------------------------------------------

/**
 * Validate and return an EditInput array from a parsed --edits value.
 *
 * Accepts an array of objects with required keys: ref, range, content.
 * Optional key: action.
 */
export function parseEditsArg(raw: unknown): EditInput[] {
  if (!Array.isArray(raw)) {
    throw new UsageError("--edits must be a JSON array");
  }
  return raw.map((item: unknown, i: number) => {
    if (typeof item !== "object" || item === null) {
      throw new UsageError(`--edits[${i}]: expected an object`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.ref !== "string") throw new UsageError(`--edits[${i}]: missing "ref"`);
    if (typeof obj.range !== "string") throw new UsageError(`--edits[${i}]: missing "range"`);
    if (typeof obj.content !== "string") throw new UsageError(`--edits[${i}]: missing "content"`);
    const action = obj.action;
    if (action !== undefined && action !== "replace" && action !== "insert_after") {
      throw new UsageError(`--edits[${i}]: action must be "replace" or "insert_after"`);
    }
    return { ref: obj.ref, range: obj.range, content: obj.content, action: action as EditInput["action"] };
  });
}

// ---------------------------------------------------------------------------
// Refs argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse the --refs argument array which supports three forms:
 *   repeatable:  --refs r1 --refs r2  (each arg is a ref string)
 *   @file:       --refs @path         (single element starting with @)
 *   stdin:       --refs -             (single element "-")
 *
 * If @file or - is mixed with other entries, raises UsageError (exit 3).
 */
export function parseRefsArg(refsArray: string[]): string[] {
  if (refsArray.length === 0) {
    throw new UsageError("--refs is required");
  }

  // Detect @file or - forms
  const hasAtFile = refsArray.some((r) => r.startsWith("@"));
  const hasDash = refsArray.some((r) => r === "-");

  if ((hasAtFile || hasDash) && refsArray.length > 1) {
    throw new UsageError("--refs @file and --refs - cannot be combined with other --refs values");
  }

  if (hasAtFile || hasDash) {
    // Load via @file or stdin, then split on newlines (one ref per line)
    const raw = loadAtOrDashOrLiteral(refsArray[0], "text") as string;
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  return refsArray;
}

// ---------------------------------------------------------------------------
// Ranges argument validation (conflict detection)
// ---------------------------------------------------------------------------

/**
 * Check for ambiguous ranges: a path like "src/foo.ts:10-20" already embeds
 * a range; combining it with --ranges is ambiguous and exits 3.
 */
export function validateRangesConflict(paths: string[], flagRanges: string[] | undefined): void {
  if (!flagRanges || flagRanges.length === 0) return;

  for (const p of paths) {
    const parsed = parseFilePathWithRanges(p);
    if (parsed.rangeSpecs && parsed.rangeSpecs.length > 0) {
      throw new UsageError(`ambiguous ranges for ${p}: use either inline ':range' or --ranges, not both`);
    }
  }
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

export interface FormatOptions {
  json: boolean;
  /** When true, exit code 1 is used for zero-match results (search command). */
  search?: boolean;
}

export interface FormatResult {
  exitCode: number;
  stdout: string;
}

/**
 * Convert a ToolResult into a formatted string and an appropriate exit code.
 *
 * Exit code scheme:
 *   0   success
 *   1   search: valid pattern but zero matches
 *   2   tool error (result.isError) or runtime failure
 *   3   usage / parse error (handled by callers, not here)
 */
export function formatResult(result: ToolResult, opts: FormatOptions): FormatResult {
  const text = result.content.map((c) => c.text).join("");

  if (opts.json) {
    const ok = !result.isError;
    const envelope = JSON.stringify({ ok, result }, null, 2);
    return { exitCode: ok ? 0 : 2, stdout: envelope };
  }

  if (result.isError) {
    return { exitCode: 2, stdout: text };
  }

  // Search zero-match: handler returns success but text says "No matches"
  if (opts.search && text.startsWith("No matches")) {
    return { exitCode: 1, stdout: text };
  }

  return { exitCode: 0, stdout: text };
}

/**
 * Write formatted output to the appropriate stream and set process.exitCode.
 *
 * Errors (exit 2) go to stderr; everything else goes to stdout.
 */
export function emitResult(result: ToolResult, opts: FormatOptions): void {
  const { exitCode, stdout } = formatResult(result, opts);
  const trailing = stdout.endsWith("\n") ? "" : "\n";

  if (exitCode === 2 && !opts.json) {
    process.stderr.write(stdout + trailing);
  } else {
    process.stdout.write(stdout + trailing);
  }
  process.exitCode = exitCode;
}

/**
 * Handle a UsageError (exit 3): print to stderr and set exitCode.
 */
export function emitUsageError(err: UsageError): void {
  process.stderr.write(`trueline: ${err.message}\n`);
  process.exitCode = 3;
}
