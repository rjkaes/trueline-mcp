import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../../src/tools/read.ts";
import { handleVerify } from "../../src/tools/verify.ts";
import { getText, issueTestRef, writeTestFile } from "../helpers.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-verify-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Extract inline refs from a trueline_read result. */
function extractInlineRefs(text: string): string[] {
  const matches = text.matchAll(/ref: ((?:[a-z]{2})?\d+-(?:[a-z]{2})?\d+\/[a-z]{6})/g);
  return [...matches].map((m) => m[1]);
}

describe("trueline_verify", () => {
  test("all valid — refs match immediately after read", async () => {
    const file = writeTestFile(testDir, "valid.txt", "line one\nline two\nline three\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));
    expect(refs.length).toBeGreaterThan(0);

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("stale after external modification", async () => {
    const file = writeTestFile(testDir, "stale.txt", "original content\n");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));

    // Modify the file externally
    writeFileSync(file, "modified content\n");

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("- ");
    expect(text).toContain("checksum mismatch");
  });

  test("mixed valid and stale with two ranges", async () => {
    const content = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const file = writeTestFile(testDir, "mixed.txt", content);

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
    expect(text).toContain("+ ");
    expect(text).toContain("- ");
  });

  test("invalid ref format returns error", async () => {
    const file = writeTestFile(testDir, "any.txt", "hello\n");
    const result = await handleVerify({
      file_path: file,
      refs: ["not-a-valid-ref"],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("empty refs array returns error", async () => {
    const file = writeTestFile(testDir, "any2.txt", "hello\n");
    const result = await handleVerify({
      file_path: file,
      refs: [],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No refs provided");
  });

  test("range past EOF is stale", async () => {
    const file = writeTestFile(testDir, "short.txt", "one\ntwo\n");
    const lines = ["one", "two"];
    // Fabricate a ref claiming lines 1-100 (file only has 2 lines)
    const ref = issueTestRef(lines, 1, 100);

    const result = await handleVerify({ file_path: file, refs: [ref], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("- ");
  });

  test("empty file ref is valid", async () => {
    const file = writeTestFile(testDir, "empty.txt", "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("empty file sentinel 0-0/aaaaaa is valid for empty file", async () => {
    const file = writeTestFile(testDir, "empty2.txt", "");

    const result = await handleVerify({ file_path: file, refs: ["0-0/aaaaaa"], projectDir: testDir });
    expect(getText(result)).toBe("all refs valid");
  });

  test("empty file ref becomes stale when content is added", async () => {
    const file = writeTestFile(testDir, "empty3.txt", "");
    const readResult = await handleRead({ file_path: file, projectDir: testDir });
    const refs = extractInlineRefs(getText(readResult));

    // Write content so it's no longer empty
    writeFileSync(file, "now has content\n");

    const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("- ");
  });

  test("empty file sentinel against a multi-line file does not misreport the line count", async () => {
    const file = writeTestFile(testDir, "sentinel-stale.txt", "one\ntwo\nthree\nfour\nfive\n");

    const result = await handleVerify({ file_path: file, refs: ["0-0/aaaaaa"], projectDir: testDir });
    const text = getText(result);
    expect(text).not.toContain("1 lines");
    expect(text).toContain("no longer empty");
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

  // Refs from trueline_read hash BOM-stripped, transcoded lines; verify must do the same.
  const encodedFixtures: Array<[string, (text: string) => Buffer]> = [
    ["UTF-8 BOM", (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf-8")])],
    ["UTF-16LE", (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])],
    ["UTF-16BE", (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])],
  ];

  for (const [label, encode] of encodedFixtures) {
    test(`${label} file — ref from read verifies as valid`, async () => {
      const file = join(testDir, `valid-${label}.txt`);
      writeFileSync(file, encode("alpha\nbeta\ngamma\n"));
      const readResult = await handleRead({ file_path: file, projectDir: testDir });
      const refs = extractInlineRefs(getText(readResult));
      expect(refs.length).toBe(1);

      const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
      expect(getText(result)).toBe("all refs valid");
    });

    test(`${label} file — ref goes stale after content change`, async () => {
      const file = join(testDir, `stale-${label}.txt`);
      writeFileSync(file, encode("alpha\nbeta\ngamma\n"));
      const readResult = await handleRead({ file_path: file, projectDir: testDir });
      const refs = extractInlineRefs(getText(readResult));

      writeFileSync(file, encode("alpha\nBETA\ngamma\n"));

      const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
      expect(getText(result)).toContain("checksum mismatch");
    });
  }

  test("file with NUL bytes and no UTF-16 BOM is still rejected as binary", async () => {
    const file = join(testDir, "binary-no-bom.bin");
    writeFileSync(file, Buffer.from("alpha\0beta\ngamma\n"));
    const ref = issueTestRef(["alpha", "beta", "gamma"], 1, 3);

    const result = await handleVerify({ file_path: file, refs: [ref], projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("binary");
  });

  // Bun >= 1.4 throws when a FileHandle is garbage-collected unclosed. /dev/fd has no Windows equivalent.
  describe.skipIf(process.platform === "win32")("fd lifetime", () => {
    const openFdCount = () => readdirSync("/dev/fd").length;

    test("closes the fd when verify stops before the end of a UTF-16 file", async () => {
      const file = join(testDir, "fd-early-stop.txt");
      writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("alpha\nbeta\ngamma\n", "utf16le")]));
      const readResult = await handleRead({ file_path: file, ranges: ["1-1"], projectDir: testDir });
      const refs = extractInlineRefs(getText(readResult));

      const before = openFdCount();
      const result = await handleVerify({ file_path: file, refs, projectDir: testDir });
      expect(getText(result)).toBe("all refs valid");
      expect(openFdCount()).toBe(before);
    });

    test("closes the fd when verify rejects a binary file", async () => {
      const file = join(testDir, "fd-binary.bin");
      writeFileSync(file, Buffer.from("alpha\0beta\ngamma\n"));

      const before = openFdCount();
      const result = await handleVerify({
        file_path: file,
        refs: [issueTestRef(["alpha", "beta", "gamma"], 1, 3)],
        projectDir: testDir,
      });
      expect(result.isError).toBe(true);
      expect(openFdCount()).toBe(before);
    });
  });
});
