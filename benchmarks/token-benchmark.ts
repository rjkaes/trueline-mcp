/**
 * Token benchmark harness.
 *
 * Measures output bytes (÷4 ≈ tokens) across realistic agent workflows.
 * Compares trueline-mcp tools against simulated built-in tool equivalents.
 * Run: bun run benchmark
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRead } from "../src/tools/read.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { handleSearch } from "../src/tools/search.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StepDetail {
  tool: string;
  callBytes: number;
  resultBytes: number;
}

interface ScenarioResult {
  name: string;
  steps: StepDetail[];
  totalCallBytes: number;
  totalResultBytes: number;
  totalBytes: number;
  totalTokens: number;
  roundTrips: number;
}

function outputBytes(result: { content: Array<{ text: string }> }): number {
  return result.content.reduce((sum, c) => sum + Buffer.byteLength(c.text, "utf-8"), 0);
}

function jsonCallBytes(obj: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(obj), "utf-8");
}

// ---------------------------------------------------------------------------
// Built-in tool simulators
// ---------------------------------------------------------------------------

/** Simulate built-in Read output: cat -n format with 6-char padded line numbers. */
function simulateBuiltinRead(filePath: string, offset = 1, limit = 2000): string {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const start = Math.max(0, offset - 1);
  const end = Math.min(lines.length, start + limit);
  const result: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNum = String(i + 1).padStart(6, " ");
    const content = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
    result.push(`${lineNum}\t${content}`);
  }
  return result.join("\n");
}

/** Simulate the JSON call payload the model generates for built-in Read. */
function builtinReadCallBytes(filePath: string, offset?: number, limit?: number): number {
  const call: Record<string, unknown> = { file_path: filePath };
  if (offset !== undefined) call.offset = offset;
  if (limit !== undefined) call.limit = limit;
  return jsonCallBytes(call);
}

/** Simulate the JSON call payload for built-in Edit (old_string/new_string). */
function builtinEditCallBytes(filePath: string, oldString: string, newString: string): number {
  return jsonCallBytes({ file_path: filePath, old_string: oldString, new_string: newString });
}

/** Simulate built-in Edit result (success message). */
function builtinEditResultBytes(): number {
  return Buffer.byteLength("The file was edited successfully.", "utf-8");
}

/** Simulate built-in Grep result in content mode (ripgrep-style). */
function simulateBuiltinGrepContent(filePath: string, pattern: string): string {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const re = new RegExp(pattern);
  const matches: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      matches.push(`${filePath}:${i + 1}:${lines[i]}`);
    }
  }
  return matches.join("\n");
}

function builtinGrepCallBytes(pattern: string, path: string): number {
  return jsonCallBytes({ pattern, path, include_pattern: "*.ts" });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_DIRS = [PROJECT_DIR];
const SAMPLE_FILE = `${PROJECT_DIR}/src/streaming-edit.ts`;
const SAMPLE_FILES = [
  `${PROJECT_DIR}/src/streaming-edit.ts`,
  `${PROJECT_DIR}/src/tools/read.ts`,
  `${PROJECT_DIR}/src/tools/shared.ts`,
];

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

function buildResult(name: string, steps: StepDetail[]): ScenarioResult {
  const totalCallBytes = steps.reduce((s, x) => s + x.callBytes, 0);
  const totalResultBytes = steps.reduce((s, x) => s + x.resultBytes, 0);
  const totalBytes = totalCallBytes + totalResultBytes;
  return {
    name,
    steps,
    totalCallBytes,
    totalResultBytes,
    totalBytes,
    totalTokens: Math.round(totalBytes / 4),
    roundTrips: steps.length,
  };
}

// ---------------------------------------------------------------------------
// Trueline scenarios
// ---------------------------------------------------------------------------

async function truelineNavigate(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  // outline
  const outlineCall = jsonCallBytes({ file_path: SAMPLE_FILE });
  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", callBytes: outlineCall, resultBytes: outputBytes(outline) });

  // read targeted range
  const readCallObj = { file_path: SAMPLE_FILE, ranges: [{ start: 74, end: 150 }], hashes: false };
  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 150 }],
    hashes: false,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "read 74-150 (no hashes)",
    callBytes: jsonCallBytes(readCallObj),
    resultBytes: outputBytes(read),
  });

  return buildResult("Navigate & understand", steps);
}

async function truelineExploreEdit(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  // outline
  const outlineCall = jsonCallBytes({ file_path: SAMPLE_FILE });
  const outline = await handleOutline({ file_path: SAMPLE_FILE, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
  steps.push({ tool: "outline", callBytes: outlineCall, resultBytes: outputBytes(outline) });

  // exploratory read (no hashes)
  const exploreCallObj = { file_path: SAMPLE_FILE, ranges: [{ start: 74, end: 250 }], hashes: false };
  const explore = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 250 }],
    hashes: false,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "read 74-250 (exploratory)",
    callBytes: jsonCallBytes(exploreCallObj),
    resultBytes: outputBytes(explore),
  });

  // targeted re-read with hashes for edit
  const targetCallObj = { file_path: SAMPLE_FILE, ranges: [{ start: 100, end: 115 }] };
  const targeted = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 100, end: 115 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "read 100-115 (edit target)",
    callBytes: jsonCallBytes(targetCallObj),
    resultBytes: outputBytes(targeted),
  });

  // edit call: range:hash format (no old_string echo)
  const editCall = jsonCallBytes({
    file_path: SAMPLE_FILE,
    edits: [{ range: "100:ab..115:cd", checksum: "100-115:abcdef01", content: "// replaced content\n" }],
  });
  steps.push({
    tool: "edit (range:hash)",
    callBytes: editCall,
    resultBytes: Buffer.byteLength("checksum: 100-115:newcheck", "utf-8"),
  });

  return buildResult("Explore then edit", steps);
}

async function truelineSearchFix(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  // search
  const searchCallObj = { file_path: SAMPLE_FILE, pattern: "validatePath", context_lines: 3 };
  const search = await handleSearch({
    file_path: SAMPLE_FILE,
    pattern: "validatePath",
    context_lines: 3,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "search (validatePath)",
    callBytes: jsonCallBytes(searchCallObj),
    resultBytes: outputBytes(search),
  });

  // edit from search results
  const editCall = jsonCallBytes({
    file_path: SAMPLE_FILE,
    edits: [{ range: "10:ab..12:cd", checksum: "10-12:abcdef01", content: "// fixed\n" }],
  });
  steps.push({
    tool: "edit (from search)",
    callBytes: editCall,
    resultBytes: Buffer.byteLength("checksum: 10-12:newcheck", "utf-8"),
  });

  return buildResult("Search & fix", steps);
}

async function truelineMultiRegion(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  // single read with disjoint ranges
  const readCallObj = {
    file_path: SAMPLE_FILE,
    ranges: [
      { start: 1, end: 15 },
      { start: 200, end: 220 },
      { start: 400, end: 420 },
    ],
    hashes: false,
  };
  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [
      { start: 1, end: 15 },
      { start: 200, end: 220 },
      { start: 400, end: 420 },
    ],
    hashes: false,
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "read (3 disjoint ranges)",
    callBytes: jsonCallBytes(readCallObj),
    resultBytes: outputBytes(read),
  });

  return buildResult("Multi-region read", steps);
}

async function truelineMultiFile(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  for (const file of SAMPLE_FILES) {
    const callBytes = jsonCallBytes({ file_path: file });
    const outline = await handleOutline({ file_path: file, projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
    steps.push({ tool: `outline ${file.split("/").pop()}`, callBytes, resultBytes: outputBytes(outline) });
  }

  return buildResult("Multi-file exploration", steps);
}

// ---------------------------------------------------------------------------
// Built-in scenarios
// ---------------------------------------------------------------------------

function builtinNavigate(): ScenarioResult {
  const steps: StepDetail[] = [];

  // Read full file (no outline alternative)
  const callBytes = builtinReadCallBytes(SAMPLE_FILE);
  const resultBytes = Buffer.byteLength(simulateBuiltinRead(SAMPLE_FILE), "utf-8");
  steps.push({ tool: "Read full file", callBytes, resultBytes });

  return buildResult("Navigate & understand", steps);
}

function builtinExploreEdit(): ScenarioResult {
  const steps: StepDetail[] = [];
  const lines = readFileSync(SAMPLE_FILE, "utf-8").split("\n");

  // Read full file
  const readCall = builtinReadCallBytes(SAMPLE_FILE);
  const readResult = Buffer.byteLength(simulateBuiltinRead(SAMPLE_FILE), "utf-8");
  steps.push({ tool: "Read full file", callBytes: readCall, resultBytes: readResult });

  // Edit: must echo old_string verbatim (lines 100-115)
  const oldString = lines.slice(99, 115).join("\n");
  const newString = "// replaced content";
  const editCall = builtinEditCallBytes(SAMPLE_FILE, oldString, newString);
  steps.push({ tool: "Edit (old_string echo)", callBytes: editCall, resultBytes: builtinEditResultBytes() });

  return buildResult("Explore then edit", steps);
}

function builtinSearchFix(): ScenarioResult {
  const steps: StepDetail[] = [];
  const lines = readFileSync(SAMPLE_FILE, "utf-8").split("\n");

  // Grep for pattern
  const grepCall = builtinGrepCallBytes("validatePath", SAMPLE_FILE);
  const grepResult = Buffer.byteLength(simulateBuiltinGrepContent(SAMPLE_FILE, "validatePath"), "utf-8");
  steps.push({ tool: "Grep (content mode)", callBytes: grepCall, resultBytes: grepResult });

  // Read full file to get context for editing
  const readCall = builtinReadCallBytes(SAMPLE_FILE);
  const readResult = Buffer.byteLength(simulateBuiltinRead(SAMPLE_FILE), "utf-8");
  steps.push({ tool: "Read full file", callBytes: readCall, resultBytes: readResult });

  // Edit with old_string (the first validatePath match + surrounding lines)
  const matchIdx = lines.findIndex((l) => l.includes("validatePath"));
  const oldString = lines.slice(matchIdx, matchIdx + 3).join("\n");
  const editCall = builtinEditCallBytes(SAMPLE_FILE, oldString, "// fixed");
  steps.push({ tool: "Edit (old_string echo)", callBytes: editCall, resultBytes: builtinEditResultBytes() });

  return buildResult("Search & fix", steps);
}

function builtinMultiRegion(): ScenarioResult {
  const steps: StepDetail[] = [];

  // Built-in Read can't do disjoint ranges — must read the full file
  const callBytes = builtinReadCallBytes(SAMPLE_FILE);
  const resultBytes = Buffer.byteLength(simulateBuiltinRead(SAMPLE_FILE), "utf-8");
  steps.push({ tool: "Read full file (no disjoint)", callBytes, resultBytes });

  return buildResult("Multi-region read", steps);
}

function builtinMultiFile(): ScenarioResult {
  const steps: StepDetail[] = [];

  // No outline — must read each full file
  for (const file of SAMPLE_FILES) {
    const callBytes = builtinReadCallBytes(file);
    const resultBytes = Buffer.byteLength(simulateBuiltinRead(file), "utf-8");
    steps.push({ tool: `Read ${file.split("/").pop()}`, callBytes, resultBytes });
  }

  return buildResult("Multi-file exploration", steps);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printComparisonTable(pairs: { name: string; builtin: ScenarioResult; trueline: ScenarioResult }[]): void {
  const lineWidth = 96;
  console.log(`\n${"=".repeat(lineWidth)}`);
  console.log("Comparison: Built-in Tools vs Trueline-MCP");
  console.log("=".repeat(lineWidth));

  for (const { name, builtin, trueline } of pairs) {
    console.log(`\n${name}`);
    console.log("-".repeat(name.length));

    // Built-in detail
    const biSteps = builtin.steps.map((s) => s.tool).join(" → ");
    console.log(
      `  Built-in:  ${biSteps.padEnd(38)} call: ${String(builtin.totalCallBytes).padStart(5)}B  result: ${String(builtin.totalResultBytes).padStart(6)}B  total: ${String(builtin.totalBytes).padStart(6)}B  trips: ${builtin.roundTrips}`,
    );

    // Trueline detail
    const tlSteps = trueline.steps.map((s) => s.tool).join(" → ");
    console.log(
      `  Trueline:  ${tlSteps.padEnd(38)} call: ${String(trueline.totalCallBytes).padStart(5)}B  result: ${String(trueline.totalResultBytes).padStart(6)}B  total: ${String(trueline.totalBytes).padStart(6)}B  trips: ${trueline.roundTrips}`,
    );

    const saved = builtin.totalBytes - trueline.totalBytes;
    const pct = ((saved / builtin.totalBytes) * 100).toFixed(0);
    console.log(`  Savings:   ${saved}B (~${Math.round(saved / 4)} tokens, -${pct}%)`);
  }

  // Summary table
  console.log(`\n${"Summary".padEnd(lineWidth)}`);
  console.log("=".repeat(lineWidth));
  const hdr = `${"Scenario".padEnd(30)} | ${"Built-in".padStart(10)} | ${"Trueline".padStart(10)} | ${"Saved".padStart(10)} | ${"%".padStart(5)}`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  let grandBuiltin = 0;
  let grandTrueline = 0;
  for (const { name, builtin, trueline } of pairs) {
    const saved = builtin.totalBytes - trueline.totalBytes;
    const pct = ((saved / builtin.totalBytes) * 100).toFixed(0);
    grandBuiltin += builtin.totalBytes;
    grandTrueline += trueline.totalBytes;
    console.log(
      `${name.padEnd(30)} | ${String(builtin.totalBytes).padStart(10)} | ${String(trueline.totalBytes).padStart(10)} | ${String(saved).padStart(10)} | ${`${pct}%`.padStart(5)}`,
    );
  }
  console.log("-".repeat(hdr.length));
  const grandSaved = grandBuiltin - grandTrueline;
  const grandPct = ((grandSaved / grandBuiltin) * 100).toFixed(0);
  console.log(
    `${"TOTAL".padEnd(30)} | ${String(grandBuiltin).padStart(10)} | ${String(grandTrueline).padStart(10)} | ${String(grandSaved).padStart(10)} | ${`${grandPct}%`.padStart(5)}`,
  );
  console.log(`\nTotal saved: ~${Math.round(grandSaved / 4)} tokens`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const lineCount = readFileSync(SAMPLE_FILE, "utf-8").split("\n").length;
  console.log("Token Benchmark — trueline-mcp vs Built-in Tools");
  console.log(`Sample file: src/streaming-edit.ts (${lineCount} lines)`);
  console.log(`Multi-file: ${SAMPLE_FILES.map((f) => f.split("/").pop()).join(", ")}`);

  // Run all trueline scenarios
  const [tlNav, tlExplore, tlSearch, tlMultiRegion, tlMultiFile] = await Promise.all([
    truelineNavigate(),
    truelineExploreEdit(),
    truelineSearchFix(),
    truelineMultiRegion(),
    truelineMultiFile(),
  ]);

  // Run all built-in scenarios (synchronous — no IO)
  const biNav = builtinNavigate();
  const biExplore = builtinExploreEdit();
  const biSearch = builtinSearchFix();
  const biMultiRegion = builtinMultiRegion();
  const biMultiFile = builtinMultiFile();

  printComparisonTable([
    { name: "Navigate & understand", builtin: biNav, trueline: tlNav },
    { name: "Explore then edit", builtin: biExplore, trueline: tlExplore },
    { name: "Search & fix", builtin: biSearch, trueline: tlSearch },
    { name: "Multi-region read", builtin: biMultiRegion, trueline: tlMultiRegion },
    { name: "Multi-file exploration", builtin: biMultiFile, trueline: tlMultiFile },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
