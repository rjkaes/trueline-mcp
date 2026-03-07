// ==============================================================================
// Platform-Agnostic Hook Routing
// ==============================================================================
//
// Normalizes tool names across platforms via TOOL_ALIASES, then makes
// block/approve decisions. Returns normalized {action, reason} objects
// that platform-specific formatters translate to the right JSON shape.

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
 * Route a pre-tool-use event. Returns a routing decision or null for passthrough.
 *
 * @param {string} toolName - Raw tool name from the platform
 * @param {Record<string, unknown> | undefined} toolInput
 * @param {(filePath: string, toolName: string) => Promise<boolean>} canAccessFn
 * @returns {Promise<{ action: "block"; reason: string } | null>}
 */
export async function routePreToolUse(toolName, toolInput, canAccessFn) {
  const canonical = canonicalToolName(toolName);
  const filePath = extractFilePath(toolInput);

  if (canonical === "Edit" || canonical === "MultiEdit") {
    if (typeof filePath === "string") {
      const [canRead, canWrite] = await Promise.all([canAccessFn(filePath, "Read"), canAccessFn(filePath, "Edit")]);
      if (canRead && canWrite) {
        return {
          action: "block",
          reason:
            "<trueline_redirect>" + "Edit is blocked. Use trueline_read then trueline_edit." + "</trueline_redirect>",
        };
      }
    }
    return null;
  }

  if (canonical === "Read") {
    if (typeof filePath === "string") {
      const canRead = await canAccessFn(filePath, "Read");
      if (canRead) {
        return {
          action: "block",
          reason:
            "<trueline_redirect>" +
            "Read is blocked for this file. Use trueline_read instead. " +
            "trueline_read returns per-line hashes and a checksum needed for trueline_edit." +
            "</trueline_redirect>",
        };
      }
    }
    return null;
  }

  if (canonical === "Write") {
    if (typeof filePath === "string") {
      const canWrite = await canAccessFn(filePath, "Edit");
      if (canWrite) {
        // Fall through to built-in Write for non-regular files (directories,
        // devices, etc.) that trueline_write would reject.
        try {
          const s = await stat(filePath);
          if (!s.isFile()) return null;
        } catch {
          // File doesn't exist yet — trueline_write can handle creation.
        }
        return {
          action: "block",
          reason:
            "<trueline_redirect>" +
            "Use trueline_write instead of Write for files in the project directory. " +
            "trueline_write returns a checksum for verification." +
            "</trueline_redirect>",
        };
      }
    }
    return null;
  }

  return null;
}
