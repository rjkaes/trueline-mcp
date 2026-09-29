import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routePreToolUse } from "../../hooks/core/routing.js";

let tmpDir: string;
let smallFile: string;
let largeFile: string;
let mediumFile: string;
let largeImage: string;
let largePdf: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "routing-test-"));
  smallFile = join(tmpDir, "small.ts");
  writeFileSync(smallFile, "const x = 1;\n");
  largeFile = join(tmpDir, "large.ts");
  writeFileSync(largeFile, "x\n".repeat(10000)); // ~20KB
  mediumFile = join(tmpDir, "medium.ts");
  writeFileSync(mediumFile, "const x = 1;\n".repeat(400)); // ~5.2KB
  // Binary media: well over LARGE_FILE_THRESHOLD, as real images are.
  largeImage = join(tmpDir, "screenshot.PNG");
  writeFileSync(largeImage, Buffer.alloc(20480, 0));
  largePdf = join(tmpDir, "invoice.pdf");
  writeFileSync(largePdf, Buffer.alloc(20480, 0));
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

  test("blocks Read on medium files (3-10KB)", async () => {
    const result = await routePreToolUse("Read", { file_path: mediumFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
    expect(result!.reason).toContain("trueline_outline");
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

  test("blocks Gemini CLI read_file on large files", async () => {
    const result = await routePreToolUse("read_file", { file_path: largeFile }, alwaysAccessible);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
  });
});

describe("routePreToolUse — binary media pass-through", () => {
  test("passes through Read on a large image, case-insensitively", async () => {
    const result = await routePreToolUse("Read", { file_path: largeImage }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("passes through Read on a large PDF", async () => {
    const result = await routePreToolUse("Read", { file_path: largePdf }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("still blocks Edit on an image", async () => {
    const result = await routePreToolUse(
      "Edit",
      { file_path: largeImage, old_string: "x", new_string: "y" },
      alwaysAccessible,
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("block");
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

  test("passes through Read with only start_line", async () => {
    const result = await routePreToolUse("read_file", { file_path: largeFile, start_line: 10 }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("passes through Read with only end_line", async () => {
    const result = await routePreToolUse("read_file", { file_path: largeFile, end_line: 50 }, alwaysAccessible);
    expect(result).toBeNull();
  });

  test("blocks Read when range fields are zero (equivalent to a full read)", async () => {
    const result = await routePreToolUse(
      "read_file",
      { file_path: largeFile, offset: 0, start_line: 0 },
      alwaysAccessible,
    );
    expect(result!.action).toBe("block");
  });

  test("blocks Read when range fields are non-numeric", async () => {
    const result = await routePreToolUse("Read", { file_path: largeFile, offset: "50" }, alwaysAccessible);
    expect(result!.action).toBe("block");
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
