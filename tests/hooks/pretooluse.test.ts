import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processHookEvent } from "../../hooks/pretooluse.js";
import { clearCaches } from "../../src/security.js";

let projectDir: string;
let smallFile: string;
let largeFile: string;
let smallNonOutlineable: string;
let largeNonOutlineable: string;
let savedProjectDir: string | undefined;

beforeAll(() => {
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  projectDir = mkdtempSync(join(tmpdir(), "hook-test-"));
  smallFile = join(projectDir, "small.ts");
  writeFileSync(smallFile, "const x = 1;\n");
  largeFile = join(projectDir, "large.ts");
  writeFileSync(largeFile, "x\n".repeat(10000)); // ~20KB
  smallNonOutlineable = join(projectDir, "config.json");
  writeFileSync(smallNonOutlineable, '{"key": "value"}\n');
  largeNonOutlineable = join(projectDir, "data.json");
  writeFileSync(largeNonOutlineable, '{"x": 1}\n'.repeat(2000)); // ~18KB
  process.env.CLAUDE_PROJECT_DIR = projectDir;
});

afterAll(() => {
  if (savedProjectDir !== undefined) {
    process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  } else {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
  rmSync(projectDir, { recursive: true, force: true });
});

describe("PreToolUse hook — Read routing", () => {
  test("passes through Read on small files without advisory", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: smallFile },
    });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBeUndefined();
  });

  test("blocks Read on large files", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: largeFile },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_read");
  });

  test("passes through Read on small non-outlineable files without advisory", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: smallNonOutlineable },
    });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBeUndefined();
  });

  test("omits outline from block for non-outlineable large files", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: largeNonOutlineable },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).not.toContain("trueline_outline");
    expect(result.reason).toContain("trueline_read");
  });

  test("approves Read for files outside project", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: "/nonexistent/outside/file.ts" },
    });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBeUndefined();
  });

  test("approves Read when no file_path", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: {},
    });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBeUndefined();
  });
});

describe("PreToolUse hook — Edit routing", () => {
  test("blocks Edit for small files", async () => {
    const result = await processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: smallFile, old_string: "x", new_string: "y" },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_edit");
  });

  test("blocks Edit on large files", async () => {
    const result = await processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: largeFile, old_string: "x", new_string: "y" },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline");
  });

  test("blocks MultiEdit on large files", async () => {
    const result = await processHookEvent({
      tool_name: "MultiEdit",
      tool_input: { file_path: largeFile, edits: [] },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline");
  });

  test("approves Edit for files outside project", async () => {
    const result = await processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: "/nonexistent/outside/file.ts", old_string: "x", new_string: "y" },
    });
    expect(result.decision).toBe("approve");
    expect(result.reason).toBeUndefined();
  });

  test("approves Edit when Read access is denied", async () => {
    const claudeDir = join(projectDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    const secretFile = join(projectDir, "data.secret");
    writeFileSync(secretFile, "secret data\n".repeat(200));
    writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ["Read(**/*.secret)"] } }));

    try {
      const result = await processHookEvent({
        tool_name: "Edit",
        tool_input: { file_path: secretFile, old_string: "secret", new_string: "public" },
      });
      // trueline can't read .secret files, so no block
      expect(result.decision).toBe("approve");
      expect(result.reason).toBeUndefined();
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("approves Edit when Write access is denied", async () => {
    clearCaches();
    const claudeDir = join(projectDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    const lockedFile = join(projectDir, "locked.cfg");
    writeFileSync(lockedFile, "config\n".repeat(200));
    writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ["Edit(**/*.cfg)"] } }));

    try {
      const result = await processHookEvent({
        tool_name: "Edit",
        tool_input: { file_path: lockedFile, old_string: "config", new_string: "updated" },
      });
      // trueline can't edit .cfg files, so no block
      expect(result.decision).toBe("approve");
      expect(result.reason).toBeUndefined();
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe("PreToolUse hook — other tools", () => {
  test("approves other tools unconditionally", async () => {
    for (const tool of ["Bash", "Glob"]) {
      const result = await processHookEvent({ tool_name: tool, tool_input: {} });
      expect(result.decision).toBe("approve");
      expect(result.reason).toBeUndefined();
    }
  });
});
