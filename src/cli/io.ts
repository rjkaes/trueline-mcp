// Shared I/O helpers for the trueline CLI subcommands.
//
// Two concerns live here:
//   1. @file / - / literal value dispatch (including stdin)
//   2. Result formatting (human-readable vs --json envelope)

import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type ParseArgsConfig, type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { evaluateFilePath, readToolDenyPatterns } from "../security.js";
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

/** Thrown by parseCliArgs for a --help/-h option token; cli.ts prints the subcommand's usage. */
export class HelpRequested extends Error {}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type ParsedArgs<T extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseArgs<{ options: T; allowPositionals: true }>
>;

/** A value shaped like a long flag: taken for a mistyped flag, not content. */
const LONG_FLAG_LIKE = /^--[A-Za-z]/;

/**
 * parseArgs with unknown options rejected. Not strict:true, because strict also rejects
 * option values that start with '-' (--content "- item") as ambiguous. Instead parse
 * loosely and check the tokens here; the checks make the loose result match strict typing.
 */
export function parseCliArgs<T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  const config: ParseArgsConfig = { args: argv, options, allowPositionals: true, strict: false, tokens: true };
  const { values, positionals, tokens = [] } = parseArgs(config);
  // Only an option token asks for help: a value (--content -h) or an operand after "--" does not.
  if (tokens.some((token) => token.kind === "option" && (token.rawName === "--help" || token.rawName === "-h"))) {
    throw new HelpRequested();
  }
  // Loose parsing hands a string option the next argv entry even when it is a flag
  // (--content --dry-run), and a typo of one (--dryrun) would be written as the value.
  // Long flag-like values must use the --name=value form; short flags are matched by name.
  const shortSpellings = new Set(Object.values(options).flatMap(({ short }) => (short ? [`-${short}`] : [])));
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const option = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
    if (!option) throw new UsageError(`unknown option ${token.rawName}`);
    const swallowedFlag =
      !token.inlineValue &&
      token.value !== undefined &&
      (LONG_FLAG_LIKE.test(token.value) || shortSpellings.has(token.value));
    if (option.type === "string" && (token.value === undefined || swallowedFlag)) {
      throw new UsageError(`option ${token.rawName} requires a value`);
    }
    if (option.type === "boolean" && token.value !== undefined) {
      throw new UsageError(`option ${token.rawName} does not take a value`);
    }
  }
  return { values: values as unknown as ParsedArgs<T>["values"], positionals };
}

/**
 * Strict integer for a numeric flag. The CLI skips the zod schemas the MCP tools use, so
 * each caller passes the minimum its schema enforces (1 for positive(), otherwise 0).
 */
export function parseIntFlag(name: string, raw: string | undefined, min: 0 | 1): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new UsageError(`--${name} must be ${min === 1 ? "a positive" : "a non-negative"} integer`);
  }
  return Number(raw);
}

/**
 * Make a path argument absolute against the shell cwd. Handlers resolve relative paths
 * against projectDir, which CLAUDE_PROJECT_DIR can pin somewhere other than cwd; that
 * is the security boundary, so it stays as is and only the argument changes. Inline
 * `path:range` suffixes and glob patterns pass through resolve() untouched.
 */
export function fromCwd(arg: string): string {
  return resolve(process.cwd(), arg);
}

// ---------------------------------------------------------------------------
// @file / - / literal dispatch
// ---------------------------------------------------------------------------

// `trueline read` refuses a file a Read deny rule covers. An @path operand feeds file content into a
// diff preview or an error message, so it faces the same rules. Containment is not enforced: patches
// and edit lists commonly sit outside the project.
async function assertNotDenied(filePath: string): Promise<void> {
  const requested = resolve(process.cwd(), filePath);
  const { projectDir } = await resolveProjectDirs();
  const denyGlobs = await readToolDenyPatterns("Read", projectDir);
  const real = await realpath(requested).catch(() => requested);
  for (const candidate of new Set([real, requested])) {
    const { denied, matchedPattern } = evaluateFilePath(candidate, denyGlobs);
    if (denied) {
      throw new UsageError(`cannot read ${filePath}: Access denied: matched deny pattern "${matchedPattern}"`);
    }
  }
}

// Not readFileSync(0): under node, asking process.stdin about a TTY puts a pipe fd in non-blocking
// mode, and the synchronous read then fails with EAGAIN whenever the producer is slower than the CLI.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Resolve a CLI value that may be:
 *   "@path"   — read the file at `path`, unless a Read deny rule covers it
 *   "@@text"  — the literal "@text"; the escape for content that starts with @
 *   "-"       — read stdin (raises UsageError if stdin is a TTY)
 *   anything else — return as-is (literal string)
 *
 * A missing @path is an error, never a literal: falling back would make the
 * result depend on which files happen to exist. A leading UTF-8 BOM (added by
 * some Windows editors) is stripped from file and stdin input so it neither
 * breaks JSON.parse nor lands in the edited file.
 *
 * When `kind === "json"`, the resolved string is JSON.parsed before return.
 */
export async function loadAtOrDashOrLiteral(value: string, kind: "json" | "text"): Promise<unknown> {
  let raw: string;

  if (value.startsWith("@@")) {
    raw = value.slice(1);
  } else if (value.startsWith("@")) {
    const filePath = value.slice(1);
    await assertNotDenied(filePath);
    try {
      raw = stripBom(readFileSync(filePath, "utf-8"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UsageError(`cannot read ${filePath}: ${msg}`);
    }
  } else if (value === "-") {
    if (process.stdin.isTTY) {
      throw new UsageError("stdin is a TTY; pipe data in or use @file");
    }
    try {
      raw = stripBom(await readStdin());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UsageError(`cannot read stdin: ${msg}`);
    }
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
