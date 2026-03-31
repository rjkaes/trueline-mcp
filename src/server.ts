import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

function safeTool<P>(handler: (params: P) => Promise<ToolResult>): (params: P) => Promise<ToolResult> {
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

/**
 * Create a lenient version of a tool schema for the MCP SDK's tools/list response.
 *
 * The MCP SDK's normalizeObjectSchema() can't see through z.preprocess() (ZodEffects),
 * so tools/list emits empty `{type: "object", properties: {}}` for all our tools.
 * This function takes the raw z.object() schema and:
 * 1. Adds .passthrough() so alias keys (file_path, path, etc.) survive SDK validation
 * 2. Makes file_paths optional (strips min/default) so validation doesn't reject
 *    requests that provide file paths via an alias — coercion happens in the handler
 */
// Fields that are arrays in the canonical schema but may arrive as JSON
// strings from some callers. Accept both so SDK validation doesn't reject
// them before coerceParams can parse the string.
const STRINGABLE_ARRAY_KEYS = new Set(["file_paths", "edits", "ranges", "checksums"]);

function laxify(schema: z.AnyZodObject): z.AnyZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    if (key === "file_paths") {
      // Accept array, string, or omitted — coerceParams normalizes later
      shape[key] = z
        .union([z.array(z.string()), z.string()])
        .optional()
        .describe(value.description ?? "");
    } else if (STRINGABLE_ARRAY_KEYS.has(key)) {
      // Accept the original type or a stringified version
      shape[key] = z.union([value, z.string()]);
    } else {
      shape[key] = value;
    }
  }
  return z.object(shape).passthrough();
}

const VERSION = pkg.version;

const server = new McpServer({
  name: "trueline-mcp",
  version: VERSION,
});

const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);

// Build the list of additional allowed directories beyond projectDir.
// ~/.claude/ is added when running under Claude Code (detected via
// CLAUDE_CODE_ENTRYPOINT) — that's where it stores plans, memory, and settings.
// TRUELINE_ALLOWED_DIRS adds arbitrary extras on any platform.
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
  // (colon on POSIX, semicolon on Windows to avoid splitting drive letters)
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

const readSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass an array of file paths to read, e.g. {"file_paths": ["src/main.ts"]}')
    .default([])
    .describe("One or more files to read. Accepts file_path as alias."),
  ranges: z
    .array(z.string())
    .describe(
      'Line ranges to read (applied to each file). Omit to read the whole file. Examples: ["10-25"], ["1-50", "200-220"], ["10"] (single line), ["10-"] (to EOF). Each range gets its own checksum.',
    )
    .optional(),
  encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
});

server.registerTool(
  "trueline_read",
  {
    description:
      'Read files. Example: {"file_paths": ["src/main.ts"], "ranges": ["10-25"]}. Returns per-line hashes and checksums for editing. Supports multiple files in one call.',
    inputSchema: laxify(readSchema),
  },
  safeTool(async (rawParams) => {
    const params = readSchema.parse(coerceParams(rawParams));
    return handleReadMulti({ ...params, projectDir, allowedDirs });
  }),
);

const editSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass a single-element array, e.g. {"file_paths": ["src/main.ts"]}')
    .max(1)
    .default([])
    .describe("File to edit (single-element array). Accepts file_path as alias."),
  edits: z
    .array(
      z.object({
        checksum: z
          .string()
          .describe(
            'Required. Copy EXACTLY from the "checksum:" line in trueline_read/trueline_search output. ' +
              "NEVER modify or construct checksums. A wide checksum (e.g. lines 1-50) works for editing any sub-range within it.",
          ),
        range: z
          .string()
          .describe(
            'Lines to replace in hash.line format copied from output: "ab.10-cd.20" (range), "ab.10" (single line), "+ab.10" (insert after). ' +
              "The 2-letter hash before each line number is required.",
          ),

        content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
        action: z
          .enum(["replace", "insert_after"])
          .describe(
            'What to do: "replace" (default) replaces the lines in range. ' +
              '"insert_after" inserts new content after the line in range (single-line range required).',
          )
          .optional(),
      }),
    )
    .min(1),
  encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
  dry_run: z.boolean().describe("Preview edits as unified diff without writing. Defaults to false.").optional(),
});

server.registerTool(
  "trueline_edit",
  {
    description:
      "Apply hash-verified edits to a file. Edits go in the edits array. " +
      'Example: {file_path: "foo.ts", edits: [{range: "ab.10-cd.20", checksum: "ab.10-cd.20:f7e2abcd", content: "new text"}]}. ' +
      "NEVER construct checksums — always copy verbatim from trueline_read/trueline_search output. " +
      'Use action: "insert_after" to insert content after a line instead of replacing it.',
    inputSchema: laxify(editSchema),
  },
  safeTool(async (rawParams) => {
    const params = editSchema.parse(coerceParams(rawParams));
    const { file_paths, ...rest } = params;
    return handleEdit({ ...rest, file_path: file_paths[0], projectDir, allowedDirs });
  }),
);

const changesSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(
      1,
      'file_paths is required — pass an array of file paths, e.g. {"file_paths": ["src/app.ts"]}. Use ["*"] for all changed files.',
    )
    .default([])
    .describe('Paths to diff. Pass multiple files in one call. Use ["*"] for all changed files.'),
  compare_against: z
    .string()
    .describe('Git ref to compare against. Defaults to "HEAD". Use ":0" for staged content.')
    .optional(),
});

server.registerTool(
  "trueline_changes",
  {
    description:
      "Semantic, AST-based summary of structural changes compared to a git ref. " +
      "Detects added/removed/renamed symbols, signature changes, and logic modifications. " +
      "Pass ALL files in a single call via file_paths (never call once per file). " +
      "Returns a compact structural summary, not a line-by-line diff.",
    inputSchema: laxify(changesSchema),
  },
  safeTool(async (rawParams) => {
    const params = changesSchema.parse(coerceParams(rawParams));
    return handleDiff({ ...params, projectDir, allowedDirs });
  }),
);

const outlineSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass an array of file paths to outline, e.g. {"file_paths": ["src/main.ts"]}')
    .default([])
    .describe("One or more absolute or project-relative file paths to outline."),
  depth: z
    .number()
    .int()
    .min(0)
    .describe("Maximum nesting depth. 0 = top-level only, 1 = include class/interface members. Omit for all levels.")
    .optional(),
});

server.registerTool(
  "trueline_outline",
  {
    description:
      "List functions, classes, types, and key structures in the specified files (requires file_paths). " +
      "Supports code (functions/classes), markdown (headings), and XML (elements). " +
      "Much smaller than trueline_read \u2014 use first to find line ranges, then read specific sections.",
    inputSchema: laxify(outlineSchema),
  },
  safeTool(async (rawParams) => {
    const params = outlineSchema.parse(coerceParams(rawParams));
    return handleOutline({ ...params, projectDir, allowedDirs });
  }),
);

const searchSchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass a single-element array, e.g. {"file_paths": ["src/main.ts"]}')
    .max(1)
    .default([])
    .describe("File to search (single-element array). Accepts file_path as alias."),
  pattern: z
    .string({ required_error: "pattern is required" })
    .describe("Search string. Literal by default; set regex=true for regular expressions."),
  context_lines: z.number().int().min(0).describe("Lines of context above/below each match. Default: 2.").optional(),
  max_matches: z.number().int().positive().describe("Maximum number of matches to return. Default: 10.").optional(),
  case_insensitive: z.boolean().describe("Case-insensitive matching. Default: false.").optional(),
  regex: z.boolean().describe("Treat pattern as a regular expression. Default: false (literal match).").optional(),
});

server.registerTool(
  "trueline_search",
  {
    description:
      "Search a file for a literal string or regex pattern. Returns matching lines with context, per-line hashes, and checksums \u2014 " +
      "ready for immediate editing. Use instead of outline+read when you know what to look for.",
    inputSchema: laxify(searchSchema),
  },
  safeTool(async (rawParams) => {
    const params = searchSchema.parse(coerceParams(rawParams));
    const { file_paths, ...rest } = params;
    return handleSearch({ ...rest, file_path: file_paths[0], projectDir, allowedDirs });
  }),
);

const verifySchema = z.object({
  file_paths: z
    .array(z.string())
    .min(1, 'file_paths is required — pass a single-element array, e.g. {"file_paths": ["src/main.ts"]}')
    .max(1)
    .default([])
    .describe("File to verify (single-element array). Accepts file_path as alias."),
  checksums: z.array(z.string()).describe('Checksum strings from a prior trueline_read, e.g. ["1-50:abcdef01"].'),
});

server.registerTool(
  "trueline_verify",
  {
    description:
      "Validate held checksums against a file. Returns which are valid or stale. " +
      "Cheaper than re-reading \u2014 use before editing when the file may have changed.",
    inputSchema: laxify(verifySchema),
  },
  safeTool(async (rawParams) => {
    const params = verifySchema.parse(coerceParams(rawParams));
    const { file_paths, ...rest } = params;
    return handleVerify({ ...rest, file_path: file_paths[0], projectDir, allowedDirs });
  }),
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  console.error("Failed to start trueline-mcp server:", err);
  process.exit(1);
}

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
  server.sendLoggingMessage({ level: "warning", logger: "trueline-mcp", data: message }).catch(() => {});
});
