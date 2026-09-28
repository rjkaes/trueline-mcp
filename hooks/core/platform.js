// ==============================================================================
// Platform Detection
// ==============================================================================
//
// Detects which AI coding agent is running based on environment variables.
// Used by hooks and the CLI dispatcher to select the right formatting and
// tool aliases.

const PLATFORM_ENV_VARS = {
  "gemini-cli": "GEMINI_PROJECT_DIR",
  // claude-code and vscode-copilot both use CLAUDE_PROJECT_DIR, so we can't
  // distinguish them by env var alone. VS Code Copilot detection would need
  // an additional signal (e.g. VSCODE_PID). For now, both default to
  // claude-code behavior which is correct since they share tool names.
  "claude-code": "CLAUDE_PROJECT_DIR",
};

/**
 * Get the project directory for a given platform.
 * @param {string} platform
 * @returns {string | undefined}
 */
export function getProjectDir(platform) {
  const envVar = PLATFORM_ENV_VARS[platform];
  return envVar ? process.env[envVar] : process.env.CLAUDE_PROJECT_DIR;
}
