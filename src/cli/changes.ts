import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../allowed-dirs.ts";
import { handleDiff } from "../tools/diff.ts";
import { emitResult } from "./io.ts";

export default defineCommand({
  meta: {
    name: "changes",
    description: "Semantic AST-based diff of structural changes vs a git ref",
  },
  args: {
    against: {
      type: "string",
      description: "Git ref to compare against (default: HEAD)",
    },
    json: {
      type: "boolean",
      description: "Output JSON envelope {ok, result}",
      default: false,
    },
  },
  run: async ({ args }) => {
    const paths = args._ as string[];
    // No paths → diff all changed files (handler treats "*" as sentinel)
    const filePaths = paths.length > 0 ? paths : ["*"];

    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
    const allowedDirs = await resolveAllowedDirs();

    const result = await handleDiff({
      file_paths: filePaths,
      compare_against: args.against,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
});
