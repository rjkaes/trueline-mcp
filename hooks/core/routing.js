// ==============================================================================
// Platform-Agnostic Hook Routing
// ==============================================================================
//
// Normalizes tool names across platforms via TOOL_ALIASES, then makes
// advise/approve decisions based on file size and edit token cost.
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

// Different platforms use different field names for file paths in tool input.
const FILE_PATH_FIELDS = ["file_path", "path", "target_file"];

// Files below this threshold are small enough for built-in tools.
const LARGE_FILE_THRESHOLD = 15360; // 15KB

// Token-cost estimation for Edit vs trueline_edit comparison.
// Code averages ~3.5 characters per token across common languages.
const CHARS_PER_TOKEN = 3.5;
// Fixed MCP round-trip overhead for a trueline_edit call: tool schema,
// parameters framing, response framing.
const MCP_OVERHEAD_TOKENS = 300;

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
 * Format a human-readable file size.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

// Field names for old_string across platforms:
//   Claude Code / Gemini CLI / OpenCode: old_string
//   VS Code Copilot: oldString
const OLD_STRING_FIELDS = ["old_string", "oldString"];

/**
 * Check whether the tool input indicates a replace-all / multi-replace operation.
 *
 * Platform conventions:
 *   Claude Code / OpenCode: replace_all (boolean)
 *   Gemini CLI: expected_replacements (number > 1), allow_multiple (boolean)
 *   VS Code Copilot: separate multi_replace_string_in_file tool (handled by
 *     canonicalToolName mapping to MultiEdit, not here)
 *
 * @param {Record<string, unknown>} input
 * @returns {boolean}
 */
function isReplaceAll(input) {
  // Claude Code / OpenCode
  if (input.replace_all === true) return true;

  // Gemini CLI: expected_replacements > 1 means multiple occurrences
  const er = input.expected_replacements;
  if (typeof er === "number" && er > 1) return true;

  // Gemini CLI: allow_multiple
  if (input.allow_multiple === true) return true;

  return false;
}

/**
 * Extract old_string from tool input, trying known field names.
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function extractOldString(input) {
  for (const field of OLD_STRING_FIELDS) {
    const val = input[field];
    if (typeof val === "string") return val;
  }
  return null;
}

/**
 * Estimate context tokens saved by using trueline_edit instead of built-in Edit.
 *
 * Built-in Edit sends old_string verbatim; trueline_edit replaces it with a
 * compact hash-verified range spec (~10 tokens). The savings are offset by
 * the fixed MCP round-trip overhead. When the tool replaces multiple
 * occurrences, trueline_edit needs one entry per occurrence, so Edit is
 * likely cheaper; we return 0.
 *
 * Handles field name differences across platforms (old_string, oldString,
 * replace_all, expected_replacements, allow_multiple).
 *
 * @param {Record<string, unknown> | undefined} toolInput
 * @returns {number} Estimated token savings (0 or negative means Edit is fine)
 */
export function estimateEditTokenSavings(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return 0;

  // Replace-all sends old_string once for N occurrences; trueline_edit would
  // need N separate range-spec entries. Edit wins here.
  if (isReplaceAll(toolInput)) return 0;

  const oldStr = extractOldString(toolInput);
  if (oldStr === null) return 0;

  const oldTokens = oldStr.length / CHARS_PER_TOKEN;
  return oldTokens - MCP_OVERHEAD_TOKENS;
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
 * - Read, small file: **advise** trueline_outline but allow through.
 *   The MCP overhead of trueline_read isn't worth it on small files,
 *   but outline is still a better first step.
 *
 * - Edit/MultiEdit, costly old_string (replace_all=false, old_string tokens
 *   exceed MCP overhead): **advise** trueline_edit. The old_string content
 *   wastes more context than the MCP round-trip would cost.
 *
 * - Edit/MultiEdit, large file: **advise** trueline_search -> trueline_edit.
 *   We don't block because the agent may have already committed to an
 *   edit workflow; blocking mid-edit is more disruptive than a read redirect.
 *
 * - Edit/MultiEdit, small file, small old_string: **pass through** silently.
 *
 * Returns null for silent approve, or { action, reason } for advise/block.
 *
 * @param {string} toolName - Raw tool name from the platform
 * @param {Record<string, unknown> | undefined} toolInput
 * @param {(filePath: string, toolName: string) => Promise<boolean>} canAccessFn
 * @returns {Promise<{ action: "advise" | "block"; reason: string } | null>}
 */
export async function routePreToolUse(toolName, toolInput, canAccessFn) {
  const canonical = canonicalToolName(toolName);

  // Only intercept file read/edit tools.
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
    const canRead = await canAccessFn(filePath, "Read");
    if (!canRead) return null;

    const size = formatSize(fileSize);

    const canOutline = OUTLINEABLE_EXTENSIONS.has(extname(filePath).toLowerCase());

    // Large files: block and redirect to trueline.
    if (fileSize >= LARGE_FILE_THRESHOLD) {
      const outlineHint = canOutline ? "Use trueline_outline for structure, or " : "Use ";
      return {
        action: "block",
        reason:
          `<trueline_redirect>This file is ${size}. ` +
          outlineHint +
          "trueline_read with targeted line ranges " +
          "to avoid loading the entire file into context.</trueline_redirect>",
      };
    }

    // Small files: advise outline/search but let the read through.
    // Only mention outline when the file type has a tree-sitter grammar.
    if (canOutline) {
      return {
        action: "advise",
        reason:
          "<trueline_advisory>trueline_outline gives a compact structural map " +
          "and is often enough on its own. If you plan to edit, " +
          "trueline_search returns matches with checksums ready for trueline_edit.</trueline_advisory>",
      };
    }

    // Non-outlineable small files: advise search for edit prep only.
    return {
      action: "advise",
      reason:
        "<trueline_advisory>If you plan to edit this file, " +
        "trueline_search returns matches with checksums ready for trueline_edit.</trueline_advisory>",
    };
  }

  // Edit or MultiEdit: check token cost, then file size.
  const tokenSavings = estimateEditTokenSavings(toolInput);
  const needsTokenAdvice = tokenSavings > 0;
  const needsFileSizeAdvice = fileSize >= LARGE_FILE_THRESHOLD;

  if (!needsTokenAdvice && !needsFileSizeAdvice) return null;

  const [canRead, canWrite] = await Promise.all([canAccessFn(filePath, "Read"), canAccessFn(filePath, "Edit")]);
  if (!canRead || !canWrite) return null;

  // Token-cost advisory takes priority: it's a concrete, quantifiable saving.
  if (needsTokenAdvice) {
    const saved = Math.round(tokenSavings);
    return {
      action: "advise",
      reason:
        `<trueline_advisory>old_string is ~${saved} tokens larger than the MCP round-trip cost. ` +
        "trueline_search \u2192 trueline_edit replaces it with a compact hash reference, " +
        "saving context window.</trueline_advisory>",
    };
  }

  // Large file advisory: stale-content risk even with small old_string.
  const size = formatSize(fileSize);

  return {
    action: "advise",
    reason:
      `<trueline_advisory>This file is ${size}. ` +
      "Use trueline_search \u2192 trueline_edit for verified changes. " +
      "Built-in Edit on large files risks stale-content matches; " +
      "trueline_edit verifies hashes before writing.</trueline_advisory>",
  };
}
