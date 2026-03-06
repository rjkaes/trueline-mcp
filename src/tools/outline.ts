/**
 * trueline_outline tool handler.
 *
 * Returns a compact structural outline of a source file using tree-sitter.
 * Much smaller than reading the full file — useful for navigation and
 * understanding file structure before reading specific ranges.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { extractOutline, formatOutline } from "../outline/extract.ts";
import { getLanguageConfig } from "../outline/languages.ts";
import { validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface OutlineParams {
  file_path: string;
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleOutline(params: OutlineParams): Promise<ToolResult> {
  const { file_path, projectDir, allowedDirs } = params;

  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const ext = extname(validated.resolvedPath).toLowerCase();
  const config = getLanguageConfig(ext);
  if (!config) {
    return textResult(`No outline support for "${ext}" files — use trueline_read to read this file directly.`);
  }

  let source: string;
  try {
    source = readFileSync(validated.resolvedPath, "utf-8");
  } catch (err: unknown) {
    return errorResult(`Error reading file: ${(err as Error).message}`);
  }

  const totalLines = source.split("\n").length;

  try {
    const entries = await extractOutline(source, config);
    if (entries.length === 0) {
      return textResult(`(no outline entries found in ${totalLines}-line file)`);
    }
    return textResult(formatOutline(entries, totalLines));
  } catch (err: unknown) {
    return errorResult(`Outline extraction failed: ${(err as Error).message}`);
  }
}
