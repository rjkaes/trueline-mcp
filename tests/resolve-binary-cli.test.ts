import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const scriptsDir = join(import.meta.dir, "..", "scripts");

let pluginRoot: string;
let fakeBinDir: string;

// Stands in for bun: passes hasBun()'s `--version` probe, then echoes the
// argv resolve-binary-cli.cjs hands it instead of running anything.
const FAKE_BUN = '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "$@"\n';

beforeEach(() => {
  // realpath: node resolves __dirname through the macOS /var -> /private/var symlink.
  pluginRoot = realpathSync(mkdtempSync(join(tmpdir(), "resolve-binary-cli-")));
  mkdirSync(join(pluginRoot, "scripts"));
  for (const name of ["resolve-binary-cli.cjs", "resolve-binary-shared.cjs"]) {
    copyFileSync(join(scriptsDir, name), join(pluginRoot, "scripts", name));
  }
  // Present node_modules makes ensureDeps() skip the first-run install.
  mkdirSync(join(pluginRoot, "node_modules"));
  mkdirSync(join(pluginRoot, "dist"));
  writeFileSync(join(pluginRoot, "dist", "cli.js"), "");

  fakeBinDir = join(pluginRoot, "fake-bin");
  mkdirSync(fakeBinDir);
  writeFileSync(join(fakeBinDir, "bun"), FAKE_BUN, { mode: 0o755 });
});

afterEach(() => {
  rmSync(pluginRoot, { recursive: true, force: true });
});

function runLauncher(): string {
  const result = spawnSync("node", [join(pluginRoot, "scripts", "resolve-binary-cli.cjs"), "--help"], {
    env: { ...process.env, PATH: `${fakeBinDir}${delimiter}${process.env.PATH}` },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

// The fake bun is a POSIX shell script; Windows can't exec it without a shell.
describe.skipIf(process.platform === "win32")("resolve-binary-cli.cjs under bun", () => {
  test("runs dist/cli.js when src/ isn't published (npm install)", () => {
    expect(runLauncher()).toBe(`${join(pluginRoot, "dist", "cli.js")} --help`);
  });

  test("runs src/cli.ts when the source is present (plugin clone)", () => {
    mkdirSync(join(pluginRoot, "src"));
    writeFileSync(join(pluginRoot, "src", "cli.ts"), "");
    expect(runLauncher()).toBe(`${join(pluginRoot, "src", "cli.ts")} --help`);
  });
});
