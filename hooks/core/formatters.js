// ==============================================================================
// Per-Platform Response Formatters
// ==============================================================================
//
// Translates normalized routing decisions into the JSON shape each platform
// expects on stdout from a hook.

const formatters = {
  "claude-code": {
    block: (reason) => ({ decision: "block", reason }),
    advise: (reason) => ({ decision: "approve", reason }),
    approve: () => ({ decision: "approve" }),
  },
  "gemini-cli": {
    block: (reason) => ({ decision: "deny", reason }),
    advise: (reason) => ({ decision: "allow", reason }),
    approve: () => null,
  },
  "vscode-copilot": {
    block: (reason) => ({ permissionDecision: "deny", reason }),
    advise: (reason) => ({ permissionDecision: "allow", reason }),
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
 * @param {{ action: "advise" | "block"; reason: string } | null} routing
 * @returns {Record<string, unknown> | null} JSON to write to stdout, or null for passthrough
 */
export function formatDecision(platform, routing) {
  const fmt = formatters[platform] ?? formatters["claude-code"];

  if (!routing) return fmt.approve();
  if (routing.action === "block") return fmt.block(routing.reason);
  if (routing.action === "advise") return fmt.advise(routing.reason);
  return fmt.approve();
}
