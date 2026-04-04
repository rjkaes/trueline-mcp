import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routePreToolUse, isPartialRead } from "../../hooks/core/routing.js";
import { OUTLINEABLE_EXTENSIONS } from "../../src/outline/supported-extensions.js";
import { supportedExtensions } from "../../src/outline/languages.js";

let tmpDir: string;
let smallFile: string;
let largeFile: string;
let smallNonOutlineable: string;
let largeNonOutlineable: string;
let mediumFile: string;
let mediumNonOutlineable: string;

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
  mediumFile = join(tmpDir, "medium.ts");
  writeFileSync(mediumFile, "const x = 1;\n".repeat(400)); // ~5.2KB
  mediumNonOutlineable = join(tmpDir, "medium.json");
  writeFileSync(mediumNonOutlineable, '{"x": 1}\n'.repeat(600)); // ~5.4KB
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

  test("blocks Read on medium outlineable files (3-10KB)", async () => {
    const result = await routePreToolUse("Read", { file_path: mediumFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).toContain("trueline_outline");
    expect(result!.reason).toContain("trueline_read");
  });

  test("blocks Read on medium non-outlineable files (3-10KB)", async () => {
    const result = await routePreToolUse("Read", { file_path: mediumNonOutlineable }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).not.toContain("trueline_outline");
    expect(result!.reason).toContain("trueline_read");
  });

  test("passes through Read on small files without advisory", async () => {
    const result = await routePreToolUse("Read", { file_path: smallFile }, alwaysAccessible);
    expect(result).toBeNull();
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

  test("passes through Read on small non-outlineable files without advisory", async () => {
    const result = await routePreToolUse("Read", { file_path: smallNonOutlineable }, alwaysAccessible);
    expect(result).toBeNull();
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

describe("routePreToolUse — Edit routing", () => {
  test("blocks Edit on small files with small old_string", async () => {
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: "const x", new_string: "const y" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).toContain("trueline_edit");
  });

  test("blocks Edit on small files with no old_string", async () => {
    const result = await routePreToolUse("Edit", { file_path: smallFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });

  test("blocks Edit on small files when old_string is costly", async () => {
    const bigOldString = "x\n".repeat(800); // ~1600 chars ≈ 457 tokens > 300 overhead
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: bigOldString, new_string: "replaced" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).toContain("trueline_edit");
  });

  test("blocks Edit even when replace_all is true", async () => {
    const bigOldString = "x\n".repeat(800);
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: bigOldString, new_string: "y", replace_all: true },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });

  test("blocks Edit on large files", async () => {
    const result = await routePreToolUse("Edit", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).toContain("trueline");
  });

  test("blocks MultiEdit on large files", async () => {
    const result = await routePreToolUse("MultiEdit", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });

  test("returns null for Edit when trueline cannot access the file", async () => {
    const result = await routePreToolUse("Edit", { file_path: largeFile }, neverAccessible);
    expect(result).toBeNull();
  });

  test("returns null for Edit on small file when trueline cannot access the file", async () => {
    const result = await routePreToolUse(
      "Edit",
      { file_path: smallFile, old_string: "const x", new_string: "const y" },
      neverAccessible,
    );
    expect(result).toBeNull();
  });

  test("blocks VS Code Copilot replace_string_in_file", async () => {
    const result = await routePreToolUse(
      "replace_string_in_file",
      { file_path: smallFile, oldString: "x", newString: "y" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });

  test("blocks VS Code Copilot multi_replace_string_in_file", async () => {
    const result = await routePreToolUse("multi_replace_string_in_file", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });

  test("blocks Gemini CLI edit_file", async () => {
    const result = await routePreToolUse(
      "edit_file",
      { file_path: smallFile, old_string: "x", new_string: "y" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });

  test("returns null for Gemini CLI edit_file when trueline cannot access", async () => {
    const result = await routePreToolUse(
      "edit_file",
      { file_path: smallFile, old_string: "x", new_string: "y" },
      neverAccessible,
    );
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
