import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { isContained } from "../../src/allowed-dirs.js";
import { handleRead } from "../../src/tools/read.ts";

// Two temp directories simulate: (1) the project dir, (2) an external allowed dir.
let projectDir: string;
let externalDir: string;
let projectFile: string;
let externalFile: string;
let outsideFile: string;
let outsideDir: string;

beforeAll(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-proj-")));
  externalDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-ext-")));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-out-")));

  projectFile = join(projectDir, "main.ts");
  writeFileSync(projectFile, "export const x = 1;\n");

  externalFile = join(externalDir, "plan.md");
  writeFileSync(externalFile, "# Plan\n");

  outsideFile = join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, "top secret\n");
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("allowedDirs containment", () => {
  test("file inside project dir is allowed (baseline)", async () => {
    const result = await handleRead({
      file_path: projectFile,
      projectDir,
      allowedDirs: [externalDir],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("export const x = 1;");
  });

  test("file inside an allowed dir is allowed", async () => {
    const result = await handleRead({
      file_path: externalFile,
      projectDir,
      allowedDirs: [externalDir],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("# Plan");
  });

  test("file outside all allowed dirs is denied", async () => {
    const result = await handleRead({
      file_path: outsideFile,
      projectDir,
      allowedDirs: [externalDir],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Access denied");
  });

  test("empty allowedDirs still allows project dir", async () => {
    const result = await handleRead({
      file_path: projectFile,
      projectDir,
      allowedDirs: [],
    });
    expect(result.isError).toBeUndefined();
  });

  test("empty allowedDirs denies external paths", async () => {
    const result = await handleRead({
      file_path: externalFile,
      projectDir,
      allowedDirs: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Access denied");
  });

  test("multiple allowed dirs all work", async () => {
    const result = await handleRead({
      file_path: outsideFile,
      projectDir,
      allowedDirs: [externalDir, outsideDir],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("top secret");
  });
});

describe("isContained", () => {
  const originalPlatform = process.platform;
  const base = join(sep, "Users", "Alice", "project");

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("accepts the base itself and paths under it", () => {
    expect(isContained(base, [base])).toBe(true);
    expect(isContained(join(base, "src", "app.ts"), [base])).toBe(true);
  });

  test("rejects a sibling that shares the base as a string prefix", () => {
    expect(isContained(`${base}-archive${sep}app.ts`, [base])).toBe(false);
  });

  test("a filesystem-root base contains every absolute path", () => {
    expect(isContained(join(sep, "etc", "hosts"), [sep])).toBe(true);
  });

  test("ignores case on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(isContained(join(sep, "users", "alice", "project", "app.ts"), [base])).toBe(true);
  });

  test("respects case elsewhere", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(isContained(join(sep, "users", "alice", "project", "app.ts"), [base])).toBe(false);
  });
});
