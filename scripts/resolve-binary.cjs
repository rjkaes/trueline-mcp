#!/usr/bin/env node
"use strict";

const { spawn, execFileSync } = require("child_process");
const path = require("path");

const pluginRoot = path.join(__dirname, "..");

// ==============================================================================
// Runtime Selection
// ==============================================================================

// Prefer bun: it runs the TypeScript source directly with no build step.
// Fall back to node with a pre-bundled JS file committed to the repo.
function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ==============================================================================
// Launch
// ==============================================================================

let cmd, args;
if (hasBun()) {
  cmd = "bun";
  args = [path.join(pluginRoot, "src", "server.ts")];
} else {
  cmd = "node";
  args = [path.join(pluginRoot, "dist", "server.js")];
}

const child = spawn(cmd, [...args, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  process.stderr.write(`trueline-mcp: failed to start server: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
