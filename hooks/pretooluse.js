import { fileURLToPath } from "node:url";
import { text } from "node:stream/consumers";
import { createAccessChecker } from "./core/access.js";
import { routePreToolUse } from "./core/routing.js";
import { formatDecision } from "./core/formatters.js";

/**
 * @param {{ tool_name: string; tool_input: Record<string, unknown> }} event
 * @param {string} [platform]
 * @returns {Promise<{ decision: string; reason?: string }>}
 */
export async function processHookEvent(event, platform = "claude-code") {
  // vscode-copilot shares CLAUDE_PROJECT_DIR with claude-code.
  const projectDir = process.env[platform === "gemini-cli" ? "GEMINI_PROJECT_DIR" : "CLAUDE_PROJECT_DIR"];
  const canAccess = await createAccessChecker(projectDir);
  const routing = await routePreToolUse(event.tool_name, event.tool_input, canAccess);
  return formatDecision(platform, routing);
}

// Main: read hook event from stdin, write result to stdout.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let event;
  try {
    event = JSON.parse(await text(process.stdin));
  } catch {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "hook: failed to parse stdin" }));
  }
  if (event !== undefined) {
    const result = await processHookEvent(event);
    process.stdout.write(JSON.stringify(result));
  }
}
