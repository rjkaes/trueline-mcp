import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleSearch } from "../tools/search.ts";
import { type CliSubcommand, emitResult, fromCwd, jsonFlag, parseCliArgs, parseIntFlag, UsageError } from "./io.ts";

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
    const { values: args, positionals: rest } = parseCliArgs(argv, OPTIONS);
    // First positional is the pattern; remaining are paths.
    if (rest.length === 0) {
      throw new UsageError("search requires a pattern and at least one path");
    }

    const [pattern, ...paths] = rest;

    if (paths.length === 0) {
      throw new UsageError("paths required");
    }

    const contextLines = parseIntFlag("context", args.context, 0);
    const maxMatches = parseIntFlag("max", args.max, 1);
    const maxMatchLines = parseIntFlag("max-match-lines", args["max-match-lines"], 1);

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleSearch({
      pattern,
      file_paths: paths.map(fromCwd),
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
