/**
 * Red-green timing support for `*.perf.ts` tests.
 *
 * Each perf test imports a module twice: from the working tree and from a
 * pinned baseline commit, then asserts a minimum speedup. Comparing against
 * a baseline instead of absolute thresholds keeps the tests stable across
 * machines. The `.perf.ts` suffix keeps them out of `bun test`, where
 * timing noise would make pre-commit flaky.
 *
 * Run: bun run perf
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Import `modulePath` (repo-relative) as it existed at `commit`.
 *
 * Extracts src/ under node_modules/.cache: ignored by git everywhere, and
 * bare imports inside the baseline still resolve to the repo's node_modules.
 */
export async function importBaseline<T>(commit: string, modulePath: string): Promise<T> {
  const dir = join(REPO_ROOT, "node_modules", ".cache", "trueline-perf-baseline", commit);
  if (!existsSync(dir)) {
    // Extract beside the final path, then rename, so an interrupted run
    // never leaves a half-populated baseline behind.
    const staging = `${dir}.partial`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = execFileSync("git", ["archive", commit, "src"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", staging], { input: archive });
    renameSync(staging, dir);
  }
  return import(join(dir, modulePath));
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function timeOnce(fn: () => unknown): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Returns median(baseline) / median(current). Runs alternate so thermal or
 * GC drift lands on both sides equally; warm-up rounds let the JIT settle.
 */
export async function measureSpeedup(
  label: string,
  baseline: () => unknown,
  current: () => unknown,
  rounds = 40,
): Promise<number> {
  for (let i = 0; i < 10; i++) {
    await baseline();
    await current();
  }
  const baselineMs: number[] = [];
  const currentMs: number[] = [];
  for (let i = 0; i < rounds; i++) {
    baselineMs.push(await timeOnce(baseline));
    currentMs.push(await timeOnce(current));
  }
  const speedup = median(baselineMs) / median(currentMs);
  console.log(
    `${label}: baseline ${median(baselineMs).toFixed(3)}ms, current ${median(currentMs).toFixed(3)}ms, ${speedup.toFixed(2)}x`,
  );
  return speedup;
}
