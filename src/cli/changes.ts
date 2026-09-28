import { defineCommand } from "citty";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleDiff } from "../tools/diff.ts";
import { emitResult, jsonFlag } from "./io.ts";

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
    json: jsonFlag,
  },
  run: async ({ args }) => {
    const paths = args._ as string[];
    // No paths → diff all changed files (handler treats "*" as sentinel)
    const filePaths = paths.length > 0 ? paths : ["*"];

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleDiff({
      file_paths: filePaths,
      compare_against: args.against,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
});
