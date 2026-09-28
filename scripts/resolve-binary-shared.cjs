"use strict";

// Shared by resolve-binary.cjs (MCP server) and resolve-binary-cli.cjs (CLI):
// runtime detection and first-run dependency install, identical for both
// besides the log prefix each caller passes to ensureDeps().

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

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

// When installed as a Claude Code plugin, node_modules won't exist.
// Install dependencies on first launch so tree-sitter WASMs (needed by
// trueline_outline) and other native deps are available.
function ensureDeps(pluginRoot, logName) {
  if (existsSync(path.join(pluginRoot, "node_modules"))) return;

  process.stderr.write(`${logName}: installing dependencies (first run)...\n`);
  try {
    // Prefer bun for speed, fall back to npm (ships with node).
    const installer = hasBun() ? "bun" : "npm";
    const args = installer === "bun" ? ["install"] : ["install", "--production"];
    execFileSync(installer, args, {
      cwd: pluginRoot,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 120_000,
    });
    process.stderr.write(`${logName}: dependencies installed.\n`);
  } catch (err) {
    // Non-fatal: outline won't work, but read/edit/search/diff/verify will.
    process.stderr.write(
      `${logName}: dependency install failed (${err.message}). trueline_outline will be unavailable.\n`,
    );
  }
}

module.exports = { hasBun, hasDeno, ensureDeps };
