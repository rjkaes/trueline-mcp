import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routePreToolUse, estimateEditTokenSavings, isPartialRead } from "../../hooks/core/routing.js";
import { OUTLINEABLE_EXTENSIONS } from "../../src/outline/supported-extensions.js";
import { supportedExtensions } from "../../src/outline/languages.js";

let tmpDir: string;
let smallFile: string;
let largeFile: string;
let smallNonOutlineable: string;
let largeNonOutlineable: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "routing-test-"));
  smallFile = join(tmpDir, "small.ts");
  writeFileSync(smallFile, "const x = 1;\n");
  largeFile = join(tmpDir, "large.ts");
  writeFileSync(largeFile, "x\n".repeat(10000)); // ~20KB
  smallNonOutlineable = join(tmpDir, "config.json");
  writeFileSync(smallNonOutlineable, '{"key": "value"}\n');
  largeNonOutlineable = join(tmpDir, "data.json");
  writeFileSync(largeNonOutlineable, '{"x": 1}\n'.repeat(2000)); // ~18KB
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

  test("omits outline from block message for non-outlineable large files", async () => {
    const result = await routePreToolUse("Read", { file_path: largeNonOutlineable }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).not.toContain("trueline_outline");
    expect(result!.reason).toContain("trueline_read");
  });

  test("omits outline from advise for non-outlineable small files", async () => {
    const result = await routePreToolUse("Read", { file_path: smallNonOutlineable }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    expect(result!.reason).not.toContain("trueline_outline");
    expect(result!.reason).toContain("trueline_search");
  });

  test("blocks Gemini CLI read_file on large files", async () => {
    const result = await routePreToolUse("read_file", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });
});

describe("isPartialRead", () => {
  test("returns false for undefined/null input", () => {
    expect(isPartialRead(undefined)).toBe(false);
    expect(isPartialRead(null as unknown as undefined)).toBe(false);
  });

  test("returns false for full read (no range fields)", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts" })).toBe(false);
  });

  test("detects Claude Code / OpenCode offset", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts", offset: 50 })).toBe(true);
  });

  test("detects Claude Code / OpenCode limit", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts", limit: 100 })).toBe(true);
  });

  test("detects Gemini CLI start_line", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts", start_line: 10 })).toBe(true);
  });

  test("detects Gemini CLI end_line", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts", end_line: 50 })).toBe(true);
  });

  test("ignores zero values (equivalent to full read)", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts", offset: 0 })).toBe(false);
    expect(isPartialRead({ file_path: "/tmp/foo.ts", start_line: 0 })).toBe(false);
  });

  test("ignores non-numeric values", () => {
    expect(isPartialRead({ file_path: "/tmp/foo.ts", offset: "50" })).toBe(false);
  });
});

describe("routePreToolUse — partial Read pass-through", () => {
  test("passes through partial Read on large files (Claude Code offset)", async () => {
    const result = await routePreToolUse("Read", { file_path: largeFile, offset: 100 }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("passes through partial Read on large files (Claude Code limit)", async () => {
    const result = await routePreToolUse("Read", { file_path: largeFile, limit: 50 }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("passes through partial Read on large files (Gemini CLI start_line/end_line)", async () => {
    const result = await routePreToolUse(
      "read_file",
      { file_path: largeFile, start_line: 10, end_line: 50 },
      alwaysAccessible,
    );
    expect(result).toBeNull();
  });

  test("passes through partial Read on large files (OpenCode view offset)", async () => {
    const result = await routePreToolUse("view", { file_path: largeFile, offset: 200 }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("still blocks full Read on large files", async () => {
    const result = await routePreToolUse("Read", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });
});

describe("estimateEditTokenSavings", () => {
  test("returns 0 for missing or non-object input", () => {
    expect(estimateEditTokenSavings(undefined)).toBe(0);
    expect(estimateEditTokenSavings(null as unknown as undefined)).toBe(0);
  });

  test("returns 0 when replace_all is true (Claude Code / OpenCode)", () => {
    expect(estimateEditTokenSavings({ old_string: "x".repeat(2000), replace_all: true })).toBe(0);
  });

  test("returns 0 when expected_replacements > 1 (Gemini CLI)", () => {
    expect(estimateEditTokenSavings({ old_string: "x".repeat(2000), expected_replacements: 3 })).toBe(0);
  });

  test("returns 0 when allow_multiple is true (Gemini CLI)", () => {
    expect(estimateEditTokenSavings({ old_string: "x".repeat(2000), allow_multiple: true })).toBe(0);
  });

  test("does not treat expected_replacements=1 as replace-all", () => {
    const savings = estimateEditTokenSavings({ old_string: "x".repeat(2000), expected_replacements: 1 });
    expect(savings).toBeGreaterThan(0);
  });

  test("returns 0 when old_string is missing", () => {
    expect(estimateEditTokenSavings({ new_string: "hello" })).toBe(0);
  });

  test("returns negative for small old_string (Edit is cheaper)", () => {
    // 100 chars / 3.5 ≈ 29 tokens, well below 300 overhead
    expect(estimateEditTokenSavings({ old_string: "x".repeat(100) })).toBeLessThan(0);
  });

  test("returns positive for large old_string (trueline_edit is cheaper)", () => {
    // 2000 chars / 3.5 ≈ 571 tokens, minus 300 overhead ≈ 271 savings
    const savings = estimateEditTokenSavings({ old_string: "x".repeat(2000) });
    expect(savings).toBeGreaterThan(0);
    expect(savings).toBeCloseTo(2000 / 3.5 - 300, 0);
  });

  test("handles VS Code Copilot camelCase field: oldString", () => {
    const savings = estimateEditTokenSavings({ oldString: "x".repeat(2000) });
    expect(savings).toBeGreaterThan(0);
  });
});

describe("routePreToolUse — Edit routing", () => {
  test("returns null (silent approve) for small files with small old_string", async () => {
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: "const x", new_string: "const y" },
      alwaysAccessible,
    );
    expect(result).toBeNull();
  });

  test("returns null (silent approve) for small files with no old_string", async () => {
    const result = await routePreToolUse("Edit", { file_path: smallFile }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("advises on small files when old_string is costly", async () => {
    const bigOldString = "x\n".repeat(800); // ~1600 chars ≈ 457 tokens > 300 overhead
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: bigOldString, new_string: "replaced" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    expect(result!.reason).toContain("old_string");
    expect(result!.reason).toContain("tokens");
  });

  test("skips token advisory when replace_all is true even with large old_string", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: bigOldString, new_string: "y", replace_all: true },
      alwaysAccessible,
    );
    // Small file + replace_all → no token advice, no file-size advice → null
    expect(result).toBeNull();
  });

  test("returns advise for large files on Edit", async () => {
    const result = await routePreToolUse("Edit", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    expect(result!.reason).toContain("trueline");
  });

  test("token advisory takes priority over file-size advisory on large files", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "Edit",
      { file_path: largeFile, old_string: bigOldString, new_string: "replaced" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    // Should mention token savings, not file size
    expect(result!.reason).toContain("old_string");
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

  test("returns null for costly old_string when trueline cannot access the file", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: bigOldString, new_string: "replaced" },
      neverAccessible,
    );
    expect(result).toBeNull();
  });

  test("advises for VS Code Copilot replace_string_in_file with costly oldString", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "replace_string_in_file",
      { file_path: smallFile, oldString: bigOldString, newString: "replaced" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
    expect(result!.reason).toContain("old_string");
  });

  test("advises for VS Code Copilot multi_replace_string_in_file on large files", async () => {
    const result = await routePreToolUse("multi_replace_string_in_file", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
  });

  test("advises for Gemini CLI edit_file with costly old_string", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "edit_file",
      { file_path: smallFile, old_string: bigOldString, new_string: "replaced" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("advise");
  });

  test("skips token advisory for Gemini CLI edit_file with expected_replacements > 1", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "edit_file",
      { file_path: smallFile, old_string: bigOldString, new_string: "y", expected_replacements: 5 },
      alwaysAccessible,
    );
    // Small file + replace-all → no token advice, no file-size advice → null
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

describe("OUTLINEABLE_EXTENSIONS sync", () => {
  test("contains all LANGUAGES keys from languages.ts", () => {
    for (const ext of supportedExtensions()) {
      expect(OUTLINEABLE_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});
