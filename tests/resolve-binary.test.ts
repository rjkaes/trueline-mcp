import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { useTestDir } from "./helpers.ts";

const scriptsDir = join(import.meta.dir, "..", "scripts");

const pluginRoot = useTestDir("resolve-binary-");
let fakeBinDir: string;

// Stands in for bun: passes hasBun()'s `--version` probe, then echoes the
// argv resolve-binary.cjs hands it instead of running anything.
const FAKE_BUN = '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "$@"\n';

beforeEach(() => {
  mkdirSync(join(pluginRoot(), "scripts"));
  copyFileSync(join(scriptsDir, "resolve-binary.cjs"), join(pluginRoot(), "scripts", "resolve-binary.cjs"));
  // Present node_modules makes ensureDeps() skip the first-run install.
  mkdirSync(join(pluginRoot(), "node_modules"));
  mkdirSync(join(pluginRoot(), "dist"));
  writeFileSync(join(pluginRoot(), "dist", "cli.js"), "");
  writeFileSync(join(pluginRoot(), "dist", "server.js"), "");

  fakeBinDir = join(pluginRoot(), "fake-bin");
  mkdirSync(fakeBinDir);
  writeFileSync(join(fakeBinDir, "bun"), FAKE_BUN, { mode: 0o755 });
});

function runLauncher(entry: "cli" | "server"): string {
  const result = spawnSync("node", [join(pluginRoot(), "scripts", "resolve-binary.cjs"), entry, "--help"], {
    env: { ...process.env, PATH: `${fakeBinDir}${delimiter}${process.env.PATH}` },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

// The fake bun is a POSIX shell script; Windows can't exec it without a shell.
describe.skipIf(process.platform === "win32")("resolve-binary.cjs under bun", () => {
  test("runs dist/cli.js when src/ isn't published (npm install)", () => {
    expect(runLauncher("cli")).toBe(`${join(pluginRoot(), "dist", "cli.js")} --help`);
  });

  test("runs src/cli.ts when the source is present (plugin clone)", () => {
    mkdirSync(join(pluginRoot(), "src"));
    writeFileSync(join(pluginRoot(), "src", "cli.ts"), "");
    expect(runLauncher("cli")).toBe(`${join(pluginRoot(), "src", "cli.ts")} --help`);
  });

  test("runs dist/server.js for the server entry the same way", () => {
    expect(runLauncher("server")).toBe(`${join(pluginRoot(), "dist", "server.js")} --help`);
  });
});
