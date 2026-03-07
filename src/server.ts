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
import { handleWrite } from "./tools/write.ts";
import { scheduleUpdateCheck } from "./update-check.ts";

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
// ~/.claude/ is added when running under Claude Code (detected via the
// CLAUDECODE env var) — that's where it stores plans, memory, and settings.
// TRUELINE_ALLOWED_DIRS adds arbitrary extras on any platform.
async function resolveAllowedDirs(): Promise<string[]> {
  const dirs: string[] = [];

  // ~/.claude/ — only relevant for Claude Code
  if (process.env.CLAUDECODE) {
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
    description: "Read a file; returns N:hash|content per line plus a checksum per range.",
    inputSchema: z.object({
      file_path: z.string(),
      ranges: z
        .preprocess(
          (val) => (typeof val === "string" ? JSON.parse(val) : val),
          z
            .array(
              z.object({
                start: z.number().int().positive().describe("First line to read (1-based).").optional(),
                end: z.number().int().positive().describe("Last line to read (1-based, inclusive).").optional(),
              }),
            )
            .describe(
              "Line ranges to read. Omit to read the whole file. Example: [{start: 10, end: 25}] or [{start: 1, end: 50}, {start: 200, end: 220}] for disjoint ranges. Each range gets its own checksum.",
            ),
        )
        .optional(),
      encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
      hashes: z
        .boolean()
        .describe(
          "Include per-line hashes in output. Defaults to true. Set to false for exploratory reads where you don't plan to edit — saves tokens. Checksums are always included.",
        )
        .optional(),
    }),
  },
  safeTool(async (params) => {
    return handleRead({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_edit",
  {
    description: "Apply hash-verified edits to a file. Each edit carries its own checksum.",
    inputSchema: z.object({
      file_path: z.string(),
      edits: z.preprocess(
        (val) => (typeof val === "string" ? JSON.parse(val) : val),
        z
          .array(
            z.object({
              checksum: z.string().describe("Checksum from trueline_read for the covering range"),
              range: z.string().describe("startLine:hash..endLine:hash or startLine:hash; prefix + for insert-after"),
              content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
            }),
          )
          .min(1),
      ),
      encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
    }),
  },
  safeTool(async (params) => {
    return handleEdit({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_diff",
  {
    description: "Preview edits as a unified diff without writing to disk. Each edit carries its own checksum.",
    inputSchema: z.object({
      file_path: z.string(),
      edits: z.preprocess(
        (val) => (typeof val === "string" ? JSON.parse(val) : val),
        z
          .array(
            z.object({
              checksum: z.string().describe("Checksum from trueline_read for the covering range"),
              range: z.string().describe("startLine:hash..endLine:hash or startLine:hash; prefix + for insert-after"),
              content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
            }),
          )
          .min(1),
      ),
      encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
    }),
  },
  safeTool(async (params) => {
    return handleDiff({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_outline",
  {
    description:
      "Get a compact structural outline of a source file (functions, classes, types, etc.) without reading the full content. " +
      "Much smaller than trueline_read — use this first to understand file structure, then read specific ranges.",
    inputSchema: z.object({
      file_path: z.string(),
    }),
  },
  safeTool(async (params) => {
    return handleOutline({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_search",
  {
    description:
      "Search a file by regex pattern. Returns matching lines with context, per-line hashes, and checksums — " +
      "ready for immediate editing. Use instead of outline+read when you know what pattern to look for.",
    inputSchema: z.object({
      file_path: z.string(),
      pattern: z.string().describe("Regex pattern to search for (line-by-line matching)."),
      context_lines: z
        .number()
        .int()
        .min(0)
        .describe("Lines of context above/below each match. Default: 2.")
        .optional(),
      max_matches: z.number().int().positive().describe("Maximum number of matches to return. Default: 10.").optional(),
    }),
  },
  safeTool(async (params) => {
    return handleSearch({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_write",
  {
    description:
      "Create or overwrite a file. Returns a checksum of the written content for verification. " +
      "To edit afterward, call trueline_read first to get per-line hashes.",
    inputSchema: z.object({
      file_path: z.string(),
      content: z.string().describe("The full file content to write."),
      create_directories: z
        .boolean()
        .describe("Create parent directories if they don't exist. Default: true.")
        .optional(),
    }),
  },
  safeTool(async (params) => {
    return handleWrite({ ...params, projectDir, allowedDirs });
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
