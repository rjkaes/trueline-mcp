import { readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

// ==============================================================================
// Module-level caches
// ==============================================================================

// Settings cache: keyed by file path, stores the last-seen mtime and parsed
// globs. Avoids re-reading and re-parsing settings.json on every tool call.
/** @type {Map<string, { mtime: number; globs: string[] | null }>} */
const settingsCache = new Map();

// Regex cache: keyed by "glob:caseInsensitive", avoids re-compiling the same
// pattern on every evaluateFilePath call.
/** @type {Map<string, RegExp>} */
const regexCache = new Map();

// Home directory spellings for "~/" rules. homedir() is fixed for the
// process, so its realpath is resolved once.
/** @type {string[] | undefined} */
let homeForms;

/**
 * Clear internal caches. Exported for testing only.
 */
export function clearCaches() {
  settingsCache.clear();
  regexCache.clear();
  homeForms = undefined;
}

// ==============================================================================
// Pattern Parsing
// ==============================================================================

/**
 * Parse any tool permission pattern like "ToolName(glob)".
 * Returns { tool, glob } or null if not a valid pattern.
 * @param {string} pattern
 * @returns {{ tool: string; glob: string } | null}
 */
export function parseToolPattern(pattern) {
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
 *
 * @param {string} glob
 * @param {boolean} [caseInsensitive=false]
 * @returns {RegExp}
 */
export function fileGlobToRegex(glob, caseInsensitive = false) {
  const cacheKey = `${glob}:${caseInsensitive}`;
  const cached = regexCache.get(cacheKey);
  if (cached) return cached;

  // Collapse consecutive globstars ("**/**/**/") into a single "**/" to
  // prevent exponential backtracking — each `**/` becomes `(.*/)?` in the
  // regex, and multiple adjacent groups cause catastrophic backtracking.
  glob = glob.replace(/(\*\*\/)+/g, "**/");

  // Tokenize the glob: match globstar+slash, globstar, single-star, question
  // mark, or a run of literal characters — then map each token to its regex.
  const regexStr = glob.replace(/\*\*\/|\*\*|\*|\?|[^*?]+/g, (token, offset) => {
    const atBoundary = offset === 0 || glob[offset - 1] === "/";
    switch (token) {
      case "**/":
        return atBoundary ? "(.*/)?" : "[^/]*/";
      case "**":
        return atBoundary ? ".*" : "[^/]*";
      case "*":
        return "[^/]*";
      case "?":
        return "[^/]";
      default:
        return token.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
    }
  });

  const re = new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
  regexCache.set(cacheKey, re);
  return re;
}

/**
 * Forward-slash form used for matching, applied to candidate paths and to
 * patterns alike. Like Claude Code, a Windows drive letter becomes the first
 * segment ("C:\Users" -> "/c/Users"), and a UNC root collapses to the
 * single-slash path its documented "//srv/share" spelling names.
 * @param {string} path
 * @returns {string}
 */
function toPosix(path) {
  return path
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
    .replace(/^\/{2,}/, "/");
}

/**
 * A directory's lexical spelling and its symlink-free realpath, both in
 * forward-slash form. A rule anchored at one must still match a path that
 * reaches the directory through the other (a symlinked home or project dir).
 * realpathSync.native agrees with the async realpath that validatePath uses,
 * Windows 8.3 short names included.
 * @param {string} dir
 * @returns {string[]}
 */
function posixForms(dir) {
  const forms = [toPosix(dir)];
  try {
    forms.push(toPosix(realpathSync.native(dir)));
  } catch {
    // A directory that does not exist has no other spelling.
  }
  return [...new Set(forms)];
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
 *   3. $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json (global)
 *
 * @param {string} toolName
 * @param {string} [projectDir]
 * @param {string} [globalSettingsPath]
 * @returns {Promise<string[][]>}
 */
export async function readToolDenyPatterns(toolName, projectDir, globalSettingsPath) {
  /** @param {string} path @param {string} anchorDir @returns {Promise<string[] | null>} */
  const extractGlobs = async (path, anchorDir) => {
    const cacheKey = `${path}:${toolName}:${anchorDir}`;
    // Check mtime — if unchanged since last call, return cached result.
    /** @type {number} */
    let mtime;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      return null;
    }

    const cached = settingsCache.get(cacheKey);
    if (cached && cached.mtime === mtime) return cached.globs;

    // Read and parse in one step — both failures mean "no usable data".
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf-8"));
    } catch {
      settingsCache.set(cacheKey, { mtime, globs: null });
      return null;
    }

    // Extract globs for the target tool from permissions.deny.
    const obj =
      typeof parsed === "object" && parsed !== null ? /** @type {Record<string, unknown>} */ (parsed) : undefined;
    const perms =
      typeof obj?.permissions === "object" && obj.permissions !== null
        ? /** @type {Record<string, unknown>} */ (obj.permissions)
        : undefined;
    const denyArr = perms?.deny;
    /** @type {string[]} */
    const globs = [];
    if (Array.isArray(denyArr)) {
      const anchors = posixForms(resolve(anchorDir));
      for (const entry of denyArr) {
        if (typeof entry !== "string") continue;
        const tp = parseToolPattern(entry);
        if (tp?.tool !== toolName) continue;
        // A single leading "/" is relative to the settings source, not the filesystem root.
        if (tp.glob.startsWith("/") && !tp.glob.startsWith("//")) {
          globs.push(...anchors.map((anchor) => `${anchor}${tp.glob}`));
        } else {
          globs.push(tp.glob);
        }
      }
    }
    settingsCache.set(cacheKey, { mtime, globs });
    return globs;
  };

  // Each settings file with the directory its "/path" patterns are relative to:
  // the project for project settings, the file's own directory (~/.claude) for user settings.
  /** @type {[path: string, anchorDir: string][]} */
  const sources = [];
  if (projectDir) {
    sources.push([resolve(projectDir, ".claude", "settings.local.json"), projectDir]);
    sources.push([resolve(projectDir, ".claude", "settings.json"), projectDir]);
  }
  // CLAUDE_CONFIG_DIR relocates the user settings file (https://code.claude.com/docs/en/env-vars).
  const configDir = process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude");
  const globalPath = globalSettingsPath ?? resolve(configDir, "settings.json");
  sources.push([globalPath, dirname(globalPath)]);

  // Read all settings files in parallel — they're independent.
  const allGlobs = await Promise.all(sources.map(([path, anchorDir]) => extractGlobs(path, anchorDir)));
  return allGlobs.filter((g) => g !== null);
}

// ==============================================================================
// File Path Evaluation
// ==============================================================================

/**
 * Expand the pattern prefixes whose meaning does not depend on the settings
 * source: "//path" is absolute, "~/path" sits under the home directory, and
 * "./path" is relative like a bare "path". A single leading "/" is left alone;
 * readToolDenyPatterns has already anchored it to its settings source.
 * https://code.claude.com/docs/en/permissions ("Read and Edit")
 * @param {string} glob
 * @returns {string[]}
 */
function expandPathPrefix(glob) {
  if (glob.startsWith("//")) return [glob.slice(1)];
  if (glob.startsWith("~/")) {
    homeForms ??= posixForms(homedir());
    return homeForms.map((home) => `${home}${glob.slice(1)}`);
  }
  if (glob.startsWith("./")) return [glob.slice(2)];
  return [glob];
}

/**
 * Check if a file path should be denied based on deny globs.
 *
 * Normalizes backslashes to forward slashes before matching so that
 * Windows paths work with Unix-style glob patterns. As in gitignore, a rule
 * that matches a directory also denies everything under it, and a "!" rule
 * reopens what earlier relative rules from the same source matched.
 * https://code.claude.com/docs/en/permissions ("Read and Edit")
 *
 * @param {string} filePath
 * @param {string[][]} denyGlobs one list per settings source, in file order
 * @param {boolean} [caseInsensitive] defaults on for win32 and darwin, whose default
 *   filesystems are case-insensitive: "VAULT/key" must not dodge a "vault/**" rule
 * @returns {{ denied: boolean; matchedPattern?: string }}
 */
export function evaluateFilePath(
  filePath,
  denyGlobs,
  caseInsensitive = process.platform === "win32" || process.platform === "darwin",
) {
  // Test the path and each of its parent directories, so a rule naming a
  // directory covers its contents.
  /** @type {string[]} */
  const targets = [];
  for (let path = toPosix(filePath); path; path = path.slice(0, Math.max(path.lastIndexOf("/"), 0))) {
    targets.push(path);
  }

  /** @param {string} expanded @param {string} target @returns {boolean} */
  const matchesExpanded = (expanded, target) => {
    // A trailing "/" limits a gitignore rule to directories. What kind of path
    // this is isn't known here, so the rule applies to either (fail-closed).
    const glob = toPosix(expanded).replace(/(?<=.)\/+$/, "");
    const re = fileGlobToRegex(glob, caseInsensitive);
    if (re.test(target)) return true;

    // Glob without "/" — also test the basename so that a simple pattern like
    // ".env" matches "/any/path/.env" (gitignore semantics).
    if (!glob.includes("/")) return re.test(target.slice(target.lastIndexOf("/") + 1));

    // Relative glob with "/" — treat as a suffix match via globstar prefix.
    // e.g. deny pattern "src/.env" should match "/project/src/.env".
    if (!glob.startsWith("/") && !glob.startsWith("**/")) {
      return fileGlobToRegex(`**/${glob}`, caseInsensitive).test(target);
    }

    return false;
  };

  /** @param {string} declared @param {string} target @returns {boolean} */
  const matches = (declared, target) =>
    expandPathPrefix(declared).some((expanded) => matchesExpanded(expanded, target));

  // Claude Code reads a "!" body relative to the working directory, which is not
  // known here, so only a bare name ("!sample.env") reopens anything. Anything
  // with a "/" reopens nothing, and names match case-sensitively: both err
  // toward denying.
  /** @param {string} negated @param {string} target @returns {boolean} */
  const reopens = (negated, target) =>
    !negated.includes("/") && fileGlobToRegex(negated).test(target.slice(target.lastIndexOf("/") + 1));

  for (const rules of denyGlobs) {
    for (const target of targets) {
      /** @type {string | undefined} */
      let relativeMatch;
      for (const rule of rules) {
        if (rule.startsWith("!")) {
          if (relativeMatch && reopens(rule.slice(1), target)) relativeMatch = undefined;
        } else if (matches(rule, target)) {
          // A "!" rule cannot reach a rule anchored with "/", "//" or "~/".
          if (/^~?\//.test(toPosix(rule))) return { denied: true, matchedPattern: rule };
          relativeMatch ??= rule;
        }
      }
      if (relativeMatch) return { denied: true, matchedPattern: relativeMatch };
    }
  }
  return { denied: false };
}
