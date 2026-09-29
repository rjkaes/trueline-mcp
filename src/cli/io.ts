// Shared I/O helpers for the trueline CLI subcommands.
//
// Two concerns live here:
//   1. @file / - / literal value dispatch (including stdin)
//   2. Result formatting (human-readable vs --json envelope)

import { readFileSync } from "node:fs";
import { type ParseArgsConfig, type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { ToolResult } from "../tools/types.ts";

// ---------------------------------------------------------------------------
// Shared CLI arg definitions
// ---------------------------------------------------------------------------

export const jsonFlag = {
  type: "boolean",
  default: false,
} as const;

/** A registered `trueline <name>` subcommand: name is the dispatch key in cli.ts. */
export interface CliSubcommand {
  /** Printed for `trueline <name> --help`. */
  usage: string;
  run(argv: string[]): Promise<void>;
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
// Arg parsing
// ---------------------------------------------------------------------------

type ParsedArgs<T extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseArgs<{ options: T; allowPositionals: true }>
>;

/**
 * parseArgs with unknown options rejected. Not strict:true, because strict also rejects
 * option values that start with '-' (--content "- item") as ambiguous. Instead parse
 * loosely and check the tokens here; the checks make the loose result match strict typing.
 */
export function parseCliArgs<T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  const config: ParseArgsConfig = { args: argv, options, allowPositionals: true, strict: false, tokens: true };
  const { values, positionals, tokens = [] } = parseArgs(config);
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const option = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
    if (!option) throw new UsageError(`unknown option ${token.rawName}`);
    if (option.type === "string" && token.value === undefined) {
      throw new UsageError(`option ${token.rawName} requires a value`);
    }
    if (option.type === "boolean" && token.value !== undefined) {
      throw new UsageError(`option ${token.rawName} does not take a value`);
    }
  }
  return { values: values as unknown as ParsedArgs<T>["values"], positionals };
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
    raw = readFileSync(0, "utf-8");
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

/**
 * Write a ToolResult to the appropriate stream and set process.exitCode.
 *
 * Exit code scheme:
 *   0   success
 *   1   search: valid pattern but zero matches
 *   2   tool error (result.isError) or runtime failure
 *   3   usage / parse error (thrown as UsageError, handled in cli.ts)
 *
 * Errors (exit 2) go to stderr unless --json; everything else goes to stdout.
 */
export function emitResult(result: ToolResult, opts: FormatOptions): void {
  const text = result.content.map((c) => c.text).join("");
  let output = text;
  let exitCode = 0;
  let stream: NodeJS.WriteStream = process.stdout;

  if (opts.json) {
    output = JSON.stringify({ ok: !result.isError, result }, null, 2);
    if (result.isError) exitCode = 2;
  } else if (result.isError) {
    exitCode = 2;
    stream = process.stderr;
  } else if (opts.search && text.startsWith("No matches")) {
    // Handler returns success but text says "No matches"
    exitCode = 1;
  }

  stream.write(output.endsWith("\n") ? output : `${output}\n`);
  process.exitCode = exitCode;
}
