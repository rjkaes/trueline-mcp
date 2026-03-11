#!/usr/bin/env node
// CLI entry point for npm distribution.
// Delegates to resolve-binary-cli.cjs which prefers bun > deno > node.
//
// Usage:
//   npx trueline read src/foo.ts
//   trueline read src/foo.ts        # after npm i -g trueline-mcp

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(__dirname, "..", "scripts", "resolve-binary-cli.cjs");

try {
  execFileSync("node", [script, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (err) {
  process.exit(err.status ?? 1);
}
