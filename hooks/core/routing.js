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
 * Route a pre-tool-use event. Returns an advisory decision or null for
 * silent passthrough.
 *
 * Advisory logic:
 * 1. Only intercepts Read, Edit, MultiEdit (canonical names).
 * 2. Requires a file path in the tool input.
 * 3. File must exist and be statable.
 * 4. Trueline must be able to access the file (canAccessFn).
 * 5. File must be >= LARGE_FILE_THRESHOLD bytes.
 *
 * If all conditions pass, returns { action: "advise", reason } suggesting
 * trueline tools. Otherwise returns null (silent approve).
 *
 * @param {string} toolName - Raw tool name from the platform
 * @param {Record<string, unknown> | undefined} toolInput
 * @param {(filePath: string, toolName: string) => Promise<boolean>} canAccessFn
 * @returns {Promise<{ action: "advise"; reason: string } | null>}
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

  // Small files: let built-in tools handle them.
  if (fileSize < LARGE_FILE_THRESHOLD) return null;

  // Check if trueline can access this file. For Edit/MultiEdit, check
  // both read and write access; for Read, only read access.
  if (canonical === "Edit" || canonical === "MultiEdit") {
    const [canRead, canWrite] = await Promise.all([canAccessFn(filePath, "Read"), canAccessFn(filePath, "Edit")]);
    if (!canRead || !canWrite) return null;
  } else {
    const canRead = await canAccessFn(filePath, "Read");
    if (!canRead) return null;
  }

  const size = formatSize(fileSize);

  if (canonical === "Read") {
    return {
      action: "advise",
      reason:
        `<trueline_advisory>This file is ${size}. ` +
        "Consider trueline_outline for structure, or trueline_read with targeted ranges " +
        "to avoid loading the entire file into context.</trueline_advisory>",
    };
  }

  // Edit or MultiEdit
  return {
    action: "advise",
    reason:
      `<trueline_advisory>This file is ${size}. ` +
      "Consider trueline_search \u2192 trueline_edit for targeted changes, " +
      "or trueline_outline to explore structure first.</trueline_advisory>",
  };
}
