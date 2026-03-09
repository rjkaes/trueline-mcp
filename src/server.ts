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
import { handleRead } from "./tools/read.ts";
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

server.registerTool(
  "trueline_read",
  {
    description:
      'Read a file. Requires file_path. Example: {"file_path": "src/main.ts", "ranges": ["10-25"]}. Returns line content with checksums for editing.',
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_path: z
          .string({ required_error: "file_path is required" })
          .describe("Absolute or project-relative file path."),
        ranges: z
          .array(z.string())
          .describe(
            'Line ranges to read. Omit to read the whole file. Examples: ["10-25"], ["1-50", "200-220"], ["10"] (single line), ["10-"] (to EOF). Each range gets its own checksum.',
          )
          .optional(),
        encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
      }),
    ),
  },
  safeTool(async (params) => {
    return handleRead({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_edit",
  {
    description: "Apply hash-verified edits to a file. Each edit carries its own checksum.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_path: z
          .string({ required_error: "file_path is required" })
          .describe("Absolute or project-relative file path."),
        edits: z
          .array(
            z.object({
              checksum: z
                .string()
                .describe(
                  "Checksum from trueline_read or trueline_search whose line range covers this edit's target lines",
                ),
              range: z.string().describe("startLine-endLine or startLine; prefix + for insert-after"),

              content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
            }),
          )
          .min(1),
        encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
        dry_run: z.boolean().describe("Preview edits as unified diff without writing. Defaults to false.").optional(),
      }),
    ),
  },
  safeTool(async (params) => {
    return handleEdit({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_diff",
  {
    description:
      "Semantic, AST-based summary of structural changes compared to a git ref. " +
      "Detects added/removed/renamed symbols, signature changes, and logic modifications. " +
      "Pass ALL files in a single call via file_paths (never call once per file). " +
      "Use instead of `git diff` to review changes with minimal token usage.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_paths: z
          .array(z.string({ required_error: "file_paths is required" }))
          .min(1)
          .describe('Paths to diff. Pass multiple files in one call. Use ["*"] for all changed files.'),
        compare_against: z
          .string()
          .describe('Git ref to compare against. Defaults to "HEAD". Use ":0" for staged content.')
          .optional(),
      }),
    ),
  },
  safeTool(async (params) => {
    return handleDiff({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_outline",
  {
    description:
      "Get a compact structural outline of source files (functions, classes, types, etc.) without reading the full content. " +
      "Much smaller than trueline_read \u2014 use first to find line ranges, then read specific sections.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_paths: z
          .array(z.string({ required_error: "file_paths is required" }))
          .describe("One or more absolute or project-relative file paths to outline."),
        depth: z
          .number()
          .int()
          .min(0)
          .describe(
            "Maximum nesting depth. 0 = top-level only, 1 = include class/interface members. Omit for all levels.",
          )
          .optional(),
      }),
    ),
  },
  safeTool(async (params) => {
    return handleOutline({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_search",
  {
    description:
      "Search a file for a literal string or regex pattern. Returns matching lines with context and checksums \u2014 " +
      "ready for immediate editing. Use instead of outline+read when you know what to look for.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_path: z
          .string({ required_error: "file_path is required" })
          .describe("Absolute or project-relative file path."),
        pattern: z
          .string({ required_error: "pattern is required" })
          .describe("Search string. Literal by default; set regex=true for regular expressions."),
        context_lines: z
          .number()
          .int()
          .min(0)
          .describe("Lines of context above/below each match. Default: 2.")
          .optional(),
        max_matches: z
          .number()
          .int()
          .positive()
          .describe("Maximum number of matches to return. Default: 10.")
          .optional(),
        case_insensitive: z.boolean().describe("Case-insensitive matching. Default: false.").optional(),
        regex: z
          .boolean()
          .describe("Treat pattern as a regular expression. Default: false (literal match).")
          .optional(),
      }),
    ),
  },
  safeTool(async (params) => {
    return handleSearch({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_verify",
  {
    description:
      "Validate held checksums against a file. Returns which are valid or stale. " +
      "Cheaper than re-reading \u2014 use before editing when the file may have changed.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_path: z
          .string({ required_error: "file_path is required" })
          .describe("Absolute or project-relative file path."),
        checksums: z.array(z.string()).describe('Checksum strings from a prior trueline_read, e.g. ["1-50:abcdef01"].'),
      }),
    ),
  },
  safeTool(async (params) => {
    return handleVerify({ ...params, projectDir, allowedDirs });
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
