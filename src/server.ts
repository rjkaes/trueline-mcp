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

const VERSION = pkg.version;

const server = new McpServer({
  name: "trueline-mcp",
  version: VERSION,
});

const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);

// Build the list of additional allowed directories beyond projectDir.
// ~/.claude/ is always allowed — Claude Code stores plans, memory, and
// settings there.  TRUELINE_ALLOWED_DIRS adds arbitrary extras.
async function resolveAllowedDirs(): Promise<string[]> {
  const dirs: string[] = [];

  // ~/.claude/ — ensure it exists so realpath doesn't fail
  const claudeDir = join(homedir(), ".claude");
  await mkdir(claudeDir, { recursive: true }).catch(() => {});
  const realClaudeDir = await realpath(claudeDir).catch(() => null);
  if (realClaudeDir) dirs.push(realClaudeDir);

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
    description: "Read a file; returns N:hash|content per line plus a range checksum.",
    inputSchema: z.object({
      file_path: z.string(),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    }),
  },
  async (params) => {
    return handleRead({ ...params, projectDir, allowedDirs });
  },
);

server.registerTool(
  "trueline_edit",
  {
    description: "Apply hash-verified edits to a file. Pass all changes in `edits` array.",
    inputSchema: z.object({
      file_path: z.string(),
      checksum: z.string().describe("Checksum from trueline_read (e.g. 1-50:ab12cd34)"),
      edits: z
        .array(
          z.object({
            range: z.string().describe("startLine:hash..endLine:hash or startLine:hash; prefix + for insert-after"),
            content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
          }),
        )
        .min(1),
    }),
  },
  async (params) => {
    return handleEdit({ ...params, projectDir, allowedDirs });
  },
);

server.registerTool(
  "trueline_diff",
  {
    description: "Preview edits as a unified diff without writing to disk.",
    inputSchema: z.object({
      file_path: z.string(),
      checksum: z.string().describe("Checksum from trueline_read (e.g. 1-50:ab12cd34)"),
      edits: z
        .array(
          z.object({
            range: z.string().describe("startLine:hash..endLine:hash or startLine:hash; prefix + for insert-after"),
            content: z.string().describe("Replacement lines, newline-separated. Empty string to delete."),
          }),
        )
        .min(1),
    }),
  },
  async (params) => {
    return handleDiff({ ...params, projectDir, allowedDirs });
  },
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  console.error("Failed to start trueline-mcp server:", err);
  process.exit(1);
}
