/**
 * trueline_search tool handler (orchestrator).
 *
 * Accepts one or more files, delegates to the line-by-line or multiline
 * engine per file, and formats unified output with per-line hashes,
 * checksums, and refs ready for immediate editing.
 */
import { checksumToLetters, hashToLetters, foldHash, FNV_OFFSET_BASIS } from "../hash.ts";
import { displayPath, expandGlobs, isAbsolutePathArg, relativePathError, validatePath } from "./shared.ts";
import { errorResult, textResult, type ToolResult } from "./types.ts";
import { searchLineByLine } from "./search-line.ts";
import { searchMultiline } from "./search-multiline.ts";
import type { FileSearchResult, LineMatcher } from "./search-types.ts";

interface SearchParams {
  file_path?: string;
  file_paths?: string[];
  pattern: string;
  context_lines?: number;
  max_matches?: number;
  max_match_lines?: number;
  case_insensitive?: boolean;
  regex?: boolean;
  multiline?: boolean;
  projectDir?: string;
  allowedDirs?: string[];
  requireAbsolutePath?: boolean;
}

export async function handleSearch(params: SearchParams): Promise<ToolResult> {
  const { pattern, projectDir, allowedDirs, requireAbsolutePath } = params;
  const contextLines = params.context_lines ?? 2;
  const maxMatches = params.max_matches ?? 10;

  const MAX_CONTEXT_LINES = 100_000;
  if (contextLines < 0 || contextLines > MAX_CONTEXT_LINES || !Number.isFinite(contextLines)) {
    return errorResult(`context_lines must be between 0 and ${MAX_CONTEXT_LINES}`);
  }

  // Normalize file_path / file_paths
  const rawPaths = normalizeFilePaths(params);

  if (requireAbsolutePath && rawPaths.length === 1 && !isAbsolutePathArg(rawPaths[0])) {
    return relativePathError(rawPaths[0]);
  }

  // Reject relative entries before glob expansion, so a relative glob never
  // resolves against a possibly-stale projectDir. Absolute siblings still
  // proceed (graceful degradation).
  const rejectedSections: string[] = [];
  let candidatePaths = rawPaths;
  if (requireAbsolutePath) {
    candidatePaths = rawPaths.filter((entry) => {
      if (isAbsolutePathArg(entry)) return true;
      const errorText = (relativePathError(entry).content[0] as { text: string }).text;
      rejectedSections.push(`${entry}:\nerror: ${errorText}\n`);
      return false;
    });
  }

  const filePaths = await expandGlobs(candidatePaths, projectDir);
  if (filePaths.length === 0) {
    if (rejectedSections.length > 0) return textResult(rejectedSections.join("\n"));
    return errorResult("file_paths must be a non-empty array");
  }

  // Search each file, tracking global match budget
  let matchBudget = maxMatches;
  const results: FileSearchResult[] = [];
  const multiFile = filePaths.length > 1 || rejectedSections.length > 0;

  if (params.multiline) {
    // Multiline mode: build regex with dotAll flag, delegate to multiline engine
    const maxMatchLines = params.max_match_lines ?? 50;

    if (pattern === "") {
      return errorResult("Pattern must not be empty for multiline search");
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, `s${params.case_insensitive ? "i" : ""}`);
    } catch {
      return errorResult(`Invalid regex pattern: "${pattern}"`);
    }

    for (const fp of filePaths) {
      const validated = await validatePath(fp, "Read", projectDir, allowedDirs);
      if (!validated.ok) {
        results.push({
          filePath: fp,
          resolvedPath: fp,
          matches: [],
          totalMatches: 0,
          capped: false,
          error: validated.error.content[0].text,
        });
        continue;
      }

      const fileResult = await searchMultiline({
        resolvedPath: validated.resolvedPath,
        regex,
        contextLines,
        maxMatches: matchBudget,
        maxMatchLines,
      });
      fileResult.filePath = fp;
      fileResult.resolvedPath = validated.resolvedPath;
      results.push(fileResult);
      matchBudget = Math.max(0, matchBudget - fileResult.matches.length);
    }
  } else {
    // Line-by-line mode: reject newline patterns, build line matcher
    if (pattern.includes("\n") || pattern.includes("\r")) {
      return errorResult(
        "Pattern contains newlines. trueline_search matches line-by-line, so multiline patterns cannot match. " +
          "Set multiline=true for patterns spanning multiple lines, or search for a single-line substring instead.",
      );
    }

    const matcherResult = buildMatcher(pattern, params.regex || false, params.case_insensitive || false);
    if (!matcherResult.ok) return matcherResult.error;
    const matchLine = matcherResult.matcher;

    for (const fp of filePaths) {
      const validated = await validatePath(fp, "Read", projectDir, allowedDirs);
      if (!validated.ok) {
        results.push({
          filePath: fp,
          resolvedPath: fp,
          matches: [],
          totalMatches: 0,
          capped: false,
          error: validated.error.content[0].text,
        });
        continue;
      }

      const fileResult = await searchLineByLine({
        resolvedPath: validated.resolvedPath,
        matchLine,
        contextLines,
        maxMatches: matchBudget,
      });
      fileResult.filePath = fp;
      fileResult.resolvedPath = validated.resolvedPath;
      results.push(fileResult);

      const captured = fileResult.matches.reduce((sum, m) => sum + m.lines.filter((l) => l.isMatch).length, 0);
      matchBudget = Math.max(0, matchBudget - captured);
    }
  }

  const formatted = formatResults(
    results,
    filePaths,
    pattern,
    maxMatches,
    multiFile,
    projectDir,
    params.regex || params.multiline,
  );
  if (rejectedSections.length === 0) return formatted;

  // Prepend rejected-path sections so a relative sibling doesn't hide the
  // successful matches from the rest of the batch.
  const formattedText = (formatted.content[0] as { text: string }).text;
  return textResult([...rejectedSections, formattedText].join("\n"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFilePaths(params: SearchParams): string[] {
  if (params.file_paths && params.file_paths.length > 0) return params.file_paths;
  if (params.file_path) return [params.file_path];
  return [];
}

function buildMatcher(
  pattern: string,
  regex: boolean,
  caseInsensitive: boolean,
): { ok: true; matcher: LineMatcher } | { ok: false; error: ToolResult } {
  if (regex) {
    try {
      const re = new RegExp(pattern, caseInsensitive ? "i" : undefined);
      return { ok: true, matcher: (text) => re.test(text) };
    } catch {
      return { ok: false, error: errorResult(`Invalid regex pattern: "${pattern}"`) };
    }
  }
  if (caseInsensitive) {
    const lower = pattern.toLowerCase();
    return { ok: true, matcher: (text) => text.toLowerCase().includes(lower) };
  }
  return { ok: true, matcher: (text) => text.includes(pattern) };
}

function formatResults(
  results: FileSearchResult[],
  filePaths: string[],
  pattern: string,
  maxMatches: number,
  multiFile: boolean,
  projectDir: string | undefined,
  isRegex?: boolean,
): ToolResult {
  const grandTotal = results.reduce((sum, r) => sum + r.totalMatches, 0);
  const anyCapped = results.some((r) => r.capped);

  // Single-file mode: if the only file had a validation/binary error, propagate it as an error result
  if (!multiFile && results.length === 1 && results[0].error) {
    return errorResult(results[0].error);
  }

  if (grandTotal === 0) {
    let msg = multiFile
      ? `No matches for pattern "${pattern}" across ${filePaths.length} files`
      : `No matches for pattern "${pattern}" in ${displayPath(filePaths[0], projectDir)}`;
    if (!isRegex && /[.*+?^${}()|[\]\\]/.test(pattern)) {
      msg +=
        "\n\n(hint: pattern contains regex metacharacters but was searched literally — add regex=true for regex matching)";
    }
    return textResult(msg);
  }

  const parts: string[] = [];
  let matchesEmitted = 0;

  for (const result of results) {
    if (result.error) {
      if (multiFile) {
        parts.push(`${displayPath(result.filePath, projectDir)}:`);
        parts.push(`error: ${result.error}`);
        parts.push("");
      }
      continue;
    }
    if (result.matches.length === 0) continue;

    if (multiFile) {
      if (parts.length > 0) parts.push("");
      parts.push(`${displayPath(result.filePath, projectDir)}:`);
    }

    for (let i = 0; i < result.matches.length; i++) {
      const match = result.matches[i];
      let checksumHash = FNV_OFFSET_BASIS;
      let firstLetters = "";
      let lastLetters = "";

      if (!multiFile && i > 0) parts.push("");

      for (const line of match.lines) {
        const letters = hashToLetters(line.hash);
        checksumHash = foldHash(checksumHash, line.hash);
        if (!firstLetters) firstLetters = letters;
        lastLetters = letters;

        const isMarked = line.isMatch && matchesEmitted < maxMatches;
        if (isMarked) matchesEmitted++;
        const prefix = isMarked ? "->" : "";
        parts.push(`${prefix}${letters}${line.lineNumber}\t${line.text}`);
      }

      const ck = checksumToLetters(checksumHash);
      parts.push("");
      parts.push(`ref: ${firstLetters}${match.firstLine}-${lastLetters}${match.lastLine}/${ck}`);
    }
  }

  if (grandTotal > maxMatches) {
    parts.push("");
    const countLabel = anyCapped ? `${grandTotal}+` : `${grandTotal}`;
    const scope = multiFile ? ` across ${filePaths.length} files` : "";
    parts.push(`(showing ${maxMatches} of ${countLabel} matches${scope} — increase max_matches to see more)`);
  }

  return textResult(parts.join("\n"));
}
