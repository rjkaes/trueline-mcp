import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectBOM, transcodedLines, bomBytes, encodeString, encodeBuffer } from "../src/encoding.ts";
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
// detectBOM
// ==============================================================================

describe("detectBOM", () => {
  test("detects UTF-8 BOM", () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const info = detectBOM(buf);
    expect(info.encoding).toBe("utf-8");
    expect(info.bomLength).toBe(3);
    expect(info.hasBOM).toBe(true);
  });

  test("detects UTF-16 LE BOM", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00]);
    const info = detectBOM(buf);
    expect(info.encoding).toBe("utf-16le");
    expect(info.bomLength).toBe(2);
    expect(info.hasBOM).toBe(true);
  });

  test("detects UTF-16 BE BOM", () => {
    const buf = Buffer.from([0xfe, 0xff, 0x00, 0x68]);
    const info = detectBOM(buf);
    expect(info.encoding).toBe("utf-16be");
    expect(info.bomLength).toBe(2);
    expect(info.hasBOM).toBe(true);
  });

  test("returns utf-8 with no BOM for plain text", () => {
    const buf = Buffer.from("hello");
    const info = detectBOM(buf);
    expect(info.encoding).toBe("utf-8");
    expect(info.bomLength).toBe(0);
    expect(info.hasBOM).toBe(false);
  });

  test("handles empty buffer", () => {
    const info = detectBOM(Buffer.alloc(0));
    expect(info.encoding).toBe("utf-8");
    expect(info.hasBOM).toBe(false);
  });

  test("handles single-byte buffer", () => {
    const info = detectBOM(Buffer.from([0xff]));
    expect(info.encoding).toBe("utf-8");
    expect(info.hasBOM).toBe(false);
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
    expect(bomInfo.hasBOM).toBe(true);

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
    expect(bomInfo.hasBOM).toBe(true);

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
    expect(bomInfo.hasBOM).toBe(true);
    expect(bomInfo.bomLength).toBe(3);

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
    expect(bomInfo.hasBOM).toBe(false);
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
    expect(bomInfo.hasBOM).toBe(false);

    const collected = [];
    for await (const line of lines) {
      collected.push(line);
    }
    expect(collected).toHaveLength(0);
  });
});

// ==============================================================================
// encodeString / encodeBuffer
// ==============================================================================

describe("encodeString", () => {
  test("UTF-8 identity", () => {
    const result = encodeString("hello", "utf-8");
    expect(result.toString("utf-8")).toBe("hello");
  });

  test("UTF-16 LE encoding", () => {
    const result = encodeString("AB", "utf-16le");
    expect(result).toEqual(Buffer.from([0x41, 0x00, 0x42, 0x00]));
  });

  test("UTF-16 BE encoding", () => {
    const result = encodeString("AB", "utf-16be");
    expect(result).toEqual(Buffer.from([0x00, 0x41, 0x00, 0x42]));
  });
});

describe("encodeBuffer", () => {
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
// bomBytes
// ==============================================================================

describe("bomBytes", () => {
  test("UTF-8 BOM", () => {
    expect(bomBytes({ encoding: "utf-8", bomLength: 3, hasBOM: true })).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test("UTF-16 LE BOM", () => {
    expect(bomBytes({ encoding: "utf-16le", bomLength: 2, hasBOM: true })).toEqual(Buffer.from([0xff, 0xfe]));
  });

  test("UTF-16 BE BOM", () => {
    expect(bomBytes({ encoding: "utf-16be", bomLength: 2, hasBOM: true })).toEqual(Buffer.from([0xfe, 0xff]));
  });

  test("no BOM returns empty buffer", () => {
    expect(bomBytes({ encoding: "utf-8", bomLength: 0, hasBOM: false })).toEqual(Buffer.alloc(0));
  });
});

// ==============================================================================
// Integration: trueline_read with UTF-16 LE
// ==============================================================================

describe("trueline_read — UTF-16 LE integration", () => {
  test("reads UTF-16 LE file and returns UTF-8 content", async () => {
    const p = writeFile("read-utf16le.txt", utf16leFile("alpha", "beta"));
    const result = await handleRead({
      file_path: p,
      allowedDirs: [tmpDir],
    });

    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("encoding: utf-16le");
    // Should not contain BOM bytes in output
    expect(text).not.toContain("\ufeff");
    expect(text).not.toContain("\ufffe");
  });
});

// ==============================================================================
// Integration: trueline_read with UTF-8 BOM
// ==============================================================================

describe("trueline_read — UTF-8 BOM integration", () => {
  test("reads UTF-8 BOM file without BOM leaking into content", async () => {
    const p = writeFile("read-utf8bom.txt", utf8bomFile("first", "second"));
    const result = await handleRead({
      file_path: p,
      allowedDirs: [tmpDir],
    });

    const text = getText(result);
    // First line content should be "first", not "\uFEFFfirst"
    const firstContentLine = text.split("\n").find((l) => l.includes("first"));
    expect(firstContentLine).toBeDefined();
    expect(firstContentLine!).not.toContain("\ufeff");
    expect(text).toContain("encoding: utf-8-bom");
  });
});

// ==============================================================================
// Integration: round-trip edit for UTF-16 LE
// ==============================================================================

describe("trueline_edit — UTF-16 LE round-trip", () => {
  test("edits a UTF-16 LE file and preserves encoding", async () => {
    const p = writeFile("edit-utf16le.txt", utf16leFile("alpha", "beta", "gamma"));

    // Read to get checksums
    const readResult = await handleRead({
      file_path: p,
      allowedDirs: [tmpDir],
    });
    const readText = getText(readResult);

    // Extract ref from readResult
    const refMatch = readText.match(/ref: (\S+)/);
    expect(refMatch).toBeTruthy();
    const ref = refMatch![1];

    // Extract hash.line for "beta" (line 2)
    const betaLine = readText.split("\n").find((l) => l.includes("beta"));
    expect(betaLine).toBeDefined();
    const hashDotLine = betaLine!.split("\t")[0]; // e.g., "ab.2"

    // Edit: replace "beta" with "BETA"
    const editResult = await handleEdit({
      file_path: p,
      edits: [
        {
          range: `${hashDotLine}-${hashDotLine}`,
          content: "BETA",
          ref,
        },
      ],
      allowedDirs: [tmpDir],
    });
    expect(editResult.isError).toBeFalsy();

    // Verify the file is still UTF-16 LE with BOM
    const raw = readFileSync(p);
    expect(raw[0]).toBe(0xff);
    expect(raw[1]).toBe(0xfe);

    // Decode and verify content
    const decoded = raw.subarray(2).toString("utf16le");
    expect(decoded).toContain("BETA");
    expect(decoded).toContain("alpha");
    expect(decoded).toContain("gamma");
    expect(decoded).not.toContain("beta");
  });
});

// ==============================================================================
// Integration: round-trip edit for UTF-8 BOM
// ==============================================================================

describe("trueline_edit — UTF-8 BOM round-trip", () => {
  test("edits a UTF-8 BOM file and preserves BOM", async () => {
    const p = writeFile("edit-utf8bom.txt", utf8bomFile("hello", "world"));

    // Read
    const readResult = await handleRead({
      file_path: p,
      allowedDirs: [tmpDir],
    });
    const readText = getText(readResult);

    const refMatch = readText.match(/ref: (\S+)/);
    const ref = refMatch![1];

    const worldLine = readText.split("\n").find((l) => l.includes("world"));
    const hashDotLine = worldLine!.split("\t")[0];

    // Edit: replace "world" with "universe"
    const editResult = await handleEdit({
      file_path: p,
      edits: [
        {
          range: `${hashDotLine}-${hashDotLine}`,
          content: "universe",
          ref,
        },
      ],
      allowedDirs: [tmpDir],
    });
    expect(editResult.isError).toBeFalsy();

    // Verify BOM is preserved
    const raw = readFileSync(p);
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);

    // Verify content
    const content = raw.subarray(3).toString("utf-8");
    expect(content).toContain("hello");
    expect(content).toContain("universe");
    expect(content).not.toContain("world");
  });
});

// ==============================================================================
// Integration: round-trip edit for UTF-16 BE
// ==============================================================================

describe("trueline_edit — UTF-16 BE round-trip", () => {
  test("edits a UTF-16 BE file and preserves encoding", async () => {
    const p = writeFile("edit-utf16be.txt", utf16beFile("one", "two", "three"));

    const readResult = await handleRead({
      file_path: p,
      allowedDirs: [tmpDir],
    });
    const readText = getText(readResult);

    const refMatch = readText.match(/ref: (\S+)/);
    const ref = refMatch![1];

    const twoLine = readText.split("\n").find((l) => l.includes("\ttwo"));
    const hashDotLine = twoLine!.split("\t")[0];

    const editResult = await handleEdit({
      file_path: p,
      edits: [
        {
          range: `${hashDotLine}-${hashDotLine}`,
          content: "TWO",
          ref,
        },
      ],
      allowedDirs: [tmpDir],
    });
    expect(editResult.isError).toBeFalsy();

    // Verify BOM is UTF-16 BE
    const raw = readFileSync(p);
    expect(raw[0]).toBe(0xfe);
    expect(raw[1]).toBe(0xff);

    // Decode BE: swap byte pairs to LE, then decode
    const payload = raw.subarray(2);
    const le = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length - 1; i += 2) {
      le[i] = payload[i + 1];
      le[i + 1] = payload[i];
    }
    const decoded = le.toString("utf16le");
    expect(decoded).toContain("TWO");
    expect(decoded).toContain("one");
    expect(decoded).toContain("three");
    expect(decoded).not.toContain("\ttwo\n");
  });
});
