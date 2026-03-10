import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOutline } from "../../src/tools/outline.ts";
import { handleDiff } from "../../src/tools/diff.ts";

let testDir: string;
let binaryFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-binary-security-")));
  binaryFile = join(testDir, "test.ts");
  const content = Buffer.concat([
    Buffer.from("function hello() {\n"),
    Buffer.from([0x00]), // Null byte
    Buffer.from("\n}"),
  ]);
  writeFileSync(binaryFile, content);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Binary file security", () => {
  test("trueline_outline should reject binary files", async () => {
    const result = await handleOutline({
      file_paths: [binaryFile],
      projectDir: testDir,
    });

    // FAIL: Currently returns a valid outline
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("binary");
  });

  test("trueline_diff should reject binary files", async () => {
    const result = await handleDiff({
      file_paths: [binaryFile],
      projectDir: testDir,
    });

    // FAIL: Currently returns a valid diff
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("binary");
  });
});
