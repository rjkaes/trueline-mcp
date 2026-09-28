import { parseArgs } from "node:util";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleVerify } from "../tools/verify.ts";
import {
  asStringArray,
  type CliSubcommand,
  emitResult,
  emitUsageError,
  jsonFlag,
  parseRefsArg,
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
      emitUsageError(new UsageError("verify requires a file path"));
      return;
    }
    const filePath = paths[0];

    let refs: string[];
    try {
      refs = parseRefsArg(asStringArray(args.refs));
    } catch (err) {
      emitUsageError(err as UsageError);
      return;
    }

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
