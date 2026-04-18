import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamingEdit } from "../../src/streaming-edit.ts";
import { FNV_OFFSET_BASIS, foldHash, fnv1aHashBytes, checksumToLetters } from "../../src/hash.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-overlapping-checksums-")));
  testFile = join(testDir, "sample.txt");
  writeFileSync(testFile, "line1\nline2\nline3\nline4\nline5\n");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("streamingEdit should handle overlapping checksum ranges", async () => {
  const fileStat = await (await import("node:fs/promises")).stat(testFile);
  const mtimeMs = fileStat.mtimeMs;

  const h = (s: string) => fnv1aHashBytes(Buffer.from(s), 0, s.length);

  let acc1 = FNV_OFFSET_BASIS;
  acc1 = foldHash(acc1, h("line1"));
  acc1 = foldHash(acc1, h("line2"));
  acc1 = foldHash(acc1, h("line3"));

  let acc2 = FNV_OFFSET_BASIS;
  acc2 = foldHash(acc2, h("line2"));
  acc2 = foldHash(acc2, h("line3"));
  acc2 = foldHash(acc2, h("line4"));

  const ops = [
    {
      startLine: 3,
      endLine: 3,
      content: ["new line 3"],
      insertAfter: false,
      startHash: "",
      endHash: "",
    },
  ];

  const result = await streamingEdit(
    testFile,
    ops,
    [
      { startLine: 1, endLine: 3, hash: checksumToLetters(acc1) },
      { startLine: 2, endLine: 4, hash: checksumToLetters(acc2) },
    ],
    mtimeMs,
    false,
  );

  // FAIL: Currently fails with checksum mismatch for 2-4 because line 2 and 3 were only folded into range 1-3.
  expect(result.ok).toBe(true);
});
