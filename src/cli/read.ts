import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleReadMulti } from "../tools/read.ts";
import { type CliSubcommand, emitResult, fromCwd, jsonFlag, parseCliArgs, UsageError } from "./io.ts";

const OPTIONS = {
  ranges: { type: "string", multiple: true },
  encoding: { type: "string" },
  json: jsonFlag,
} as const;

const USAGE = `Usage: trueline read [options] <paths...>

Read files with per-line hashes and refs. Paths accept an inline
range suffix, e.g. src/foo.ts:10-25.

Options:
  --ranges <ranges>   Comma-separated line ranges, e.g. 10-20,50-60 (repeatable)
  --encoding <enc>    File encoding (utf-8, ascii, latin1)
  --json              Output JSON envelope {ok, result}
`;

export default {
  usage: USAGE,
  async run(argv: string[]): Promise<void> {
    const { values: args, positionals: paths } = parseCliArgs(argv, OPTIONS);
    if (paths.length === 0) {
      throw new UsageError("read requires at least one file path");
    }

    // --ranges is repeatable and each value is comma-separated; flatten into one list.
    const flagRanges = args.ranges
      ?.flatMap((r) => r.split(","))
      .map((r) => r.trim())
      .filter(Boolean);

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleReadMulti({
      file_paths: paths.map(fromCwd),
      ranges: flagRanges,
      encoding: args.encoding,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
