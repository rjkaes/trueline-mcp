import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleOutline } from "../tools/outline.ts";
import { type CliSubcommand, emitResult, jsonFlag, parseCliArgs, UsageError } from "./io.ts";

const OPTIONS = {
  json: jsonFlag,
  depth: { type: "string" },
} as const;

const USAGE = `Usage: trueline outline [options] <paths...>

Structural outline of files via tree-sitter (functions, classes, types).

Options:
  --depth <n>   Max nesting depth (0 = top-level only)
  --json        Output JSON envelope {ok, result}
`;

export default {
  usage: USAGE,
  async run(argv: string[]): Promise<void> {
    const { values: args, positionals: paths } = parseCliArgs(argv, OPTIONS);
    if (paths.length === 0) {
      throw new UsageError("outline requires at least one file path");
    }

    const depthVal = args.depth !== undefined ? Number.parseInt(args.depth, 10) : undefined;
    if (depthVal !== undefined && Number.isNaN(depthVal)) {
      throw new UsageError("--depth must be a number");
    }

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleOutline({
      file_paths: paths,
      depth: depthVal,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
