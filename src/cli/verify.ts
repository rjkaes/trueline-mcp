import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleVerify } from "../tools/verify.ts";
import {
  type CliSubcommand,
  emitResult,
  fromCwd,
  jsonFlag,
  loadAtOrDashOrLiteral,
  parseCliArgs,
  UsageError,
} from "./io.ts";

const OPTIONS = {
  refs: { type: "string", multiple: true },
  json: jsonFlag,
} as const;

const USAGE = `Usage: trueline verify [options] <path>

Check if held refs are still valid against current file content.

Options:
  --refs <ref>   Refs to verify: repeatable, @file, or - (stdin)
  --json         Output JSON envelope {ok, result}
`;

/**
 * Parse the --refs argument array which supports three forms:
 *   repeatable:  --refs r1 --refs r2  (each arg is a ref string)
 *   @file:       --refs @path         (single element starting with @)
 *   stdin:       --refs -             (single element "-")
 *
 * If @file or - is mixed with other entries, raises UsageError (exit 3).
 */
function parseRefsArg(refsArray: string[]): string[] {
  if (refsArray.length === 0) {
    throw new UsageError("--refs is required");
  }

  // Detect @file or - forms
  const hasAtFile = refsArray.some((r) => r.startsWith("@"));
  const hasDash = refsArray.some((r) => r === "-");

  if ((hasAtFile || hasDash) && refsArray.length > 1) {
    throw new UsageError("--refs @file and --refs - cannot be combined with other --refs values");
  }

  if (hasAtFile || hasDash) {
    // Load via @file or stdin, then split on newlines (one ref per line)
    const raw = loadAtOrDashOrLiteral(refsArray[0], "text") as string;
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  return refsArray;
}

export default {
  usage: USAGE,
  async run(argv: string[]): Promise<void> {
    const { values: args, positionals: paths } = parseCliArgs(argv, OPTIONS);
    if (paths.length !== 1) {
      throw new UsageError("verify requires exactly one file path");
    }
    const filePath = fromCwd(paths[0]);

    const refs = parseRefsArg(args.refs ?? []);

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleVerify({
      file_path: filePath,
      refs,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
