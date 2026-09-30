import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../src/tools/edit.ts";
import { handleRead } from "../src/tools/read.ts";
import { getText, issueTestRef, lineHash, writeTestFile } from "./helpers.ts";
import type { ToolResult } from "../src/tools/types.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-bughunt-edit-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function refOf(text: string): string {
  const match = text.match(/ref: (\S+)/);
  if (!match) throw new Error(`no ref in: ${text}`);
  return match[1];
}

function linesOf(readText: string): string[] {
  return readText
    .split("\n")
    .filter((l) => /^[a-z]{2}\d+\t/.test(l))
    .map((l) => l.slice(l.indexOf("\t") + 1));
}

function hashLineOf(readText: string, lineNumber: number): string {
  const line = readText.split("\n").find((l) => new RegExp(`^[a-z]{2}${lineNumber}\t`).test(l));
  return line!.split("\t")[0];
}

describe("edit engine bug hunt", () => {
  // A line ending in a lone CR followed by an empty LF-terminated line was
  // written as "...\r" + "\n", which the splitter read back as one CRLF.
  test("blank line after a lone-CR line survives deleting the line between them", async () => {
    const f = writeTestFile(testDir, "notes.txt", "header\rstray\n\nfooter\n");
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir })));

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      edits: [{ ref, range: `${lineHash("stray")}2`, content: "" }],
    });
    expect(result.isError).toBeUndefined();

    const reread = getText(await handleRead({ file_path: f, projectDir: testDir }));
    expect(linesOf(reread)).toEqual(["header", "", "footer"]);
    expect(refOf(reread)).toBe(refOf(getText(result)));
  });

  // Buffer.from(str, "latin1") keeps only the low byte of each code unit, so
  // U+010D (č) is written as 0x0D, a CR that splits the line on the next read.
  test("latin1 edit with a code point above U+00FF does not split the line or return a stale ref", async () => {
    const f = join(testDir, "pets.txt");
    writeFileSync(f, Buffer.from("caf\xe9\nend\n", "latin1"));
    const readText = getText(await handleRead({ file_path: f, projectDir: testDir, encoding: "latin1" }));
    const ref = refOf(readText);
    const line1 = readText.split("\n")[0].split("\t")[0];

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      encoding: "latin1",
      edits: [{ ref, range: line1, content: "kočka" }],
    });

    if (!result.isError) {
      const reread = getText(await handleRead({ file_path: f, projectDir: testDir, encoding: "latin1" }));
      expect(refOf(reread)).toBe(refOf(getText(result)));
    }
    expect(readFileSync(f).includes(0x0d)).toBe(false);
  });

  // The stale-ref hint assumed every edit's boundary lines streamed by, but an
  // edit past a truncated EOF never did; its ref's EOF check ran after the
  // first ref's mismatch had already returned.
  test("stale-ref hint does not call a line past a truncated EOF unchanged", async () => {
    const lines = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const f = writeTestFile(testDir, "greek.txt", `${lines.join("\n")}\n`);
    // Narrow refs as trueline_read would issue them for lines 1-4 and line 5.
    const refHead = issueTestRef(lines, 1, 4);
    const refTail = issueTestRef(lines, 5, 5);

    // Another process edits line 2 and drops line 5.
    writeFileSync(f, "alpha\nBETA\ngamma\ndelta\n");

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      edits: [
        { ref: refHead, range: `${lineHash("delta")}4`, content: "DELTA" },
        { ref: refTail, range: `${lineHash("epsilon")}5`, content: "EPSILON" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).not.toContain("lines 4–5 appear unchanged");
  });

  // git apply and patch both reject a hunk whose last context line claims a
  // newline the file does not have.
  test("dry_run diff marks a missing trailing newline", async () => {
    const f = writeTestFile(testDir, "config.ini", "debug=false\nport=8080");
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir })));

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      dry_run: true,
      edits: [{ ref, range: `${lineHash("debug=false")}1`, content: "debug=true" }],
    });
    expect(result.isError).toBeUndefined();

    const diff = getText(result);
    expect(diff).toContain("+debug=true");
    expect(diff).toContain("\\ No newline at end of file");
  });
});

describe("lone CR followed by an empty LF line", () => {
  // Each case leaves a lone-CR line directly before an empty line whose EOL is LF.
  test.each([
    {
      name: "replace under a CR-detected EOL",
      source: "title\rold\n\nbody\n",
      edit: { range: `${lineHash("old")}2`, content: "new" },
      lines: ["title", "new", "", "body"],
      bytes: "title\rnew\r\r\nbody\n",
    },
    {
      name: "insert a blank line after a lone-CR line",
      source: "a\nb\rc\n",
      edit: { range: `+${lineHash("b")}2`, content: "" },
      lines: ["a", "b", "", "c"],
      bytes: "a\nb\r\r\nc\n",
    },
    {
      name: "delete before a run of blank lines",
      source: "x\ry\n\n\nz\n",
      edit: { range: `${lineHash("y")}2`, content: "" },
      lines: ["x", "", "", "z"],
      bytes: "x\r\r\n\nz\n",
    },
  ])("$name keeps every line", async ({ source, edit, lines, bytes }) => {
    const f = writeTestFile(testDir, "mixed.txt", source);
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir })));

    const result = await handleEdit({ file_path: f, projectDir: testDir, edits: [{ ref, ...edit }] });
    expect(result.isError).toBeUndefined();

    const reread = getText(await handleRead({ file_path: f, projectDir: testDir }));
    expect(linesOf(reread)).toEqual([...lines]);
    expect(refOf(reread)).toBe(refOf(getText(result)));
    // One CR added before the blank line's LF; the lone-CR line keeps its bytes.
    expect(readFileSync(f, "latin1")).toBe(bytes);
  });
});

describe("single-byte encodings reject unrepresentable content", () => {
  test("ascii edit rejects a non-ASCII character before writing anything", async () => {
    const f = writeTestFile(testDir, "motd.txt", "hello\nbye\n");
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir, encoding: "ascii" })));

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      encoding: "ascii",
      edits: [{ ref, range: `${lineHash("hello")}1`, content: "café" }],
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("U+00E9");
    expect(readFileSync(f, "latin1")).toBe("hello\nbye\n");
  });

  test("latin1 dry run rejects a code point above U+00FF", async () => {
    const f = writeTestFile(testDir, "pets.txt", "cat\n");
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir, encoding: "latin1" })));

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      encoding: "latin1",
      dry_run: true,
      edits: [{ ref, range: `${lineHash("cat")}1`, content: "kočka" }],
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("U+010D");
  });

  // A BOM overrides the encoding parameter, so UTF-16 content is not limited to latin1.
  test("latin1 encoding on a UTF-16 file still accepts any character", async () => {
    const f = join(testDir, "pets16.txt");
    const bom = Buffer.from([0xff, 0xfe]);
    writeFileSync(f, Buffer.concat([bom, Buffer.from("cat\n", "utf16le")]));
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir })));

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      encoding: "latin1",
      edits: [{ ref, range: `${lineHash("cat")}1`, content: "kočka" }],
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(f).equals(Buffer.concat([bom, Buffer.from("kočka\n", "utf16le")]))).toBe(true);
  });
});

describe("dry_run diff: missing final newline", () => {
  // Expected output matches `git diff --no-index` for the same before/after files.
  test.each([
    {
      name: "insert after a last line that has no newline",
      source: "alpha\nomega",
      edit: { range: `+${lineHash("omega")}2`, content: "tail" },
      diff: "@@ -1,2 +1,3 @@\n alpha\n-omega\n\\ No newline at end of file\n+omega\n+tail\n\\ No newline at end of file\n",
    },
    {
      name: "delete a last line that has no newline",
      source: "alpha\nomega",
      edit: { range: `${lineHash("omega")}2`, content: "" },
      diff: "@@ -1,2 +1 @@\n-alpha\n-omega\n\\ No newline at end of file\n+alpha\n\\ No newline at end of file\n",
    },
    {
      name: "replace a last line with a blank line",
      source: "alpha\nomega",
      edit: { range: `${lineHash("omega")}2`, content: "\n" },
      diff: "@@ -1,2 +1,2 @@\n alpha\n-omega\n\\ No newline at end of file\n+\n",
    },
    {
      name: "insert into an empty file",
      source: "",
      edit: { range: "+0", content: "hello" },
      diff: "@@ -0,0 +1 @@\n+hello\n\\ No newline at end of file\n",
    },
  ])("$name", async ({ source, edit, diff }) => {
    const f = writeTestFile(testDir, "notes.txt", source);
    const ref = refOf(getText(await handleRead({ file_path: f, projectDir: testDir })));

    const result = await handleEdit({ file_path: f, projectDir: testDir, dry_run: true, edits: [{ ref, ...edit }] });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toBe(`--- a/notes.txt\n+++ b/notes.txt\n${diff}`);
  });
});

describe("UTF-16 untouched lines round-trip byte-exact", () => {
  const bomLE = Buffer.from([0xff, 0xfe]);
  const bomBE = Buffer.from([0xfe, 0xff]);
  const be = (text: string) => Buffer.from(text, "utf16le").swap16();

  async function editLine1(f: string): Promise<void> {
    const readText = getText(await handleRead({ file_path: f, projectDir: testDir }));
    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      edits: [{ ref: refOf(readText), range: `${lineHash("alpha")}1`, content: "ALPHA" }],
    });
    expect(result.isError).toBeUndefined();
    expect(refOf(getText(await handleRead({ file_path: f, projectDir: testDir })))).toBe(refOf(getText(result)));
  }

  test("odd trailing byte on the last line", async () => {
    const f = join(testDir, "odd.txt");
    const tail = Buffer.concat([Buffer.from("omega", "utf16le"), Buffer.from([0x41])]);
    writeFileSync(f, Buffer.concat([bomLE, Buffer.from("alpha\n", "utf16le"), tail]));

    await editLine1(f);
    expect(readFileSync(f).toString("hex")).toBe(
      Buffer.concat([bomLE, Buffer.from("ALPHA\n", "utf16le"), tail]).toString("hex"),
    );
  });

  // The unpaired byte is not a character; lines appended after it must not shift into it.
  test("appending after the last line keeps the odd byte at EOF", async () => {
    const f = join(testDir, "odd-append.txt");
    writeFileSync(f, Buffer.concat([bomLE, Buffer.from("alpha\nomega", "utf16le"), Buffer.from([0x41])]));
    const readText = getText(await handleRead({ file_path: f, projectDir: testDir }));
    expect(linesOf(readText)).toEqual(["alpha", "omega"]);

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir,
      edits: [{ ref: refOf(readText), range: `+${lineHash("omega")}2`, content: "tail" }],
    });
    expect(result.isError).toBeUndefined();
    const reread = getText(await handleRead({ file_path: f, projectDir: testDir }));
    expect(linesOf(reread)).toEqual(["alpha", "omega", "tail"]);
    expect(refOf(reread)).toBe(refOf(getText(result)));
    expect(readFileSync(f).toString("hex")).toBe(
      Buffer.concat([bomLE, Buffer.from("alpha\nomega\ntail", "utf16le"), Buffer.from([0x41])]).toString("hex"),
    );
  });
  test("lone low surrogate in a big-endian file", async () => {
    const f = join(testDir, "be.txt");
    const line2 = Buffer.concat([Buffer.from([0xdc, 0x00]), be("x\n")]);
    writeFileSync(f, Buffer.concat([bomBE, be("alpha\n"), line2]));

    await editLine1(f);
    expect(readFileSync(f).toString("hex")).toBe(Buffer.concat([bomBE, be("ALPHA\n"), line2]).toString("hex"));
  });

  // 32766 units after the 2-byte BOM end the first 64 KB read between the pair's halves.
  test("surrogate pair split across a read chunk still decodes as one character", async () => {
    const f = join(testDir, "emoji.txt");
    const line2 = Buffer.from(`${"a".repeat(32760)}\u{1F600}\n`, "utf16le");
    writeFileSync(f, Buffer.concat([bomLE, Buffer.from("alpha\n", "utf16le"), line2]));

    const readText = getText(await handleRead({ file_path: f, projectDir: testDir }));
    expect(linesOf(readText)[1].endsWith("a\u{1F600}")).toBe(true);
    await editLine1(f);
    expect(readFileSync(f).toString("hex")).toBe(
      Buffer.concat([bomLE, Buffer.from("ALPHA\n", "utf16le"), line2]).toString("hex"),
    );
  });
});

describe("encoding: UTF-16 round-trip of untouched lines", () => {
  test("editing line 1 keeps a lone surrogate on line 2 byte-exact", async () => {
    const file = join(testDir, "strings.txt");
    const bom = Buffer.from([0xff, 0xfe]);
    const loneHighSurrogate = Buffer.from([0x00, 0xd8]);
    const line2 = Buffer.concat([loneHighSurrogate, Buffer.from("x\n", "utf16le")]);
    writeFileSync(file, Buffer.concat([bom, Buffer.from("alpha\n", "utf16le"), line2]));

    const readText = getText(await handleRead({ file_path: file, allowedDirs: [testDir] }));
    const result = await handleEdit({
      file_path: file,
      edits: [{ range: hashLineOf(readText, 1), ref: refOf(readText), content: "ALPHA" }],
      allowedDirs: [testDir],
    });
    expect(result.isError).toBeFalsy();

    const expected = Buffer.concat([bom, Buffer.from("ALPHA\n", "utf16le"), line2]);
    expect(readFileSync(file).toString("hex")).toBe(expected.toString("hex"));
  });
});

describe("UTF-32 files are refused", () => {
  function utf32(text: string, littleEndian: boolean): Buffer {
    const codePoints = [0xfeff, ...[...text].map((ch) => ch.codePointAt(0) ?? 0)];
    const buf = Buffer.alloc(codePoints.length * 4);
    for (const [i, cp] of codePoints.entries()) {
      if (littleEndian) buf.writeUInt32LE(cp, i * 4);
      else buf.writeUInt32BE(cp, i * 4);
    }
    return buf;
  }

  // The refusal may arrive as a thrown error or an error result; either must name UTF-32.
  const outcome = (pending: Promise<ToolResult>) => pending.then(getText, (err: Error) => err.message);

  test.each([
    ["UTF-32LE", true],
    ["UTF-32BE", false],
  ])("%s is refused by read and edit, and the file is left alone", async (_label, littleEndian) => {
    const f = join(testDir, "wide.txt");
    const original = utf32("hi\nthere\n", littleEndian);
    writeFileSync(f, original);

    expect(await outcome(handleRead({ file_path: f, projectDir: testDir }))).toContain("UTF-32 is not supported");

    const edit = { ref: issueTestRef(["hi", "there"], 1, 2), range: `${lineHash("hi")}1`, content: "hello" };
    expect(await outcome(handleEdit({ file_path: f, projectDir: testDir, edits: [edit] }))).toContain(
      "UTF-32 is not supported",
    );
    expect(readFileSync(f).equals(original)).toBe(true);
  });
});
