#!/usr/bin/env node
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const pluginRoot = path.join(__dirname, "..");

// ==============================================================================
// Runtime Selection
// ==============================================================================

// Prefer bun: it runs the TypeScript source directly with no build step.
// Then try deno, then fall back to node — both use the pre-bundled JS file.
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

// When installed as a Claude Code plugin, node_modules won't exist.
// Install dependencies on first launch so tree-sitter WASMs (needed by
// trueline_outline) and other native deps are available.
function ensureDeps() {
  if (existsSync(path.join(pluginRoot, "node_modules"))) return;

  process.stderr.write("trueline-mcp: installing dependencies (first run)...\n");
  try {
    // Prefer bun for speed, fall back to npm (ships with node).
    const installer = hasBun() ? "bun" : "npm";
    const args = installer === "bun" ? ["install"] : ["install", "--production"];
    execFileSync(installer, args, {
      cwd: pluginRoot,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 120_000,
    });
    process.stderr.write("trueline-mcp: dependencies installed.\n");
  } catch (err) {
    // Non-fatal: outline won't work, but read/edit/search/diff/verify will.
    process.stderr.write(
      `trueline-mcp: dependency install failed (${err.message}). ` + "trueline_outline will be unavailable.\n",
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
  args = [path.join(pluginRoot, "src", "server.ts")];
} else if (hasDeno()) {
  cmd = "deno";
  args = ["run", "-A", path.join(pluginRoot, "dist", "server.js")];
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
