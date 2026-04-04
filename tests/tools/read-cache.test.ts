import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead, clearReadCache } from "../../src/tools/read.ts";
import { getText, resetRefStore } from "../helpers.ts";

let testDir: string;

beforeEach(() => {
  clearReadCache();
  resetRefStore();
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-read-cache-")));
});

afterEach(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const p = join(testDir, name);
  writeFileSync(p, content);
  return p;
}

describe("read cache — unchanged file", () => {
  test("second read of same file returns stub with refs", async () => {
    const f = writeFile("cached.txt", "line one\nline two\n");

    const r1 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const r2 = await handleRead({ file_path: f, allowedDirs: [testDir] });

    const t1 = getText(r1);
    const t2 = getText(r2);

    // First read has content lines
    expect(t1).toContain("line one");
    expect(t1).toContain("line two");

    // Second read returns stub
    expect(t2).toContain("unchanged");
    expect(t2).not.toContain("line one");

    // Stub includes refs
    expect(t2).toMatch(/ref:R\d+/);

    // Refs match between full read and stub
    const ref1 = t1.match(/ref:(R\d+)/)?.[1];
    const ref2 = t2.match(/ref:(R\d+)/)?.[1];
    expect(ref1).toBeDefined();
    expect(ref1).toBe(ref2);
  });

  test("stub refs are valid for editing", async () => {
    const f = writeFile("edit-from-stub.txt", "alpha\nbeta\ngamma\n");

    // First read — get full content
    const r1 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const t1 = getText(r1);

    // Second read — get stub with refs
    const r2 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const t2 = getText(r2);

    // Both should have the same ref
    const ref1 = t1.match(/ref:(R\d+)/)?.[1];
    const ref2 = t2.match(/ref:(R\d+)/)?.[1];
    expect(ref1).toBe(ref2);
  });

  test("modified file returns full content, not stub", async () => {
    const f = writeFile("modified.txt", "original\n");

    await handleRead({ file_path: f, allowedDirs: [testDir] });

    // Modify the file (changes mtime)
    // Small delay to ensure mtime changes — filesystem may have 1ms resolution
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(f, "modified\n");

    const r2 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const t2 = getText(r2);

    expect(t2).not.toContain("unchanged");
    expect(t2).toContain("modified");
  });

  test("different ranges produce cache miss", async () => {
    const f = writeFile("ranges.txt", "one\ntwo\nthree\nfour\nfive\n");

    await handleRead({ file_path: f, ranges: ["1-3"], allowedDirs: [testDir] });
    const r2 = await handleRead({ file_path: f, ranges: ["2-4"], allowedDirs: [testDir] });
    const t2 = getText(r2);

    // Different ranges = cache miss = full content
    expect(t2).not.toContain("unchanged");
    expect(t2).toContain("two");
  });

  test("same ranges produce cache hit", async () => {
    const f = writeFile("same-ranges.txt", "one\ntwo\nthree\nfour\nfive\n");

    await handleRead({ file_path: f, ranges: ["2-4"], allowedDirs: [testDir] });
    const r2 = await handleRead({ file_path: f, ranges: ["2-4"], allowedDirs: [testDir] });
    const t2 = getText(r2);

    expect(t2).toContain("unchanged");
  });

  test("clearReadCache forces a full re-read", async () => {
    const f = writeFile("clear.txt", "content\n");

    await handleRead({ file_path: f, allowedDirs: [testDir] });
    clearReadCache();
    const r2 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const t2 = getText(r2);

    expect(t2).not.toContain("unchanged");
    expect(t2).toContain("content");
  });

  test("empty file caches correctly", async () => {
    const f = writeFile("empty.txt", "");

    const r1 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const r2 = await handleRead({ file_path: f, allowedDirs: [testDir] });

    expect(getText(r1)).toContain("empty file");
    expect(getText(r2)).toContain("unchanged");
    expect(getText(r2)).toMatch(/ref:R\d+/);
  });

  test("stub includes encoding metadata for BOM files", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.concat([bom, Buffer.from("hello\n")]);
    const f = join(testDir, "bom.txt");
    writeFileSync(f, content);

    const r1 = await handleRead({ file_path: f, allowedDirs: [testDir] });
    const r2 = await handleRead({ file_path: f, allowedDirs: [testDir] });

    expect(getText(r1)).toContain("encoding: utf-8-bom");
    expect(getText(r2)).toContain("encoding: utf-8-bom");
    expect(getText(r2)).toContain("unchanged");
  });
});

describe("read cache — FIFO eviction", () => {
  test("evicts oldest entries after MAX_READ_CACHE (500)", async () => {
    // Create and read 502 files to exceed the 500-entry cache limit
    for (let i = 0; i < 502; i++) {
      const f = writeFile(`evict-${i}.txt`, `content ${i}\n`);
      await handleRead({ file_path: f, allowedDirs: [testDir] });
    }

    // Re-read the first file — should be a cache miss (evicted), returning full content
    const f0 = join(testDir, "evict-0.txt");
    const result = await handleRead({ file_path: f0, allowedDirs: [testDir] });
    expect(getText(result)).not.toContain("unchanged");
    expect(getText(result)).toContain("content 0");
  });

  test("recent entries survive eviction", async () => {
    for (let i = 0; i < 502; i++) {
      const f = writeFile(`evict2-${i}.txt`, `data ${i}\n`);
      await handleRead({ file_path: f, allowedDirs: [testDir] });
    }

    // Re-read a recent file — should be a cache hit
    const fRecent = join(testDir, "evict2-501.txt");
    const result = await handleRead({ file_path: fRecent, allowedDirs: [testDir] });
    expect(getText(result)).toContain("unchanged");
  });
});
