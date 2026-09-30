/**
 * trueline_outline tool handler.
 *
 * Returns a compact structural outline of a source file using tree-sitter.
 * Much smaller than reading the full file — useful for navigation and
 * understanding file structure before reading specific ranges.
 */
import { isBinaryError, transcodedLines } from "../encoding.ts";
import { extname } from "node:path";
import { extractOutline, formatOutline } from "../outline/extract.ts";
import type { OutlineEntry } from "../outline/extract.ts";
import { getLanguageConfig } from "../outline/languages.ts";
import { extractMarkdownOutline } from "../outline/markdown.ts";
import { extractXmlOutline } from "../outline/xml.ts";
import {
  binaryFileError,
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
  ".fsproj",
  ".props",
  ".targets",
  ".fxml",
  ".xaml",
  ".xsd",
  ".plist",
  ".resx",
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
    return runExtractor("Markdown outline", () => extractMarkdownOutline(resolvedPath, depth));
  }

  if (XML_EXTENSIONS.has(ext)) {
    return runExtractor("XML outline", () => extractXmlOutline(resolvedPath, depth));
  }

  let source: string;
  try {
    source = await readSource(resolvedPath);
  } catch (err: unknown) {
    if (isBinaryError(err)) return binaryFileError(file_path);
    return errorResult(`Error reading file: ${(err as Error).message}`);
  }

  // A trailing newline ends the last line; it does not start another. An empty file has no lines, as in
  // the markdown and XML outlines.
  const totalLines = source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);

  const config = getLanguageConfig(ext);
  if (!config) {
    return textResult(`No outline support for "${ext}" files \u2014 use trueline_read to read this file directly.`);
  }

  return runExtractor("Outline", async () => ({ entries: await extractOutline(source, config, depth), totalLines }));
}

/** Decoded file text via the BOM-aware path trueline_read uses, so UTF-16 is not mistaken for binary. */
async function readSource(filePath: string): Promise<string> {
  const { lines } = await transcodedLines(filePath, { detectBinary: true });
  const chunks: Buffer[] = [];
  for await (const { lineBytes, eolBytes } of lines) chunks.push(lineBytes, eolBytes);
  return Buffer.concat(chunks).toString("utf-8");
}

/** Shared try/format/empty-check/error-label plumbing for the outline extractors. */
async function runExtractor(
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
    return errorResult(`${label} extraction failed: ${(err as Error).message}`);
  }
}
