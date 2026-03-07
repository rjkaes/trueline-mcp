import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleWrite } from "../../src/tools/write.ts";
import { handleRead } from "../../src/tools/read.ts";
import { handleEdit } from "../../src/tools/edit.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-write-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("trueline_write", () => {
  test("creates a new file and returns checksum", async () => {
    const filePath = join(testDir, "new-file.ts");
    const content = "const x = 1;\nconst y = 2;\n";

    const result = await handleWrite({ file_path: filePath, content, projectDir: testDir });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("File created: ");
    expect(text).toMatch(/checksum: \d+-\d+:[0-9a-f]{8}/);
    expect(readFileSync(filePath, "utf-8")).toBe(content);
  });

  test("overwrites an existing file", async () => {
    const filePath = join(testDir, "existing.ts");
    writeFileSync(filePath, "old content\n");

    const result = await handleWrite({ file_path: filePath, content: "new content\n", projectDir: testDir });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("File overwritten: ");
    expect(readFileSync(filePath, "utf-8")).toBe("new content\n");
  });

  test("creates parent directories by default", async () => {
    const filePath = join(testDir, "deep", "nested", "dir", "file.ts");

    const result = await handleWrite({ file_path: filePath, content: "hello\n", projectDir: testDir });

    expect(result.isError).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("hello\n");
  });

  test("rejects paths outside allowed directories", async () => {
    const result = await handleWrite({ file_path: "/tmp/outside.ts", content: "x", projectDir: testDir });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Access denied");
  });

  test("rejects writing to a directory", async () => {
    const dirPath = join(testDir, "a-directory");
    mkdirSync(dirPath, { recursive: true });

    const result = await handleWrite({ file_path: dirPath, content: "x", projectDir: testDir });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a regular file");
  });

  test("returned checksum is valid for trueline_edit", async () => {
    const filePath = join(testDir, "edit-after-write.ts");
    const content = "line one\nline two\nline three\n";

    const writeResult = await handleWrite({ file_path: filePath, content, projectDir: testDir });
    const writeText = writeResult.content[0].text;
    const checksumMatch = writeText.match(/checksum: (\S+)/);
    expect(checksumMatch).not.toBeNull();
    const writeChecksum = checksumMatch![1];

    // Read to get line hashes for the edit range
    const readResult = await handleRead({ file_path: filePath, projectDir: testDir });
    const readText = readResult.content[0].text;
    const readChecksumMatch = readText.match(/checksum: (\S+)/);
    expect(readChecksumMatch).not.toBeNull();

    // The checksums from write and read should match
    expect(writeChecksum).toBe(readChecksumMatch![1]);

    // Extract line hashes for an edit
    const lines = readText.split("\n").filter((l: string) => l.match(/^\d+:/));
    const line2Match = lines[1].match(/^2:(\w+)\|/);
    expect(line2Match).not.toBeNull();
    const line2Hash = line2Match![1];

    // Use the write checksum to edit
    const editResult = await handleEdit({
      file_path: filePath,
      edits: [{ checksum: writeChecksum, range: `2:${line2Hash}`, content: "line TWO" }],
      projectDir: testDir,
    });
    expect(editResult.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("line one\nline TWO\nline three\n");
  });

  test("CRLF content checksum matches trueline_read", async () => {
    const filePath = join(testDir, "crlf-file.ts");
    const content = "alpha\r\nbeta\r\ngamma\r\n";

    const writeResult = await handleWrite({ file_path: filePath, content, projectDir: testDir });
    const writeChecksum = writeResult.content[0].text.match(/checksum: (\S+)/)![1];

    const readResult = await handleRead({ file_path: filePath, projectDir: testDir });
    const readChecksum = readResult.content[0].text.match(/checksum: (\S+)/)![1];

    expect(writeChecksum).toBe(readChecksum);
  });

  test("CR content checksum matches trueline_read", async () => {
    const filePath = join(testDir, "cr-file.ts");
    const content = "alpha\rbeta\rgamma\r";

    const writeResult = await handleWrite({ file_path: filePath, content, projectDir: testDir });
    const writeChecksum = writeResult.content[0].text.match(/checksum: (\S+)/)![1];

    const readResult = await handleRead({ file_path: filePath, projectDir: testDir });
    const readChecksum = readResult.content[0].text.match(/checksum: (\S+)/)![1];

    expect(writeChecksum).toBe(readChecksum);
  });

  test("handles empty content", async () => {
    const filePath = join(testDir, "empty.ts");

    const result = await handleWrite({ file_path: filePath, content: "", projectDir: testDir });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("");
    // Empty file returns the sentinel checksum
    expect(result.content[0].text).toContain("checksum: 0-0:00000000");
  });
});
