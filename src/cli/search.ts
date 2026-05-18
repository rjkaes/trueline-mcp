import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../allowed-dirs.ts";
import { handleSearch } from "../tools/search.ts";
import { emitResult, emitUsageError, UsageError } from "./io.ts";

export default defineCommand({
  meta: {
    name: "search",
    description: "Search files for a literal string or regex, returns edit-ready hashes",
  },
  args: {
    "ignore-case": {
      type: "boolean",
      alias: "i",
      description: "Case-insensitive matching",
      default: false,
    },
    regex: {
      type: "boolean",
      alias: "r",
      description: "Treat pattern as a regular expression",
      default: false,
    },
    multiline: {
      type: "boolean",
      description: "Enable multiline regex matching",
      default: false,
    },
    context: {
      type: "string",
      alias: "C",
      description: "Lines of context around each match",
    },
    max: {
      type: "string",
      alias: "m",
      description: "Maximum number of matches to return",
    },
    "max-match-lines": {
      type: "string",
      description: "Maximum lines a single multiline match can span",
    },
    json: {
      type: "boolean",
      description: "Output JSON envelope {ok, result}",
      default: false,
    },
  },
  run: async ({ args }) => {
    // First positional is the pattern; remaining are paths.
    const rest = args._ as string[];
    if (rest.length === 0) {
      emitUsageError(new UsageError("search requires a pattern and at least one path"));
      return;
    }

    const [pattern, ...paths] = rest;

    if (paths.length === 0) {
      emitUsageError(new UsageError("paths required"));
      return;
    }

    const contextLines = args.context !== undefined ? Number.parseInt(args.context, 10) : undefined;
    const maxMatches = args.max !== undefined ? Number.parseInt(args.max, 10) : undefined;
    const maxMatchLines =
      args["max-match-lines"] !== undefined ? Number.parseInt(args["max-match-lines"], 10) : undefined;

    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
    const allowedDirs = await resolveAllowedDirs();

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
});
