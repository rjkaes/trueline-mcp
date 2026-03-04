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
});
