// A decoded line with its hash, ready for output.
export interface DecodedLine {
  lineNumber: number;
  text: string;
  hash: number;
  isMatch: boolean;
}

// A contiguous block of matches + context, ready for formatting.
export interface SearchMatch {
  lines: DecodedLine[];
  firstLine: number;
  lastLine: number;
}

// Result of searching a single file.
export interface FileSearchResult {
  filePath: string;
  resolvedPath: string;
  matches: SearchMatch[];
  totalMatches: number;
  capped: boolean;
  error?: string;
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
