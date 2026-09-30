/**
 * Performance benchmark harness.
 *
 * Measures wall-clock time of core operations across realistic workloads.
 * Run: bun run benchmark
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { handleRead } from "../src/tools/read.ts";
import { handleSearch } from "../src/tools/search.ts";
import { handleDiff } from "../src/tools/diff.ts";
import { streamingEdit } from "../src/streaming-edit.ts";
import { fnv1aHashBytes, hashToLetters } from "../src/hash.ts";
import { parseChecksum } from "../src/parse.ts";

// ===========================================================================
// Helpers
// ===========================================================================

interface BenchResult {
  name: string;
  iterations: number;
  medianMs: number;
  p95Ms: number;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)];
}

async function bench(name: string, iterations: number, fn: () => void | Promise<void>): Promise<BenchResult> {
  // Warm up
  for (let i = 0; i < Math.min(3, iterations); i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return { name, iterations, medianMs: median(times), p95Ms: p95(times) };
}

function formatDuration(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(1)}µs` : `${ms.toFixed(2)}ms`;
}

function printResults(results: BenchResult[]): void {
  const header = `${"Benchmark".padEnd(30)} | ${"Iters".padStart(7)} | ${"Median".padStart(10)} | ${"P95".padStart(10)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of results) {
    const med = formatDuration(r.medianMs);
    const p = formatDuration(r.p95Ms);
    console.log(`${r.name.padEnd(30)} | ${String(r.iterations).padStart(7)} | ${med.padStart(10)} | ${p.padStart(10)}`);
  }
}

// ===========================================================================
// Setup: generate large temp file
// ===========================================================================

const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-perf-")));
const LARGE_FILE = join(tmpDir, "large.ts");
const LINE_COUNT = 10_000;

function generateLargeFile(): void {
  const lines: string[] = [];
  for (let i = 0; i < LINE_COUNT; i++) {
    if (i % 2000 === 0) {
      lines.push(`// MARKER: section ${i / 2000}`);
    } else if (i % 100 === 0) {
      lines.push(`function func_${i}(x: number): number {`);
    } else if (i % 100 === 1) {
      lines.push(`  return x * ${i};`);
    } else if (i % 100 === 2) {
      lines.push("}");
    } else {
      lines.push(`const line_${i} = "value_${i}"; // padding line to simulate real file content`);
    }
  }
  writeFileSync(LARGE_FILE, `${lines.join("\n")}\n`);
}

// ===========================================================================
// Benchmarks
// ===========================================================================

const scope = { projectDir: tmpDir, allowedDirs: [tmpDir] };

// trueline_read pads a range with one context line per side. The dry-run edit
// replaces only the first returned line, or every returned line if `wholeRead`.
async function editBench(name: string, range: string, content: string[], wholeRead: boolean): Promise<BenchResult> {
  const readResult = await handleRead({ file_path: LARGE_FILE, ranges: [range], ...scope });
  const text = readResult.content[0].text;
  const refMatch = text.match(/^ref: (\S+)$/m);
  const hashLines = [...text.matchAll(/^([a-z]{2})(\d+)\t/gm)];
  if (!refMatch || hashLines.length === 0) throw new Error(`Failed to parse read result for ${name} benchmark`);

  const { startLine: csStart, endLine: csEnd, hash: csHash } = parseChecksum(refMatch[1]);
  const first = hashLines[0];
  const last = wholeRead ? hashLines[hashLines.length - 1] : first;
  const startLine = Number.parseInt(first[2], 10);
  const endLine = Number.parseInt(last[2], 10);

  return bench(name, 20, async () => {
    const mtimeMs = statSync(LARGE_FILE).mtimeMs;
    await streamingEdit(
      LARGE_FILE,
      [{ startLine, endLine, startHash: first[1], endHash: last[1], content, insertAfter: false }],
      [{ startLine: csStart, endLine: csEnd, hash: csHash }],
      mtimeMs,
      true, // dryRun — don't modify the file
    );
  });
}

const benchmarks: Array<() => Promise<BenchResult>> = [
  () =>
    bench("read-large-file", 20, async () => {
      await handleRead({ file_path: LARGE_FILE, ...scope });
    }),
  () =>
    bench("read-ranged", 50, async () => {
      await handleRead({ file_path: LARGE_FILE, ranges: ["5000-5050"], ...scope });
    }),
  () =>
    bench("search-large-file", 30, async () => {
      await handleSearch({ file_paths: [LARGE_FILE], pattern: "MARKER", max_matches: 10, ...scope });
    }),
  () =>
    bench("search-many-matches", 30, async () => {
      await handleSearch({ file_paths: [LARGE_FILE], pattern: "const line_", max_matches: 500, ...scope });
    }),
  () => editBench("edit-single-line", "100-100", ["const replaced = true;"], false),
  () =>
    editBench(
      "edit-multi-line",
      "100-119",
      Array.from({ length: 20 }, (_, i) => `const replaced_${i} = ${i};`),
      true,
    ),
  async () => {
    const buf = Buffer.alloc(10240);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff;

    return bench("hash-bytes", 10_000, () => {
      fnv1aHashBytes(buf);
    });
  },
  async () => {
    const hashes = new Uint32Array(1000);
    for (let i = 0; i < hashes.length; i++) hashes[i] = (i * 2654435761) >>> 0;

    return bench("hash-to-letters", 1000, () => {
      for (let i = 0; i < hashes.length; i++) hashToLetters(hashes[i]);
    });
  },
  async () => {
    const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-sdiff-")));
    const testFile = join(gitDir, "app.ts");
    const git = (cmd: string) =>
      execSync(cmd, {
        cwd: gitDir,
        stdio: "pipe",
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      });

    // A small committed file, then a working-tree version that removes, adds and re-signs
    // functions, changes a body and adds a method.
    const baseContent = `function add(a: number, b: number): number { return a + b; }
function subtract(a: number, b: number): number { return a - b; }
function multiply(a: number, b: number): number { return a * b; }
class Calculator {
  compute(op: string, a: number, b: number): number {
    switch (op) {
      case "add": return add(a, b);
      case "sub": return subtract(a, b);
      case "mul": return multiply(a, b);
      default: throw new Error("unknown");
    }
  }
}
`;
    const modifiedContent = baseContent
      .replace(
        /function subtract.*/,
        'function divide(a: number, b: number): number { if (b === 0) throw new Error("zero"); return a / b; }',
      )
      .replace(
        "multiply(a: number, b: number): number { return a * b; }",
        "multiply(x: number, y: number): number { return x * y; }",
      )
      .replace('"sub": return subtract', '"div": return divide')
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal code content
      .replace('new Error("unknown")', "new Error(`unknown: ${op}`)")
      .replace("  }\n}\n", "  }\n  getHistory(): number[] { return []; }\n}\n");

    writeFileSync(testFile, baseContent);
    git('git init && git config user.email "bench@test.com" && git config user.name "Bench"');
    git("git add . && git commit -m initial");
    writeFileSync(testFile, modifiedContent);

    return bench("semantic-diff", 20, async () => {
      await handleDiff({ file_paths: ["app.ts"], compare_against: "HEAD", projectDir: gitDir, allowedDirs: [gitDir] });
    }).finally(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });
  },
];

// ===========================================================================
// Main
// ===========================================================================

async function main(): Promise<void> {
  console.log("Performance Benchmark — trueline-mcp");
  console.log(`Temp dir: ${tmpDir}`);
  console.log(`Generating ${LINE_COUNT}-line test file...`);
  generateLargeFile();
  console.log();

  const results: BenchResult[] = [];
  for (const run of benchmarks) results.push(await run());

  // Cleanup temp dir before printing (semantic-diff already cleans its own)
  rmSync(tmpDir, { recursive: true, force: true });

  console.log();
  printResults(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
