// Shared allowed-dirs resolution used by both the MCP server and the CLI.
//
// The server historically included ~/.claude/ when running under Claude Code
// (gated on CLAUDE_CODE_ENTRYPOINT). The CLI previously only added projectDir
// plus TRUELINE_ALLOWED_DIRS. Extracting this shared module aligns both.

import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Resolve the set of directories trueline tools are allowed to access.
 *
 * Always returns an empty array — callers are expected to prepend projectDir
 * themselves (so the server can pass it separately from the allow-list).
 * The ~/.claude/ entry is added only when running under Claude Code.
 */
export async function resolveAllowedDirs(): Promise<string[]> {
  const dirs: string[] = [];

  // ~/.claude/ — only relevant for Claude Code
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    const claudeDir = join(homedir(), ".claude");
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
