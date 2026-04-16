// ==============================================================================
// Per-Platform Response Formatters
// ==============================================================================
//
// Translates normalized routing decisions into the JSON shape each platform
// expects on stdout from a hook.

const formatters = {
  "claude-code": {
    block: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    advise: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: reason,
      },
    }),
    approve: () => null,
  },
  "gemini-cli": {
    block: (reason) => ({ decision: "deny", reason }),
    // Gemini has no non-blocking advisory channel for PreToolUse. Surface the
    // nudge via stderr; Gemini echoes stderr into model context on exit 0.
    advise: (reason) => ({ stderr: reason }),
    approve: () => ({}),
  },
  "vscode-copilot": {
    block: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    advise: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: reason,
      },
    }),
    approve: () => null,
  },
  // OpenCode uses in-process TS plugins, not JSON hooks. Included for
  // completeness but the CLI dispatcher is the only realistic consumer.
  opencode: {
    block: (reason) => ({ decision: "block", reason }),
    advise: (reason) => ({ decision: "approve", reason }),
    approve: () => null,
  },
};

/**
 * Format a routing decision for a specific platform.
 *
 * @param {string} platform
 * @param {{ action: "block"; reason: string } | null} routing
 * @returns {Record<string, unknown> | null} JSON to write to stdout, or null for passthrough
 */
export function formatDecision(platform, routing) {
  const fmt = formatters[platform] ?? formatters["claude-code"];

  if (!routing) return fmt.approve();
  if (routing.action === "block") return fmt.block(routing.reason);
  if (routing.action === "advise") return fmt.advise(routing.reason);
  return fmt.approve();
}
