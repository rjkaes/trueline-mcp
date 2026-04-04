import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead, clearReadCache } from "../../src/tools/read.ts";
import { handleVerify } from "../../src/tools/verify.ts";
import { getText, writeTestFile as _writeTestFile, resetRefStore } from "../helpers.ts";
import { issueRef } from "../../src/ref-store.ts";

let testDir: string;
const writeTestFile = (name: string, content: string) => _writeTestFile(testDir, name, content);

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-verify-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearReadCache();
  resetRefStore();
});

/** Extract ref IDs from a trueline_read result. */
function extractRefs(text: string): string[] {
  const matches = text.matchAll(/ref:(R\d+)/g);
  return [...matches].map((m) => m[1]);
}

describe("trueline_verify", () => {
  test("all valid — refs match immediately after read", async () => {
    const file = writeTestFile("valid.txt", "line one\nline two\nline three\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractRefs(getText(readResult));
    expect(refs.length).toBeGreaterThan(0);

    const result = await handleVerify({ refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("stale after external modification", async () => {
    const file = writeTestFile("stale.txt", "original content\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractRefs(getText(readResult));

    // Modify the file externally
    writeFileSync(file, "modified content\n");

    const result = await handleVerify({ refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("mixed valid and stale with two ranges", async () => {
    const lines = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const file = writeTestFile("mixed.txt", lines);

    // Read two non-adjacent ranges
    const readResult = await handleRead({
      file_path: file,
      ranges: ["1-5", "10-15"],
      projectDir: testDir,
    });
    const refs = extractRefs(getText(readResult));
    expect(refs.length).toBe(2);

    // Modify only lines in the second range (10-15)
    const modifiedLines =
      Array.from({ length: 20 }, (_, i) => (i >= 9 && i <= 14 ? `modified ${i + 1}` : `line ${i + 1}`)).join("\n") +
      "\n";
    writeFileSync(file, modifiedLines);

    const result = await handleVerify({ refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("valid:");
    expect(text).toContain("stale:");
  });

  test("unknown ref returns error", async () => {
    const result = await handleVerify({
      refs: ["R9999"],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Unknown ref");
  });

  test("empty refs array returns error", async () => {
    const result = await handleVerify({
      refs: [],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No refs provided");
  });

  test("range past EOF is stale", async () => {
    const file = writeTestFile("short.txt", "one\ntwo\n");
    // Issue a ref for lines 1-100 that extends past EOF
    const ref = issueRef(file, 1, 100, "deadbeef");

    const result = await handleVerify({ refs: [ref], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("empty file ref is valid", async () => {
    const file = writeTestFile("empty.txt", "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractRefs(getText(readResult));

    const result = await handleVerify({ refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("empty file ref becomes stale when content is added", async () => {
    const file = writeTestFile("empty2.txt", "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractRefs(getText(readResult));

    // Write content so it's no longer empty
    writeFileSync(file, "now has content\n");

    const result = await handleVerify({ refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("overlapping ranges both compute correctly", async () => {
    const lines = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const file = writeTestFile("overlap.txt", lines);

    // Read full file and a sub-range
    const fullRead = await handleRead({ file_path: file, projectDir: testDir });
    clearReadCache();
    const subRead = await handleRead({
      file_path: file,
      ranges: ["5-15"],
      projectDir: testDir,
    });

    const fullRefs = extractRefs(getText(fullRead));
    const subRefs = extractRefs(getText(subRead));

    // Verify both in one call (overlapping ranges)
    const result = await handleVerify({
      refs: [...subRefs, ...fullRefs],
      projectDir: testDir,
    });
    expect(getText(result)).toBe("all refs valid");
  });
});
