// CLI entry point — delegates to the trueline command dispatcher.
//
// This file stays at src/cli.ts so the existing build script
// (`bun build src/cli.ts --target=node --outfile dist/cli.js`) and the
// bun-launcher path in scripts/resolve-binary.cjs (invoked with the "cli" entry arg)
// work without any changes.

import main from "./cli/index.ts";

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
