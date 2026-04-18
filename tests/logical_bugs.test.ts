import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../src/tools/edit.ts";
import { handleRead } from "../src/tools/read.ts";
import { lineHash, issueTestRef } from "./helpers.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-logical-bugs-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("logical bugs and edge cases", () => {
  /**
   * BUG: DiffCollector duplicates context lines when a no-op edit (replacement
   * with identical content) is present. This happens because src/streaming-edit.ts
   * calls collector.context() twice in the no-op path.
   */
  test("DiffCollector duplicates context lines for no-op edits (KNOWN BUG)", async () => {
    const f = join(testDir, "diff-dup.txt");
    const content = "line1\nline2\nline3\nline4\nline5\n";
    writeFileSync(f, content);

    const lines = ["line1", "line2", "line3", "line4", "line5"];
    const ref = issueTestRef(f, lines, 1, 5);

    // Edit 1: change line 1 (to trigger a diff)
    // Edit 2: no-op change line 3
    const result = await handleEdit({
      file_path: f,
      dry_run: true,
      edits: [
        {
          ref,
          range: `${lineHash("line1")}.1`,
          content: "LINE1",
        },
        {
          ref,
          range: `${lineHash("line3")}.3`,
          content: "line3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const diff = result.content[0].text;

    const line3Count = (diff.match(/^ line3$/gm) || []).length;
    // This test is EXPECTED TO FAIL until the bug in streaming-edit.ts is fixed.
    // It currently receives 2 because of the duplicate call.
    expect(line3Count).toBe(1);
  });

  /**
   * BUG: Prepending to a file (insert-after at line 0) defaults to LF (\n)
   * even if the file uses CRLF (\r\n). This is because EOL detection
   * happens during the stream, but prepend happens before the stream starts.
   */
  test("insertAfter at line 0 on CRLF file incorrectly uses LF (KNOWN BUG)", async () => {
    const f = join(testDir, "prepend-crlf.txt");
    writeFileSync(f, "existing\r\n");

    const ref = issueTestRef(f, ["existing"], 1, 1);

    await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: "+0",
          content: "prepended",
        },
      ],
      projectDir: testDir,
    });

    const written = readFileSync(f);
    // This test is EXPECTED TO FAIL.
    // It currently produces <prepended\nexisting\r\n>
    const expected = Buffer.from("prepended\r\nexisting\r\n");
    expect(written.equals(expected)).toBe(true);
  });

  test("insertAfter at line 0 on empty file with multi-line content", async () => {
    const f = join(testDir, "empty-multi.txt");
    writeFileSync(f, "");

    const ref = "0-0:aaaaaa";

    await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: "+0",
          content: "line1\nline2",
        },
      ],
      projectDir: testDir,
    });

    const written = readFileSync(f, "utf-8");
    // Should result in "line1\nline2" (no trailing newline because original was empty)
    expect(written).toBe("line1\nline2");
  });

  test("handleRead truncates at MAX_OUTPUT_LINES", async () => {
    const f = join(testDir, "large.txt");
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`);
    writeFileSync(f, `${lines.join("\n")}\n`);

    const result = await handleRead({
      file_path: f,
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("(truncated at 2000 line limit");
    const lineCount = (text.match(/^[a-z]{2}\.\d+\t/gm) || []).length;
    expect(lineCount).toBe(2000);
  });

  test("ref mismatch provides narrow re-read suggestion", async () => {
    const f = join(testDir, "suggestion.txt");
    const content = "line1\nline2\nline3\nline4\nline5\n";
    writeFileSync(f, content);

    const lines = ["line1", "line2", "line3", "line4", "line5"];
    const ref = issueTestRef(f, lines, 1, 5);

    // Modify file externally but keep line 4 unchanged
    writeFileSync(f, "line1\nline2\nCHANGED\nline4\nline5\n");

    const result = await handleEdit({
      file_path: f,
      edits: [
        {
          ref,
          range: `${lineHash("line4")}.4`,
          content: "LINE4",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    const errorText = result.content[0].text;
    expect(errorText).toContain("checksum mismatch");
    expect(errorText).toContain("Re-read with trueline_read");
    expect(errorText).toContain("lines 4\u20134 appear unchanged");
  });

  test("coerceParams standardizes singular file_path to file_paths array", () => {
    const { coerceParams } = require("../src/coerce.ts");
    const input = { file_path: "foo.ts", edits: "[]" };
    const output: Record<string, unknown> = coerceParams(input);
    expect(Array.isArray(output.file_paths)).toBe(true);
    expect(output.file_paths[0]).toBe("foo.ts");
    // Should also parse stringified JSON for edits
    expect(Array.isArray(output.edits)).toBe(true);
  });
});
