import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json";
import { handleDiff } from "./tools/diff.ts";
import { handleEdit } from "./tools/edit.ts";
import { handleRead } from "./tools/read.ts";
import { handleOutline } from "./tools/outline.ts";

const VERSION = pkg.version;

const server = new McpServer({
  name: "trueline-mcp",
  version: VERSION,
});

const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);

// Build the list of additional allowed directories beyond projectDir.
// ~/.claude/ is added when running under Claude Code (detected via
// CLAUDE_PROJECT_DIR) — that's where it stores plans, memory, and settings.
// TRUELINE_ALLOWED_DIRS adds arbitrary extras on any platform.
async function resolveAllowedDirs(): Promise<string[]> {
  const dirs: string[] = [];

  // ~/.claude/ — only relevant for Claude Code
  if (process.env.CLAUDE_PROJECT_DIR) {
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
        .array(
          z.object({
            start: z.number().int().positive().describe("First line to read (1-based).").optional(),
            end: z.number().int().positive().describe("Last line to read (1-based, inclusive).").optional(),
          }),
        )
        .describe(
          "Line ranges to read. Omit to read the whole file. Example: [{start: 10, end: 25}] or [{start: 1, end: 50}, {start: 200, end: 220}] for disjoint ranges. Each range gets its own checksum.",
        )
        .optional(),
      encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
    }),
  },
  async (params) => {
    return handleRead({ ...params, projectDir, allowedDirs });
  },
);

server.registerTool(
  "trueline_edit",
  {
    description: "Apply hash-verified edits to a file. Each edit carries its own checksum.",
    inputSchema: z.object({
      file_path: z.string(),
      edits: z
        .array(
          z.object({
            checksum: z.string().describe("Checksum from trueline_read for the covering range"),
            range: z.string().describe("startLine:hash..endLine:hash or startLine:hash; prefix + for insert-after"),
            content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
          }),
        )
        .min(1),
      encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
    }),
  },
  async (params) => {
    return handleEdit({ ...params, projectDir, allowedDirs });
  },
);

server.registerTool(
  "trueline_diff",
  {
    description: "Preview edits as a unified diff without writing to disk. Each edit carries its own checksum.",
    inputSchema: z.object({
      file_path: z.string(),
      edits: z
        .array(
          z.object({
            checksum: z.string().describe("Checksum from trueline_read for the covering range"),
            range: z.string().describe("startLine:hash..endLine:hash or startLine:hash; prefix + for insert-after"),
            content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
          }),
        )
        .min(1),
      encoding: z.string().describe("File encoding. Defaults to utf-8. Supported: utf-8, ascii, latin1.").optional(),
    }),
  },
  async (params) => {
    return handleDiff({ ...params, projectDir, allowedDirs });
  },
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
  async (params) => {
    return handleOutline({ ...params, projectDir, allowedDirs });
  },
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  console.error("Failed to start trueline-mcp server:", err);
  process.exit(1);
}
