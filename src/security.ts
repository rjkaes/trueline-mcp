import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ==============================================================================
// Module-level caches
// ==============================================================================

// Settings cache: keyed by file path, stores the last-seen mtime and parsed
// globs. Avoids re-reading and re-parsing settings.json on every tool call.
const settingsCache = new Map<string, { mtime: number; globs: string[] | null }>();

// Regex cache: keyed by "glob:caseInsensitive", avoids re-compiling the same
// pattern on every evaluateFilePath call.
const regexCache = new Map<string, RegExp>();

// ==============================================================================
// Pattern Parsing
// ==============================================================================

/**
 * Parse any tool permission pattern like "ToolName(glob)".
 * Returns { tool, glob } or null if not a valid pattern.
 */
export function parseToolPattern(
  pattern: string,
): { tool: string; glob: string } | null {
  // .+ is greedy: for "Read(some(path))" it captures "some(path)"
  // because $ forces the final \) to match only the last paren.
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  return match ? { tool: match[1], glob: match[2] } : null;
}

// ==============================================================================
// Glob-to-Regex Conversion
// ==============================================================================

/**
 * Convert a file path glob to a regex.
 *
 * - `**` matches any number of path segments (including zero)
 * - `*` matches anything except path separators
 * - `?` matches a single non-separator character
 * - Paths are matched with forward slashes (callers normalize first)
 */
export function fileGlobToRegex(
  glob: string,
  caseInsensitive: boolean = false,
): RegExp {
  const cacheKey = `${glob}:${caseInsensitive}`;
  const cached = regexCache.get(cacheKey);
  if (cached) return cached;

  // Collapse consecutive globstars ("**/**/**/") into a single "**/" to
  // prevent exponential backtracking — each `**/` becomes `(.*/)?` in the
  // regex, and multiple adjacent groups cause catastrophic backtracking.
  glob = glob.replace(/(\*\*\/)+/g, "**/");

  // Tokenize the glob: match globstar+slash, globstar, single-star, question
  // mark, or a run of literal characters — then map each token to its regex.
  const regexStr = glob.replace(
    /\*\*\/|\*\*|\*|\?|[^*?]+/g,
    (token, offset) => {
      const atBoundary = offset === 0 || glob[offset - 1] === "/";
      switch (token) {
        case "**/": return atBoundary ? "(.*/)?" : "[^/]*/";
        case "**":  return atBoundary ? ".*" : "[^/]*";
        case "*":   return "[^/]*";
        case "?":   return "[^/]";
        default:    return token.replace(/[.+^${}()|[\]\\\/-]/g, "\\$&");
      }
    },
  );

  const re = new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
  regexCache.set(cacheKey, re);
  return re;
}

// ==============================================================================
// Settings Reader
// ==============================================================================

/**
 * Read deny patterns for a specific tool from the 3-tier settings files.
 *
 * Returns an array of arrays (one per settings file found, in precedence
 * order). Each inner array contains the extracted glob strings.
 *
 * Precedence order (most local first):
 *   1. .claude/settings.local.json  (project-local)
 *   2. .claude/settings.json        (project-shared)
 *   3. ~/.claude/settings.json      (global)
 */
export async function readToolDenyPatterns(
  toolName: string,
  projectDir?: string,
  globalSettingsPath?: string,
): Promise<string[][]> {
  const result: string[][] = [];

  const extractGlobs = async (path: string): Promise<string[] | null> => {
    // Check mtime before reading. If the file hasn't changed since the last
    // call, return the cached result without reading from disk.
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      // File doesn't exist — cache a miss so we don't re-stat on every call
      settingsCache.set(path, { mtime: -1, globs: null });
      return null;
    }

    const cached = settingsCache.get(path);
    if (cached && cached.mtime === mtime) return cached.globs;

    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      settingsCache.set(path, { mtime, globs: null });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      settingsCache.set(path, { mtime, globs: null });
      return null;
    }

    const deny = (parsed as Record<string, unknown>)?.permissions as Record<string, unknown>;
    const denyArr = deny?.deny;
    if (!Array.isArray(denyArr)) {
      settingsCache.set(path, { mtime, globs: [] });
      return [];
    }

    const globs: string[] = [];
    for (const entry of denyArr) {
      if (typeof entry !== "string") continue;
      const tp = parseToolPattern(entry);
      if (tp && tp.tool === toolName) {
        globs.push(tp.glob);
      }
    }
    settingsCache.set(path, { mtime, globs });
    return globs;
  };

  const paths: string[] = [];
  if (projectDir) {
    paths.push(resolve(projectDir, ".claude", "settings.local.json"));
    paths.push(resolve(projectDir, ".claude", "settings.json"));
  }
  paths.push(
    globalSettingsPath ?? resolve(homedir(), ".claude", "settings.json"),
  );

  // Read all settings files in parallel — they're independent.
  const allGlobs = await Promise.all(paths.map(extractGlobs));
  for (const globs of allGlobs) {
    if (globs !== null) result.push(globs);
  }

  return result;
}

// ==============================================================================
// File Path Evaluation
// ==============================================================================

/**
 * Check if a file path should be denied based on deny globs.
 *
 * Normalizes backslashes to forward slashes before matching so that
 * Windows paths work with Unix-style glob patterns.
 */
export function evaluateFilePath(
  filePath: string,
  denyGlobs: string[][],
  caseInsensitive: boolean = process.platform === "win32",
): { denied: boolean; matchedPattern?: string } {
  // Normalize backslashes to forward slashes for cross-platform matching
  const normalized = filePath.replace(/\\/g, "/");
  // For globs without path separators, also test just the basename so that
  // a simple pattern like ".env" matches "/any/path/.env" — the same
  // gitignore-style semantics Claude Code settings use.
  const basename = normalized.split("/").pop() ?? normalized;

  for (const globs of denyGlobs) {
    for (const glob of globs) {
      const re = fileGlobToRegex(glob, caseInsensitive);
      if (re.test(normalized)) {
        return { denied: true, matchedPattern: glob };
      }
      // Pattern has no "/" — try matching just the filename (gitignore semantics)
      if (!glob.includes("/") && re.test(basename)) {
        return { denied: true, matchedPattern: glob };
      }
      // Relative pattern containing "/" but not anchored with "/" or "*":
      // treat as a suffix — "src/.env" should match "/project/src/.env".
      if (!glob.startsWith("/") && !glob.startsWith("*") && glob.includes("/")) {
        const normCmp = caseInsensitive ? normalized.toLowerCase() : normalized;
        const globCmp = caseInsensitive ? glob.toLowerCase() : glob;
        if (normCmp.endsWith("/" + globCmp) || normCmp === globCmp) {
          return { denied: true, matchedPattern: glob };
        }
      }
    }
  }

  return { denied: false };
}
