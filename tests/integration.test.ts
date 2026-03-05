import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../src/tools/read.ts";
import { handleEdit } from "../src/tools/edit.ts";
import { handleDiff } from "../src/tools/diff.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-integration-")));
  testFile = join(testDir, "app.ts");
  writeFileSync(testFile, 'function greet(name: string) {\n  return "Hello, " + name;\n}\n');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("read → diff → edit roundtrip", () => {
  test("complete workflow", async () => {
    // Step 1: Read the file
    const readResult = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();
    const readText = readResult.content[0].text;

    // Extract checksum from read result
    const checksumMatch = readText.match(/checksum: (.+)$/m);
    expect(checksumMatch).not.toBeNull();
    const checksum = checksumMatch![1];

    // Extract line 2 hash from read result
    const line2Match = readText.match(/^2:([a-z]{2})\|/m);
    expect(line2Match).not.toBeNull();
    const line2Hash = line2Match![1];

    // Step 2: Preview the edit with diff
    const diffResult = await handleDiff({
      file_path: testFile,
      checksum,
      edits: [
        {
          range: `2:${line2Hash}..2:${line2Hash}`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: test content is source code with template literals
          content: "  return `Hello, ${name}!`;",
        },
      ],
      projectDir: testDir,
    });
    expect(diffResult.isError).toBeUndefined();
    const diffText = diffResult.content[0].text;
    expect(diffText).toContain("-");
    expect(diffText).toContain("+");

    // Verify file unchanged after diff
    const beforeEdit = readFileSync(testFile, "utf-8");
    expect(beforeEdit).toContain('"Hello, " + name');

    // Step 3: Apply the edit
    const editResult = await handleEdit({
      file_path: testFile,
      checksum,
      edits: [
        {
          range: `2:${line2Hash}..2:${line2Hash}`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: test content is source code with template literals
          content: "  return `Hello, ${name}!`;",
        },
      ],
      projectDir: testDir,
    });
    expect(editResult.isError).toBeUndefined();

    // Step 4: Verify file changed
    const afterEdit = readFileSync(testFile, "utf-8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: verifying written source code content
    expect(afterEdit).toContain("`Hello, ${name}!`");
    expect(afterEdit).not.toContain('"Hello, " + name');

    // Step 5: Re-read and verify new hashes work
    const rereadResult = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(rereadResult.isError).toBeUndefined();
  });
});
