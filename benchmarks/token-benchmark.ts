/**
 * Token benchmark harness.
 *
 * Measures output bytes (÷4 ≈ tokens) across realistic agent workflows.
 * Compares trueline-mcp tools against simulated built-in tool equivalents.
 * Run: bun run benchmark
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { handleRead } from "../src/tools/read.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { handleSearch } from "../src/tools/search.ts";
import { handleVerify } from "../src/tools/verify.ts";
import { handleDiff } from "../src/tools/diff.ts";

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
// Diff repo setup (shared by trueline and built-in scenarios)
// ---------------------------------------------------------------------------

const DIFF_BASE = [
  "function add(a: number, b: number): number { return a + b; }",
  "function subtract(a: number, b: number): number { return a - b; }",
  "function multiply(a: number, b: number): number { return a * b; }",
  "class Calculator {",
  "  compute(op: string, a: number, b: number): number {",
  "    switch (op) {",
  '      case "add": return add(a, b);',
  '      case "sub": return subtract(a, b);',
  '      default: throw new Error("unknown");',
  "    }",
  "  }",
  "}",
].join("\n");

const DIFF_MODIFIED = [
  "function add(a: number, b: number): number { return a + b; }",
  'function divide(a: number, b: number): number { if (b === 0) throw new Error("zero"); return a / b; }',
  "function multiply(x: number, y: number): number { return x * y; }",
  "class Calculator {",
  "  compute(op: string, a: number, b: number): number {",
  "    switch (op) {",
  '      case "add": return add(a, b);',
  '      case "div": return divide(a, b);',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal code content
  "      default: throw new Error(`unknown: ${op}`);",
  "    }",
  "  }",
  "  getHistory(): number[] { return []; }",
  "}",
].join("\n");

function setupDiffRepo(): { gitDir: string; cleanup: () => void } {
  const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-tdiff-")));
  const testFile = join(gitDir, "app.ts");
  const git = (cmd: string) =>
    execSync(cmd, {
      cwd: gitDir,
      stdio: "pipe",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    });

  git("git init");
  git('git config user.email "bench@test.com"');
  git('git config user.name "Bench"');
  writeFileSync(testFile, `${DIFF_BASE}\n`);
  git("git add .");
  git("git commit -m initial");
  writeFileSync(testFile, `${DIFF_MODIFIED}\n`);

  return { gitDir, cleanup: () => rmSync(gitDir, { recursive: true, force: true }) };
}

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
  const outlineCall = jsonCallBytes({ file_paths: [SAMPLE_FILE] });
  const outline = await handleOutline({
    file_paths: [SAMPLE_FILE],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "outline", callBytes: outlineCall, resultBytes: outputBytes(outline) });

  // read targeted range
  const readCallObj = { file_path: SAMPLE_FILE, ranges: [{ start: 74, end: 150 }] };
  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 150 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "read 74-150",
    callBytes: jsonCallBytes(readCallObj),
    resultBytes: outputBytes(read),
  });

  return buildResult("Navigate & understand", steps);
}

async function truelineExploreEdit(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  // outline
  const outlineCall = jsonCallBytes({ file_paths: [SAMPLE_FILE] });
  const outline = await handleOutline({
    file_paths: [SAMPLE_FILE],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({ tool: "outline", callBytes: outlineCall, resultBytes: outputBytes(outline) });

  // exploratory read
  const exploreCallObj = { file_path: SAMPLE_FILE, ranges: [{ start: 74, end: 250 }] };
  const explore = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 250 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "read 74-250 (exploratory)",
    callBytes: jsonCallBytes(exploreCallObj),
    resultBytes: outputBytes(explore),
  });

  // targeted re-read for edit
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
    edits: [{ range: "100:ab-115:cd", checksum: "100-115:abcdef01", content: "// replaced content\n" }],
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
    edits: [{ range: "10:ab-12:cd", checksum: "10-12:abcdef01", content: "// fixed\n" }],
  });
  steps.push({
    tool: "edit (from search)",
    callBytes: editCall,
    resultBytes: Buffer.byteLength("checksum: 10-12:newcheck", "utf-8"),
  });

  return buildResult("Search & fix", steps);
}

async function truelineVerifyBeforeEdit(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];

  // Initial read to get checksums (simulated prior session)
  const readCallObj = { file_path: SAMPLE_FILE, ranges: [{ start: 74, end: 150 }] };
  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [{ start: 74, end: 150 }],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  const readText = read.content[0].text;
  const checksumMatch = readText.match(/checksum: (\S+)/);
  const checksum = checksumMatch ? checksumMatch[1] : "74-150:00000000";
  steps.push({
    tool: "read 74-150 (initial)",
    callBytes: jsonCallBytes(readCallObj),
    resultBytes: outputBytes(read),
  });

  // Verify checksums are still valid (file unchanged — common case)
  const verifyCallObj = { file_path: SAMPLE_FILE, checksums: [checksum] };
  const verify = await handleVerify({
    file_path: SAMPLE_FILE,
    checksums: [checksum],
    projectDir: PROJECT_DIR,
    allowedDirs: ALLOWED_DIRS,
  });
  steps.push({
    tool: "verify (still valid)",
    callBytes: jsonCallBytes(verifyCallObj),
    resultBytes: outputBytes(verify),
  });

  // Edit using held checksums (no re-read needed)
  const editCall = jsonCallBytes({
    file_path: SAMPLE_FILE,
    edits: [{ range: "100:ab-115:cd", checksum: "74-150:abcdef01", content: "// replaced content\n" }],
  });
  steps.push({
    tool: "edit (cached checksums)",
    callBytes: editCall,
    resultBytes: Buffer.byteLength("checksum: 74-150:newcheck", "utf-8"),
  });

  return buildResult("Verify before edit", steps);
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
  };
  const read = await handleRead({
    file_path: SAMPLE_FILE,
    ranges: [
      { start: 1, end: 15 },
      { start: 200, end: 220 },
      { start: 400, end: 420 },
    ],
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
    const callBytes = jsonCallBytes({ file_paths: [file] });
    const outline = await handleOutline({ file_paths: [file], projectDir: PROJECT_DIR, allowedDirs: ALLOWED_DIRS });
    steps.push({ tool: `outline ${file.split("/").pop()}`, callBytes, resultBytes: outputBytes(outline) });
  }

  return buildResult("Multi-file exploration", steps);
}

async function truelineSemanticDiff(): Promise<ScenarioResult> {
  const steps: StepDetail[] = [];
  const { gitDir, cleanup } = setupDiffRepo();

  try {
    const callObj = { file_paths: ["app.ts"], compare_against: "HEAD" };
    const result = await handleDiff({
      file_paths: ["app.ts"],
      compare_against: "HEAD",
      projectDir: gitDir,
      allowedDirs: [gitDir],
    });
    steps.push({ tool: "semantic diff", callBytes: jsonCallBytes(callObj), resultBytes: outputBytes(result) });
  } finally {
    cleanup();
  }

  return buildResult("Review changes (diff)", steps);
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

function builtinVerifyBeforeEdit(): ScenarioResult {
  const steps: StepDetail[] = [];
  const lines = readFileSync(SAMPLE_FILE, "utf-8").split("\n");

  // Initial read (full file — built-in can't do ranges)
  const readCall1 = builtinReadCallBytes(SAMPLE_FILE);
  const readResult1 = Buffer.byteLength(simulateBuiltinRead(SAMPLE_FILE), "utf-8");
  steps.push({ tool: "Read full file (initial)", callBytes: readCall1, resultBytes: readResult1 });

  // Must re-read full file to check if anything changed (no verify)
  const readCall2 = builtinReadCallBytes(SAMPLE_FILE);
  const readResult2 = Buffer.byteLength(simulateBuiltinRead(SAMPLE_FILE), "utf-8");
  steps.push({ tool: "Read full file (re-check)", callBytes: readCall2, resultBytes: readResult2 });

  // Edit with old_string echo
  const oldString = lines.slice(99, 115).join("\n");
  const editCall = builtinEditCallBytes(SAMPLE_FILE, oldString, "// replaced content");
  steps.push({ tool: "Edit (old_string echo)", callBytes: editCall, resultBytes: builtinEditResultBytes() });

  return buildResult("Verify before edit", steps);
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

function builtinSemanticDiff(): ScenarioResult {
  const steps: StepDetail[] = [];

  // Built-in has no semantic diff — the agent would run `git diff` via Bash
  // and receive the raw unified diff output
  const { gitDir, cleanup } = setupDiffRepo();
  try {
    const rawDiff = execSync("git diff", {
      cwd: gitDir,
      stdio: "pipe",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    }).toString();
    const callBytes = Buffer.byteLength("git diff", "utf-8");
    const resultBytes = Buffer.byteLength(rawDiff, "utf-8");
    steps.push({ tool: "Bash(git diff)", callBytes, resultBytes });
  } finally {
    cleanup();
  }

  return buildResult("Review changes (diff)", steps);
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
  const [tlNav, tlExplore, tlSearch, tlMultiRegion, tlMultiFile, tlVerify, tlDiff] = await Promise.all([
    truelineNavigate(),
    truelineExploreEdit(),
    truelineSearchFix(),
    truelineMultiRegion(),
    truelineMultiFile(),
    truelineVerifyBeforeEdit(),
    truelineSemanticDiff(),
  ]);

  // Run all built-in scenarios (synchronous — no IO)
  const biNav = builtinNavigate();
  const biExplore = builtinExploreEdit();
  const biSearch = builtinSearchFix();
  const biMultiRegion = builtinMultiRegion();
  const biMultiFile = builtinMultiFile();
  const biVerify = builtinVerifyBeforeEdit();
  const biDiff = builtinSemanticDiff();

  printComparisonTable([
    { name: "Navigate & understand", builtin: biNav, trueline: tlNav },
    { name: "Explore then edit", builtin: biExplore, trueline: tlExplore },
    { name: "Search & fix", builtin: biSearch, trueline: tlSearch },
    { name: "Multi-region read", builtin: biMultiRegion, trueline: tlMultiRegion },
    { name: "Multi-file exploration", builtin: biMultiFile, trueline: tlMultiFile },
    { name: "Verify before edit", builtin: biVerify, trueline: tlVerify },
    { name: "Review changes (diff)", builtin: biDiff, trueline: tlDiff },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
