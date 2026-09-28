#!/usr/bin/env node
// ==============================================================================
// CLI Dispatcher: trueline-hook <platform> <event>
// ==============================================================================
//
// Universal entry point for hook integration on any platform.
//
// Usage:
//   trueline-hook gemini-cli beforetool    # Gemini CLI BeforeTool hook
//   trueline-hook gemini-cli session-start # Gemini CLI session instructions
//   trueline-hook vscode-copilot pretooluse
//
// Reads hook event JSON from stdin (for tool-use hooks), writes platform-
// formatted JSON to stdout.

import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

const hooksDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks");

const USAGE = `Usage: trueline-hook <platform> <event>

Platforms: gemini-cli, vscode-copilot
Events:    pretooluse, beforetool, session-start

Examples:
  trueline-hook gemini-cli beforetool
  trueline-hook vscode-copilot pretooluse
  trueline-hook gemini-cli session-start`;

// ==============================================================================
// Argument Parsing
// ==============================================================================

const platform = process.argv[2];
const event = process.argv[3];

if (!platform || !event || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error(USAGE);
  process.exit(1);
}

// Normalize event names across platforms.
// Gemini calls it "beforetool", VS Code Copilot calls it "pretooluse" — both
// map to the same routing logic.
const EVENT_ALIASES = {
  beforetool: "pretooluse",
  before_tool: "pretooluse",
  "session-start": "session-start",
  sessionstart: "session-start",
};

const normalizedEvent = EVENT_ALIASES[event.toLowerCase()] ?? event.toLowerCase();

// ==============================================================================
// Event Dispatch
// ==============================================================================

if (normalizedEvent === "session-start") {
  const { getInstructions } = await import(pathToFileURL(resolve(hooksDir, "core", "instructions.js")).href);
  process.stdout.write(getInstructions(platform));
} else if (normalizedEvent === "pretooluse") {
  const { createAccessChecker } = await import(pathToFileURL(resolve(hooksDir, "core", "access.js")).href);
  const { routePreToolUse } = await import(pathToFileURL(resolve(hooksDir, "core", "routing.js")).href);
  const { formatDecision } = await import(pathToFileURL(resolve(hooksDir, "core", "formatters.js")).href);
  const { getProjectDir } = await import(pathToFileURL(resolve(hooksDir, "core", "platform.js")).href);

  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", async () => {
    let hookEvent;
    try {
      hookEvent = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      console.error("trueline-hook: failed to parse JSON from stdin");
      process.exit(1);
    }

    const projectDir = getProjectDir(platform);
    const canAccess = await createAccessChecker(projectDir);
    const routing = await routePreToolUse(hookEvent.tool_name, hookEvent.tool_input, canAccess);
    const result = formatDecision(platform, routing);

    if (result !== null) {
      process.stdout.write(JSON.stringify(result));
    }
  });
} else {
  console.error(`trueline-hook: unknown event "${event}". Use pretooluse, beforetool, or session-start.`);
  process.exit(1);
}
