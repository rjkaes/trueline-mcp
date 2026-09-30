// A decoded line with its hash, ready for output.
export interface DecodedLine {
  lineNumber: number;
  text: string;
  hash: number;
  isMatch: boolean;
}

// Result of searching a single file.
export interface FileSearchResult {
  filePath: string;
  // Each match is a contiguous block of matches + context, ready for formatting.
  matches: DecodedLine[][];
  totalMatches: number;
  capped: boolean;
  // Multiline matches skipped for spanning more than max_match_lines.
  oversizeMatches?: number;
  error?: string;
}

// Result for a file that couldn't be scanned (binary, unreadable, or rejected by path validation).
export function failedSearchResult(path: string, error: string): FileSearchResult {
  return { filePath: path, matches: [], totalMatches: 0, capped: false, error };
}

// A function that tests whether a line matches the search pattern.
export type LineMatcher = (text: string) => boolean;

// Parameters for the line-by-line engine.
export interface EngineParams {
  resolvedPath: string;
  matchLine: LineMatcher;
  contextLines: number;
  maxMatches: number;
}
