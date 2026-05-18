// Root citty command for the trueline CLI.
//
// Subcommands are registered as lazy imports so the CLI starts quickly
// regardless of which subcommand is invoked.

import { defineCommand } from "citty";
import pkg from "../../package.json";

export default defineCommand({
  meta: {
    name: "trueline",
    version: pkg.version,
    description: "Hash-verified file operations for AI coding agents",
  },
  subCommands: {
    outline: () => import("./outline.ts").then((m) => m.default),
    read: () => import("./read.ts").then((m) => m.default),
    search: () => import("./search.ts").then((m) => m.default),
    edit: () => import("./edit.ts").then((m) => m.default),
    verify: () => import("./verify.ts").then((m) => m.default),
    changes: () => import("./changes.ts").then((m) => m.default),
    // "diff" alias: same handler as "changes"
    diff: () => import("./changes.ts").then((m) => m.default),
  },
});
