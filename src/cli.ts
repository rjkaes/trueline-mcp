// ==============================================================================
// CLI entry point — thin dispatch layer over existing tool handlers
// ==============================================================================
//
// Parses process.argv and calls the same handle* functions used by the MCP
// server, printing results to stdout/stderr. No arg-parser dependency.

import { realpath } from "node:fs/promises";
import { handleRead } from "./tools/read.ts";
import { handleEdit } from "./tools/edit.ts";
import { handleDiff } from "./tools/diff.ts";
import { handleOutline } from "./tools/outline.ts";
import { handleSearch } from "./tools/search.ts";
import { handleVerify } from "./tools/verify.ts";
import type { ToolResult } from "./tools/types.ts";

const COMMANDS = new Set(["read", "edit", "outline", "search", "diff", "verify"]);

export interface ParsedArgs {
  command: string;
  params: Record<string, unknown>;
}

// ==============================================================================
// Arg Parsing
// ==============================================================================

/**
 * Parse CLI args into a command + params object matching the handle* interfaces.
 * Exported for testing; the main() function calls this with process.argv.slice(2).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  if (!command || !COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command ?? "(none)"}. Available: ${[...COMMANDS].join(", ")}`);
  }

  switch (command) {
    case "read":
      return { command, params: parseRead(rest) };
    case "edit":
      return { command, params: parseEdit(rest) };
    case "outline":
      return { command, params: parseOutline(rest) };
    case "search":
      return { command, params: parseSearch(rest) };
    case "diff":
      return { command, params: parseDiff(rest) };
    case "verify":
      return { command, params: parseVerify(rest) };
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Consume the next arg, throwing if missing.
function requireArg(args: string[], i: number, name: string): string {
  if (i >= args.length) throw new Error(`Missing value for ${name}`);
  return args[i];
}

// Collect contiguous non-flag args starting at index i.
function collectValues(args: string[], start: number): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let i = start;
  while (i < args.length && !args[i].startsWith("--")) {
    values.push(args[i]);
    i++;
  }
  return { values, nextIndex: i };
}

function parseRead(args: string[]): Record<string, unknown> {
  if (args.length === 0 || args[0].startsWith("--")) throw new Error("read requires a file path");
  const params: Record<string, unknown> = { file_path: args[0] };
  let i = 1;
  while (i < args.length) {
    switch (args[i]) {
      case "--ranges": {
        i++;
        const { values, nextIndex } = collectValues(args, i);
        if (values.length === 0) throw new Error("--ranges requires at least one value");
        params.ranges = values;
        i = nextIndex;
        break;
      }
      case "--encoding":
        i++;
        params.encoding = requireArg(args, i, "--encoding");
        i++;
        break;
      case "--no-hashes":
        params.hashes = false;
        i++;
        break;
      default:
        throw new Error(`Unknown flag for read: ${args[i]}`);
    }
  }
  return params;
}

function parseEdit(args: string[]): Record<string, unknown> {
  if (args.length === 0 || args[0].startsWith("--")) throw new Error("edit requires a file path");
  const params: Record<string, unknown> = { file_path: args[0] };
  let i = 1;
  while (i < args.length) {
    switch (args[i]) {
      case "--edits":
        i++;
        params.edits = JSON.parse(requireArg(args, i, "--edits"));
        i++;
        break;
      case "--encoding":
        i++;
        params.encoding = requireArg(args, i, "--encoding");
        i++;
        break;
      case "--dry-run":
        params.dry_run = true;
        i++;
        break;
      default:
        throw new Error(`Unknown flag for edit: ${args[i]}`);
    }
  }
  if (!params.edits) throw new Error("edit requires --edits '<json array>'");
  return params;
}

function parseOutline(args: string[]): Record<string, unknown> {
  const file_paths: string[] = [];
  const params: Record<string, unknown> = {};
  let i = 0;

  // Collect positional file paths first
  while (i < args.length && !args[i].startsWith("--")) {
    file_paths.push(args[i]);
    i++;
  }
  if (file_paths.length === 0) throw new Error("outline requires at least one file path");
  params.file_paths = file_paths;

  while (i < args.length) {
    switch (args[i]) {
      case "--depth":
        i++;
        params.depth = Number.parseInt(requireArg(args, i, "--depth"), 10);
        i++;
        break;
      default:
        throw new Error(`Unknown flag for outline: ${args[i]}`);
    }
  }
  return params;
}

function parseSearch(args: string[]): Record<string, unknown> {
  if (args.length === 0 || args[0].startsWith("--")) throw new Error("search requires a file path");
  if (args.length < 2 || args[1].startsWith("--")) throw new Error("search requires a pattern");
  const params: Record<string, unknown> = { file_path: args[0], pattern: args[1] };
  let i = 2;
  while (i < args.length) {
    switch (args[i]) {
      case "--context":
        i++;
        params.context_lines = Number.parseInt(requireArg(args, i, "--context"), 10);
        i++;
        break;
      case "--max-matches":
        i++;
        params.max_matches = Number.parseInt(requireArg(args, i, "--max-matches"), 10);
        i++;
        break;
      case "--case-insensitive":
        params.case_insensitive = true;
        i++;
        break;
      case "--regex":
        params.regex = true;
        i++;
        break;
      default:
        throw new Error(`Unknown flag for search: ${args[i]}`);
    }
  }
  return params;
}

function parseDiff(args: string[]): Record<string, unknown> {
  const file_paths: string[] = [];
  const params: Record<string, unknown> = {};
  let i = 0;

  while (i < args.length && !args[i].startsWith("--")) {
    file_paths.push(args[i]);
    i++;
  }
  // Default to all changed files when none specified
  params.file_paths = file_paths.length > 0 ? file_paths : ["*"];

  while (i < args.length) {
    switch (args[i]) {
      case "--ref":
        i++;
        params.compare_against = requireArg(args, i, "--ref");
        i++;
        break;
      default:
        throw new Error(`Unknown flag for diff: ${args[i]}`);
    }
  }
  return params;
}

function parseVerify(args: string[]): Record<string, unknown> {
  if (args.length === 0 || args[0].startsWith("--")) throw new Error("verify requires a file path");
  const params: Record<string, unknown> = { file_path: args[0] };
  let i = 1;
  while (i < args.length) {
    switch (args[i]) {
      case "--checksums": {
        i++;
        const { values, nextIndex } = collectValues(args, i);
        if (values.length === 0) throw new Error("--checksums requires at least one value");
        params.checksums = values;
        i = nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown flag for verify: ${args[i]}`);
    }
  }
  if (!params.checksums) throw new Error("verify requires --checksums");
  return params;
}

// ==============================================================================
// Dispatch
// ==============================================================================

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

function buildHandlerMap(projectDir: string, allowedDirs: string[]): Record<string, Handler> {
  return {
    read: (p) => handleRead({ ...p, projectDir, allowedDirs } as Parameters<typeof handleRead>[0]),
    edit: (p) => handleEdit({ ...p, projectDir, allowedDirs } as Parameters<typeof handleEdit>[0]),
    diff: (p) => handleDiff({ ...p, projectDir, allowedDirs } as Parameters<typeof handleDiff>[0]),
    outline: (p) => handleOutline({ ...p, projectDir, allowedDirs } as Parameters<typeof handleOutline>[0]),
    search: (p) => handleSearch({ ...p, projectDir, allowedDirs } as Parameters<typeof handleSearch>[0]),
    verify: (p) => handleVerify({ ...p, projectDir, allowedDirs } as Parameters<typeof handleVerify>[0]),
  };
}

// ==============================================================================
// Main
// ==============================================================================

async function resolveAllowedDirs(projectDir: string): Promise<string[]> {
  const dirs = [projectDir];
  const envDirs = process.env.TRUELINE_ALLOWED_DIRS;
  if (envDirs) {
    for (const d of envDirs.split(":")) {
      const trimmed = d.trim();
      if (trimmed) dirs.push(await realpath(trimmed).catch(() => trimmed));
    }
  }
  return dirs;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
  const allowedDirs = await resolveAllowedDirs(projectDir);

  const handlers = buildHandlerMap(projectDir, allowedDirs);
  const handler = handlers[parsed.command];
  const result = await handler(parsed.params);

  if (result.isError) {
    process.stderr.write(typeof result.content === "string" ? result.content : JSON.stringify(result.content));
    process.stderr.write("\n");
    process.exitCode = 1;
  } else {
    const text =
      typeof result.content === "string"
        ? result.content
        : Array.isArray(result.content)
          ? result.content.map((c: { text?: string }) => c.text ?? "").join("")
          : JSON.stringify(result.content);
    process.stdout.write(text);
    // Add trailing newline if output doesn't end with one
    if (!text.endsWith("\n")) process.stdout.write("\n");
  }
}

// Run when executed directly
const isDirectRun = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`trueline: ${err.message}\n`);
    process.exitCode = 1;
  });
}
