import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { resolveAllowedDirs } from "../allowed-dirs.ts";
import { handleEdit } from "../tools/edit.ts";
import type { EditInput } from "../tools/shared.ts";
import { emitResult, emitUsageError, loadAtOrDashOrLiteral, parseEditsArg, UsageError } from "./io.ts";

export default defineCommand({
  meta: {
    name: "edit",
    description: "Apply hash-verified edits to a file",
  },
  args: {
    edits: {
      type: "string",
      description: "JSON edit array: @file, - (stdin), or JSON string",
    },
    // Flat flags for single-edit case
    ref: {
      type: "string",
      description: "Ref from a prior trueline read (single-edit shorthand)",
    },
    range: {
      type: "string",
      description: "Range in hash.line format (single-edit shorthand)",
    },
    content: {
      type: "string",
      description: "Replacement content: literal, @file, or - (stdin)",
    },
    action: {
      type: "string",
      description: "Edit action: replace (default) or insert_after",
    },
    "dry-run": {
      type: "boolean",
      description: "Preview edits as unified diff without writing",
      default: false,
    },
    "context-lines": {
      type: "string",
      description: "Lines of hash.line context to return around each edit site",
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
      emitUsageError(new UsageError("edit requires a file path"));
      return;
    }
    const filePath = paths[0];

    const hasFlatFlags = args.ref !== undefined || args.range !== undefined || args.content !== undefined;
    const hasEditsFlag = args.edits !== undefined;

    // Mutually exclusive: --edits vs flat flags
    if (hasEditsFlag && hasFlatFlags) {
      emitUsageError(new UsageError("--edits and --ref/--range/--content are mutually exclusive"));
      return;
    }

    // Both --edits - and --content - would consume stdin
    if (args.edits === "-" && args.content === "-") {
      emitUsageError(new UsageError("--edits - and --content - cannot both consume stdin"));
      return;
    }

    let edits: EditInput[];

    if (hasEditsFlag) {
      // Load via @file, stdin, or literal JSON string
      let raw: unknown;
      try {
        raw = loadAtOrDashOrLiteral(args.edits!, "json");
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
      if (!args.ref || !args.range || args.content === undefined) {
        emitUsageError(new UsageError("single-edit shorthand requires --ref, --range, and --content"));
        return;
      }
      let contentValue: string;
      try {
        contentValue = loadAtOrDashOrLiteral(args.content!, "text") as string;
      } catch (err) {
        emitUsageError(err as UsageError);
        return;
      }
      const action = args.action as EditInput["action"] | undefined;
      if (action !== undefined && action !== "replace" && action !== "insert_after") {
        emitUsageError(new UsageError('--action must be "replace" or "insert_after"'));
        return;
      }
      edits = [{ ref: args.ref, range: args.range, content: contentValue, action }];
    } else {
      emitUsageError(new UsageError("provide either --edits or the flat --ref/--range/--content flags"));
      return;
    }

    const contextLines = args["context-lines"] !== undefined ? Number.parseInt(args["context-lines"], 10) : undefined;

    const rawProjectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
    const allowedDirs = await resolveAllowedDirs();

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
});
