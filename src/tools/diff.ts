import { createTwoFilesPatch } from "diff";
import { relative } from "node:path";
import { applyEdits } from "../trueline.ts";
import { type ToolResult } from "./types.ts";
import { prepareFile, buildOps, type EditInput } from "./shared.ts";

interface DiffParams {
  file_path: string;
  edits: EditInput[];
  projectDir?: string;
}

/**
 * Produce a standard unified diff between two arrays of lines.
 *
 * Delegates to `createTwoFilesPatch` from the `diff` package, which
 * produces correct `@@` hunk headers and handles all edge cases including
 * files that gain or lose a trailing newline.
 */
function unifiedDiff(
  oldLines: string[],
  newLines: string[],
  relativePath: string,
  hasTrailingNewline: boolean,
): string {
  const eol = hasTrailingNewline ? "\n" : "";
  const oldStr = oldLines.join("\n") + (oldLines.length ? eol : "");
  const newStr = newLines.join("\n") + (newLines.length ? eol : "");
  return createTwoFilesPatch(
    `a/${relativePath}`,
    `b/${relativePath}`,
    oldStr,
    newStr,
  );
}

export async function handleDiff(params: DiffParams): Promise<ToolResult> {
  const { file_path, edits, projectDir } = params;

  // Diff intentionally uses Read deny patterns (not a separate "Diff" tool
  // name) since diff is a read-only preview operation and should share the
  // same access restrictions as trueline_read.
  const prepared = await prepareFile(file_path, "Read", projectDir);
  if (!prepared.ok) return prepared.error;

  const { fileLines, resolvedPath, hasTrailingNewline } = prepared;

  const built = buildOps(fileLines, edits);
  if (!built.ok) return built.error;

  // Compute new lines WITHOUT writing
  const newLines = applyEdits(fileLines, built.ops);

  // Use the resolved path relative to the project root so diff headers
  // show a meaningful path rather than just the basename.
  const relPath = file_path.startsWith("/")
    ? relative(projectDir ?? process.cwd(), resolvedPath)
    : file_path;
  const diff = unifiedDiff(fileLines, newLines, relPath, hasTrailingNewline);

  return {
    content: [{ type: "text", text: diff }],
  };
}
