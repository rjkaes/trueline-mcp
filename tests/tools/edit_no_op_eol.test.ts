import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { streamingEdit } from "../../src/streaming-edit.ts";
import { FNV_OFFSET_BASIS, foldHash, fnv1aHashBytes } from "../../src/hash.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-eol-noop-")));
  testFile = join(testDir, "mixed.txt");
  // line 1 has \r\n, line 2 has \n
  const content = Buffer.concat([Buffer.from("line1\r\n"), Buffer.from("line2\n")]);
  writeFileSync(testFile, content);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("streamingEdit should preserve original EOL in a no-op replace when other changes exist", async () => {
  const fileStat = await (await import("node:fs/promises")).stat(testFile);
  const mtimeMs = fileStat.mtimeMs;

  // 1. Replace line 2 with itself ("line2")
  // 2. Insert line 3 at the end
  const ops = [
    {
      startLine: 2,
      endLine: 2,
      content: ["line2"],
      insertAfter: false,
      startHash: "",
      endHash: "",
    },
    {
      startLine: 2,
      endLine: 2,
      content: ["inserted"],
      insertAfter: true,
      startHash: "",
      endHash: "",
    },
  ];

  let acc = FNV_OFFSET_BASIS;
  acc = foldHash(acc, fnv1aHashBytes(Buffer.from("line1"), 0, 5));
  acc = foldHash(acc, fnv1aHashBytes(Buffer.from("line2"), 0, 5));

  const result = await streamingEdit(
    testFile,
    ops,
    [{ startLine: 1, endLine: 2, hash: acc.toString(16).padStart(8, "0") }],
    mtimeMs,
    false,
  );

  expect(result.ok).toBe(true);
  expect(result.changed).toBe(true); // Forced change by insertion

  const newContent = readFileSync(testFile);
  const hex = newContent.toString("hex");
  console.log(`New content hex: ${hex}`);

  // EXPECTED:
  // line 1: 6c696e6531 0d0a (line1\r\n)
  // line 2: 6c696e6532 0a (line2\n)
  // line 3: 696e736572746564 0a (inserted\n)

  // ACTUAL (BUG):
  // line 2 gets normalized to \r\n (0d0a)
  const hasLFOnlyForLine2 =
    newContent.includes(Buffer.from("line2\n")) && !newContent.includes(Buffer.from("line2\r\n"));

  expect(hasLFOnlyForLine2).toBe(true);
});
