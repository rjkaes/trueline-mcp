/**
 * Token benchmark harness.
 *
 * Measures output bytes (÷4 ≈ tokens) across realistic agent workflows.
 * Run: bun run benchmark
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRead } from "../src/tools/read.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { handleSearch } from "../src/tools/search.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  steps: { tool: string; outputBytes: number }[];
  totalBytes: number;
  totalTokens: number;
}

function outputBytes(result: { content: Array<{ text: string }> }): number {
  return result.content.reduce((sum, c) => sum + Buffer.byteLength(c.text, "utf-8"), 0);
}

function printTable(label: string, results: ScenarioResult[]): void {
  console.log(`\n${label}`);
  console.log("=".repeat(label.length));
  const header = `${"Scenario".padEnd(40)} | ${"Bytes".padStart(8)} | ${"~Tokens".padStart(8)}`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    console.log(`${r.name.padEnd(40)} | ${String(r.totalBytes).padStart(8)} | ${String(r.totalTokens).padStart(8)}`);
    for (const step of r.steps) {
      console.log(`  ${step.tool.padEnd(38)} | ${String(step.outputBytes).padStart(8)} |`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Use this project's own source files as realistic fixtures.
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_DIRS = [PROJECT_DIR];
const SAMPLE_FILE = `${PROJECT_DIR}/src/streaming-edit.ts`;

async function scenarioNavigateAndUnderstand(): Promise<ScenarioResult> {
  const steps: ScenarioResult["steps"] = [];

  // Step 1: outline
  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", outputBytes: outputBytes(outline) });

  // Step 2: read a function (lines 74-150 — a chunk of streamingEdit)
  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 150 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "read (with hashes)", outputBytes: outputBytes(read) });

  const totalBytes = steps.reduce((s, x) => s + x.outputBytes, 0);
  return { name: "Navigate and understand", steps, totalBytes, totalTokens: Math.round(totalBytes / 4) };
}

async function scenarioExploreAndEdit(): Promise<ScenarioResult> {
  const steps: ScenarioResult["steps"] = [];

  // Step 1: outline
  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", outputBytes: outputBytes(outline) });

  // Step 2: exploratory read (large range)
  const explore = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 250 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "read (exploratory)", outputBytes: outputBytes(explore) });

  // Step 3: targeted re-read for edit (narrow range)
  const targeted = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 100, end: 115 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "read (edit target)", outputBytes: outputBytes(targeted) });

  const totalBytes = steps.reduce((s, x) => s + x.outputBytes, 0);
  return { name: "Explore then edit", steps, totalBytes, totalTokens: Math.round(totalBytes / 4) };
}

async function scenarioBroadExploration(): Promise<ScenarioResult> {
  const steps: ScenarioResult["steps"] = [];

  // Step 1: outline
  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", outputBytes: outputBytes(outline) });

  // Step 2-4: multiple reads across the file
  for (const range of [
    { start: 42, end: 70 },
    { start: 200, end: 280 },
    { start: 400, end: 470 },
  ]) {
    const read = await handleRead({
      file_path: SAMPLE_FILE,
      ranges: [range],
      projectDir: PROJECT_DIR,
      allowedDirs: ALLOWED_DIRS,
    });
    steps.push({ tool: `read ${range.start}-${range.end}`, outputBytes: outputBytes(read) });
  }

  const totalBytes = steps.reduce((s, x) => s + x.outputBytes, 0);
  return { name: "Broad exploration", steps, totalBytes, totalTokens: Math.round(totalBytes / 4) };
}

// Compact-read variants: same scenarios but with hashes=false for exploratory reads

async function scenarioNavigateCompact(): Promise<ScenarioResult> {
  const steps: ScenarioResult["steps"] = [];

  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", outputBytes: outputBytes(outline) });

  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 150 }],
    hashes: false,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "read (no hashes)", outputBytes: outputBytes(read) });

  const totalBytes = steps.reduce((s, x) => s + x.outputBytes, 0);
  return { name: "Navigate and understand (compact)", steps, totalBytes, totalTokens: Math.round(totalBytes / 4) };
}

async function scenarioExploreCompact(): Promise<ScenarioResult> {
  const steps: ScenarioResult["steps"] = [];

  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", outputBytes: outputBytes(outline) });

  // Exploratory read without hashes
  const explore = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 250 }],
    hashes: false,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "read (exploratory, no hashes)", outputBytes: outputBytes(explore) });

  // Targeted re-read with hashes for editing
  const targeted = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 100, end: 115 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "read (edit target, with hashes)", outputBytes: outputBytes(targeted) });

  const totalBytes = steps.reduce((s, x) => s + x.outputBytes, 0);
  return { name: "Explore then edit (compact)", steps, totalBytes, totalTokens: Math.round(totalBytes / 4) };
}

// Search-based workflow: find pattern → edit-ready in one step

async function scenarioSearchAndEdit(): Promise<ScenarioResult> {
  const steps: ScenarioResult["steps"] = [];

  const search = await handleSearch({
    file_path: SAMPLE_FILE,
    pattern: "validatePath",
    context_lines: 3,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "search (validatePath, ctx=3)", outputBytes: outputBytes(search) });

  const totalBytes = steps.reduce((s, x) => s + x.outputBytes, 0);
  return { name: "Find and fix (search)", steps, totalBytes, totalTokens: Math.round(totalBytes / 4) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Token Benchmark — trueline-mcp");
  console.log(`Sample file: ${SAMPLE_FILE}`);

  const baseline = await Promise.all([
    scenarioNavigateAndUnderstand(),
    scenarioExploreAndEdit(),
    scenarioBroadExploration(),
  ]);
  printTable("Baseline (hashes=true)", baseline);

  const compact = await Promise.all([scenarioNavigateCompact(), scenarioExploreCompact(), scenarioSearchAndEdit()]);
  printTable("With compact reads & search", compact);

  // Comparison
  console.log("\nComparison");
  console.log("==========");
  const pairs: [string, ScenarioResult, ScenarioResult][] = [
    ["Navigate", baseline[0], compact[0]],
    ["Explore→edit", baseline[1], compact[1]],
  ];
  for (const [name, b, c] of pairs) {
    const saved = b.totalBytes - c.totalBytes;
    const pct = ((saved / b.totalBytes) * 100).toFixed(1);
    console.log(`${name.padEnd(20)} ${b.totalBytes} → ${c.totalBytes} bytes (−${saved}, −${pct}%)`);
  }

  const grandBaseline = baseline.reduce((s, r) => s + r.totalBytes, 0);
  const grandCompact = compact.reduce((s, r) => s + r.totalBytes, 0);
  console.log(`\nBaseline total:  ${grandBaseline} bytes (~${Math.round(grandBaseline / 4)} tokens)`);
  console.log(`Compact total:   ${grandCompact} bytes (~${Math.round(grandCompact / 4)} tokens)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
