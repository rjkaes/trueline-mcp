import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamingEdit } from "../../src/streaming-edit.ts";
import { FNV_OFFSET_BASIS, foldHash, fnv1aHashBytes, checksumToLetters } from "../../src/hash.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-eol-test-")));
  testFile = join(testDir, "mixed.txt");
  // Create a file with mixed EOLs: \r\n and \n
  const content = Buffer.concat([Buffer.from("line1\r\n"), Buffer.from("line2\n"), Buffer.from("line3\n")]);
  writeFileSync(testFile, content);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("streamingEdit should preserve EOLs of unchanged lines", async () => {
  const fileStat = await (await import("node:fs/promises")).stat(testFile);
  const mtimeMs = fileStat.mtimeMs;

  const ops = [
    {
      startLine: 1,
      endLine: 1,
      content: ["new line 1"],
      insertAfter: false,
      startHash: "",
      endHash: "",
    },
  ];

  let acc = FNV_OFFSET_BASIS;
  acc = foldHash(acc, fnv1aHashBytes(Buffer.from("line1"), 0, 5));
  acc = foldHash(acc, fnv1aHashBytes(Buffer.from("line2"), 0, 5));
  acc = foldHash(acc, fnv1aHashBytes(Buffer.from("line3"), 0, 5));

  const result = await streamingEdit(
    testFile,
    ops,
    [{ startLine: 1, endLine: 3, hash: checksumToLetters(acc) }],
    mtimeMs,
    false,
  );

  expect(result.ok).toBe(true);
  const newContent = readFileSync(testFile);

  // FAIL: Currently normalizes to \r\n
  const hasLFOnlyForLine2 =
    newContent.includes(Buffer.from("line2\n")) && !newContent.includes(Buffer.from("line2\r\n"));
  expect(hasLFOnlyForLine2).toBe(true);
});
