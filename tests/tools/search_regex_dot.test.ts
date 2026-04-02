import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";
import { getText } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-search-dot-")));
  testFile = join(testDir, "sample.txt");
  const lines = [];
  for (let i = 1; i <= 50; i++) lines.push(`line ${i}`);
  writeFileSync(testFile, lines.join("\n"));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("trueline_search with dot regex and max_matches should not return entire file as context", async () => {
  // If we search for "." with max_matches: 2 and context_lines: 5.
  // Every line is a match.
  // Match 1 captured. Match 2 captured.
  // But line 3 is a match AND it's in context of line 2.
  // Line 4 is a match AND in context of line 3...
  // Currently this will return ALL 50 lines because each match extends the window.

  const result = await handleSearch({
    file_paths: [testFile],
    pattern: ".",
    regex: true,
    max_matches: 2,
    context_lines: 5,
    projectDir: testDir,
  });

  expect(result.isError).toBeUndefined();
  const text = getText(result);
  const outputLines = text.split("\n").filter((l) => l.includes("\t"));

  // We asked for 2 matches with 5 context lines.
  // Max expected output lines: 2 + 5 + 5 = 12 (roughly, if they don't overlap much).
  // But currently it returns 50 lines.

  console.log(`Output lines count: ${outputLines.length}`);

  // FAIL: Currently returns 50 lines.
  expect(outputLines.length).toBeLessThan(20);
});
