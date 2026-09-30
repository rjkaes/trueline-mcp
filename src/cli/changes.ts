import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleDiff } from "../tools/diff.ts";
import { type CliSubcommand, emitResult, fromCwd, jsonFlag, parseCliArgs } from "./io.ts";

const OPTIONS = {
  against: { type: "string" },
  json: jsonFlag,
} as const;

const USAGE = `Usage: trueline changes [options] [paths...]

Semantic AST-based diff of structural changes vs a git ref. With no
paths, diffs all changed files.

Options:
  --against <ref>   Git ref to compare against (default: HEAD)
  --json            Output JSON envelope {ok, result}
`;

export default {
  usage: USAGE,
  async run(argv: string[]): Promise<void> {
    const { values: args, positionals: paths } = parseCliArgs(argv, OPTIONS);
    // No paths → diff all changed files (handler treats "*" as sentinel)
    // An explicit "*" stays the sentinel, not a cwd-relative glob.
    const filePaths = paths.length > 0 ? paths.map((p) => (p === "*" ? p : fromCwd(p))) : ["*"];

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleDiff({
      file_paths: filePaths,
      compare_against: args.against,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
