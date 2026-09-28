// Root command dispatcher for the trueline CLI.
//
// Subcommands are registered as lazy imports so the CLI starts quickly
// regardless of which subcommand is invoked.

import pkg from "../../package.json";
import type { CliSubcommand } from "./io.ts";

const SUBCOMMAND_LOADERS: Record<string, () => Promise<{ default: CliSubcommand }>> = {
  outline: () => import("./outline.ts"),
  read: () => import("./read.ts"),
  search: () => import("./search.ts"),
  edit: () => import("./edit.ts"),
  verify: () => import("./verify.ts"),
  changes: () => import("./changes.ts"),
  diff: () => import("./changes.ts"), // "diff" alias: same handler as "changes"
};

function rootUsage(): string {
  return `Hash-verified file operations for AI coding agents (trueline v${pkg.version})

Usage: trueline <command> [options]

Commands:
  outline   Structural outline of files via tree-sitter (functions, classes, types)
  read      Read files with per-line hashes and refs
  search    Search files for a literal string or regex, returns edit-ready hashes
  edit      Apply hash-verified edits to a file
  verify    Check if held refs are still valid against current file content
  changes   Semantic AST-based diff of structural changes vs a git ref
  diff      Semantic AST-based diff of structural changes vs a git ref (alias for changes)

Run "trueline <command> --help" for command-specific options.
`;
}

export default async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const load = argv[0] !== undefined ? SUBCOMMAND_LOADERS[argv[0]] : undefined;
    const mod = load ? await load() : undefined;
    process.stdout.write(mod ? mod.default.usage : rootUsage());
    return;
  }

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const [name, ...rest] = argv;
  if (name === undefined) {
    process.stderr.write("No command specified.\n");
    process.stdout.write(rootUsage());
    process.exitCode = 1;
    return;
  }

  const load = SUBCOMMAND_LOADERS[name];
  if (!load) {
    process.stderr.write(`Unknown command ${name}\n`);
    process.stdout.write(rootUsage());
    process.exitCode = 1;
    return;
  }

  const mod = await load();
  await mod.default.run(rest);
}
