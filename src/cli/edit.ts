import { parseArgs } from "node:util";
import { resolveProjectDirs } from "../allowed-dirs.js";
import { handleEdit } from "../tools/edit.ts";
import type { EditInput } from "../tools/shared.ts";
import {
  asString,
  type CliSubcommand,
  emitResult,
  emitUsageError,
  jsonFlag,
  loadAtOrDashOrLiteral,
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
  --content <content>      Replacement content: literal, @file, or - (stdin)
  --action <action>        Edit action: replace (default) or insert_after
  --dry-run                Preview edits as unified diff without writing
  --context-lines <n>      Lines of hashLine context to return around each edit site
  --encoding <enc>         File encoding (utf-8, ascii, latin1)
  --json                   Output JSON envelope {ok, result}
`;

/**
 * Validate and return an EditInput array from a parsed --edits value.
 *
 * Accepts an array of objects with required keys: ref, range, content.
 * Optional key: action.
 */
function parseEditsArg(raw: unknown): EditInput[] {
  if (!Array.isArray(raw)) {
    throw new UsageError("--edits must be a JSON array");
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
    const { values: args, positionals: paths } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: false,
    });
    if (paths.length === 0) {
      emitUsageError(new UsageError("edit requires a file path"));
      return;
    }
    const filePath = paths[0];

    const editsArg = asString(args.edits);
    const refArg = asString(args.ref);
    const rangeArg = asString(args.range);
    const contentArg = asString(args.content);

    const hasFlatFlags = refArg !== undefined || rangeArg !== undefined || contentArg !== undefined;
    const hasEditsFlag = editsArg !== undefined;

    // Mutually exclusive: --edits vs flat flags
    if (hasEditsFlag && hasFlatFlags) {
      emitUsageError(new UsageError("--edits and --ref/--range/--content are mutually exclusive"));
      return;
    }

    // Both --edits - and --content - would consume stdin
    if (editsArg === "-" && contentArg === "-") {
      emitUsageError(new UsageError("--edits - and --content - cannot both consume stdin"));
      return;
    }

    let edits: EditInput[];

    if (hasEditsFlag) {
      // Load via @file, stdin, or literal JSON string
      let raw: unknown;
      try {
        raw = loadAtOrDashOrLiteral(editsArg!, "json");
      } catch (err) {
        emitUsageError(err as UsageError);
        return;
      }
      try {
        edits = parseEditsArg(raw);
      } catch (err) {
        emitUsageError(err as UsageError);
        return;
      }
    } else if (hasFlatFlags) {
      // Flat single-edit shorthand: --ref, --range, --content required
      if (!refArg || !rangeArg || contentArg === undefined) {
        emitUsageError(new UsageError("single-edit shorthand requires --ref, --range, and --content"));
        return;
      }
      let contentValue: string;
      try {
        contentValue = loadAtOrDashOrLiteral(contentArg, "text") as string;
      } catch (err) {
        emitUsageError(err as UsageError);
        return;
      }
      const action = asString(args.action) as EditInput["action"] | undefined;
      if (action !== undefined && action !== "replace" && action !== "insert_after") {
        emitUsageError(new UsageError('--action must be "replace" or "insert_after"'));
        return;
      }
      edits = [{ ref: refArg, range: rangeArg, content: contentValue, action }];
    } else {
      emitUsageError(new UsageError("provide either --edits or the flat --ref/--range/--content flags"));
      return;
    }

    const contextLinesArg = asString(args["context-lines"]);
    const contextLines = contextLinesArg !== undefined ? Number.parseInt(contextLinesArg, 10) : undefined;

    const { projectDir, allowedDirs } = await resolveProjectDirs();

    const result = await handleEdit({
      file_path: filePath,
      edits,
      dry_run: Boolean(args["dry-run"]),
      context_lines: contextLines,
      encoding: asString(args.encoding),
      projectDir,
      allowedDirs,
    });

    emitResult(result, { json: Boolean(args.json) });
  },
} satisfies CliSubcommand;
