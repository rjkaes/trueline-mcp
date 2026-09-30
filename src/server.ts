import { z } from "zod";
import pkg from "../package.json";
import type { ToolResult } from "./tools/types.ts";
import { errorResult } from "./tools/types.ts";
import { handleDiff } from "./tools/diff.ts";
import { handleEdit } from "./tools/edit.ts";
import { handleReadMulti } from "./tools/read.ts";
import { handleOutline } from "./tools/outline.ts";
import { handleSearch } from "./tools/search.ts";
import { handleVerify } from "./tools/verify.ts";
import { scheduleUpdateCheck } from "./update-check.ts";
import { coerceParams, ParamError } from "./coerce.ts";
import { resolveProjectDirs } from "./allowed-dirs.js";

// =============================================================================
// JSON-RPC types
// =============================================================================

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

// =============================================================================
// Stdio transport — newline-delimited JSON-RPC
// =============================================================================

function send(msg: unknown): void {
  const json = `${JSON.stringify(msg)}\n`;
  process.stdout.write(json);
}

function respond(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params?: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

// =============================================================================
// Tool registry
// =============================================================================

// Clients derive read-only-ness solely from the wire annotation; they never infer
// it from the tool name. Claude Code in particular hard-gates any MCP tool whose
// readOnlyHint is absent while in plan mode, and that gate is evaluated before the
// permission allow-list, so no user rule can grant an unannotated read tool. The
// same hint also marks a tool concurrency-safe, letting reads run in parallel.
interface ToolAnnotations {
  readOnlyHint: boolean;
}

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
  annotations?: ToolAnnotations;
}

const tools = new Map<string, ToolDef>();

// Single-file tools: unwrap coerceParams' file_paths array back to file_path.
function coerceSingleFileParams(rawParams: Record<string, unknown>): Record<string, unknown> {
  const coerced = coerceParams(rawParams) as Record<string, unknown>;
  if (!coerced.file_path && Array.isArray(coerced.file_paths)) {
    const paths = coerced.file_paths as string[];
    if (paths.length > 1) {
      throw new ParamError(
        `This tool accepts a single file path; received ${paths.length}. Pass one path as file_path.`,
      );
    }
    coerced.file_path = paths[0];
    delete coerced.file_paths;
  }
  return coerced;
}

// =============================================================================
// Protocol constants
// =============================================================================

const VERSION = pkg.version;
const PROTOCOL_VERSION = "2024-11-05";

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// =============================================================================
// Project directory and allowed paths
// =============================================================================

const { projectDir, allowedDirs } = await resolveProjectDirs();

// =============================================================================
// Zod schemas — used only for validation inside handlers, never serialized
// =============================================================================

const readSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass an array of file paths to read, e.g. {"file_paths": ["src/main.ts"]}')
    .default([]),
  ranges: z.array(z.string()).optional(),
  encoding: z.string().optional(),
});

const editSchema = z.object({
  file_path: z.string(),
  edits: z
    .array(
      z.object({
        ref: z.string({
          required_error:
            'Missing "ref" — copy the inline ref (e.g. "ab1-cd50/efghij") from trueline_read or trueline_search output.',
        }),
        range: z.string(),
        content: z.string(),
        action: z.enum(["replace", "insert_after"]).optional(),
      }),
    )
    .min(1),
  encoding: z.string().optional(),
  dry_run: z.boolean().optional(),
  context_lines: z.number().int().min(0).optional(),
});

const changesSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(
      1,
      'file_paths is required — pass an array of file paths, e.g. {"file_paths": ["src/app.ts"]}. Use ["*"] for all changed files.',
    )
    .default([]),
  compare_against: z.string().optional(),
});

const outlineSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass an array of file paths to outline, e.g. {"file_paths": ["src/main.ts"]}')
    .default([]),
  depth: z.number().int().min(0).optional(),
});

const searchSchema = z.object({
  file_paths: z.array(z.string()).optional(),
  pattern: z.string({ required_error: "pattern is required" }),
  context_lines: z.number().int().min(0).optional(),
  max_matches: z.number().int().positive().optional(),
  max_match_lines: z.number().int().positive().optional(),
  case_insensitive: z.boolean().optional(),
  regex: z.boolean().optional(),
  multiline: z.boolean().optional(),
});

const verifySchema = z.object({
  file_path: z.string(),
  refs: z.array(z.string()),
});

// =============================================================================
// Hand-crafted JSON schemas — what the LLM sees in tools/list
//
// These are the canonical types only. No anyOf noise, no union slop.
// coerceParams in the handlers tolerates everything the LLM actually sends.
// =============================================================================

const readJsonSchema = {
  type: "object",
  properties: {
    file_paths: {
      type: "array",
      items: { type: "string" },
      description:
        'One or more files to read. Supports globs: "src/tools/*.ts". ' +
        'Append :range for specific lines: "src/foo.ts:10-25". Accepts file_path as alias. Paths must be absolute.',
    },
    ranges: {
      type: "array",
      items: { type: "string" },
      description:
        "Line ranges (single-file shorthand). Only allowed with one file_path. " +
        "For multiple files, use inline syntax on file_paths instead. " +
        'Examples: ["10-25"], ["1-50", "200-220"], ["10"] (single line), ["10-"] (to EOF). Each range gets its own ref.',
    },
    encoding: {
      type: "string",
      description: "File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.",
    },
  },
  required: ["file_paths"],
};

const editJsonSchema = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      description:
        "Absolute path to the file to edit (e.g. /Users/you/project/src/foo.ts). " +
        "Relative paths are rejected: they resolve against the session project root, not your working directory " +
        "(e.g. a git worktree), and would silently target the wrong file.",
    },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'Required. Copy the ref from trueline_read/trueline_search output (e.g. "ab1-cd50/efghij"). A ref from a wide read works for editing any sub-range within it.',
          },
          range: {
            type: "string",
            description:
              'Lines to replace in hashLine format copied from output: "ab10-cd20" (range), "ab10" (single line), "+ab10" (insert after). The 2-letter hash before each line number is required.',
          },
          content: {
            type: "string",
            description:
              "Replacement lines, newline-separated; a trailing newline is optional. " +
              'Empty string deletes the range, or inserts one blank line with action: "insert_after".',
          },
          action: {
            type: "string",
            enum: ["replace", "insert_after"],
            description:
              'What to do: "replace" (default) replaces the lines in range. "insert_after" inserts new content after the line in range (single-line range required).',
          },
        },
        required: ["ref", "range", "content"],
      },
    },
    encoding: {
      type: "string",
      description: "File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.",
    },
    dry_run: {
      type: "boolean",
      description: "Preview edits as unified diff without writing. Defaults to false.",
    },
    context_lines: {
      type: "integer",
      minimum: 0,
      description:
        "Lines of hashLine context to return around each edit site. Omitted: 2 when the call has 2 or more edits, otherwise 0. Pass 0 for none. Use when you plan to make follow-up edits to the same file.",
    },
  },
  required: ["file_path", "edits"],
};

const changesJsonSchema = {
  type: "object",
  properties: {
    file_paths: {
      type: "array",
      items: { type: "string" },
      description:
        'Paths to diff. Pass multiple files in one call. Use ["*"] for all changed files. Explicit paths must be absolute.',
    },
    compare_against: {
      type: "string",
      description: 'Git ref to compare against. Defaults to "HEAD". Use ":0" for staged content.',
    },
  },
  required: ["file_paths"],
};

const outlineJsonSchema = {
  type: "object",
  properties: {
    file_paths: {
      type: "array",
      items: { type: "string" },
      description: 'One or more file paths or globs (e.g. "src/tools/*.ts") to outline. Paths must be absolute.',
    },
    depth: {
      type: "integer",
      minimum: 0,
      description:
        "Maximum nesting depth. 0 = top-level only, 1 = include class/interface members. Omit for all levels.",
    },
  },
  required: ["file_paths"],
};

const searchJsonSchema = {
  type: "object",
  properties: {
    file_paths: {
      type: "array",
      items: { type: "string" },
      description: 'Paths or globs (e.g. "src/tools/*.ts") to search. Paths must be absolute.',
    },
    pattern: {
      type: "string",
      description: "Search string. Literal by default; set regex=true for regular expressions.",
    },
    context_lines: {
      type: "integer",
      minimum: 0,
      description: "Lines of context above/below each match. Default: 2.",
    },
    max_matches: {
      type: "integer",
      exclusiveMinimum: 0,
      description: "Maximum number of matches to return (global across all files). Default: 10.",
    },
    max_match_lines: {
      type: "integer",
      exclusiveMinimum: 0,
      description: "Maximum lines a single multiline match can span. Default: 50. Only used with multiline=true.",
    },
    case_insensitive: {
      type: "boolean",
      description: "Case-insensitive matching. Default: false.",
    },
    regex: {
      type: "boolean",
      description: "Treat pattern as a regular expression. Default: false (literal match).",
    },
    multiline: {
      type: "boolean",
      description: "Enable multiline matching. Pattern can span multiple lines. Implies regex=true. Default: false.",
    },
  },
  required: ["file_paths", "pattern"],
};

const verifyJsonSchema = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      description: "Path to the file whose refs should be verified. Must be absolute.",
    },
    refs: {
      type: "array",
      items: { type: "string" },
      description: 'Inline ref strings from a prior trueline_read/trueline_search, e.g. ["ab1-cd50/efghij"].',
    },
  },
  required: ["file_path", "refs"],
};

// =============================================================================
// Register tools
// =============================================================================

tools.set("trueline_read", {
  description:
    "Read files with per-line hashes and refs. Supports globs and :range syntax. " +
    'Example: {"file_paths": ["src/tools/*.ts", "src/foo.ts:10-25"]}.',
  inputSchema: readJsonSchema,
  handler: async (rawParams) => {
    const params = readSchema.parse(coerceParams(rawParams));
    return handleReadMulti({ ...params, projectDir, allowedDirs, requireAbsolutePath: true });
  },
  annotations: { readOnlyHint: true },
});

tools.set("trueline_edit", {
  description:
    "Apply hash-verified edits to a file. Edits go in the edits array. " +
    'Example: {file_path: "/Users/you/project/src/foo.ts", edits: [{range: "ab10-cd20", ref: "ab10-cd20/efghij", content: "new text"}]}. ' +
    "Copy the ref from trueline_read/trueline_search output. The 2-letter hash prefix on each line number is required in ranges. " +
    'Use action: "insert_after" to insert content after a line instead of replacing it. ' +
    "Set context_lines to get hashLine context around edit sites for chaining edits without re-searching.",
  inputSchema: editJsonSchema,
  handler: async (rawParams) => {
    const params = editSchema.parse(coerceSingleFileParams(rawParams));
    return handleEdit({ ...params, projectDir, allowedDirs, requireAbsolutePath: true });
  },
});

tools.set("trueline_changes", {
  description:
    "Semantic, AST-based summary of structural changes compared to a git ref. " +
    "Detects added/removed/renamed symbols, signature changes, and logic modifications. " +
    "Pass ALL files in a single call via file_paths (never call once per file). " +
    "Returns a compact structural summary, not a line-by-line diff.",
  inputSchema: changesJsonSchema,
  handler: async (rawParams) => {
    const coerced = coerceParams(rawParams) as Record<string, unknown>;
    // LLMs may send "ref" meaning git ref; alias it here (not globally,
    // since "ref" is a first-class edit field in other tools).
    if (typeof coerced.ref === "string" && !coerced.compare_against) {
      coerced.compare_against = coerced.ref;
      delete coerced.ref;
    }
    const params = changesSchema.parse(coerced);
    return handleDiff({ ...params, projectDir, allowedDirs, requireAbsolutePath: true });
  },
  annotations: { readOnlyHint: true },
});

tools.set("trueline_outline", {
  description:
    "List functions, classes, types, and key structures in the specified files (requires file_paths). " +
    "Supports code (functions/classes), markdown (headings), and XML (elements). " +
    "Much smaller than trueline_read \u2014 use first to find line ranges, then read specific sections.",
  inputSchema: outlineJsonSchema,
  handler: async (rawParams) => {
    const params = outlineSchema.parse(coerceParams(rawParams));
    return handleOutline({ ...params, projectDir, allowedDirs, requireAbsolutePath: true });
  },
  annotations: { readOnlyHint: true },
});

tools.set("trueline_search", {
  description:
    "Search files for a literal string or regex pattern. Accepts multiple file_paths in one call. " +
    "Returns matching lines with context, per-line hashes, and refs \u2014 ready for immediate editing. " +
    "Set multiline=true for patterns spanning multiple lines.",
  inputSchema: searchJsonSchema,
  handler: async (rawParams) => {
    const coerced = coerceParams(rawParams) as Record<string, unknown>;
    const params = searchSchema.parse(coerced);
    return handleSearch({ ...params, projectDir, allowedDirs, requireAbsolutePath: true });
  },
  annotations: { readOnlyHint: true },
});

tools.set("trueline_verify", {
  description:
    "Check if inline refs are still valid against the current file content. Returns valid or stale per ref. " +
    "Pass file_path and the refs[] array from a prior trueline_read/trueline_search. " +
    "Cheaper than re-reading — use before editing when the file may have changed.",
  inputSchema: verifyJsonSchema,
  handler: async (rawParams) => {
    const params = verifySchema.parse(coerceSingleFileParams(rawParams));
    return handleVerify({ ...params, projectDir, allowedDirs, requireAbsolutePath: true });
  },
  annotations: { readOnlyHint: true },
});

// =============================================================================
// MCP protocol handlers
// =============================================================================

async function handleToolsCall(id: string | number, params: Record<string, unknown>): Promise<void> {
  const name = params.name as string;
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const tool = tools.get(name);
  if (!tool) {
    // MCP: an unknown tool is a protocol error, reported as invalid params.
    respondError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    return;
  }

  // Handlers may throw; report as MCP error content rather than a protocol error.
  let result: ToolResult;
  try {
    result = await tool.handler(args);
  } catch (err: unknown) {
    // ZodError.message is a JSON dump of issues; surface the per-field messages instead.
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      );
      result = errorResult(`Invalid parameters: ${issues.join("; ")}`);
    } else if (err instanceof ParamError) {
      result = errorResult(`Invalid parameters: ${err.message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[trueline-mcp] tool error: ${message}\n`);
      result = errorResult(`Internal error: ${message}`);
    }
  }
  respond(id, result);
}

// =============================================================================
// Message dispatch
// =============================================================================

async function dispatch(msg: JsonRpcMessage): Promise<void> {
  // A JSON-RPC id is a string or number (null tolerated); echoing any other value back would put an id
  // in a reply that no conforming client can have sent.
  if (msg.id !== undefined && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") {
    respondError(null, INVALID_REQUEST, "Invalid Request: id must be a string or number");
    return;
  }
  if (typeof msg.method !== "string") {
    respondError(msg.id ?? null, INVALID_REQUEST, "Invalid Request: missing method");
    return;
  }

  // Notifications carry no id — nothing to respond to
  if (msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: { name: "trueline-mcp", version: VERSION },
      });
      break;
    case "ping":
      respond(msg.id, {});
      break;
    case "logging/setLevel":
      // `logging` is declared because the update notice goes out as notifications/message. That is
      // the only log message we send, once at startup, so the requested level is accepted, not tracked.
      respond(msg.id, {});
      break;
    case "tools/list":
      respond(msg.id, {
        tools: [...tools.entries()].map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
          ...(def.annotations ? { annotations: def.annotations } : {}),
        })),
      });
      break;
    case "tools/call":
      await handleToolsCall(msg.id, (msg.params ?? {}) as Record<string, unknown>);
      break;
    default:
      respondError(msg.id, METHOD_NOT_FOUND, `Method not supported: ${msg.method}`);
  }
}

// =============================================================================
// Stdio transport — read newline-delimited JSON from stdin
// =============================================================================

// Aborted at stdin EOF so the update check's pending registry request cannot hold the process open
// for its 3 s timeout.
const stdinClosed = new AbortController();

// Frame on "\n" alone: readline would also split on U+2028/U+2029, which JSON allows raw inside
// strings, turning one valid request into two parse errors.
function handleLine(rawLine: string): void {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    respondError(null, PARSE_ERROR, "Parse error");
    return;
  }

  // Batch arrays are not supported, but JSON-RPC still wants an error reply.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    respondError(null, INVALID_REQUEST, "Invalid Request");
    return;
  }

  const msg = parsed as JsonRpcMessage;
  dispatch(msg).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[trueline-mcp] dispatch error: ${message}\n`);
    if (msg.id !== undefined) respondError(msg.id, INVALID_PARAMS, `Internal error: ${message}`);
  });
}

let pendingInput = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (pendingInput + chunk).split("\n");
  pendingInput = lines.pop() ?? "";
  for (const line of lines) handleLine(line);
});
process.stdin.on("end", () => {
  handleLine(pendingInput);
  // No process.exit(): under Bun it does not wait for queued stdout, so large replies are cut off.
  // Requests still running keep the event loop alive, and the process leaves once they drain.
  stdinClosed.abort();
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[trueline-mcp] uncaught exception: ${err.message}\n`);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[trueline-mcp] unhandled rejection: ${message}\n`);
});

scheduleUpdateCheck(
  VERSION,
  ({ current, latest }) => {
    const message = `update available: ${current} → ${latest} (npm i -g trueline-mcp)`;
    process.stderr.write(`[trueline-mcp] ${message}\n`);
    notify("notifications/message", { level: "warning", logger: "trueline-mcp", data: message });
  },
  stdinClosed.signal,
);
