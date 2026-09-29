import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEdit } from "../../src/tools/edit.ts";
import { handleRead } from "../../src/tools/read.ts";
import { validateEncoding } from "../../src/tools/shared.ts";
import { getText, LINE_PATTERN } from "../helpers.ts";

describe("validateEncoding", () => {
  test("defaults to utf-8 when undefined", () => {
    expect(validateEncoding(undefined)).toBe("utf-8");
  });

  test("accepts utf-8", () => {
    expect(validateEncoding("utf-8")).toBe("utf-8");
  });

  test("accepts utf8 (alias)", () => {
    expect(validateEncoding("utf8")).toBe("utf-8");
  });

  test("accepts ascii", () => {
    expect(validateEncoding("ascii")).toBe("ascii");
  });

  test("accepts latin1", () => {
    expect(validateEncoding("latin1")).toBe("latin1");
  });

  test("is case-insensitive", () => {
    expect(validateEncoding("UTF-8")).toBe("utf-8");
    expect(validateEncoding("Latin1")).toBe("latin1");
    expect(validateEncoding("ASCII")).toBe("ascii");
  });

  test("rejects unsupported encoding", () => {
    expect(() => validateEncoding("utf-16le")).toThrow("Unsupported encoding");
    expect(() => validateEncoding("binary")).toThrow("Unsupported encoding");
    expect(() => validateEncoding("shift_jis")).toThrow("Unsupported encoding");
  });
});

// Context hashes must match what trueline_read issues: BOM stripped, UTF-16 transcoded.
describe("trueline_edit context_lines — BOM and UTF-16 files", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-context-test-")));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const encodedFixtures: Array<[string, (text: string) => Buffer]> = [
    ["UTF-8 BOM", (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf-8")])],
    ["UTF-16LE", (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])],
    ["UTF-16BE", (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])],
  ];

  const hashedLines = (text: string) => text.split("\n").filter((line) => LINE_PATTERN.test(line));

  for (const [label, encode] of encodedFixtures) {
    test(`${label} — context lines carry the same hashes as a fresh read`, async () => {
      const file = join(testDir, `context-${label}.txt`);
      writeFileSync(file, encode("alpha\nbeta\ngamma\ndelta\n"));
      const readText = getText(await handleRead({ file_path: file, projectDir: testDir }));
      const ref = readText.match(/ref: (\S+)/)?.[1] ?? "";
      const gammaHashLine = hashedLines(readText)
        .find((line) => line.endsWith("\tgamma"))
        ?.split("\t")[0];

      const editResult = await handleEdit({
        file_path: file,
        edits: [{ range: `${gammaHashLine}-${gammaHashLine}`, content: "GAMMA", ref }],
        context_lines: 5,
        projectDir: testDir,
      });
      expect(editResult.isError).toBeFalsy();

      const freshRead = getText(await handleRead({ file_path: file, projectDir: testDir }));
      const contextLines = hashedLines(getText(editResult));
      expect(contextLines).toEqual(hashedLines(freshRead));
      expect(contextLines).toHaveLength(4);
    });
  }
});
