import { parseArgs } from "node:util";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { parseFilePathWithRanges } from "../parse.ts";
import { handleReadMulti } from "../tools/read.ts";
import { asString, type CliSubcommand, emitResult, emitUsageError, jsonFlag, UsageError } from "./io.ts";

const OPTIONS = {
  ranges: { type: "string" },
  encoding: { type: "string" },
  json: jsonFlag,
} as const;

const USAGE = `Usage: trueline read [options] <paths...>

Read files with per-line hashes and refs. Paths accept an inline
range suffix, e.g. src/foo.ts:10-25.

Options:
  --ranges <ranges>   Comma-separated line ranges, e.g. 10-20,50-60
  --encoding <enc>    File encoding (utf-8, ascii, latin1)
  --json              Output JSON envelope {ok, result}
`;

/**
 * Check for ambiguous ranges: a path like "src/foo.ts:10-20" already embeds
 * a range; combining it with --ranges is ambiguous and exits 3.
 */
function validateRangesConflict(paths: string[], flagRanges: string[] | undefined): void {
  if (!flagRanges || flagRanges.length === 0) return;

  for (const p of paths) {
    const parsed = parseFilePathWithRanges(p);
    if (parsed.rangeSpecs && parsed.rangeSpecs.length > 0) {
      throw new UsageError(`ambiguous ranges for ${p}: use either inline ':range' or --ranges, not both`);
    }
  }
}

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
      emitUsageError(new UsageError("read requires at least one file path"));
      return;
    }

    // --ranges is a single comma-separated string; split it here.
    const rangesArg = asString(args.ranges);
    const flagRanges = rangesArg
      ? rangesArg
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
      : undefined;

    try {
      validateRangesConflict(paths, flagRanges);
    } catch (err) {
      emitUsageError(err as UsageError);
      return;
    }

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleReadMulti({
      file_paths: paths,
      ranges: flagRanges,
      encoding: asString(args.encoding),
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
