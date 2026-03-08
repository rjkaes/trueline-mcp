import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processHookEvent } from "../../hooks/pretooluse.js";
import { clearCaches } from "../../src/security.js";

let projectDir: string;
let insideFile: string;
let savedProjectDir: string | undefined;

beforeAll(() => {
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  projectDir = mkdtempSync(join(tmpdir(), "hook-test-"));
  insideFile = join(projectDir, "app.ts");
  writeFileSync(insideFile, "const x = 1;\n");
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

describe("PreToolUse hook", () => {
  test("blocks Read for files trueline can access", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: insideFile },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_read");
  });

  test("approves Read for files outside project", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: { file_path: "/nonexistent/outside/file.ts" },
    });
    expect(result.decision).toBe("approve");
  });

  test("approves Read when no file_path", async () => {
    const result = await processHookEvent({
      tool_name: "Read",
      tool_input: {},
    });
    expect(result.decision).toBe("approve");
  });

  test("blocks Edit for files trueline can read and write", async () => {
    const result = await processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: insideFile, old_string: "x", new_string: "y" },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_edit");
  });

  test("blocks MultiEdit for files trueline can read and write", async () => {
    const result = await processHookEvent({
      tool_name: "MultiEdit",
      tool_input: { file_path: insideFile, edits: [] },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_edit");
  });

  test("approves Edit for files outside project", async () => {
    const result = await processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: "/nonexistent/outside/file.ts", old_string: "x", new_string: "y" },
    });
    expect(result.decision).toBe("approve");
  });

  test("approves MultiEdit for files outside project", async () => {
    const result = await processHookEvent({
      tool_name: "MultiEdit",
      tool_input: { file_path: "/nonexistent/outside/file.ts", edits: [] },
    });
    expect(result.decision).toBe("approve");
  });

  test("approves Edit when Read access is denied", async () => {
    const claudeDir = join(projectDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    const secretFile = join(projectDir, "data.secret");
    writeFileSync(secretFile, "secret data\n");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ["Read(**/*.secret)"] } }));

    try {
      const result = await processHookEvent({
        tool_name: "Edit",
        tool_input: { file_path: secretFile, old_string: "secret", new_string: "public" },
      });
      // trueline can't read .secret files, so Edit falls through to built-in
      expect(result.decision).toBe("approve");
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
    writeFileSync(lockedFile, "config\n");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ["Edit(**/*.cfg)"] } }));

    try {
      const result = await processHookEvent({
        tool_name: "Edit",
        tool_input: { file_path: lockedFile, old_string: "config", new_string: "updated" },
      });
      // trueline can't edit .cfg files, so Edit falls through to built-in
      expect(result.decision).toBe("approve");
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("approves other tools unconditionally", async () => {
    for (const tool of ["Bash", "Glob"]) {
      const result = await processHookEvent({ tool_name: tool, tool_input: {} });
      expect(result.decision).toBe("approve");
      expect(result.reason).toBeUndefined();
    }
  });
});
