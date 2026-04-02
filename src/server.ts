import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
import { coerceParams } from "./coerce.ts";

// =============================================================================
// JSON-RPC types
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg;
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

function respondError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params?: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

// =============================================================================
// Tool registry
// =============================================================================

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

const tools = new Map<string, ToolDef>();

function registerTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (params: Record<string, unknown>) => Promise<ToolResult>,
): void {
  tools.set(name, { description, inputSchema, handler });
}

// Wrap handlers so they never throw — errors become MCP error content.

// coerceParams normalizes file_path → file_paths (array) for multi-file tools.
// Single-file tools (edit, search) need to unwrap back to file_path (string).
function unwrapFilePath(coerced: Record<string, unknown>): void {
  if (!coerced.file_path && Array.isArray(coerced.file_paths)) {
    coerced.file_path = (coerced.file_paths as string[])[0];
    delete coerced.file_paths;
  }
  if (Array.isArray(coerced.file_path)) {
    coerced.file_path = (coerced.file_path as string[])[0];
  }
}
function safeTool(
  handler: (params: Record<string, unknown>) => Promise<ToolResult>,
): (params: Record<string, unknown>) => Promise<ToolResult> {
  return async (params) => {
    try {
      return await handler(params);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[trueline-mcp] tool error: ${message}\n`);
      return errorResult(`Internal error: ${message}`);
    }
  };
}

// =============================================================================
// Protocol constants
// =============================================================================

const VERSION = pkg.version;
const PROTOCOL_VERSION = "2024-11-05";

// JSON-RPC error codes
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// =============================================================================
// Project directory and allowed paths
// =============================================================================

const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);

async function resolveAllowedDirs(): Promise<string[]> {
  const dirs: string[] = [];

  // ~/.claude/ — only relevant for Claude Code
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    const claudeDir = join(homedir(), ".claude");
    await mkdir(claudeDir, { recursive: true }).catch(() => {});
    const realClaudeDir = await realpath(claudeDir).catch(() => null);
    if (realClaudeDir) dirs.push(realClaudeDir);
  }

  // TRUELINE_ALLOWED_DIRS — platform-delimited additional paths
  const extra = process.env.TRUELINE_ALLOWED_DIRS;
  if (extra) {
    for (const raw of extra.split(delimiter).filter(Boolean)) {
      const resolved = await realpath(raw).catch(() => null);
      if (resolved) dirs.push(resolved);
    }
  }

  return dirs;
}

const allowedDirs = await resolveAllowedDirs();

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
          required_error: 'Missing "ref" — copy the ref ID (e.g. "R1") from trueline_read or trueline_search output.',
        }),
        range: z.string(),
        content: z.string(),
        action: z.enum(["replace", "insert_after"]).optional(),
      }),
    )
    .min(1),
  encoding: z.string().optional(),
  dry_run: z.boolean().optional(),
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
  file_path: z.string().optional(),
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
      description: "One or more files to read. Accepts file_path as alias.",
    },
    ranges: {
      type: "array",
      items: { type: "string" },
      description:
        'Line ranges to read (applied to each file). Omit to read the whole file. Examples: ["10-25"], ["1-50", "200-220"], ["10"] (single line), ["10-"] (to EOF). Each range gets its own ref.',
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
      description: "Absolute path to the file to edit.",
    },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'Required. Copy the ref ID (e.g. "R1") from trueline_read/trueline_search output. A ref from a wide read works for editing any sub-range within it.',
          },
          range: {
            type: "string",
            description:
              'Lines to replace in hash.line format copied from output: "ab.10-cd.20" (range), "ab.10" (single line), "+ab.10" (insert after). The 2-letter hash before each line number is required.',
          },
          content: {
            type: "string",
            description: "Replacement lines, newline-separated. Empty string to delete.",
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
  },
  required: ["file_path", "edits"],
};

const changesJsonSchema = {
  type: "object",
  properties: {
    file_paths: {
      type: "array",
      items: { type: "string" },
      description: 'Paths to diff. Pass multiple files in one call. Use ["*"] for all changed files.',
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
      description: "One or more absolute or project-relative file paths to outline.",
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
      description: "Absolute paths to the files to search.",
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
  required: ["pattern"],
};

const verifyJsonSchema = {
  type: "object",
  properties: {
    refs: {
      type: "array",
      items: { type: "string" },
      description: 'Ref IDs from a prior trueline_read/trueline_search, e.g. ["R1", "R2"].',
    },
  },
  required: ["refs"],
};

// =============================================================================
// Register tools
// =============================================================================

registerTool(
  "trueline_read",
  'Read files. Example: {"file_paths": ["src/main.ts"], "ranges": ["10-25"]}. Returns per-line hashes and refs for editing. Supports multiple files in one call.',
  readJsonSchema,
  safeTool(async (rawParams) => {
    const params = readSchema.parse(coerceParams(rawParams));
    return handleReadMulti({ ...params, projectDir, allowedDirs });
  }),
);

registerTool(
  "trueline_edit",
  "Apply hash-verified edits to a file. Edits go in the edits array. " +
    'Example: {file_path: "foo.ts", edits: [{range: "ab.10-cd.20", ref: "R1", content: "new text"}]}. ' +
    "Copy the ref from trueline_read/trueline_search output. The 2-letter hash prefix on each line number is required in ranges. " +
    'Use action: "insert_after" to insert content after a line instead of replacing it.',
  editJsonSchema,
  safeTool(async (rawParams) => {
    const coerced = coerceParams(rawParams) as Record<string, unknown>;
    unwrapFilePath(coerced);
    const params = editSchema.parse(coerced);
    return handleEdit({ ...params, projectDir, allowedDirs });
  }),
);

registerTool(
  "trueline_changes",
  "Semantic, AST-based summary of structural changes compared to a git ref. " +
    "Detects added/removed/renamed symbols, signature changes, and logic modifications. " +
    "Pass ALL files in a single call via file_paths (never call once per file). " +
    "Returns a compact structural summary, not a line-by-line diff.",
  changesJsonSchema,
  safeTool(async (rawParams) => {
    const coerced = coerceParams(rawParams) as Record<string, unknown>;
    // LLMs may send "ref" meaning git ref; alias it here (not globally,
    // since "ref" is a first-class edit field in other tools).
    if (typeof coerced.ref === "string" && !coerced.compare_against) {
      coerced.compare_against = coerced.ref;
      delete coerced.ref;
    }
    const params = changesSchema.parse(coerced);
    return handleDiff({ ...params, projectDir, allowedDirs });
  }),
);

registerTool(
  "trueline_outline",
  "List functions, classes, types, and key structures in the specified files (requires file_paths). " +
    "Supports code (functions/classes), markdown (headings), and XML (elements). " +
    "Much smaller than trueline_read \u2014 use first to find line ranges, then read specific sections.",
  outlineJsonSchema,
  safeTool(async (rawParams) => {
    const params = outlineSchema.parse(coerceParams(rawParams));
    return handleOutline({ ...params, projectDir, allowedDirs });
  }),
);

registerTool(
  "trueline_search",
  "Search files for a literal string or regex pattern. Accepts multiple file_paths in one call. " +
    "Returns matching lines with context, per-line hashes, and refs \u2014 ready for immediate editing. " +
    "Set multiline=true for patterns spanning multiple lines.",
  searchJsonSchema,
  safeTool(async (rawParams) => {
    const coerced = coerceParams(rawParams) as Record<string, unknown>;
    const params = searchSchema.parse(coerced);
    return handleSearch({ ...params, projectDir, allowedDirs });
  }),
);

registerTool(
  "trueline_verify",
  "Check if held refs are still valid. Returns which are valid or stale. " +
    "Cheaper than re-reading \u2014 use before editing when the file may have changed.",
  verifyJsonSchema,
  safeTool(async (rawParams) => {
    const params = verifySchema.parse(coerceParams(rawParams));
    return handleVerify({ ...params, projectDir, allowedDirs });
  }),
);

// =============================================================================
// MCP protocol handlers
// =============================================================================

function handleInitialize(id: string | number): void {
  respond(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false }, logging: {} },
    serverInfo: { name: "trueline-mcp", version: VERSION },
  });
}

function handleToolsList(id: string | number): void {
  const toolList = [...tools.entries()].map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
  respond(id, { tools: toolList });
}

async function handleToolsCall(id: string | number, params: Record<string, unknown>): Promise<void> {
  const name = params.name as string;
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const tool = tools.get(name);
  if (!tool) {
    respondError(id, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
    return;
  }

  const result = await tool.handler(args);
  respond(id, result);
}

// =============================================================================
// Message dispatch
// =============================================================================

async function dispatch(msg: JsonRpcMessage): Promise<void> {
  if (!isRequest(msg)) {
    // Notifications — nothing to respond to
    return;
  }

  switch (msg.method) {
    case "initialize":
      handleInitialize(msg.id);
      break;
    case "ping":
      respond(msg.id, {});
      break;
    case "tools/list":
      handleToolsList(msg.id);
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

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let newlineIdx = buffer.indexOf("\n"); newlineIdx !== -1; newlineIdx = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      respondError(0, INVALID_REQUEST, "Invalid JSON");
      continue;
    }

    dispatch(msg).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[trueline-mcp] dispatch error: ${message}\n`);
      if (isRequest(msg)) {
        respondError(msg.id, INVALID_PARAMS, `Internal error: ${message}`);
      }
    });
  }
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[trueline-mcp] uncaught exception: ${err.message}\n`);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[trueline-mcp] unhandled rejection: ${message}\n`);
});

scheduleUpdateCheck(VERSION, ({ current, latest }) => {
  const message = `update available: ${current} → ${latest} (npm i -g trueline-mcp)`;
  process.stderr.write(`[trueline-mcp] ${message}\n`);
  notify("notifications/message", { level: "warning", logger: "trueline-mcp", data: message });
});
