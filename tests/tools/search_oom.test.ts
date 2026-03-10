import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSearch } from "../../src/tools/search.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-search-oom-")));
  testFile = join(testDir, "sample.txt");
  writeFileSync(testFile, "line1\nline2\n");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("trueline_search should reject excessive context_lines with an error", async () => {
  // A number that is likely to cause RangeError: Invalid array length
  const excessiveContext = 5_000_000_000;

  // FAIL: Currently throws RangeError synchronously inside the async function,
  // which might not be caught by safeTool if not careful, and definitely
  // shouldn't happen at all.

  // biome-ignore lint/suspicious/noExplicitAny: test needs flexible typing
  let result: any;
  // biome-ignore lint/suspicious/noExplicitAny: test needs flexible typing
  let error: any;
  try {
    result = await handleSearch({
      file_path: testFile,
      pattern: "line",
      context_lines: excessiveContext,
      projectDir: testDir,
    });
  } catch (err) {
    error = err;
  }

  if (error) {
    // If it threw, it's also a failure because it should return an errorResult
    console.log("Threw error:", error.message);
    expect(error).toBeUndefined();
  } else {
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("context_lines");
  }
});
