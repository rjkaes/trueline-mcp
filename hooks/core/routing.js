// ==============================================================================
// Platform-Agnostic Hook Routing
// ==============================================================================
//
// Normalizes tool names across platforms via TOOL_ALIASES, then makes
// block/pass-through decisions based on file size and edit token cost.
// Returns normalized {action, reason} objects that platform-specific
// formatters translate to the right JSON shape.

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { OUTLINEABLE_EXTENSIONS } from "../../src/outline/supported-extensions.js";

// Maps platform-specific built-in tool names to canonical names.
const TOOL_ALIASES = {
  // Gemini CLI
  read_file: "Read",
  read_many_files: "Read",
  edit_file: "Edit",
  write_file: "Write",
  run_shell_command: "Bash",
  // VS Code Copilot
  replace_string_in_file: "Edit",
  multi_replace_string_in_file: "MultiEdit",
  // OpenCode
  view: "Read",
  bash: "Bash",
  // Codex CLI
  shell: "Bash",
};

// Bash file-peek detection. These commands inspect file contents outside
// trueline and miss hash-verified refs, ranged reads, and AST outlines.
// We nudge (not block) so one-off uses still work.
const BASH_PEEK_DETECTORS = [
  // cat FILE (with or without leading flags, no piping *into* cat)
  { rx: /^\s*cat\b(?:\s+-[A-Za-z]+)*\s+([^\s|><;&]+)/, tool: "cat", hint: "trueline_read" },
  // sed -n 'N,Mp' FILE  or  sed -n N,Mp FILE
  {
    rx: /^\s*sed\s+-n\s+['"]?\d+(?:,\d+)?[pd]['"]?\s+([^\s|><;&]+)/,
    tool: "sed -n",
    hint: "trueline_read with ranges",
  },
  // head / tail FILE  (with optional -n N, -c N, or -N)
  {
    rx: /^\s*(head|tail)\b(?:\s+(?:-[nc]\s*\d+|-\d+))?\s+([^\s|><;&-][^\s|><;&]*)/,
    tool: null,
    hint: "trueline_read",
    fileGroup: 2,
    toolGroup: 1,
  },
];

// Different platforms use different field names for file paths in tool input.
const FILE_PATH_FIELDS = ["file_path", "path", "target_file"];

// Fields that indicate a partial/ranged read across platforms:
//   Claude Code / OpenCode: offset, limit
//   Gemini CLI: start_line, end_line
const PARTIAL_READ_FIELDS = ["offset", "limit", "start_line", "end_line"];

// Files at or above this size are blocked with full redirect guidance.
const LARGE_FILE_THRESHOLD = 10240; // 10KB
// Files between MEDIUM and LARGE are blocked with a concise redirect.
const MEDIUM_FILE_THRESHOLD = 3072; // 3KB

/**
 * @param {string} toolName
 * @returns {string}
 */
export function canonicalToolName(toolName) {
  return TOOL_ALIASES[toolName] ?? toolName;
}

/**
 * Extract a file path from tool input, trying known field names.
 * @param {Record<string, unknown> | undefined} toolInput
 * @returns {string | null}
 */
export function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  for (const field of FILE_PATH_FIELDS) {
    const val = toolInput[field];
    if (typeof val === "string") return val;
  }
  return null;
}

/**
 * Check whether a Read tool call is requesting a partial/ranged read.
 *
 * Partial reads already limit context consumption, which is what trueline_read
 * with targeted ranges accomplishes. Passing them through avoids blocking
 * reads that are already well-scoped.
 *
 * Platform conventions:
 *   Claude Code / OpenCode: offset (line number), limit (line count)
 *   Gemini CLI: start_line, end_line (1-based, inclusive)
 *
 * @param {Record<string, unknown> | undefined} toolInput
 * @returns {boolean}
 */
export function isPartialRead(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return false;
  for (const field of PARTIAL_READ_FIELDS) {
    const val = toolInput[field];
    if (typeof val === "number" && val > 0) return true;
  }
  return false;
}

/**
 * Format a human-readable file size.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

/**
 * Detect a Bash command that inspects file contents — an operation that
 * trueline tools do better (hash-verified refs, ranged reads, AST outlines).
 *
 * Conservative: returns null for compound commands, pipes into the detected
 * tool, or when the file arg starts with `-` (likely a flag we missed).
 *
 * @param {unknown} command
 * @returns {{ tool: string; file: string; hint: string } | null}
 */
export function detectBashFilePeek(command) {
  if (typeof command !== "string") return null;

  for (const det of BASH_PEEK_DETECTORS) {
    const m = command.match(det.rx);
    if (!m) continue;
    const file = m[det.fileGroup ?? 1];
    if (!file || file.startsWith("-")) continue;
    const tool = det.tool ?? m[det.toolGroup];
    return { tool, file, hint: det.hint };
  }

  // grep PATTERN FILE — single-file, non-recursive search.
  // grep -r/-R/-l or piped grep are legitimate search uses.
  const grepMatch = command.match(/^\s*grep\b([^|;&<>]*)$/);
  if (grepMatch) {
    const rest = grepMatch[1];
    const isRecursive = /\s-[A-Za-z]*[rRl]/.test(rest);
    if (!isRecursive) {
      const tokens = rest.trim().split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1];
      // Heuristic: last token looks like a path (has / or .), not a flag.
      if (last && !last.startsWith("-") && /[/.]/.test(last) && tokens.length >= 2) {
        return { tool: "grep", file: last, hint: "trueline_search" };
      }
    }
  }

  return null;
}

/**
 * Route a pre-tool-use event.
 *
 * Routing logic by tool, file size, and edit token cost:
 *
 * - Read, large file (>= LARGE_FILE_THRESHOLD): **block** and redirect
 *   to trueline_read. Full reads of large files waste context; the agent
 *   should use trueline_outline or targeted trueline_read ranges instead.
 *
 * - Read, medium file (>= MEDIUM_FILE_THRESHOLD): **block** with concise
 *   redirect including estimated token cost.
 *
 * - Read, small file (< MEDIUM_FILE_THRESHOLD): **pass** silently.
 *   No advisory overhead; built-in Read is fine for small files.
 *
 * - Edit/MultiEdit: **block** and redirect to trueline_search ->
 *   trueline_edit. Hash-verified edits prevent stale-content mismatches
 *   that built-in Edit can't detect.
 *
 * - Bash (canonical): if the command looks like a file-peek (`cat`, `sed -n`,
 *   `head`, `tail`, or single-file `grep`) on an accessible file, **advise**
 *   (non-blocking) with a nudge toward trueline_read/trueline_search.
 *
 * Returns null for silent pass-through, { action: "block", reason } to redirect,
 * or { action: "advise", reason } to inject context without blocking.
 *
 * @param {string} toolName - Raw tool name from the platform
 * @param {Record<string, unknown> | undefined} toolInput
 * @param {(filePath: string, toolName: string) => Promise<boolean>} canAccessFn
 * @returns {Promise<{ action: "block" | "advise"; reason: string } | null>}
 */
export async function routePreToolUse(toolName, toolInput, canAccessFn) {
  const canonical = canonicalToolName(toolName);

  // Bash: non-blocking nudge when a file-peek command is detected.
  if (canonical === "Bash") {
    const peek = detectBashFilePeek(toolInput?.command);
    if (!peek) return null;
    const accessible = await canAccessFn(peek.file, "Read").catch(() => false);
    if (!accessible) return null;
    return {
      action: "advise",
      reason:
        `<trueline_nudge>\`${peek.tool}\` on ${peek.file} inspects file content outside trueline. ` +
        `Prefer ${peek.hint} \u2014 it returns hash-verified refs ready for trueline_edit ` +
        `and avoids flooding context. Use trueline_outline first for structure on larger files.</trueline_nudge>`,
    };
  }

  // Only intercept file read/edit tools beyond this point.
  if (canonical !== "Read" && canonical !== "Edit" && canonical !== "MultiEdit") {
    return null;
  }

  const filePath = extractFilePath(toolInput);
  if (typeof filePath !== "string") return null;

  // Check file size. If stat fails (file doesn't exist), pass through.
  let fileSize;
  try {
    const st = await stat(filePath);
    fileSize = st.size;
  } catch {
    return null;
  }

  if (canonical === "Read") {
    // Partial reads (offset/limit, start_line/end_line) already limit context
    // consumption, which is the same goal as trueline_read with ranges. Let
    // them through unconditionally.
    if (isPartialRead(toolInput)) return null;

    const canRead = await canAccessFn(filePath, "Read");
    if (!canRead) return null;

    // Small files: pass through without any advisory overhead.
    if (fileSize < MEDIUM_FILE_THRESHOLD) return null;

    const size = formatSize(fileSize);
    const canOutline = OUTLINEABLE_EXTENSIONS.has(extname(filePath).toLowerCase());

    // Large files: block with full redirect guidance.
    if (fileSize >= LARGE_FILE_THRESHOLD) {
      const outlineHint = canOutline
        ? "Use trueline_outline for structure or trueline_search to find specific content, then "
        : "Use trueline_search to find specific content, then ";
      return {
        action: "block",
        reason:
          `<trueline_redirect>This file is ${size}. ` +
          outlineHint +
          "trueline_read with targeted line ranges to read only what you need. " +
          "If you do need the whole file, use a single trueline_read call with no range " +
          "rather than multiple ranged calls.</trueline_redirect>",
      };
    }

    // Medium files (3-10KB): block with concise redirect.
    const estTokens = Math.round(fileSize / 4);
    const outlineHint = canOutline ? "Use trueline_outline for structure, or " : "Use ";
    return {
      action: "block",
      reason:
        `<trueline_redirect>This file is ${size} (~${estTokens} tokens in context). ` +
        outlineHint +
        "trueline_read to get edit-ready refs.</trueline_redirect>",
    };
  }

  // Edit or MultiEdit: block and redirect to trueline_search -> trueline_edit.
  // Hash verification is the core value; always prefer it over built-in Edit.
  const [canRead, canWrite] = await Promise.all([canAccessFn(filePath, "Read"), canAccessFn(filePath, "Edit")]);
  if (!canRead || !canWrite) return null;

  return {
    action: "block",
    reason:
      "<trueline_redirect>Use trueline_search to find the target content, then trueline_edit to apply " +
      "hash-verified changes. trueline_edit confirms content hasn't changed since you last read it, " +
      "preventing stale-content mismatches that built-in Edit can't detect.</trueline_redirect>",
  };
}
