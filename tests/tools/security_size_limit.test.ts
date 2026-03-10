import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePath } from "../../src/tools/shared.ts";

let testDir: string;
let largeFile: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-security-test-")));
  largeFile = join(testDir, "large.txt");
  // Create an 11 MB file
  const buf = Buffer.alloc(11 * 1024 * 1024, "x");
  writeFileSync(largeFile, buf);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Security size limit enforcement", () => {
  test("validatePath should reject files over 10MB (as per DESIGN.md)", async () => {
    const result = await validatePath(largeFile, "Read", testDir, []);

    // FAIL: Currently returns { ok: true } because it doesn't check size
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on MCP content shape
      expect((result.error.content[0] as any).text).toContain("size limit");
    }
  });
});
