#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { hasBun, hasDeno, ensureDeps } = require("./resolve-binary-shared.cjs");

const pluginRoot = path.join(__dirname, "..");

ensureDeps(pluginRoot, "trueline");

const srcEntry = path.join(pluginRoot, "src", "cli.ts");
const distEntry = path.join(pluginRoot, "dist", "cli.js");

// Prefer bun: it runs the TypeScript source directly with no build step.
// Then try deno, then fall back to node — both use the pre-bundled JS file.
let cmd, args;
if (hasBun() && existsSync(srcEntry)) {
  // Dev / plugin-clone context: run TypeScript source directly.
  cmd = "bun";
  args = [srcEntry];
} else if (hasBun()) {
  // npx / npm-install context: src/ isn't published, use bundled JS.
  cmd = "bun";
  args = [distEntry];
} else if (hasDeno()) {
  cmd = "deno";
  args = ["run", "-A", path.join(pluginRoot, "dist", "cli.js")];
} else {
  cmd = "node";
  args = [path.join(pluginRoot, "dist", "cli.js")];
}

const child = spawn(cmd, [...args, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  process.stderr.write(`trueline: failed to start: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
