import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";
import { getText } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-search-bug-")));
  testFile = join(testDir, "sample.txt");
  writeFileSync(testFile, ["line 1", "line 2", "MATCH 1", "MATCH 2", "MATCH 3", "line 6", "line 7"].join("\n"));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("trueline_search max_matches strictness", () => {
  test("max_matches should strictly limit the number of matches shown", async () => {
    const result = await handleSearch({
      file_paths: [testFile],
      pattern: "MATCH",
      max_matches: 1,
      context_lines: 2,
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = getText(result);

    // FAIL: Currently shows all 3 matches with markers
    const matches = text.match(/->/g);
    expect(matches?.length).toBe(1);

    // FAIL: Currently says "showing 1 of 3 matches" which is WRONG
    expect(text).toContain("(showing 1 of 3 matches");
  });
});

function write(name: string, content: string | Buffer): string {
  const path = join(testDir, name);
  writeFileSync(path, content);
  return path;
}

describe("trueline_search max_matches truncation notice and budget", () => {
  // search.ts:246 emits the "showing N of M" notice only when grandTotal >
  // maxMatches. When the post-cap scan stops at POST_LIMIT_SCAN_CAP (1000
  // lines), total == max even though further matches exist, so the caller is
  // never told the result is incomplete.
  test("flags possible further matches when the post-cap scan was capped", async () => {
    const lines = ["needle first", ...Array.from({ length: 1500 }, (_, i) => `filler ${i}`), "needle far away"];
    const file = write("far-match.txt", lines.join("\n"));

    const result = await handleSearch({
      file_paths: [file],
      pattern: "needle",
      max_matches: 1,
      context_lines: 0,
      projectDir: testDir,
    });

    expect(getText(result)).toContain("increase max_matches");
  });

  // The cross-file budget shrinks by matches found, not windows returned: adjacent
  // matches share one window, so counting windows would over-grant the next file.
  test("max_matches is a global budget counted in matches, not windows", async () => {
    const adjacent = write("budget-adjacent.txt", "needle a1\nneedle a2\nfiller\n");
    const spread = write("budget-spread.txt", ["needle b1", "filler", "needle b2", "filler", "needle b3"].join("\n"));

    const result = await handleSearch({
      file_paths: [adjacent, spread],
      pattern: "needle",
      max_matches: 3,
      context_lines: 0,
      projectDir: testDir,
    });

    const marked = getText(result)
      .split("\n")
      .filter((line) => line.startsWith("->"));
    expect(marked).toHaveLength(3);
  });

  // A later match in the trailing context of the last captured match is shown as
  // context but is not one of the max_matches results, so it gets no marker.
  test("does not mark an uncaptured match that falls in trailing context", async () => {
    const file = write("trailing-match.txt", "needle one\nneedle two\nfiller\nfiller\n");

    const result = await handleSearch({
      file_paths: [file],
      pattern: "needle",
      max_matches: 1,
      context_lines: 2,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text.split("\n").filter((line) => line.startsWith("->"))).toHaveLength(1);
    expect(text).toMatch(/^[a-z]{2}2\tneedle two$/m);
  });
});
