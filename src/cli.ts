// CLI entry point — delegates to the citty-based command tree.
//
// This file stays at src/cli.ts so the existing build script
// (`bun build src/cli.ts --target=node --outfile dist/cli.js`) and the
// bun-launcher path in scripts/resolve-binary-cli.cjs both keep working
// without any changes.

import { runMain } from "citty";
import main from "./cli/index.ts";

runMain(main);
