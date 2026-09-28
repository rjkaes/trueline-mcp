#!/usr/bin/env node
// MCP server entry point for npm distribution.
// Delegates to resolve-binary.cjs which prefers bun > deno > node.
//
// Usage:
//   npx trueline-mcp              # via npx
//   trueline-mcp                   # after npm i -g trueline-mcp

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(__dirname, "..", "scripts", "resolve-binary.cjs");

try {
  execFileSync("node", [script, "server", ...process.argv.slice(2)], { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
