// ==============================================================================
// Platform-Agnostic Hook Routing
// ==============================================================================
//
// Normalizes tool names across platforms via TOOL_ALIASES, then makes
// advise/approve decisions based on file size. Returns normalized
// {action, reason} objects that platform-specific formatters translate
// to the right JSON shape.

import { stat } from "node:fs/promises";

// Maps platform-specific built-in tool names to canonical names.
const TOOL_ALIASES = {
  // Gemini CLI
  read_file: "Read",
  read_many_files: "Read",
  edit_file: "Edit",
  write_file: "Write",
  run_shell_command: "Bash",
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

/**
 * Route a pre-tool-use event.
 *
 * Routing logic by tool and file size:
 *
 * - Read, large file (>= LARGE_FILE_THRESHOLD): **block** and redirect
 *   to trueline_read. Full reads of large files waste context; the agent
 *   should use trueline_outline or targeted trueline_read ranges instead.
 *
 * - Read, small file: **advise** trueline_outline but allow through.
 *   The MCP overhead of trueline_read isn't worth it on small files,
 *   but outline is still a better first step.
 *
 * - Edit/MultiEdit, large file: **advise** trueline_search -> trueline_edit.
 *   We don't block because the agent may have already committed to an
 *   edit workflow; blocking mid-edit is more disruptive than a read redirect.
 *
 * - Edit/MultiEdit, small file: **pass through** silently.
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

    // Large files: block and redirect to trueline.
    if (fileSize >= LARGE_FILE_THRESHOLD) {
      return {
        action: "block",
        reason:
          `<trueline_redirect>This file is ${size}. ` +
          "Use trueline_outline for structure, or trueline_read with targeted line ranges " +
          "to avoid loading the entire file into context.</trueline_redirect>",
      };
    }

    // Small files: advise outline/search but let the read through.
    return {
      action: "advise",
      reason:
        "<trueline_advisory>trueline_outline gives a compact structural map " +
        "and is often enough on its own. If you plan to edit, " +
        "trueline_search returns matches with checksums ready for trueline_edit.</trueline_advisory>",
    };
  }

  // Edit or MultiEdit: only advise on large files.
  if (fileSize < LARGE_FILE_THRESHOLD) return null;

  const [canRead, canWrite] = await Promise.all([canAccessFn(filePath, "Read"), canAccessFn(filePath, "Edit")]);
  if (!canRead || !canWrite) return null;

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
