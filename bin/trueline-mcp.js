#!/usr/bin/env node
// MCP server entry point for npm distribution; forwards to resolve-binary.cjs (bun > node).
process.argv.splice(2, 0, "server");
await import("../scripts/resolve-binary.cjs");
