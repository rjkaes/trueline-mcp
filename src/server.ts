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
      'Read files. Example: {"file_paths": ["src/main.ts"], "ranges": ["10-25"]}. Returns per-line hashes and checksums for editing. Supports multiple files in one call.',
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
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
      }),
    ),
  },
  safeTool(async (params) => {
    return handleReadMulti({ ...params, projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_edit",
  {
    description:
      "Apply hash-verified edits to a file. Edits go in the edits array. " +
      'Example: {file_path: "foo.ts", edits: [{range: "ab.10-cd.20", checksum: "8-25:f7e2abcd", content: "new text"}]}. ' +
      "Copy the 2-letter hash prefix (ab, cd, ...) from trueline_read/trueline_search output.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
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
                  'Required. Checksum from trueline_read or trueline_search (e.g. "1-50:f7e2abcd"). ' +
                    "Must cover this edit's target lines.",
                ),
              range: z
                .string()
                .describe(
                  'Lines to replace in hash.line format copied from output: "ab.10-cd.20" (range), "ab.10" (single line), "+ab.10" (insert after). ' +
                    "The 2-letter hash before each line number is required.",
                ),

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
    const { file_paths, ...rest } = params;
    return handleEdit({ ...rest, file_path: file_paths[0], projectDir, allowedDirs });
  }),
);

server.registerTool(
  "trueline_changes",
  {
    description:
      "Semantic, AST-based summary of structural changes compared to a git ref. " +
      "Detects added/removed/renamed symbols, signature changes, and logic modifications. " +
      "Pass ALL files in a single call via file_paths (never call once per file). " +
      "Returns a compact structural summary, not a line-by-line diff.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
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
          .array(z.string())
          .min(
            1,
            'file_paths is required — pass an array of file paths to outline, e.g. {"file_paths": ["src/main.ts"]}',
          )
          .default([])
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
      "Search a file for a literal string or regex pattern. Returns matching lines with context, per-line hashes, and checksums \u2014 " +
      "ready for immediate editing. Use instead of outline+read when you know what to look for.",
    inputSchema: z.preprocess(
      coerceParams,
      z.object({
        file_paths: z
          .array(z.string())
          .min(1, 'file_paths is required — pass a single-element array, e.g. {"file_paths": ["src/main.ts"]}')
          .max(1)
          .default([])
          .describe("File to search (single-element array). Accepts file_path as alias."),
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
    const { file_paths, ...rest } = params;
    return handleSearch({ ...rest, file_path: file_paths[0], projectDir, allowedDirs });
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
        file_paths: z
          .array(z.string())
          .min(1, 'file_paths is required — pass a single-element array, e.g. {"file_paths": ["src/main.ts"]}')
          .max(1)
          .default([])
          .describe("File to verify (single-element array). Accepts file_path as alias."),
        checksums: z.array(z.string()).describe('Checksum strings from a prior trueline_read, e.g. ["1-50:abcdef01"].'),
      }),
    ),
  },
  safeTool(async (params) => {
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
