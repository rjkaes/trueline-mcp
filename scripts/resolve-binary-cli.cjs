#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { hasBun, hasDeno, ensureDeps } = require("./resolve-binary-shared.cjs");

const pluginRoot = path.join(__dirname, "..");

ensureDeps(pluginRoot, "trueline");

let cmd, args;
if (hasBun()) {
  cmd = "bun";
  args = [path.join(pluginRoot, "src", "cli.ts")];
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
