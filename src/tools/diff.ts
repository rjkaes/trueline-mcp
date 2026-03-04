import { readFile, unlink } from "node:fs/promises";
import { relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import { type ToolResult } from "./types.ts";
import { validatePath, validateEdits, type EditInput } from "./shared.ts";
import { streamingEdit } from "../streaming-edit.ts";

interface DiffParams {
  file_path: string;
  edits: EditInput[];
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleDiff(params: DiffParams): Promise<ToolResult> {
  const { file_path, edits, projectDir, allowedDirs } = params;

  // Diff intentionally uses Read deny patterns (not a separate "Diff" tool
  // name) since diff is a read-only preview operation and should share the
  // same access restrictions as trueline_read.
  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath, mtimeMs } = validated;

  const built = validateEdits(edits);
  if (!built.ok) return built.error;

  const result = await streamingEdit(resolvedPath, built.ops, built.checksumRefs, mtimeMs, true);

  if (!result.ok) {
    return {
      content: [{ type: "text", text: result.error }],
      isError: true,
    };
  }

  // Use the resolved path relative to the project root so diff headers
  // show a meaningful path rather than just the basename.
  const relPath = file_path.startsWith("/")
    ? relative(projectDir ?? process.cwd(), resolvedPath)
    : file_path;

  try {
    const [oldStr, newStr] = await Promise.all([
      readFile(resolvedPath, "utf-8"),
      readFile(result.tmpPath!, "utf-8"),
    ]);

    const diff = createTwoFilesPatch(
      `a/${relPath}`,
      `b/${relPath}`,
      oldStr,
      newStr,
    );

    return {
      content: [{ type: "text", text: diff }],
    };
  } finally {
    try { await unlink(result.tmpPath!); } catch { /* best-effort */ }
  }
}
