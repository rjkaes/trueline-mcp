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

// Maps platform-specific built-in tool names to canonical names.
const TOOL_ALIASES = {
  // Gemini CLI
  read_file: "Read",
  edit_file: "Edit",
  run_shell_command: "Bash",
  // VS Code Copilot
  replace_string_in_file: "Edit",
  multi_replace_string_in_file: "MultiEdit",
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
const FILE_PATH_FIELDS = ["file_path", "path"];

// Fields that indicate a partial/ranged read across platforms:
//   Claude Code / OpenCode: offset, limit
//   Gemini CLI: start_line, end_line
const PARTIAL_READ_FIELDS = ["offset", "limit", "start_line", "end_line"];

// Files at or above this size are blocked with full redirect guidance.
const LARGE_FILE_THRESHOLD = 10240; // 10KB
// Files between MEDIUM and LARGE are blocked with a concise redirect.
const MEDIUM_FILE_THRESHOLD = 3072; // 3KB

// Formats the built-in Read renders natively: images become visual input and
// PDFs paginate. trueline_read is line- and hash-oriented and cannot surface
// any of it, so redirecting these would leave the agent with no way to see the
// content at all. Pass them through regardless of size.
const NATIVE_MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

/**
 * Partial reads already limit context the way ranged trueline_read does, so they pass through.
 *
 * @param {Record<string, unknown> | undefined} toolInput
 * @returns {boolean}
 */
function isPartialRead(toolInput) {
  return PARTIAL_READ_FIELDS.some((field) => typeof toolInput?.[field] === "number" && toolInput[field] > 0);
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
function detectBashFilePeek(command) {
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
 * Route a pre-tool-use event: null passes through, "block" redirects, "advise" injects context
 * without blocking (Bash file peeks only). Thresholds and exemptions are explained at each check.
 *
 * @param {string} toolName - Raw tool name from the platform
 * @param {Record<string, unknown> | undefined} toolInput
 * @param {(filePath: string, toolName: string) => Promise<boolean>} canAccessFn
 * @returns {Promise<{ action: "block" | "advise"; reason: string } | null>}
 */
export async function routePreToolUse(toolName, toolInput, canAccessFn) {
  const canonical = TOOL_ALIASES[toolName] ?? toolName;

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

  const filePath = FILE_PATH_FIELDS.map((field) => toolInput?.[field]).find((value) => typeof value === "string");
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
    // Images and PDFs: only the built-in Read can render them.
    if (NATIVE_MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())) return null;

    // Partial reads (offset/limit, start_line/end_line) already limit context
    // consumption, which is the same goal as trueline_read with ranges. Let
    // them through unconditionally.
    if (isPartialRead(toolInput)) return null;

    const canRead = await canAccessFn(filePath, "Read");
    if (!canRead) return null;

    // Small files: pass through without any advisory overhead.
    if (fileSize < MEDIUM_FILE_THRESHOLD) return null;

    const size = `${(fileSize / 1024).toFixed(0)}KB`;

    // Large files: block with full redirect guidance.
    if (fileSize >= LARGE_FILE_THRESHOLD) {
      return {
        action: "block",
        reason:
          `<trueline_redirect>This file is ${size}. ` +
          "Use trueline_outline for structure or trueline_search to find specific content, then " +
          "trueline_read with targeted line ranges to read only what you need. " +
          "If you do need the whole file, use a single trueline_read call with no range " +
          "rather than multiple ranged calls.</trueline_redirect>",
      };
    }

    // Medium files (3-10KB): block with concise redirect.
    const estTokens = Math.round(fileSize / 4);
    return {
      action: "block",
      reason:
        `<trueline_redirect>This file is ${size} (~${estTokens} tokens in context). ` +
        "Use trueline_outline for structure, or " +
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
      "<trueline_redirect>Reuse the replacement text you just wrote verbatim; don't regenerate it. " +
      "Get a ref with one trueline_search on a snippet of the original content, then trueline_edit " +
      "with that ref and your replacement. trueline_edit confirms content hasn't changed since you " +
      "last read it, preventing stale-content mismatches that built-in Edit can't detect.</trueline_redirect>",
  };
}
