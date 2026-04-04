import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleReadMulti, clearReadCache } from "../../src/tools/read.ts";
import { handleOutline, clearOutlineCache } from "../../src/tools/outline.ts";
import { handleSearch } from "../../src/tools/search.ts";
import { resetRefStore } from "../helpers.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-glob-test-")));

  // Create a nested structure for glob testing
  mkdirSync(join(testDir, "src"), { recursive: true });
  mkdirSync(join(testDir, "lib"), { recursive: true });
  writeFileSync(join(testDir, "src", "alpha.ts"), "export function alpha(): void {}\n");
  writeFileSync(join(testDir, "src", "beta.ts"), "export function beta(): void {}\n");
  writeFileSync(join(testDir, "src", "gamma.js"), "function gamma() {}\n");
  writeFileSync(join(testDir, "lib", "delta.ts"), "export function delta(): void {}\n");
  writeFileSync(join(testDir, "config.json"), '{"key": "value"}\n');
});

beforeEach(() => {
  clearReadCache();
  clearOutlineCache();
  resetRefStore();
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function getText(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

// =============================================================================
// trueline_read glob expansion
// =============================================================================

describe("read glob expansion", () => {
  test("expands glob to matching files", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("--- src/alpha.ts ---");
    expect(text).toContain("--- src/beta.ts ---");
    expect(text).not.toContain("gamma"); // .js not matched by *.ts
  });

  test("mixes globs with literal paths", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.ts", "config.json"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("--- src/alpha.ts ---");
    expect(text).toContain("--- src/beta.ts ---");
    expect(text).toContain("--- config.json ---");
  });

  test("recursive glob with **", async () => {
    const result = await handleReadMulti({
      file_paths: ["**/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("delta"); // lib/delta.ts
  });

  test("non-glob paths pass through unchanged", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/alpha.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("function alpha");
    expect(text).not.toContain("---"); // single file, no header
  });

  test("glob with no matches returns empty result", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.xyz"],
      projectDir: testDir,
    });
    // No matches = empty output (not an error)
    expect(getText(result)).toBe("");
  });

  test("deduplicates overlapping globs", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/alpha.ts", "src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    // alpha.ts should appear exactly once
    const alphaCount = (text.match(/--- src\/alpha\.ts ---/g) || []).length;
    expect(alphaCount).toBe(1);
  });
});

// =============================================================================
// trueline_outline glob expansion
// =============================================================================

describe("outline glob expansion", () => {
  test("expands glob to matching files", async () => {
    const result = await handleOutline({
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("gamma");
  });

  test("recursive glob", async () => {
    const result = await handleOutline({
      file_paths: ["**/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("delta");
  });
});

// =============================================================================
// trueline_search glob expansion
// =============================================================================

describe("search glob expansion", () => {
  test("expands glob to matching files", async () => {
    const result = await handleSearch({
      pattern: "export function",
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("gamma"); // .js not matched
  });

  test("recursive glob", async () => {
    const result = await handleSearch({
      pattern: "export function",
      file_paths: ["**/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("delta");
  });

  test("search results from glob have refs", async () => {
    const result = await handleSearch({
      pattern: "alpha",
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toMatch(/ref:R\d+/);
  });
});
