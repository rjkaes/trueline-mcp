// Shared allowed-dirs resolution used by both the MCP server and the CLI.

import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

/**
 * Resolve the set of directories trueline tools are allowed to access.
 *
 * Callers are expected to prepend projectDir themselves (so the server can
 * pass it separately from the allow-list).
 * The Claude config dir entry is added only when running under Claude Code.
 * @returns {Promise<string[]>}
 */
export async function resolveAllowedDirs() {
  /** @type {string[]} */
  const dirs = [];

  // Claude Code's config dir — only relevant for Claude Code. CLAUDE_CONFIG_DIR relocates it,
  // as security.js assumes for settings.json.
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    await mkdir(claudeDir, { recursive: true }).catch(() => {});
    const realClaudeDir = await realpath(claudeDir).catch(() => null);
    if (realClaudeDir) dirs.push(realClaudeDir);
  }

  // TRUELINE_ALLOWED_DIRS — platform-delimited additional paths
  const extra = process.env.TRUELINE_ALLOWED_DIRS;
  if (extra) {
    for (const raw of extra.split(delimiter).filter(Boolean)) {
      const resolved = await realpath(raw).catch(() => null);
      if (resolved) dirs.push(resolved);
    }
  }

  return dirs;
}

/**
 * Resolve projectDir (from CLAUDE_PROJECT_DIR or cwd, realpath'd) and the
 * allowed-dirs list. Shared by the MCP server and every CLI subcommand so
 * they agree on the same project root and security boundary.
 * @returns {Promise<{ projectDir: string; allowedDirs: string[] }>}
 */
export async function resolveProjectDirs() {
  // `||`, not `??`: an empty CLAUDE_PROJECT_DIR means unset, and realpath("") throws under node.
  const rawProjectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectDir = await realpath(rawProjectDir).catch(() => rawProjectDir);
  const allowedDirs = await resolveAllowedDirs();
  return { projectDir, allowedDirs };
}

/**
 * Whether realPath equals or sits under one of the realpath'd bases.
 * Case-insensitive on Windows, where realpath() and realpathSync() can
 * disagree on drive-letter casing (C:\ vs c:\).
 * @param {string} realPath
 * @param {string[]} bases
 * @returns {boolean}
 */
export function isContained(realPath, bases) {
  const win = process.platform === "win32";
  const target = win ? realPath.toLowerCase() : realPath;
  return bases.some((base) => {
    const b = win ? base.toLowerCase() : base;
    // A root base ("/", C:\) already ends in the separator.
    return target === b || target.startsWith(b.endsWith(sep) ? b : b + sep);
  });
}
