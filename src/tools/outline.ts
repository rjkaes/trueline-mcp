/**
 * trueline_outline tool handler.
 *
 * Returns a compact structural outline of a source file using tree-sitter.
 * Much smaller than reading the full file — useful for navigation and
 * understanding file structure before reading specific ranges.
 */
import { readTextNoFollow } from "../line-splitter.ts";
import { extname } from "node:path";
import { extractOutline, formatOutline } from "../outline/extract.ts";
import type { OutlineEntry } from "../outline/extract.ts";
import { getLanguageConfig } from "../outline/languages.ts";
import { extractMarkdownOutline } from "../outline/markdown.ts";
import { extractXmlOutline } from "../outline/xml.ts";
import {
  displayPath,
  expandGlobs,
  filterAbsolutePaths,
  isAbsolutePathArg,
  relativePathError,
  type ToolContext,
  validatePath,
} from "./shared.ts";

import { errorResult, textResult, type ToolResult } from "./types.ts";

// Formats trueline_outline parses with custom parsers rather than tree-sitter grammars.
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const XML_EXTENSIONS = new Set([
  ".xml",
  ".xsl",
  ".xslt",
  ".xhtml",
  ".svg",
  ".pom",
  ".csproj",
  ".props",
  ".targets",
  ".fxml",
  ".xaml",
]);

interface OutlineParams extends ToolContext {
  file_paths: string[];
  depth?: number;
}

export async function handleOutline(params: OutlineParams): Promise<ToolResult> {
  const { projectDir, allowedDirs, requireAbsolutePath } = params;

  if (requireAbsolutePath && params.file_paths.length === 1 && !isAbsolutePathArg(params.file_paths[0])) {
    return relativePathError(params.file_paths[0]);
  }

  // Reject relative entries before glob expansion (mirrors trueline_read), so
  // a relative glob is never resolved against a possibly-stale projectDir.
  const { candidates, rejectedSections } = filterAbsolutePaths(
    params.file_paths,
    requireAbsolutePath,
    (entry, errorText) => `--- ${entry} ---\n${errorText}`,
  );

  const filePaths = await expandGlobs(candidates, projectDir, allowedDirs);
  if (filePaths.length === 0) {
    if (rejectedSections.length > 0) return textResult(rejectedSections.join("\n\n"));
    return errorResult("Provide at least one file path in file_paths.");
  }

  // Single file — preserve original compact output
  if (filePaths.length === 1 && rejectedSections.length === 0) {
    return outlineOneFile(filePaths[0], params.depth, projectDir, allowedDirs);
  }

  // Multiple files — collect results with per-file headers
  const sections: string[] = [...rejectedSections];

  for (const fp of filePaths) {
    const result = await outlineOneFile(fp, params.depth, projectDir, allowedDirs);
    sections.push(`--- ${displayPath(fp, projectDir)} ---\n${result.content[0].text}`);
  }

  return textResult(sections.join("\n\n"));
}

async function outlineOneFile(
  file_path: string,
  depth: number | undefined,
  projectDir: string | undefined,
  allowedDirs: string[] | undefined,
): Promise<ToolResult> {
  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const { resolvedPath } = validated;
  const ext = extname(resolvedPath).toLowerCase();

  // Streaming extractors (no tree-sitter, no full-file load)
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return runStreamingExtractor("Markdown", () => extractMarkdownOutline(resolvedPath));
  }

  if (XML_EXTENSIONS.has(ext)) {
    return runStreamingExtractor("XML", () => extractXmlOutline(resolvedPath, depth));
  }

  let source: string | null;
  try {
    source = await readTextNoFollow(resolvedPath);
  } catch (err: unknown) {
    return errorResult(`Error reading file: ${(err as Error).message}`);
  }
  if (source === null) {
    return errorResult(`"${file_path}" appears to be a binary file`);
  }

  const totalLines = source.split("\n").length;

  const config = getLanguageConfig(ext);
  if (!config) {
    return textResult(`No outline support for "${ext}" files \u2014 use trueline_read to read this file directly.`);
  }

  try {
    const entries = await extractOutline(source, config, depth);
    if (entries.length === 0) {
      return textResult(`(no outline entries found in ${totalLines}-line file)`);
    }
    const text = formatOutline(entries, totalLines);
    return textResult(text);
  } catch (err: unknown) {
    return errorResult(`Outline extraction failed: ${(err as Error).message}`);
  }
}

/** Shared try/format/empty-check/error-label plumbing for the streaming (markdown, XML) extractors. */
async function runStreamingExtractor(
  label: string,
  extract: () => Promise<{ entries: OutlineEntry[]; totalLines: number }>,
): Promise<ToolResult> {
  try {
    const { entries, totalLines } = await extract();
    if (entries.length === 0) {
      return textResult(`(no outline entries found in ${totalLines}-line file)`);
    }
    return textResult(formatOutline(entries, totalLines));
  } catch (err: unknown) {
    return errorResult(`${label} outline extraction failed: ${(err as Error).message}`);
  }
}
