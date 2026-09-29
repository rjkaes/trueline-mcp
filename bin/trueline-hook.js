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
import { text } from "node:stream/consumers";

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
const lowerEvent = event.toLowerCase();
const normalizedEvent = lowerEvent === "beforetool" ? "pretooluse" : lowerEvent;

// ==============================================================================
// Event Dispatch
// ==============================================================================

if (normalizedEvent === "session-start") {
  // import() needs a file URL: Node's ESM loader reads a Windows "C:\..." path as URL scheme "c:".
  const { getInstructions } = await import(pathToFileURL(resolve(hooksDir, "core", "instructions.js")).href);
  process.stdout.write(getInstructions(platform));
} else if (normalizedEvent === "pretooluse") {
  const { processHookEvent } = await import(pathToFileURL(resolve(hooksDir, "pretooluse.js")).href);

  let hookEvent;
  try {
    hookEvent = JSON.parse(await text(process.stdin));
  } catch {
    console.error("trueline-hook: failed to parse JSON from stdin");
    process.exit(1);
  }

  const result = await processHookEvent(hookEvent, platform);
  if (result !== null) {
    // `stderr` is out-of-band feedback; stdout stays valid JSON ({} when nothing else is set).
    const { stderr, ...json } = result;
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(JSON.stringify(json));
  }
} else {
  console.error(`trueline-hook: unknown event "${event}". Use pretooluse, beforetool, or session-start.`);
  process.exit(1);
}
