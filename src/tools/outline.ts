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
import { extractMarkdownOutline } from "../outline/markdown.ts";
import { extractXmlOutline } from "../outline/xml.ts";

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
import { validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";

interface OutlineParams {
  file_paths: string[];
  depth?: number;
  projectDir?: string;
  allowedDirs?: string[];
}

export async function handleOutline(params: OutlineParams): Promise<ToolResult> {
  const { projectDir, allowedDirs } = params;

  const filePaths = params.file_paths;
  if (filePaths.length === 0) {
    return errorResult("Provide at least one file path in file_paths.");
  }

  // Single file — preserve original compact output
  if (filePaths.length === 1) {
    return outlineOneFile(filePaths[0], params.depth, projectDir, allowedDirs);
  }

  // Multiple files — collect results with per-file headers
  const sections: string[] = [];
  let totalSymbols = 0;
  let totalLines = 0;

  for (const fp of filePaths) {
    const result = await outlineOneFile(fp, params.depth, projectDir, allowedDirs);
    const text = result.content[0].type === "text" ? result.content[0].text : "";

    // Extract counts from the summary line, e.g. "(12 symbols, 200 source lines)"
    const countsMatch = text.match(/\((\d+) symbols?, (\d+) source lines?\)/);
    if (countsMatch) {
      totalSymbols += Number(countsMatch[1]);
      totalLines += Number(countsMatch[2]);
    }

    const displayPath = projectDir && fp.startsWith(projectDir) ? fp.slice(projectDir.length + 1) : fp;
    sections.push(`--- ${displayPath} ---\n${text}`);
  }

  const combined = sections.join("\n\n");
  const summary = `\n(${totalSymbols} symbols, ${totalLines} source lines across ${filePaths.length} files)`;
  return textResult(combined + summary);
}

async function outlineOneFile(
  file_path: string,
  depth: number | undefined,
  projectDir: string | undefined,
  allowedDirs: string[] | undefined,
): Promise<ToolResult> {
  const validated = await validatePath(file_path, "Read", projectDir, allowedDirs);
  if (!validated.ok) return validated.error;

  const ext = extname(validated.resolvedPath).toLowerCase();

  // Streaming extractors (no tree-sitter, no full-file load)
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    try {
      const { entries, totalLines } = await extractMarkdownOutline(validated.resolvedPath);
      if (entries.length === 0) {
        return textResult(`(no outline entries found in ${totalLines}-line file)`);
      }
      return textResult(formatOutline(entries, totalLines));
    } catch (err: unknown) {
      return errorResult(`Markdown outline extraction failed: ${(err as Error).message}`);
    }
  }

  if (XML_EXTENSIONS.has(ext)) {
    try {
      const { entries, totalLines } = await extractXmlOutline(validated.resolvedPath, depth);
      if (entries.length === 0) {
        return textResult(`(no outline entries found in ${totalLines}-line file)`);
      }
      return textResult(formatOutline(entries, totalLines));
    } catch (err: unknown) {
      return errorResult(`XML outline extraction failed: ${(err as Error).message}`);
    }
  }

  let source: string;
  try {
    const buf = readFileSync(validated.resolvedPath);
    if (buf.includes(0)) {
      return errorResult(`"${file_path}" appears to be a binary file`);
    }
    source = buf.toString("utf-8");
  } catch (err: unknown) {
    return errorResult(`Error reading file: ${(err as Error).message}`);
  }

  let totalLines = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) totalLines++;

  const config = getLanguageConfig(ext);
  if (!config) {
    return textResult(`No outline support for "${ext}" files \u2014 use trueline_read to read this file directly.`);
  }

  try {
    const entries = await extractOutline(source, config, depth);
    if (entries.length === 0) {
      return textResult(`(no outline entries found in ${totalLines}-line file)`);
    }
    return textResult(formatOutline(entries, totalLines));
  } catch (err: unknown) {
    return errorResult(`Outline extraction failed: ${(err as Error).message}`);
  }
}
