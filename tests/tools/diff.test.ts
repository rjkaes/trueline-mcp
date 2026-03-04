import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDiff } from "../../src/tools/diff.ts";
import { lineHash } from "../helpers.ts";
import { rangeChecksum } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-diff-test-")));
  testFile = join(testDir, "target.ts");
  writeFileSync(testFile, "line 1\nline 2\nline 3\n");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleDiff", () => {
  test("returns unified diff with @@ hunk header for replacement", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleDiff({
      file_path: testFile,
      checksum: cs,
      edits: [
        {
          range: `2:${h2}..2:${h2}`,
          content: ["CHANGED"],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("-line 2");
    expect(text).toContain("+CHANGED");
    // Standard unified diff must include @@ hunk headers
    expect(text).toMatch(/^@@.+@@/m);
  });

  test("does not modify the file", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");

    await handleDiff({
      file_path: testFile,
      checksum: cs,
      edits: [
        {
          range: `1:${h1}..1:${h1}`,
          content: ["CHANGED"],
        },
      ],
      projectDir: testDir,
    });

    // File should be unchanged
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(testFile, "utf-8");
    expect(content).toBe("line 1\nline 2\nline 3\n");
  });

  test("rejects stale checksum", async () => {
    const result = await handleDiff({
      file_path: testFile,
      checksum: "1-3:00000000",
      edits: [
        {
          range: "1:zz..1:zz",
          content: ["nope"],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
  });

  // ===========================================================================
  // LCS algorithm correctness tests
  // ===========================================================================

  test("pure insertion (no deletions)", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");

    const result = await handleDiff({
      file_path: testFile,
      checksum: cs,
      edits: [
        {
          range: `+1:${h1}`,
          content: ["line 1"],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Should show inserted line and no deletions (exclude all diff headers)
    expect(text).toContain("+line 1");
    const contentLines = text.split("\n").filter((l) =>
      !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("@@") && !l.startsWith("==="),
    );
    expect(contentLines.some((l) => l.startsWith("-"))).toBe(false);
  });

  test("pure deletion (no insertions)", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleDiff({
      file_path: testFile,
      checksum: cs,
      edits: [
        {
          range: `2:${h2}..2:${h2}`,
          content: [],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("-line 2");
    expect(text).not.toMatch(/^\+(?![\+\-])/m); // no added lines (header lines start with +++)
  });

  test("identical content produces only context lines", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleDiff({
      file_path: testFile,
      checksum: cs,
      edits: [
        {
          range: `2:${h2}..2:${h2}`,
          content: ["line 2"],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // No + or - lines for content (only diff headers)
    const contentLines = text.split("\n").filter((l) =>
      !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("@@") && !l.startsWith("==="),
    );
    expect(contentLines.every((l) => l.startsWith(" ") || l === "")).toBe(true);
  });

  test("single-line swap does not loop — was the infinite-loop case", async () => {
    // The greedy diff would infinite-loop on ["a","b"] → ["b","a"]
    // because both lines match somewhere in the lookahead window.
    const swapFile = join(testDir, "swap.ts");
    writeFileSync(swapFile, "a\nb\n");

    const lines = ["a", "b"];
    const cs = rangeChecksum(lines, 1, 2);
    const ha = lineHash("a");
    const hb = lineHash("b");

    const result = await handleDiff({
      file_path: swapFile,
      checksum: cs,
      edits: [
        { range: `1:${ha}..2:${hb}`, content: ["b", "a"] },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Standard LCS diff of ["a","b"] → ["b","a"]: "b" is the LCS so it
    // stays as context; only "a" is removed and re-inserted after "b".
    expect(text).toContain("-a");
    expect(text).toContain("+a");
    expect(text).toContain(" b"); // "b" is unchanged context
  });

  test("multi-line change spanning >5 lines — was the window-size limitation", async () => {
    // The greedy diff had a 5-line lookahead window, so changes spanning
    // more than 5 lines were handled incorrectly.
    const bigFile = join(testDir, "big.ts");
    const original = ["a", "b", "c", "d", "e", "f", "g", "h"];
    writeFileSync(bigFile, original.join("\n") + "\n");

    const cs = rangeChecksum(original, 1, 8);
    const ha = lineHash("a");
    const hh = lineHash("h");

    const result = await handleDiff({
      file_path: bigFile,
      checksum: cs,
      edits: [
        {
          range: `1:${ha}..8:${hh}`,
          content: ["A", "B", "C", "D", "E", "F", "G", "H"],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // All 8 original lines removed, all 8 new lines added
    for (const line of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(text).toContain(`-${line}`);
    }
    for (const line of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      expect(text).toContain(`+${line}`);
    }
  });

  test("empty old file to non-empty new file", async () => {
    const emptyFile = join(testDir, "empty.ts");
    writeFileSync(emptyFile, "line 1\n");

    const lines = ["line 1"];
    const cs = rangeChecksum(lines, 1, 1);
    const h = lineHash("line 1");

    const result = await handleDiff({
      file_path: emptyFile,
      checksum: cs,
      edits: [
        {
          range: `1:${h}..1:${h}`,
          content: ["line 1", "added"],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("+added");
  });

  test("handles CRLF files correctly", async () => {
    const crlfFile = join(testDir, "crlf.ts");
    writeFileSync(crlfFile, "line 1\r\nline 2\r\nline 3\r\n");

    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleDiff({
      file_path: crlfFile,
      checksum: cs,
      edits: [{ range: `2:${h2}..2:${h2}`, content: ["CHANGED"] }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("-line 2");
    expect(text).toContain("+CHANGED");
  });

  test("non-empty file to empty (delete all lines)", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const cs = rangeChecksum(lines, 1, 3);
    const h1 = lineHash("line 1");
    const h3 = lineHash("line 3");

    const result = await handleDiff({
      file_path: testFile,
      checksum: cs,
      edits: [
        {
          range: `1:${h1}..3:${h3}`,
          content: [],
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("-line 1");
    expect(text).toContain("-line 2");
    expect(text).toContain("-line 3");
    // No additions
    const contentLines = text.split("\n").filter((l) =>
      !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("@@") && !l.startsWith("==="),
    );
    expect(contentLines.some((l) => l.startsWith("+"))).toBe(false);
  });
});
