import { parseArgs } from "node:util";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleSearch } from "../tools/search.ts";
import { asString, type CliSubcommand, emitResult, emitUsageError, jsonFlag, UsageError } from "./io.ts";

const OPTIONS = {
  "ignore-case": { type: "boolean", short: "i", default: false },
  regex: { type: "boolean", short: "r", default: false },
  multiline: { type: "boolean", default: false },
  context: { type: "string", short: "C" },
  max: { type: "string", short: "m" },
  "max-match-lines": { type: "string" },
  json: jsonFlag,
} as const;

const USAGE = `Usage: trueline search [options] <pattern> <paths...>

Search files for a literal string or regex, returns edit-ready hashes.

Options:
  -i, --ignore-case         Case-insensitive matching
  -r, --regex               Treat pattern as a regular expression
      --multiline           Enable multiline regex matching
  -C, --context <n>         Lines of context around each match
  -m, --max <n>              Maximum number of matches to return
      --max-match-lines <n> Maximum lines a single multiline match can span
      --json                Output JSON envelope {ok, result}
`;

export default {
  usage: USAGE,
  async run(argv: string[]): Promise<void> {
    const { values: args, positionals: rest } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    // First positional is the pattern; remaining are paths.
    if (rest.length === 0) {
      emitUsageError(new UsageError("search requires a pattern and at least one path"));
      return;
    }

    const [pattern, ...paths] = rest;

    if (paths.length === 0) {
      emitUsageError(new UsageError("paths required"));
      return;
    }

    const contextArg = asString(args.context);
    const maxArg = asString(args.max);
    const maxMatchLinesArg = asString(args["max-match-lines"]);
    const contextLines = contextArg !== undefined ? Number.parseInt(contextArg, 10) : undefined;
    const maxMatches = maxArg !== undefined ? Number.parseInt(maxArg, 10) : undefined;
    const maxMatchLines = maxMatchLinesArg !== undefined ? Number.parseInt(maxMatchLinesArg, 10) : undefined;

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleSearch({
      pattern,
      file_paths: paths,
      case_insensitive: Boolean(args["ignore-case"]),
      regex: Boolean(args.regex),
      multiline: Boolean(args.multiline),
      context_lines: contextLines,
      max_matches: maxMatches,
      max_match_lines: maxMatchLines,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json), search: true });
  },
} satisfies CliSubcommand;
