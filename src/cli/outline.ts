import { parseArgs } from "node:util";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleOutline } from "../tools/outline.ts";
import { asString, type CliSubcommand, emitResult, emitUsageError, jsonFlag, UsageError } from "./io.ts";

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
    const { values: args, positionals: paths } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    if (paths.length === 0) {
      emitUsageError(new UsageError("outline requires at least one file path"));
      return;
    }

    const depthArg = asString(args.depth);
    const depthVal = depthArg !== undefined ? Number.parseInt(depthArg, 10) : undefined;
    if (depthVal !== undefined && Number.isNaN(depthVal)) {
      emitUsageError(new UsageError("--depth must be a number"));
      return;
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
