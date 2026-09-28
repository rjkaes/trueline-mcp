// Shared I/O helpers for the trueline CLI subcommands.
//
// Three concerns live here:
//   1. stdin reading (sync, TTY detection)
//   2. @file / - / literal value dispatch
//   3. Result formatting (human-readable vs --json envelope)

import { readFileSync } from "node:fs";
import type { ToolResult } from "../tools/types.ts";

// ---------------------------------------------------------------------------
// Shared CLI arg definitions and parseArgs value narrowing
// ---------------------------------------------------------------------------

export const jsonFlag = {
  type: "boolean",
  default: false,
} as const;

/** A registered `trueline <name>` subcommand: name is the dispatch key in cli/index.ts. */
export interface CliSubcommand {
  /** Printed for `trueline <name> --help`. */
  usage: string;
  run(argv: string[]): Promise<void>;
}

// parseArgs runs with strict:false so unrecognized flags are tolerated (matching
// the prior citty-based parser) instead of throwing. That tolerance means even a
// declared `type: "string"` option can come back typed as `boolean` (e.g. a flag
// given with no following value) — these narrow it back to what each subcommand wants.

/** Narrow a parseArgs string-option value, discarding a stray boolean. */
export function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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

/**
 * Read all stdin synchronously. Blocks until EOF.
 *
 * Must only be called when stdin is not a TTY; callers are responsible for
 * checking process.stdin.isTTY first and raising UsageError if appropriate.
 */
export function readStdinSync(): string {
  // Node/Bun: fd 0 is stdin; readFileSync on fd 0 reads until EOF.
  return readFileSync(0, "utf-8");
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
    if (process.stdin.isTTY) {
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
