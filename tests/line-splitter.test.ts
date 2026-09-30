import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextNoFollow, LF_BUF, EMPTY_BUF } from "../src/line-splitter.ts";
import { transcodedLines } from "../src/encoding.ts";

const CRLF_BUF = Buffer.from("\r\n");
const CR_BUF = Buffer.from("\r");

// Temporary directory for test fixtures, cleaned up after each test.
let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "line-splitter-test-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeFile(name: string, content: Buffer | string): string {
  const dir = setup();
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

async function collect(filePath: string, opts?: { detectBinary?: boolean }) {
  const lines: { lineBytes: Buffer; eolBytes: Buffer; lineNumber: number }[] = [];
  for await (const line of (await transcodedLines(filePath, opts)).lines) {
    lines.push(line);
  }
  return lines;
}

describe("transcodedLines", () => {
  test("LF line endings", async () => {
    const p = writeFile("lf.txt", "alpha\nbeta\ngamma\n");
    const lines = await collect(p);

    expect(lines).toHaveLength(3);
    expect(lines[0].lineBytes.toString()).toBe("alpha");
    expect(lines[0].eolBytes).toBe(LF_BUF);
    expect(lines[0].lineNumber).toBe(1);
    expect(lines[1].lineBytes.toString()).toBe("beta");
    expect(lines[2].lineBytes.toString()).toBe("gamma");
    expect(lines[2].eolBytes).toBe(LF_BUF);
  });

  test("CRLF line endings", async () => {
    const p = writeFile("crlf.txt", "alpha\r\nbeta\r\ngamma\r\n");
    const lines = await collect(p);

    expect(lines).toHaveLength(3);
    expect(lines[0].lineBytes.toString()).toBe("alpha");
    expect(lines[0].eolBytes).toEqual(CRLF_BUF);
    expect(lines[1].lineBytes.toString()).toBe("beta");
    expect(lines[1].eolBytes).toEqual(CRLF_BUF);
    expect(lines[2].lineBytes.toString()).toBe("gamma");
    expect(lines[2].eolBytes).toEqual(CRLF_BUF);
  });

  test("CR line endings", async () => {
    const p = writeFile("cr.txt", "alpha\rbeta\rgamma\r");
    const lines = await collect(p);

    expect(lines).toHaveLength(3);
    expect(lines[0].lineBytes.toString()).toBe("alpha");
    expect(lines[0].eolBytes).toEqual(CR_BUF);
    expect(lines[1].lineBytes.toString()).toBe("beta");
    expect(lines[1].eolBytes).toEqual(CR_BUF);
    expect(lines[2].lineBytes.toString()).toBe("gamma");
    expect(lines[2].eolBytes).toEqual(CR_BUF);
  });

  test("mixed line endings in one file", async () => {
    const p = writeFile("mixed.txt", "alpha\nbeta\r\ngamma\rdelta\n");
    const lines = await collect(p);

    expect(lines).toHaveLength(4);
    expect(lines[0].eolBytes).toBe(LF_BUF);
    expect(lines[1].eolBytes).toEqual(CRLF_BUF);
    expect(lines[2].eolBytes).toEqual(CR_BUF);
    expect(lines[3].eolBytes).toBe(LF_BUF);
  });

  test("no trailing newline", async () => {
    const p = writeFile("no-eol.txt", "alpha\nbeta");
    const lines = await collect(p);

    expect(lines).toHaveLength(2);
    expect(lines[0].lineBytes.toString()).toBe("alpha");
    expect(lines[0].eolBytes).toBe(LF_BUF);
    expect(lines[1].lineBytes.toString()).toBe("beta");
    expect(lines[1].eolBytes).toBe(EMPTY_BUF);
  });

  test("empty file yields nothing", async () => {
    const p = writeFile("empty.txt", "");
    const lines = await collect(p);

    expect(lines).toHaveLength(0);
  });

  test("line numbering is 1-based and sequential", async () => {
    const p = writeFile("numbered.txt", "a\nb\nc\nd\ne\n");
    const lines = await collect(p);

    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  test("binary detection throws on null byte", async () => {
    const p = writeFile("binary.bin", Buffer.from([0x68, 0x65, 0x6c, 0x00, 0x6f, 0x0a]));

    await expect(collect(p, { detectBinary: true })).rejects.toThrow("binary");
  });

  test("binary detection disabled passes null bytes through", async () => {
    const p = writeFile("binary-ok.bin", Buffer.from([0x68, 0x65, 0x6c, 0x00, 0x6f, 0x0a]));
    const lines = await collect(p, { detectBinary: false });

    expect(lines).toHaveLength(1);
    expect(lines[0].lineBytes).toEqual(Buffer.from([0x68, 0x65, 0x6c, 0x00, 0x6f]));
  });

  test("binary detection defaults to off", async () => {
    const p = writeFile("binary-default.bin", Buffer.from([0x68, 0x00, 0x0a]));
    const lines = await collect(p);

    expect(lines).toHaveLength(1);
  });

  test("CR at chunk boundary resolves to CRLF", async () => {
    // Create a file where \r lands exactly at a chunk boundary.
    // Node's default highWaterMark for fs.createReadStream is 65536 bytes.
    // We place \r at byte 65535 (0-indexed), so \n starts the next chunk.
    const chunkSize = 65536;
    const padding = Buffer.alloc(chunkSize - 1, 0x61); // 'a' repeated
    const content = Buffer.concat([padding, Buffer.from("\r\n"), Buffer.from("next\n")]);
    const p = writeFile("cr-boundary.txt", content);
    const lines = await collect(p);

    expect(lines).toHaveLength(2);
    expect(lines[0].eolBytes).toEqual(CRLF_BUF);
    expect(lines[0].lineNumber).toBe(1);
    expect(lines[1].lineBytes.toString()).toBe("next");
    expect(lines[1].eolBytes).toBe(LF_BUF);
    expect(lines[1].lineNumber).toBe(2);
  });

  test("bare CR at chunk boundary (not followed by LF)", async () => {
    // \r at chunk boundary but next chunk starts with 'x', not \n.
    const chunkSize = 65536;
    const padding = Buffer.alloc(chunkSize - 1, 0x61);
    const content = Buffer.concat([padding, Buffer.from("\r"), Buffer.from("next\n")]);
    const p = writeFile("cr-bare-boundary.txt", content);
    const lines = await collect(p);

    expect(lines).toHaveLength(2);
    expect(lines[0].eolBytes).toEqual(CR_BUF);
    expect(lines[1].lineBytes.toString()).toBe("next");
  });

  test("single line no newline", async () => {
    const p = writeFile("single.txt", "hello");
    const lines = await collect(p);

    expect(lines).toHaveLength(1);
    expect(lines[0].lineBytes.toString()).toBe("hello");
    expect(lines[0].eolBytes).toBe(EMPTY_BUF);
    expect(lines[0].lineNumber).toBe(1);
  });

  test("file with only a newline", async () => {
    const p = writeFile("just-newline.txt", "\n");
    const lines = await collect(p);

    expect(lines).toHaveLength(1);
    expect(lines[0].lineBytes.toString()).toBe("");
    expect(lines[0].eolBytes).toBe(LF_BUF);
    expect(lines[0].lineNumber).toBe(1);
  });
});

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// transcodedLines (markdown/XML outlines) and readTextNoFollow (tree-sitter outline,
// semantic diff) hand text to parsers that treat a leading U+FEFF as content.
describe("leading UTF-8 BOM", () => {
  test("transcodedLines drops the BOM from line 1", async () => {
    const p = writeFile("bom.md", Buffer.concat([UTF8_BOM, Buffer.from("# Invoice Guide\nBody\n")]));
    const lines = await collect(p);

    expect(lines.map((l) => l.lineBytes.toString())).toEqual(["# Invoice Guide", "Body"]);
  });

  test("transcodedLines keeps a BOM that is not at the start of the file", async () => {
    const p = writeFile("inner-bom.md", Buffer.concat([UTF8_BOM, Buffer.from("a\n\uFEFFb\n")]));
    const lines = await collect(p);

    expect(lines.map((l) => l.lineBytes.toString())).toEqual(["a", "\uFEFFb"]);
  });

  test("transcodedLines on a BOM-only file yields no lines", async () => {
    const p = writeFile("only-bom.md", UTF8_BOM);

    expect(await collect(p)).toHaveLength(0);
  });

  test("readTextNoFollow drops the BOM", async () => {
    const p = writeFile("bom.ts", Buffer.concat([UTF8_BOM, Buffer.from("export const rate = 1;\n")]));

    expect(await readTextNoFollow(p)).toBe("export const rate = 1;\n");
  });

  test("readTextNoFollow keeps a BOM that is not at the start of the file", async () => {
    const p = writeFile("inner-bom.ts", Buffer.concat([UTF8_BOM, Buffer.from("a\n\uFEFFb\n")]));

    expect(await readTextNoFollow(p)).toBe("a\n\uFEFFb\n");
  });

  test("readTextNoFollow without a BOM is unchanged", async () => {
    const p = writeFile("plain.ts", "export const rate = 1;\n");

    expect(await readTextNoFollow(p)).toBe("export const rate = 1;\n");
  });

  test("readTextNoFollow still returns null for a NUL byte after the BOM", async () => {
    const p = writeFile("binary.bin", Buffer.concat([UTF8_BOM, Buffer.from([0x61, 0x00, 0x62])]));

    expect(await readTextNoFollow(p)).toBeNull();
  });
});
