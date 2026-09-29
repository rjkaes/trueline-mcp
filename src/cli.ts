// CLI entry point and root command dispatcher for the trueline command.
//
// This file stays at src/cli.ts so the existing build script
// (`bun build src/cli.ts --target=node --outfile dist/cli.js`) and the
// bun-launcher path in scripts/resolve-binary.cjs (invoked with the "cli" entry arg)
// work without any changes.
//
// Subcommands are registered as lazy imports so the CLI starts quickly
// regardless of which subcommand is invoked.

import pkg from "../package.json";
import { type CliSubcommand, UsageError } from "./cli/io.ts";

// Read with Object.hasOwn: names like `constructor` must not resolve to Object.prototype members.
const SUBCOMMAND_LOADERS: Record<string, () => Promise<{ default: CliSubcommand }>> = {
  outline: () => import("./cli/outline.ts"),
  read: () => import("./cli/read.ts"),
  search: () => import("./cli/search.ts"),
  edit: () => import("./cli/edit.ts"),
  verify: () => import("./cli/verify.ts"),
  changes: () => import("./cli/changes.ts"),
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

Run "trueline <command> --help" for command-specific options.
`;
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const load =
      argv[0] !== undefined && Object.hasOwn(SUBCOMMAND_LOADERS, argv[0]) ? SUBCOMMAND_LOADERS[argv[0]] : undefined;
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

  const load = Object.hasOwn(SUBCOMMAND_LOADERS, name) ? SUBCOMMAND_LOADERS[name] : undefined;
  if (!load) {
    process.stderr.write(`Unknown command ${name}\n`);
    process.stdout.write(rootUsage());
    process.exitCode = 1;
    return;
  }

  const mod = await load();
  try {
    await mod.default.run(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`trueline: ${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
