import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../../src/tools/read.ts";
import { handleVerify } from "../../src/tools/verify.ts";
import { getText, issueTestRef } from "../helpers.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-verify-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {});

/** Extract inline refs from a trueline_read result. */
function extractInlineRefs(text: string): string[] {
  const matches = text.matchAll(/ref: ((?:[a-z]{2}\.)?\d+-(?:[a-z]{2}\.)?\d+:[a-z]{6})/g);
  return [...matches].map((m) => m[1]);
}

describe("trueline_verify", () => {
  test("all valid — refs match immediately after read", async () => {
    const file = join(testDir, "valid.txt");
    writeFileSync(file, "line one\nline two\nline three\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));
    expect(refs.length).toBeGreaterThan(0);

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("stale after external modification", async () => {
    const file = join(testDir, "stale.txt");
    writeFileSync(file, "original content\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));

    // Modify the file externally
    writeFileSync(file, "modified content\n");

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
    expect(text).toContain("checksum mismatch");
  });

  test("mixed valid and stale with two ranges", async () => {
    const content = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const file = join(testDir, "mixed.txt");
    writeFileSync(file, content);

    // Read two non-adjacent ranges
    const readResult = await handleRead({
      file_path: file,
      ranges: ["1-5", "10-15"],
      projectDir: testDir,
    });
    const refs = extractInlineRefs(getText(readResult));
    expect(refs.length).toBe(2);

    // Modify only lines in the second range (10-15)
    const modifiedLines =
      Array.from({ length: 20 }, (_, i) => (i >= 9 && i <= 14 ? `modified ${i + 1}` : `line ${i + 1}`)).join("\n") +
      "\n";
    writeFileSync(file, modifiedLines);

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("valid:");
    expect(text).toContain("stale:");
  });

  test("invalid ref format returns error", async () => {
    const file = join(testDir, "any.txt");
    writeFileSync(file, "hello\n");
    const result = await handleVerify({
      file_path: file,
      refs: ["not-a-valid-ref"],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("empty refs array returns error", async () => {
    const file = join(testDir, "any2.txt");
    writeFileSync(file, "hello\n");
    const result = await handleVerify({
      file_path: file,
      refs: [],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No refs provided");
  });

  test("range past EOF is stale", async () => {
    const file = join(testDir, "short.txt");
    writeFileSync(file, "one\ntwo\n");
    const lines = ["one", "two"];
    // Fabricate a ref claiming lines 1-100 (file only has 2 lines)
    const ref = issueTestRef(file, lines, 1, 100);

    const result = await handleVerify({ file_path: file, refs: [ref], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("empty file ref is valid", async () => {
    const file = join(testDir, "empty.txt");
    writeFileSync(file, "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("empty file sentinel 0-0:aaaaaa is valid for empty file", async () => {
    const file = join(testDir, "empty2.txt");
    writeFileSync(file, "");

    const result = await handleVerify({ file_path: file, refs: ["0-0:aaaaaa"], projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("empty file ref becomes stale when content is added", async () => {
    const file = join(testDir, "empty3.txt");
    writeFileSync(file, "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));

    // Write content so it's no longer empty
    writeFileSync(file, "now has content\n");

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("multiple refs in one call — all valid", async () => {
    const file = join(testDir, "multi.txt");
    const content = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    writeFileSync(file, content);

    const readResult = await handleRead({
      file_path: file,
      ranges: ["1-5", "10-15"],
      projectDir: testDir,
    });
    const refs = extractInlineRefs(getText(readResult));
    expect(refs.length).toBe(2);

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });
});
