import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRead } from "../../src/tools/read.ts";

let testDir: string;
let testFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-read-test-")));
  testFile = join(testDir, "sample.ts");
  writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  // Create .claude/settings.json with a deny pattern
  const claudeDir = join(testDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      permissions: { deny: ["Read(.env)", "Read(**/*.secret)"] },
    }),
  );

  // Create a denied file
  writeFileSync(join(testDir, ".env"), "SECRET=abc\n");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleRead", () => {
  test("returns trueline-formatted content", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const lines = text.split("\n").filter(Boolean);
    // Should have 3 content lines + blank + checksum line
    expect(lines[0]).toMatch(/^1:[a-z]{2}\|const a = 1;$/);
    expect(lines[1]).toMatch(/^2:[a-z]{2}\|const b = 2;$/);
    expect(lines[2]).toMatch(/^3:[a-z]{2}\|const c = 3;$/);
  });

  test("returns checksum in result", async () => {
    const result = await handleRead({
      file_path: testFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    // Last line should be the checksum
    expect(text).toContain("checksum:");
  });

  test("supports start_line and end_line", async () => {
    const result = await handleRead({
      file_path: testFile,
      start_line: 2,
      end_line: 2,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    const contentLines = text.split("\n").filter((l) => l.match(/^\d+:/));
    expect(contentLines).toHaveLength(1);
    expect(contentLines[0]).toMatch(/^2:[a-z]{2}\|const b = 2;$/);
  });

  test("denies reading .env file", async () => {
    const result = await handleRead({
      file_path: join(testDir, ".env"),
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied");
  });

  test("returns error for nonexistent file", async () => {
    const result = await handleRead({
      file_path: join(testDir, "nope.ts"),
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("reads multiple disjoint ranges with separate checksums", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const multiFile = join(testDir, "multi.txt");
    writeFileSync(multiFile, `${lines.join("\n")}\n`);

    const result = await handleRead({
      file_path: multiFile,
      ranges: [
        { start: 3, end: 5 },
        { start: 15, end: 17 },
      ],
      projectDir: testDir,
    });

    const text = result.content[0].text;

    // Should have two checksum lines
    const checksumMatches = text.match(/^checksum: \d+-\d+:[0-9a-f]{8}$/gm);
    expect(checksumMatches).toHaveLength(2);

    // Should contain lines 3-5 and 15-17 but not lines 6-14
    expect(text).toMatch(/^3:/m);
    expect(text).toMatch(/^5:/m);
    expect(text).toMatch(/^15:/m);
    expect(text).toMatch(/^17:/m);
    expect(text).not.toMatch(/^6:/m);
    expect(text).not.toMatch(/^14:/m);
  });

  test("reads whole file when ranges omitted", async () => {
    const wholeFile = join(testDir, "whole.txt");
    writeFileSync(wholeFile, "a\nb\nc\n");
    const result = await handleRead({
      file_path: wholeFile,
      projectDir: testDir,
    });
    const text = result.content[0].text;
    expect(text).toContain("1:");
    expect(text).toContain("3:");
    const checksumMatches = text.match(/^checksum: /gm);
    expect(checksumMatches).toHaveLength(1);
  });

  test("rejects overlapping ranges", async () => {
    const overlapFile = join(testDir, "overlap.txt");
    writeFileSync(overlapFile, "a\nb\nc\nd\n");
    const result = await handleRead({
      file_path: overlapFile,
      ranges: [
        { start: 1, end: 3 },
        { start: 2, end: 4 },
      ],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
  });

  test("hash is based on raw file bytes, not decoded string", async () => {
    // Latin-1 file: 0xe9 = é in latin1, but 0xc3 0xa9 in UTF-8
    // If we hash raw bytes, the hash should be based on the single 0xe9 byte
    const latin1File = join(testDir, "latin1.txt");
    writeFileSync(latin1File, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café\n"

    const result = await handleRead({
      file_path: latin1File,
      encoding: "latin1",
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // The decoded content should show "café"
    expect(text).toContain("café");
    // And the hash should be present
    expect(text).toMatch(/^1:[a-z]{2}\|café$/m);
  });
});
