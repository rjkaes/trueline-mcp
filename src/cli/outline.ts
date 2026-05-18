import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../allowed-dirs.ts";
import { handleOutline } from "../tools/outline.ts";
import { emitResult, UsageError, emitUsageError } from "./io.ts";

export default defineCommand({
  meta: {
    name: "outline",
    description: "Structural outline of files via tree-sitter (functions, classes, types)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output JSON envelope {ok, result}",
      default: false,
    },
    depth: {
      type: "string",
      description: "Max nesting depth (0 = top-level only)",
    },
  },
  run: async ({ args }) => {
    // citty exposes un-named positionals in args._
    const paths = args._ as string[];
    if (paths.length === 0) {
      emitUsageError(new UsageError("outline requires at least one file path"));
      return;
    }

    const depthVal = args.depth !== undefined ? Number.parseInt(args.depth, 10) : undefined;
    if (depthVal !== undefined && Number.isNaN(depthVal)) {
      emitUsageError(new UsageError("--depth must be a number"));
      return;
    }

    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
    const allowedDirs = await resolveAllowedDirs();

    const result = await handleOutline({
      file_paths: paths,
      depth: depthVal,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
});
