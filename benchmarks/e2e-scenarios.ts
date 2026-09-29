/**
 * End-to-end perf scenarios on a 10k-line file, runnable under Bun or Node.
 *
 * Run directly to print speedups as JSON (used by runUnderNode):
 *   node benchmarks/e2e-scenarios.ts <baseline-commit>
 */
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hash from "../src/hash.ts";
import * as currentEdit from "../src/streaming-edit.ts";
import * as currentRead from "../src/tools/read.ts";
import * as currentSearch from "../src/tools/search.ts";
import { importBaseline, measureSpeedup } from "./perf-helpers.ts";

export interface E2ESpeedups {
  readRanged: number;
  search: number;
  editDryRun: number;
}

const sourceLines = Array.from({ length: 10_000 }, (_, i) =>
  i % 2000 === 0 ? `// SECTION: batch ${i / 2000}` : `  const invoice_${i} = await ledger.post(customerId, ${i * 17});`,
);

export async function measureE2E(baselineCommit: string): Promise<E2ESpeedups> {
  const baselineRead = await importBaseline<typeof currentRead>(baselineCommit, "src/tools/read.ts");
  const baselineSearch = await importBaseline<typeof currentSearch>(baselineCommit, "src/tools/search.ts");
  const baselineEdit = await importBaseline<typeof currentEdit>(baselineCommit, "src/streaming-edit.ts");

  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-perf-")));
  const ledgerFile = join(projectDir, "ledger.ts");
  writeFileSync(ledgerFile, `${sourceLines.join("\n")}\n`);

  // Dry-run replacement of line 100; the checksum ref covers just that line.
  const lineHash = hash.fnv1aHashBytes(Buffer.from(sourceLines[99]));
  const letters = hash.hashToLetters(lineHash);
  const checksumRef = {
    startLine: 100,
    endLine: 100,
    hash: hash.checksumToLetters(hash.foldHash(hash.FNV_OFFSET_BASIS, lineHash)),
  };

  const readRanged = (read: typeof currentRead) => () =>
    read.handleRead({ file_path: ledgerFile, ranges: ["9000-9050"], projectDir, allowedDirs: [projectDir] });
  const search = (tool: typeof currentSearch) => () =>
    tool.handleSearch({
      file_paths: [ledgerFile],
      pattern: "SECTION",
      max_matches: 10,
      projectDir,
      allowedDirs: [projectDir],
    });
  const editDryRun = (edit: typeof currentEdit) => async () => {
    const op = { startLine: 100, endLine: 100, startHash: letters, endHash: letters, insertAfter: false };
    const result = await edit.streamingEdit(
      ledgerFile,
      [{ ...op, content: ["  const voided = true;"] }],
      [checksumRef],
      statSync(ledgerFile).mtimeMs,
      true,
    );
    if (!result.ok) throw new Error(`dry-run edit failed: ${result.error}`);
  };

  try {
    return {
      readRanged: await measureSpeedup("read ranged", readRanged(baselineRead), readRanged(currentRead)),
      search: await measureSpeedup("search", search(baselineSearch), search(currentSearch)),
      editDryRun: await measureSpeedup("edit dry-run", editDryRun(baselineEdit), editDryRun(currentEdit)),
    };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const speedups = await measureE2E(process.argv[2]);
  // Last stdout line is the result; measureSpeedup's log lines precede it.
  console.log(JSON.stringify(speedups));
}
