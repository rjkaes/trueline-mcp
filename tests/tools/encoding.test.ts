import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// The caller's `encoding` applies to UTF-8 files only. UTF-16 lines reach the edit
// path already transcoded to UTF-8, so latin1 must not be applied to them.
describe("trueline_edit encoding param", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-encoding-test-")));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const utf16Fixtures: Array<[string, string, (text: string) => Buffer]> = [
    ["UTF-16LE", "utf-16le", (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])],
    [
      "UTF-16BE",
      "utf-16be",
      (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
    ],
  ];

  const hashedLines = (text: string) => text.split("\n").filter((line) => LINE_PATTERN.test(line));
  const refOf = (text: string) => text.match(/ref: (\S+)/)?.[1] ?? "";

  // Writes the fixture, reads it back, and returns the ref and range for editing `targetText`'s line.
  async function readFixture(file: string, contents: Buffer, targetText: string, encoding?: string) {
    writeFileSync(file, contents);
    const readText = getText(await handleRead({ file_path: file, encoding, projectDir: testDir }));
    const hashLine = hashedLines(readText)
      .find((line) => line.endsWith(`\t${targetText}`))
      ?.split("\t")[0];
    return { ref: refOf(readText), range: `${hashLine}-${hashLine}` };
  }

  for (const [label, decoderLabel, encode] of utf16Fixtures) {
    test(`${label} — latin1 param leaves context text intact`, async () => {
      const file = join(testDir, `context-${label}.txt`);
      const { ref, range } = await readFixture(file, encode("alpha\ncafé au lait\ngamma\ndelta\n"), "gamma");

      const editResult = await handleEdit({
        file_path: file,
        edits: [{ range, content: "GAMMA", ref }],
        encoding: "latin1",
        context_lines: 5,
        projectDir: testDir,
      });
      expect(editResult.isError).toBeFalsy();

      const freshRead = getText(await handleRead({ file_path: file, projectDir: testDir }));
      const contextLines = hashedLines(getText(editResult));
      expect(contextLines).toEqual(hashedLines(freshRead));
      expect(contextLines).toHaveLength(4);
    });

    test(`${label} — latin1 param does not corrupt non-ASCII replacement content`, async () => {
      const file = join(testDir, `write-${label}.txt`);
      const { ref, range } = await readFixture(file, encode("alpha\nbeta\ngamma\ndelta\n"), "beta");

      const editResult = await handleEdit({
        file_path: file,
        edits: [{ range, content: "crème brûlée", ref }],
        encoding: "latin1",
        context_lines: 5,
        projectDir: testDir,
      });
      expect(editResult.isError).toBeFalsy();

      expect(new TextDecoder(decoderLabel).decode(readFileSync(file))).toBe("alpha\ncrème brûlée\ngamma\ndelta\n");
      const freshRead = getText(await handleRead({ file_path: file, projectDir: testDir }));
      expect(refOf(getText(editResult))).toBe(refOf(freshRead));
      expect(hashedLines(getText(editResult))).toEqual(hashedLines(freshRead));
    });

    test(`${label} — latin1 param leaves dry-run diff text intact`, async () => {
      const file = join(testDir, `diff-${label}.txt`);
      const { ref, range } = await readFixture(file, encode("crème alpha\nbeta café\ngamma\n"), "beta café");

      const preview = getText(
        await handleEdit({
          file_path: file,
          edits: [{ range, content: "beta thé", ref }],
          encoding: "latin1",
          dry_run: true,
          projectDir: testDir,
        }),
      );

      expect(preview).toContain(" crème alpha");
      expect(preview).toContain("-beta café");
      expect(preview).toContain("+beta thé");
    });

    test(`${label} — latin1 param leaves deleted-line preview intact`, async () => {
      const file = join(testDir, `delete-${label}.txt`);
      const { ref, range } = await readFixture(file, encode("alpha\nbeta café\ngamma\n"), "beta café");

      const editResult = await handleEdit({
        file_path: file,
        edits: [{ range, content: "", ref }],
        encoding: "latin1",
        projectDir: testDir,
      });

      expect(getText(editResult)).toContain('"beta café"');
    });

    test(`${label} — resubmitting identical non-ASCII content under latin1 is a no-op`, async () => {
      const file = join(testDir, `noop-${label}.txt`);
      const original = encode("alpha\nbeta café\ngamma\n");
      const { ref, range } = await readFixture(file, original, "beta café");

      const editResult = await handleEdit({
        file_path: file,
        edits: [{ range, content: "beta café", ref }],
        encoding: "latin1",
        projectDir: testDir,
      });

      expect(getText(editResult)).toContain("(no changes)");
      expect(readFileSync(file).toString("hex")).toBe(original.toString("hex"));
    });
  }

  test("plain latin1 file — latin1 param still round-trips non-ASCII bytes", async () => {
    const file = join(testDir, "plain-latin1.txt");
    const { ref, range } = await readFixture(file, Buffer.from("alpha\ncafé\ngamma\n", "latin1"), "gamma", "latin1");

    const editResult = await handleEdit({
      file_path: file,
      edits: [{ range, content: "thé", ref }],
      encoding: "latin1",
      context_lines: 5,
      projectDir: testDir,
    });
    expect(editResult.isError).toBeFalsy();

    expect(readFileSync(file)).toEqual(Buffer.from("alpha\ncafé\nthé\n", "latin1"));
    const freshRead = getText(await handleRead({ file_path: file, encoding: "latin1", projectDir: testDir }));
    expect(refOf(getText(editResult))).toBe(refOf(freshRead));
    expect(hashedLines(getText(editResult))).toEqual(hashedLines(freshRead));
    expect(getText(editResult)).toContain("café");
    expect(getText(editResult)).toContain("thé");
  });

  // Summary hints are refs callers reuse for follow-up edits, so they must equal a fresh read's hashLines.
  const hintRefs = (summary: string) =>
    summary.split("\n").flatMap((line) => line.match(/^[~+].* -> (\S+)/)?.[1].split("-") ?? []);

  const hintFixtures: Array<[string, (text: string) => Buffer, string | undefined]> = [
    ["plain latin1", (text) => Buffer.from(text, "latin1"), "latin1"],
    ["UTF-16LE", utf16Fixtures[0][2], "latin1"],
    ["UTF-16BE", utf16Fixtures[1][2], "latin1"],
    ["UTF-8", (text) => Buffer.from(text, "utf-8"), undefined],
  ];

  const hintShapes: Array<[string, string, "replace" | "insert_after", number]> = [
    ["single-line replace", "crème", "replace", 1],
    ["multi-line replace", "crème\nbrûlée\nthé", "replace", 2],
    ["single-line insert_after", "crème", "insert_after", 1],
    ["multi-line insert_after", "crème\nnoël", "insert_after", 2],
  ];

  for (const [fixtureLabel, encode, encoding] of hintFixtures) {
    for (const [shape, content, action, hintCount] of hintShapes) {
      test(`${fixtureLabel} — ${shape} hint matches a fresh read`, async () => {
        const file = join(testDir, `hint-${fixtureLabel}-${shape}.txt`.replace(/\s+/g, "-"));
        const fixture = await readFixture(file, encode("alpha\nbeta\ngamma\ndelta\n"), "beta", encoding);

        const editResult = await handleEdit({
          file_path: file,
          edits: [
            {
              range: action === "insert_after" ? fixture.range.split("-")[0] : fixture.range,
              content,
              ref: fixture.ref,
              action,
            },
          ],
          encoding,
          projectDir: testDir,
        });
        expect(editResult.isError).toBeFalsy();

        const freshRead = getText(await handleRead({ file_path: file, encoding, projectDir: testDir }));
        const freshByLine = new Map(
          hashedLines(freshRead).map((line) => [Number.parseInt(line.slice(2), 10), line.split("\t")[0]]),
        );
        const hints = hintRefs(getText(editResult));
        expect(hints).toHaveLength(hintCount);
        const expected = hints.map((hint) => freshByLine.get(Number.parseInt(hint.slice(2), 10)) ?? "(no such line)");
        expect(hints).toEqual(expected);
      });
    }
  }
});
