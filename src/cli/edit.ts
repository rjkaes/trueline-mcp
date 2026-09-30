import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleEdit } from "../tools/edit.ts";
import type { EditInput } from "../tools/shared.ts";
import {
  type CliSubcommand,
  emitResult,
  fromCwd,
  jsonFlag,
  loadAtOrDashOrLiteral,
  parseCliArgs,
  parseIntFlag,
  UsageError,
} from "./io.ts";

const OPTIONS = {
  edits: { type: "string" },
  // Flat flags for single-edit case
  ref: { type: "string" },
  range: { type: "string" },
  content: { type: "string" },
  action: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  "context-lines": { type: "string" },
  encoding: { type: "string" },
  json: jsonFlag,
} as const;

const USAGE = `Usage: trueline edit [options] <path>

Apply hash-verified edits to a file.

Options:
  --edits <edits>          JSON edit array: @file, - (stdin), or JSON string
  --ref <ref>              Ref from a prior trueline read (single-edit shorthand)
  --range <range>          Range in hashLine format (single-edit shorthand)
  --content <content>      Replacement content: literal, @file, or - (stdin); @@ escapes a leading @
  --action <action>        Edit action: replace (default) or insert_after
  --dry-run                Preview edits as unified diff without writing
  --context-lines <n>      Lines of hashLine context to return around each edit site
  --encoding <enc>         File encoding (utf-8, ascii, latin1)
  --json                   Output JSON envelope {ok, result}
`;

/**
 * Validate and return an EditInput array from parsed edit input (an --edits value or the flat-flag shorthand).
 *
 * Accepts an array of objects with required keys: ref, range, content.
 * Optional key: action.
 */
function parseEditsArg(raw: unknown): EditInput[] {
  if (!Array.isArray(raw)) {
    throw new UsageError("--edits must be a JSON array");
  }
  // Mirrors editSchema's edits.min(1): an empty list would exit 0 as "(no changes)".
  if (raw.length === 0) {
    throw new UsageError("--edits must contain at least one edit");
  }
  return raw.map((item: unknown, i: number) => {
    if (typeof item !== "object" || item === null) {
      throw new UsageError(`--edits[${i}]: expected an object`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.ref !== "string") throw new UsageError(`--edits[${i}]: missing "ref"`);
    if (typeof obj.range !== "string") throw new UsageError(`--edits[${i}]: missing "range"`);
    if (typeof obj.content !== "string") throw new UsageError(`--edits[${i}]: missing "content"`);
    const action = obj.action;
    if (action !== undefined && action !== "replace" && action !== "insert_after") {
      throw new UsageError(`--edits[${i}]: action must be "replace" or "insert_after"`);
    }
    return { ref: obj.ref, range: obj.range, content: obj.content, action: action as EditInput["action"] };
  });
}

export default {
  usage: USAGE,
  async run(argv: string[]): Promise<void> {
    const { values: args, positionals: paths } = parseCliArgs(argv, OPTIONS);
    if (paths.length !== 1) {
      throw new UsageError("edit requires exactly one file path");
    }
    const filePath = fromCwd(paths[0]);

    const hasFlatFlags =
      args.ref !== undefined || args.range !== undefined || args.content !== undefined || args.action !== undefined;

    // Mutually exclusive: --edits vs flat flags
    if (args.edits !== undefined && hasFlatFlags) {
      throw new UsageError("--edits and --ref/--range/--content/--action are mutually exclusive");
    }

    // Both --edits - and --content - would consume stdin
    if (args.edits === "-" && args.content === "-") {
      throw new UsageError("--edits - and --content - cannot both consume stdin");
    }

    let raw: unknown;
    if (args.edits !== undefined) {
      // Load via @file, stdin, or literal JSON string
      raw = await loadAtOrDashOrLiteral(args.edits, "json");
    } else if (hasFlatFlags) {
      // Single-edit shorthand. Checked here, not by parseEditsArg, which would blame --edits[0].
      for (const flag of ["ref", "range", "content"] as const) {
        if (args[flag] === undefined) throw new UsageError(`missing --${flag}`);
      }
      raw = [
        {
          ref: args.ref,
          range: args.range,
          content: args.content === undefined ? undefined : await loadAtOrDashOrLiteral(args.content, "text"),
          action: args.action,
        },
      ];
    } else {
      throw new UsageError("provide either --edits or the flat --ref/--range/--content flags");
    }
    const edits = parseEditsArg(raw);

    const contextLines = parseIntFlag("context-lines", args["context-lines"], 0);

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleEdit({
      file_path: filePath,
      edits,
      dry_run: Boolean(args["dry-run"]),
      context_lines: contextLines,
      encoding: args.encoding,
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
