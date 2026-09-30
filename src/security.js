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
 * - `[abc]`, `[a-z]`, `[!abc]` and `[^abc]` match a single non-separator character; an
 *   unclosed `[` is literal
 * - `\` makes the next character literal, as in gitignore
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
  // Only at a boundary: a mid-segment "**" is a plain star, so folding "a**/**/x" to "a**/x"
  // would narrow the rule. The same lookbehind keeps an escaped star (`\*`) from pairing up.
  glob = glob.replace(/(?<=^|\/)(\*\*\/)+/g, "**/");

  // Tokenize the glob one unit at a time: globstar+slash, globstar, single-star, question
  // mark, a backslash escape, or any other character — then map each token to its regex.
  // A "[" that opens a class is scanned to its "]" here, and the tokens it spans are skipped.
  let classEnd = 0;
  // ReDoS: once a "[" finds no closing "]", no later one can (backslashes pair up the same way
  // from any later start), so the scan for a closer never runs twice over the same tail.
  let unclosed = false;
  const regexStr = glob.replace(/\*\*\/|\*\*|\*|\?|\\([\s\S])|[\s\S]/gu, (token, escaped, offset) => {
    if (offset < classEnd) return "";
    const atBoundary = offset === 0 || glob[offset - 1] === "/";
    if (token === "[" && !unclosed) {
      const negated = glob[offset + 1] === "!" || glob[offset + 1] === "^";
      const first = offset + (negated ? 2 : 1);
      // The first member is taken as is, so "[]a]" holds "]" and "a".
      let end = first + (glob[first] === "\\" ? 2 : 1);
      while (end < glob.length && glob[end] !== "]") end += glob[end] === "\\" ? 2 : 1;
      if (end >= glob.length) {
        unclosed = true;
      } else {
        // Only "\", "]", "^" and "-" need escaping inside a class; an unescaped "-" stays a range.
        const members = glob.slice(first, end).replace(/\\([\s\S])|[\]^]/g, (member, literal) => {
          const char = literal ?? member;
          return "\\]^-[".includes(char) ? `\\${char}` : char;
        });
        // (?!/): no class, however written, matches a path separator.
        const charClass = `(?!/)[${negated ? "^" : ""}${members}]`;
        try {
          new RegExp(charClass, "u");
          classEnd = end + 1;
          return charClass;
        } catch {
          // An out-of-order range such as "[z-a]" is no class: its brackets fall through as literals.
        }
      }
    }
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
        // `-` is not special outside a class and `\-` is a syntax error under the `u` flag below.
        return (escaped ?? token).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  });

  // dotAll: `**` compiles to `.*`, which must span names holding \n, \r, U+2028 or U+2029
  // just as `[^/]*` does; otherwise a rule covering a directory misses such names.
  // `u` makes `i` fold by Unicode simple case folding, as APFS does (U+017F "ſ" names "s");
  // without it only ASCII and toUpperCase() pairs fold, and "ſecrets" dodges "secrets/**".
  const re = new RegExp(`^${regexStr}$`, caseInsensitive ? "isu" : "su");
  regexCache.set(cacheKey, re);
  return re;
}

/**
 * Forward-slash form used for matching, applied to candidate paths and to
 * patterns alike. Like Claude Code, a Windows drive letter becomes the first
 * segment ("C:\Users" -> "/c/Users"), and a UNC root collapses to the
 * single-slash path its documented "//srv/share" spelling names.
 * @param {string} path
 * @param {boolean} [keepEscapes] leave backslashes alone: in a rule one may escape the next character
 * @returns {string}
 */
function toPosix(path, keepEscapes = false) {
  return (keepEscapes ? path : path.replace(/\\/g, "/"))
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

    // Read and parse in one step — both failures mean "no usable data". A leading BOM
    // (Windows editors) is stripped first: JSON.parse rejects it, which would drop every rule.
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse((await readFile(path, "utf-8")).replace(/^\uFEFF/, ""));
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
        } else if (tp.glob.startsWith("//")) {
          // Taken as written, a "//" rule spelled through a symlinked directory (macOS /var ->
          // /private/var) misses the real path validatePath tests. Like the anchors above, also
          // spell it through the realpath of its literal leading directories.
          const wildcard = tp.glob.search(/[*?[\\]/);
          const dirEnd = tp.glob.lastIndexOf("/", wildcard < 0 ? Infinity : wildcard);
          const dirs = dirEnd > 1 ? posixForms(tp.glob.slice(1, dirEnd)) : [];
          const spellings = dirs.map((dir) => `/${dir}${tp.glob.slice(dirEnd)}`);
          globs.push(...new Set([tp.glob, ...spellings]));
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
  // APFS and HFS+ treat NFC and NFD spellings as one name, just as they fold case, so a
  // rule typed in one form must still match a path reached in the other.
  /** @param {string} path @returns {string} */
  const fold = (path) => (caseInsensitive ? path.normalize("NFC") : path);

  // Test the path and each of its parent directories, so a rule naming a
  // directory covers its contents.
  /** @type {string[]} */
  const targets = [];
  for (let path = fold(toPosix(filePath)); path; path = path.slice(0, Math.max(path.lastIndexOf("/"), 0))) {
    targets.push(path);
  }

  /** @param {string} expanded one toPosix reading of a rule @param {string} target @returns {boolean} */
  const matchesExpanded = (expanded, target) => {
    // A trailing "/" limits a gitignore rule to directories. What kind of path
    // this is isn't known here, so the rule applies to either (fail-closed).
    const glob = fold(expanded).replace(/(?<=.)\/+$/, "");
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

  // A rule denies a path if any reading of it matches. Claude Code reads Read/Edit rules as
  // gitignore patterns: "[...]" is a class and "\" escapes, so "key[12].pem" guards key1.pem.
  // Earlier releases took brackets literally and "\" as a Windows separator ("C:\secrets\**");
  // both readings stay, so files named like the rule and rules written that way remain guarded.
  // https://code.claude.com/docs/en/permissions ("Read and Edit")
  /** @param {string} declared @param {string} target @returns {boolean} */
  const matches = (declared, target) =>
    expandPathPrefix(declared).some((expanded) =>
      [toPosix(expanded, true), toPosix(expanded).replace(/[[\]]/g, "\\$&")].some((reading) =>
        matchesExpanded(reading, target),
      ),
    );

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
