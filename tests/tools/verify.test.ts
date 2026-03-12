import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../../src/tools/read.ts";
import { handleVerify } from "../../src/tools/verify.ts";
import { getText, writeTestFile as _writeTestFile } from "../helpers.ts";

let testDir: string;
const writeTestFile = (name: string, content: string) => _writeTestFile(testDir, name, content);

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-verify-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Extract checksum strings from a trueline_read result. */
function extractChecksums(text: string): string[] {
  const matches = text.matchAll(/checksum: (\S+)/g);
  return [...matches].map((m) => m[1]);
}

describe("trueline_verify", () => {
  test("all valid — checksums match immediately after read", async () => {
    const file = writeTestFile("valid.txt", "line one\nline two\nline three\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const checksums = extractChecksums(getText(readResult));
    expect(checksums.length).toBeGreaterThan(0);

    const result = await handleVerify({ file_path: file, checksums, projectDir: testDir });
    expect(getText(result)).toBe("all checksums valid");
  });

  test("stale after external modification", async () => {
    const file = writeTestFile("stale.txt", "original content\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const checksums = extractChecksums(getText(readResult));

    // Modify the file externally
    writeFileSync(file, "modified content\n");

    const result = await handleVerify({ file_path: file, checksums, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
    expect(text).toContain("actual:");
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
    const checksums = extractChecksums(getText(readResult));
    expect(checksums.length).toBe(2);

    // Modify only lines in the second range (10-15)
    const modifiedLines =
      Array.from({ length: 20 }, (_, i) => (i >= 9 && i <= 14 ? `modified ${i + 1}` : `line ${i + 1}`)).join("\n") +
      "\n";
    writeFileSync(file, modifiedLines);

    const result = await handleVerify({ file_path: file, checksums, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("valid:");
    expect(text).toContain("stale:");
  });

  test("invalid checksum format returns error", async () => {
    const file = writeTestFile("invalid.txt", "content\n");
    const result = await handleVerify({
      file_path: file,
      checksums: ["not-a-checksum"],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("empty checksums array returns error", async () => {
    const file = writeTestFile("empty-cs.txt", "content\n");
    const result = await handleVerify({
      file_path: file,
      checksums: [],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No checksums provided");
  });

  test("range past EOF is stale", async () => {
    const file = writeTestFile("short.txt", "one\ntwo\n");
    // Fabricate a checksum for lines 1-100 that can't possibly match
    const result = await handleVerify({
      file_path: file,
      checksums: ["1-100:deadbeef"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("empty file with 0-0:00000000 is valid", async () => {
    const file = writeTestFile("empty.txt", "");
    const result = await handleVerify({
      file_path: file,
      checksums: ["0-0:00000000"],
      projectDir: testDir,
    });
    expect(getText(result)).toBe("all checksums valid");
  });

  test("empty file with non-empty checksum is stale", async () => {
    const file = writeTestFile("empty2.txt", "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const checksums = extractChecksums(getText(readResult));
    expect(checksums).toEqual(["0-0:00000000"]);

    // Write content so it's no longer empty
    writeFileSync(file, "now has content\n");

    const result = await handleVerify({ file_path: file, checksums, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("stale:");
  });

  test("overlapping ranges both compute correctly", async () => {
    const lines = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const file = writeTestFile("overlap.txt", lines);

    // Read full file and a sub-range
    const fullRead = await handleRead({ file_path: file, projectDir: testDir });
    const subRead = await handleRead({
      file_path: file,
      ranges: [{ start: 5, end: 15 }],
      projectDir: testDir,
    });

    const fullCs = extractChecksums(getText(fullRead));
    const subCs = extractChecksums(getText(subRead));

    // Verify both in one call (overlapping ranges)
    const result = await handleVerify({
      file_path: file,
      checksums: [...subCs, ...fullCs],
      projectDir: testDir,
    });
    expect(getText(result)).toBe("all checksums valid");
  });
});
