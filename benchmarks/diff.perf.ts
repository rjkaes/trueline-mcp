import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as current from "../src/tools/diff.ts";
import { importBaseline, measureSpeedup } from "./perf-helpers.ts";

const BASELINE = "851eec7";
const baseline = await importBaseline<typeof current>(BASELINE, "src/tools/diff.ts");

const repo = realpathSync(mkdtempSync(join(tmpdir(), "trueline-perf-diff-")));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

// Committed, then modified: every file shows up as changed vs HEAD.
const configFiles = Array.from({ length: 10 }, (_, i) => join(repo, `tenant-${i}.json`));
const sourceFiles = Array.from({ length: 10 }, (_, i) => join(repo, `ledger-${i}.ts`));
function writeConfigs(version: number): void {
  for (const file of configFiles) writeFileSync(file, `${JSON.stringify({ version, currency: "CAD" })}\n`);
  for (const file of sourceFiles) {
    const refund = version > 1 ? "export function refund(cents: number) { return -cents; }\n" : "";
    writeFileSync(file, `export function charge(cents: number) { return cents; }\n${refund}`);
  }
}
git("init", "-q");
git("config", "user.email", "perf@example.com");
git("config", "user.name", "Perf");
writeConfigs(1);
git("add", ".");
git("commit", "-q", "-m", "initial");
writeConfigs(2);

const changes = (tool: typeof current, filePaths: string[]) => () =>
  tool.handleDiff({ file_paths: filePaths, compare_against: "HEAD", projectDir: repo, allowedDirs: [repo] });

describe("trueline_changes", () => {
  test("rejects unsupported file types at least 5x faster than baseline", async () => {
    const result = await changes(current, configFiles)();
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("not supported"));

    const speedup = await measureSpeedup(
      "changes on 10 .json files",
      changes(baseline, configFiles),
      changes(current, configFiles),
      10,
    );
    expect(speedup).toBeGreaterThanOrEqual(5);
  });

  test("diffs supported files at least 1.3x faster than baseline", async () => {
    const result = await changes(current, sourceFiles)();
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("refund"));

    const speedup = await measureSpeedup(
      "changes on 10 .ts files",
      changes(baseline, sourceFiles),
      changes(current, sourceFiles),
      10,
    );
    expect(speedup).toBeGreaterThanOrEqual(1.3);
  });
});
