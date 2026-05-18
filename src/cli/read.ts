import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../allowed-dirs.ts";
import { handleReadMulti } from "../tools/read.ts";
import { emitResult, emitUsageError, UsageError, validateRangesConflict } from "./io.ts";

export default defineCommand({
  meta: {
    name: "read",
    description: "Read files with per-line hashes and refs",
  },
  args: {
    ranges: {
      type: "string",
      description: "Comma-separated line ranges, e.g. 10-20,50-60",
    },
    encoding: {
      type: "string",
      description: "File encoding (utf-8, ascii, latin1)",
    },
    json: {
      type: "boolean",
      description: "Output JSON envelope {ok, result}",
      default: false,
    },
  },
  run: async ({ args }) => {
    const paths = args._ as string[];
    if (paths.length === 0) {
      emitUsageError(new UsageError("read requires at least one file path"));
      return;
    }

    // --ranges is a single comma-separated string; split it here.
    const flagRanges = args.ranges
      ? args.ranges
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

    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
    const allowedDirs = await resolveAllowedDirs();

    const result = await handleReadMulti({
      file_paths: paths,
      ranges: flagRanges,
      encoding: args.encoding,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
});
