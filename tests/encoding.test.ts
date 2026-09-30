import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcodedLines, encodeBuffer } from "../src/encoding.ts";
import { handleRead } from "../src/tools/read.ts";
import { handleEdit } from "../src/tools/edit.ts";
import { getText } from "./helpers.ts";

let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "encoding-test-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeFile(name: string, content: Buffer): string {
  const dir = setup();
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// Helper to build a UTF-16 LE file with BOM
function utf16leFile(...lines: string[]): Buffer {
  const bom = Buffer.from([0xff, 0xfe]);
  const content = `${lines.join("\n")}\n`;
  const encoded = Buffer.from(content, "utf16le");
  return Buffer.concat([bom, encoded]);
}

// Helper to build a UTF-16 BE file with BOM
function utf16beFile(...lines: string[]): Buffer {
  const bom = Buffer.from([0xfe, 0xff]);
  const content = `${lines.join("\n")}\n`;
  const le = Buffer.from(content, "utf16le");
  // Swap byte pairs for BE
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length - 1; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return Buffer.concat([bom, be]);
}

// Helper to build a UTF-8 BOM file
function utf8bomFile(...lines: string[]): Buffer {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const content = `${lines.join("\n")}\n`;
  return Buffer.concat([bom, Buffer.from(content, "utf-8")]);
}

// ==============================================================================
// BOM detection (reported by transcodedLines)
// ==============================================================================

async function sniffBOM(name: string, content: Buffer) {
  const { lines, bomInfo } = await transcodedLines(writeFile(name, content));
  for await (const _line of lines) {
    // drain so the fd closes
  }
  return bomInfo;
}

describe("BOM detection", () => {
  test("detects UTF-8 BOM", async () => {
    const info = await sniffBOM("bom-utf8.txt", Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(info.encoding).toBe("utf-8");
    expect(info.bom).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test("detects UTF-16 LE BOM", async () => {
    const info = await sniffBOM("bom-utf16le.txt", Buffer.from([0xff, 0xfe, 0x68, 0x00]));
    expect(info.encoding).toBe("utf-16le");
    expect(info.bom).toEqual(Buffer.from([0xff, 0xfe]));
  });

  test("detects UTF-16 BE BOM", async () => {
    const info = await sniffBOM("bom-utf16be.txt", Buffer.from([0xfe, 0xff, 0x00, 0x68]));
    expect(info.encoding).toBe("utf-16be");
    expect(info.bom).toEqual(Buffer.from([0xfe, 0xff]));
  });

  test("returns utf-8 with no BOM for plain text", async () => {
    const info = await sniffBOM("bom-none.txt", Buffer.from("hello"));
    expect(info.encoding).toBe("utf-8");
    expect(info.bom.length).toBe(0);
  });

  test("handles empty file", async () => {
    const info = await sniffBOM("bom-empty.txt", Buffer.alloc(0));
    expect(info.encoding).toBe("utf-8");
    expect(info.bom.length).toBe(0);
  });

  test("handles single-byte file", async () => {
    const info = await sniffBOM("bom-single.txt", Buffer.from([0xff]));
    expect(info.encoding).toBe("utf-8");
    expect(info.bom.length).toBe(0);
  });
});

// ==============================================================================
// transcodedLines — UTF-16 LE
// ==============================================================================

describe("transcodedLines — UTF-16 LE", () => {
  test("reads UTF-16 LE file with BOM", async () => {
    const p = writeFile("utf16le.txt", utf16leFile("hello", "world"));
    const { lines, bomInfo } = await transcodedLines(p);
    expect(bomInfo.encoding).toBe("utf-16le");
    expect(bomInfo.bom).toEqual(Buffer.from([0xff, 0xfe]));

    const collected = [];
    for await (const line of lines) {
      collected.push(line.lineBytes.toString("utf-8"));
    }
    expect(collected).toEqual(["hello", "world"]);
  });

  test("preserves empty lines in UTF-16 LE", async () => {
    const p = writeFile("utf16le-empty.txt", utf16leFile("alpha", "", "gamma"));
    const { lines } = await transcodedLines(p);

    const collected = [];
    for await (const line of lines) {
      collected.push(line.lineBytes.toString("utf-8"));
    }
    expect(collected).toEqual(["alpha", "", "gamma"]);
  });

  test("handles Unicode content in UTF-16 LE", async () => {
    const p = writeFile("utf16le-unicode.txt", utf16leFile("cafe\u0301", "\u{1F600}"));
    const { lines } = await transcodedLines(p);

    const collected = [];
    for await (const line of lines) {
      collected.push(line.lineBytes.toString("utf-8"));
    }
    expect(collected[0]).toBe("cafe\u0301");
    expect(collected[1]).toBe("\u{1F600}");
  });
});

// ==============================================================================
// transcodedLines — UTF-16 BE
// ==============================================================================

describe("transcodedLines — UTF-16 BE", () => {
  test("reads UTF-16 BE file with BOM", async () => {
    const p = writeFile("utf16be.txt", utf16beFile("hello", "world"));
    const { lines, bomInfo } = await transcodedLines(p);
    expect(bomInfo.encoding).toBe("utf-16be");
    expect(bomInfo.bom).toEqual(Buffer.from([0xfe, 0xff]));

    const collected = [];
    for await (const line of lines) {
      collected.push(line.lineBytes.toString("utf-8"));
    }
    expect(collected).toEqual(["hello", "world"]);
  });
});

// ==============================================================================
// transcodedLines — UTF-8 BOM
// ==============================================================================

describe("transcodedLines — UTF-8 BOM", () => {
  test("strips BOM from first line", async () => {
    const p = writeFile("utf8bom.txt", utf8bomFile("hello", "world"));
    const { lines, bomInfo } = await transcodedLines(p);
    expect(bomInfo.encoding).toBe("utf-8");
    expect(bomInfo.bom).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const collected = [];
    for await (const line of lines) {
      collected.push(line.lineBytes.toString("utf-8"));
    }
    // BOM should NOT appear in first line content
    expect(collected[0]).toBe("hello");
    expect(collected[1]).toBe("world");
  });

  test("binary detection still works for UTF-8 BOM files", async () => {
    // UTF-8 BOM followed by a null byte
    const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\x00world\n")]);
    const p = writeFile("utf8bom-binary.txt", content);
    const { lines } = await transcodedLines(p, { detectBinary: true });

    await expect(async () => {
      for await (const _line of lines) {
        // drain
      }
    }).toThrow(/binary/);
  });
});

// ==============================================================================
// transcodedLines — plain UTF-8 (no BOM)
// ==============================================================================

describe("transcodedLines — plain UTF-8", () => {
  test("passes through plain UTF-8 unchanged", async () => {
    const p = writeFile("plain.txt", Buffer.from("hello\nworld\n"));
    const { lines, bomInfo } = await transcodedLines(p);
    expect(bomInfo.bom.length).toBe(0);
    expect(bomInfo.encoding).toBe("utf-8");

    const collected = [];
    for await (const line of lines) {
      collected.push(line.lineBytes.toString("utf-8"));
    }
    expect(collected).toEqual(["hello", "world"]);
  });

  test("handles empty file", async () => {
    const p = writeFile("empty.txt", Buffer.alloc(0));
    const { lines, bomInfo } = await transcodedLines(p);
    expect(bomInfo.bom.length).toBe(0);

    const collected = [];
    for await (const line of lines) {
      collected.push(line);
    }
    expect(collected).toHaveLength(0);
  });
});

// ==============================================================================
// transcodedLines — fd lifetime
// ==============================================================================

// Bun >= 1.4 throws when a FileHandle is garbage-collected unclosed, so an
// early exit from `lines` must close the fd itself. /dev/fd lists this
// process's open descriptors; Windows has no equivalent.
const openFdCount = () => readdirSync("/dev/fd").length;

describe.skipIf(process.platform === "win32")("transcodedLines — fd lifetime", () => {
  test("closes the fd when the consumer stops on the first chunk", async () => {
    const p = writeFile("early-exit.txt", Buffer.from("alpha\nbeta\ngamma\n"));
    const before = openFdCount();
    const { lines } = await transcodedLines(p);
    for await (const _line of lines) break;
    expect(openFdCount()).toBe(before);
  });

  test("closes the fd when binary detection throws on the first chunk", async () => {
    const p = writeFile("null-first-chunk.bin", Buffer.from("alpha\x00beta\n"));
    const before = openFdCount();
    const { lines } = await transcodedLines(p, { detectBinary: true });
    await expect(async () => {
      for await (const _line of lines) {
        // drain
      }
    }).toThrow(/binary/);
    expect(openFdCount()).toBe(before);
  });

  test("closes the fd when the consumer stops on the first UTF-16 chunk", async () => {
    const p = writeFile("early-exit-utf16.txt", utf16leFile("alpha", "beta", "gamma"));
    const before = openFdCount();
    const { lines } = await transcodedLines(p);
    for await (const _line of lines) break;
    expect(openFdCount()).toBe(before);
  });

  // open(O_RDONLY) accepts a directory; the BOM-sniffing read then fails with EISDIR.
  test("closes the fd when the BOM-sniffing read fails", async () => {
    const dir = setup();
    const before = openFdCount();
    await expect(transcodedLines(dir)).rejects.toMatchObject({ code: "EISDIR" });
    expect(openFdCount()).toBe(before);
  });
});

// ==============================================================================
// encodeBuffer
// ==============================================================================

describe("encodeBuffer", () => {
  test("UTF-16 LE byte order", () => {
    const result = encodeBuffer(Buffer.from("AB"), "utf-16le");
    expect(result).toEqual(Buffer.from([0x41, 0x00, 0x42, 0x00]));
  });

  test("UTF-16 BE byte order", () => {
    const result = encodeBuffer(Buffer.from("AB"), "utf-16be");
    expect(result).toEqual(Buffer.from([0x00, 0x41, 0x00, 0x42]));
  });

  test("UTF-8 identity returns same buffer", () => {
    const buf = Buffer.from("hello");
    const result = encodeBuffer(buf, "utf-8");
    expect(result).toBe(buf); // same reference
  });

  test("transcodes UTF-8 buffer to UTF-16 LE", () => {
    const buf = Buffer.from("hi", "utf-8");
    const result = encodeBuffer(buf, "utf-16le");
    expect(result).toEqual(Buffer.from("hi", "utf16le"));
  });
});

// ==============================================================================
// Integration: trueline_read / trueline_edit across BOM encodings
// ==============================================================================

type FileBuilder = (...lines: string[]) => Buffer;

describe("trueline_read — BOM integration", () => {
  test.each<[string, FileBuilder, string[], string]>([
    ["UTF-16 LE", utf16leFile, ["alpha", "beta"], "utf-16le"],
    ["UTF-8 BOM", utf8bomFile, ["first", "second"], "utf-8-bom"],
  ])("reads %s file without BOM leaking into content", async (_kind, build, lines, label) => {
    const p = writeFile("read-bom.txt", build(...lines));
    const result = await handleRead({
      file_path: p,
      allowedDirs: [tmpDir],
    });

    const text = getText(result);
    for (const line of lines) expect(text).toContain(line);
    expect(text).toContain(`encoding: ${label}`);
    // Should not contain BOM bytes in output
    expect(text).not.toContain("\ufeff");
    expect(text).not.toContain("\ufffe");
  });
});

describe("trueline_edit — BOM round-trip", () => {
  interface RoundTripCase {
    kind: string;
    build: FileBuilder;
    bom: number[];
    decode: (payload: Buffer) => string;
    lines: string[];
    target: string;
    replacement: string;
  }

  const cases: RoundTripCase[] = [
    {
      kind: "UTF-16 LE",
      build: utf16leFile,
      bom: [0xff, 0xfe],
      decode: (payload) => payload.toString("utf16le"),
      lines: ["alpha", "beta", "gamma"],
      target: "beta",
      replacement: "BETA",
    },
    {
      kind: "UTF-8 BOM",
      build: utf8bomFile,
      bom: [0xef, 0xbb, 0xbf],
      decode: (payload) => payload.toString("utf-8"),
      lines: ["hello", "world"],
      target: "world",
      replacement: "universe",
    },
    {
      kind: "UTF-16 BE",
      build: utf16beFile,
      bom: [0xfe, 0xff],
      // swap16 works in place, so copy first
      decode: (payload) => Buffer.from(payload).swap16().toString("utf16le"),
      lines: ["one", "two", "three"],
      target: "two",
      replacement: "TWO",
    },
  ];

  test.each(cases)("edits a $kind file and preserves its BOM and encoding", async (c) => {
    const p = writeFile("edit-bom.txt", c.build(...c.lines));

    // Read to get checksums
    const readText = getText(await handleRead({ file_path: p, allowedDirs: [tmpDir] }));
    const refMatch = readText.match(/ref: (\S+)/);
    expect(refMatch).toBeTruthy();
    const ref = refMatch![1];

    // Anchor on the tab so a random tmpdir name can't match the target
    const targetLine = readText.split("\n").find((l) => l.endsWith(`\t${c.target}`));
    expect(targetLine).toBeDefined();
    const hashLine = targetLine!.split("\t")[0]; // e.g., "ab2"

    const editResult = await handleEdit({
      file_path: p,
      edits: [
        {
          range: `${hashLine}-${hashLine}`,
          content: c.replacement,
          ref,
        },
      ],
      allowedDirs: [tmpDir],
    });
    expect(editResult.isError).toBeFalsy();

    const raw = readFileSync(p);
    expect([...raw.subarray(0, c.bom.length)]).toEqual(c.bom);

    const decoded = c.decode(raw.subarray(c.bom.length));
    expect(decoded).toContain(c.replacement);
    for (const line of c.lines.filter((l) => l !== c.target)) expect(decoded).toContain(line);
    expect(decoded).not.toContain(c.target);
  });
});

// The BOM bytes are stripped by transcodedLines itself, so the TextDecoder must
// not strip a second, content U+FEFF (ZWNBSP) that follows them.
describe("UTF-16 keeps a content U+FEFF after the BOM", () => {
  async function decodedLines(p: string): Promise<string[]> {
    const { lines } = await transcodedLines(p);
    const out: string[] = [];
    for await (const { lineBytes } of lines) out.push(lineBytes.toString("utf-8"));
    return out;
  }

  test("UTF-16 LE", async () => {
    const p = writeFile("zwnbsp-le.txt", utf16leFile("\uFEFFa", "b"));
    expect(await decodedLines(p)).toEqual(["\uFEFFa", "b"]);
  });

  test("UTF-16 BE", async () => {
    const p = writeFile("zwnbsp-be.txt", utf16beFile("\uFEFFa", "b"));
    expect(await decodedLines(p)).toEqual(["\uFEFFa", "b"]);
  });

  test("the BOM itself is stripped exactly once", async () => {
    const p = writeFile("plain-bom.txt", utf16leFile("a", "b"));
    expect(await decodedLines(p)).toEqual(["a", "b"]);
  });

  test("two content U+FEFF after the BOM both survive", async () => {
    const p = writeFile("double-zwnbsp.txt", utf16leFile("\uFEFF\uFEFFa"));
    expect(await decodedLines(p)).toEqual(["\uFEFF\uFEFFa"]);
  });

  test("an edit rewrite does not delete the character", async () => {
    const p = writeFile("zwnbsp-edit.txt", utf16leFile("\uFEFFa", "b"));
    const readText = getText(await handleRead({ file_path: p, allowedDirs: [tmpDir] }));
    const ref = readText.match(/ref: (\S+)/)![1];
    const hashLine = readText
      .split("\n")
      .find((l) => l.endsWith("\tb"))!
      .split("\t")[0];

    const editResult = await handleEdit({
      file_path: p,
      edits: [{ range: hashLine, content: "B", ref }],
      allowedDirs: [tmpDir],
    });
    expect(editResult.isError).toBeFalsy();

    const raw = readFileSync(p);
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]);
    expect(raw.subarray(2).toString("utf16le")).toBe("\uFEFFa\nB\n");
  });
});
