import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleRead } from "./tools/read.ts";
import { handleEdit } from "./tools/edit.ts";
import { handleDiff } from "./tools/diff.ts";
import pkg from "../package.json";

const VERSION = pkg.version;

const server = new McpServer({
  name: "trueline-mcp",
  version: VERSION,
});

const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);

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
    return handleRead({ ...params, projectDir });
  },
);

server.registerTool(
  "trueline_edit",
  {
    description: "Apply hash-verified edits to a file. Supports multiple edits in one call — pass all changes to the same file in the `edits` array rather than making separate calls.",
    inputSchema: z.object({
      file_path: z.string(),
      edits: z.array(
        z.object({
          range: z.string().describe("startLine:hash..endLine:hash, or just startLine:hash for a single line"),
          content: z.array(z.string()).describe("Replacement lines (one string per line, no newline characters)"),
          checksum: z.string().describe('Full checksum string from trueline_read, e.g. "1-50:ab12cd34". Must include the range prefix — do not pass just the hex hash.'),
          insert_after: z.boolean().optional(),
        }),
      ).min(1),
    }),
  },
  async (params) => {
    return handleEdit({ ...params, projectDir });
  },
);

server.registerTool(
  "trueline_diff",
  {
    description: "Preview edits as a unified diff without writing to disk. Supports multiple edits in one call — pass all changes in the `edits` array.",
    inputSchema: z.object({
      file_path: z.string(),
      edits: z.array(
        z.object({
          range: z.string().describe("startLine:hash..endLine:hash, or just startLine:hash for a single line"),
          content: z.array(z.string()).describe("Replacement lines (one string per line, no newline characters)"),
          checksum: z.string().describe('Full checksum string from trueline_read, e.g. "1-50:ab12cd34". Must include the range prefix — do not pass just the hex hash.'),
          insert_after: z.boolean().optional(),
        }),
      ).min(1),
    }),
  },
  async (params) => {
    return handleDiff({ ...params, projectDir });
  },
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  console.error("Failed to start trueline-mcp server:", err);
  process.exit(1);
}
