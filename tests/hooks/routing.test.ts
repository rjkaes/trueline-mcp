import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routePreToolUse } from "../../hooks/core/routing.js";

let tmpDir: string;
let smallFile: string;
let largeFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "routing-test-"));
  smallFile = join(tmpDir, "small.ts");
  writeFileSync(smallFile, "const x = 1;\n");
  largeFile = join(tmpDir, "large.ts");
  writeFileSync(largeFile, "x\n".repeat(10000)); // ~20KB
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const alwaysAccessible = async () => true;
const neverAccessible = async () => false;

describe("routePreToolUse — Read routing", () => {
  test("blocks Read on large files", async () => {
    const result = await routePreToolUse("Read", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).toContain("trueline_outline");
    expect(result!.reason).toContain("trueline_read");
  });

  test("advises outline for small files on Read", async () => {
    const result = await routePreToolUse("Read", { file_path: smallFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    expect(result!.reason).toContain("trueline_outline");
  });

  test("returns null for Read when trueline cannot access the file", async () => {
    const result = await routePreToolUse("Read", { file_path: largeFile }, neverAccessible);
    expect(result).toBeNull();
  });

  test("blocks Gemini CLI read_file on large files", async () => {
    const result = await routePreToolUse("read_file", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });
});

describe("routePreToolUse — Edit routing", () => {
  test("returns null (silent approve) for small files on Edit", async () => {
    const result = await routePreToolUse("Edit", { file_path: smallFile }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("returns advise for large files on Edit", async () => {
    const result = await routePreToolUse("Edit", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    expect(result!.reason).toContain("trueline");
  });

  test("returns advise for MultiEdit on large files", async () => {
    const result = await routePreToolUse("MultiEdit", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
  });

  test("returns null for Edit when trueline cannot access the file", async () => {
    const result = await routePreToolUse("Edit", { file_path: largeFile }, neverAccessible);
    expect(result).toBeNull();
  });
});

describe("routePreToolUse — common cases", () => {
  test("returns null when no file_path in input", async () => {
    const result = await routePreToolUse("Read", {}, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("returns null for non-Read/Edit tools", async () => {
    const result = await routePreToolUse("Bash", { command: "ls" }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("returns null when file does not exist", async () => {
    const result = await routePreToolUse("Read", { file_path: "/nonexistent/file.ts" }, alwaysAccessible);
    expect(result).toBeNull();
  });
});
