/**
 * Performance benchmark harness.
 *
 * Measures wall-clock time of core operations across realistic workloads.
 * Run: bun run perf
 */
import { join } from "node:path";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { handleRead } from "../src/tools/read.ts";
import { handleSearch } from "../src/tools/search.ts";
import { streamingEdit } from "../src/streaming-edit.ts";
import { fnv1aHashBytes, hashToLetters } from "../src/hash.ts";

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

async function bench(name: string, iterations: number, fn: () => Promise<void>): Promise<BenchResult> {
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

function benchSync(name: string, iterations: number, fn: () => void): BenchResult {
  // Warm up
  for (let i = 0; i < Math.min(3, iterations); i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return { name, iterations, medianMs: median(times), p95Ms: p95(times) };
}

function printResults(results: BenchResult[]): void {
  const header = `${"Benchmark".padEnd(30)} | ${"Iters".padStart(7)} | ${"Median".padStart(10)} | ${"P95".padStart(10)}`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    const med = r.medianMs < 1 ? `${(r.medianMs * 1000).toFixed(1)}µs` : `${r.medianMs.toFixed(2)}ms`;
    const p = r.p95Ms < 1 ? `${(r.p95Ms * 1000).toFixed(1)}µs` : `${r.p95Ms.toFixed(2)}ms`;
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

async function benchReadLargeFile(): Promise<BenchResult> {
  return bench("read-large-file", 20, async () => {
    await handleRead({ file_path: LARGE_FILE, projectDir: tmpDir, allowedDirs: [tmpDir] });
  });
}

async function benchReadRanged(): Promise<BenchResult> {
  return bench("read-ranged", 50, async () => {
    await handleRead({
      file_path: LARGE_FILE,
      ranges: [{ start: 5000, end: 5050 }],
      projectDir: tmpDir,
      allowedDirs: [tmpDir],
    });
  });
}

async function benchSearchFewMatches(): Promise<BenchResult> {
  return bench("search-large-file", 30, async () => {
    await handleSearch({
      file_path: LARGE_FILE,
      pattern: "MARKER",
      max_matches: 10,
      projectDir: tmpDir,
      allowedDirs: [tmpDir],
    });
  });
}

async function benchSearchManyMatches(): Promise<BenchResult> {
  return bench("search-many-matches", 30, async () => {
    await handleSearch({
      file_path: LARGE_FILE,
      pattern: "const line_",
      max_matches: 500,
      projectDir: tmpDir,
      allowedDirs: [tmpDir],
    });
  });
}

async function benchEditSingleLine(): Promise<BenchResult> {
  const readResult = await handleRead({
    file_path: LARGE_FILE,
    ranges: [{ start: 100, end: 100 }],
    projectDir: tmpDir,
    allowedDirs: [tmpDir],
  });
  const text = readResult.content[0].text;
  const checksumMatch = text.match(/checksum: (\S+)/);
  const lineMatch = text.match(/^(\d+):([a-z0-9]{2})\|(.*)$/m);
  if (!checksumMatch || !lineMatch) throw new Error("Failed to parse read result for edit benchmark");

  const checksumStr = checksumMatch[1];
  const lineNum = Number.parseInt(lineMatch[1], 10);
  const hash = lineMatch[2];

  // Parse checksum string "100-100:abcdef01" → { startLine, endLine, hash }
  const [range, csHash] = checksumStr.split(":");
  const [csStart, csEnd] = range.split("-").map(Number);

  return bench("edit-single-line", 20, async () => {
    const mtimeMs = statSync(LARGE_FILE).mtimeMs;
    await streamingEdit(
      LARGE_FILE,
      [
        {
          startLine: lineNum,
          endLine: lineNum,
          startHash: hash,
          endHash: hash,
          content: ["const replaced = true;"],
          insertAfter: false,
        },
      ],
      [{ startLine: csStart, endLine: csEnd, hash: csHash }],
      mtimeMs,
      true, // dryRun — don't modify the file
    );
  });
}

async function benchEditMultiLine(): Promise<BenchResult> {
  const readResult = await handleRead({
    file_path: LARGE_FILE,
    ranges: [{ start: 100, end: 119 }],
    projectDir: tmpDir,
    allowedDirs: [tmpDir],
  });
  const text = readResult.content[0].text;
  const checksumMatch = text.match(/checksum: (\S+)/);
  const lines = text.split("\n").filter((l) => /^\d+:[a-z0-9]{2}\|/.test(l));
  if (!checksumMatch || lines.length === 0)
    throw new Error("Failed to parse read result for multi-line edit benchmark");

  const checksumStr = checksumMatch[1];
  const [range, csHash] = checksumStr.split(":");
  const [csStart, csEnd] = range.split("-").map(Number);

  const firstMatch = lines[0].match(/^(\d+):([a-z0-9]{2})\|/);
  const lastMatch = lines[lines.length - 1].match(/^(\d+):([a-z0-9]{2})\|/);
  if (!firstMatch || !lastMatch) throw new Error("Failed to parse line hashes");

  const replacement = Array.from({ length: 20 }, (_, i) => `const replaced_${i} = ${i};`);

  return bench("edit-multi-line", 20, async () => {
    const mtimeMs = statSync(LARGE_FILE).mtimeMs;
    await streamingEdit(
      LARGE_FILE,
      [
        {
          startLine: Number.parseInt(firstMatch[1], 10),
          endLine: Number.parseInt(lastMatch[1], 10),
          startHash: firstMatch[2],
          endHash: lastMatch[2],
          content: replacement,
          insertAfter: false,
        },
      ],
      [{ startLine: csStart, endLine: csEnd, hash: csHash }],
      mtimeMs,
      true,
    );
  });
}

function benchHashBytes(): BenchResult {
  const buf = Buffer.alloc(10240);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff;

  return benchSync("hash-bytes", 10_000, () => {
    fnv1aHashBytes(buf, 0, buf.length);
  });
}

function benchHashToLetters(): BenchResult {
  const hashes = new Uint32Array(1000);
  for (let i = 0; i < hashes.length; i++) hashes[i] = (i * 2654435761) >>> 0;

  return benchSync("hash-to-letters", 1000, () => {
    for (let i = 0; i < hashes.length; i++) hashToLetters(hashes[i]);
  });
}

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

  results.push(await benchReadLargeFile());
  results.push(await benchReadRanged());
  results.push(await benchSearchFewMatches());
  results.push(await benchSearchManyMatches());
  results.push(await benchEditSingleLine());
  results.push(await benchEditMultiLine());
  results.push(benchHashBytes());
  results.push(benchHashToLetters());

  console.log();
  printResults(results);

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
