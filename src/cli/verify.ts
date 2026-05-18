import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../allowed-dirs.ts";
import { handleVerify } from "../tools/verify.ts";
import { emitResult, emitUsageError, parseRefsArg, UsageError } from "./io.ts";

export default defineCommand({
  meta: {
    name: "verify",
    description: "Check if held refs are still valid against current file content",
  },
  args: {
    refs: {
      type: "string",
      description: "Refs to verify: repeatable, @file, or - (stdin)",
    },
    json: {
      type: "boolean",
      description: "Output JSON envelope {ok, result}",
      default: false,
    },
  },
  run: async ({ args, rawArgs }) => {
    const paths = args._ as string[];
    if (paths.length === 0) {
      emitUsageError(new UsageError("verify requires a file path"));
      return;
    }
    const filePath = paths[0];

    // citty doesn't support multi-value flags natively. Collect all --refs values
    // by re-scanning rawArgs ourselves.
    const refsValues: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === "--refs" && i + 1 < rawArgs.length) {
        refsValues.push(rawArgs[i + 1]);
        i++;
      }
    }

    // Fall back to the single string citty parsed if rawArgs scan found nothing
    if (refsValues.length === 0 && args.refs !== undefined) {
      refsValues.push(args.refs);
    }

    let refs: string[];
    try {
      refs = parseRefsArg(refsValues);
    } catch (err) {
      emitUsageError(err as UsageError);
      return;
    }

    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
    const allowedDirs = await resolveAllowedDirs();

    const result = await handleVerify({
      file_path: filePath,
      refs,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
});
