#!/usr/bin/env node
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const pluginRoot = path.join(__dirname, "..");

// ==============================================================================
// Runtime Selection
// ==============================================================================

function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasDeno() {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ==============================================================================
// Dependency Installation
// ==============================================================================

function ensureDeps() {
  if (existsSync(path.join(pluginRoot, "node_modules"))) return;

  process.stderr.write("trueline: installing dependencies (first run)...\n");
  try {
    const installer = hasBun() ? "bun" : "npm";
    const args = installer === "bun" ? ["install"] : ["install", "--production"];
    execFileSync(installer, args, {
      cwd: pluginRoot,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 120_000,
    });
    process.stderr.write("trueline: dependencies installed.\n");
  } catch (err) {
    process.stderr.write(
      `trueline: dependency install failed (${err.message}). trueline_outline will be unavailable.\n`,
    );
  }
}

// ==============================================================================
// Launch
// ==============================================================================

ensureDeps();

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
