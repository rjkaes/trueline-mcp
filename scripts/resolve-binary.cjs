#!/usr/bin/env node
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

function has(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
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
    const installer = bun ? "bun" : "npm";
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

// Entry-specific strings: ensureDeps() log prefix and the spawn-error message.
const ENTRIES = {
  server: { logName: "trueline-mcp", failPrefix: "trueline-mcp: failed to start server" },
  cli: { logName: "trueline", failPrefix: "trueline: failed to start" },
};

const entryArg = process.argv[2];
const entry = ENTRIES[entryArg];
if (!entry) {
  process.stderr.write(`resolve-binary.cjs: unknown entry "${entryArg}" (expected "server" or "cli")\n`);
  process.exit(1);
}

const pluginRoot = path.join(__dirname, "..");

// Computed once, reused by ensureDeps and the runtime selection below.
const bun = has("bun");

ensureDeps(pluginRoot, entry.logName);

const srcEntry = path.join(pluginRoot, "src", `${entryArg}.ts`);
const distEntry = path.join(pluginRoot, "dist", `${entryArg}.js`);

// Prefer bun: it runs the TypeScript source directly with no build step.
// Then try deno, then fall back to node — both use the pre-bundled JS file.
const [cmd, args] =
  bun && existsSync(srcEntry)
    ? ["bun", [srcEntry]] // Dev / plugin-clone context: run TypeScript source directly.
    : bun
      ? ["bun", [distEntry]] // npx / npm-install context: src/ isn't published, use bundled JS.
      : has("deno")
        ? ["deno", ["run", "-A", distEntry]]
        : ["node", [distEntry]];

const child = spawn(cmd, [...args, ...process.argv.slice(3)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  process.stderr.write(`${entry.failPrefix}: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
