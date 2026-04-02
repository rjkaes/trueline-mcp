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
    const matches = text.match(/← match/g);
    expect(matches?.length).toBe(1);

    // FAIL: Currently says "showing 1 of 3 matches" which is WRONG
    expect(text).toContain("(showing 1 of 3 matches");
  });
});
