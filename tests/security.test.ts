import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseToolPattern,
  fileGlobToRegex,
  readToolDenyPatterns,
  evaluateFilePath,
} from "../src/security.ts";

describe("parseToolPattern", () => {
  test("parses Read(.env)", () => {
    const result = parseToolPattern("Read(.env)");
    expect(result).toEqual({ tool: "Read", glob: ".env" });
  });

  test("parses Edit(**/*.secret)", () => {
    const result = parseToolPattern("Edit(**/*.secret)");
    expect(result).toEqual({ tool: "Edit", glob: "**/*.secret" });
  });

  test("handles nested parens", () => {
    const result = parseToolPattern("Read(some(path))");
    expect(result).toEqual({ tool: "Read", glob: "some(path)" });
  });

  test("returns null for non-pattern", () => {
    expect(parseToolPattern("justAString")).toBeNull();
  });

  test("returns null for Bash patterns", () => {
    // We still parse them, but tool will be "Bash"
    const result = parseToolPattern("Bash(sudo *)");
    expect(result?.tool).toBe("Bash");
  });
});

describe("fileGlobToRegex", () => {
  test("** matches any depth", () => {
    const re = fileGlobToRegex("**/*.env");
    expect(re.test("src/config/.env")).toBe(true);
    expect(re.test(".env")).toBe(true);
    expect(re.test("deep/nested/path/.env")).toBe(true);
  });

  test("** mid-segment is not globstar (boundary check)", () => {
    // "a**b" should not match across directories — the ** is not at a boundary
    const re = fileGlobToRegex("a**b");
    expect(re.test("a/foo/b")).toBe(false); // ** not at boundary, just single-segment wildcards
    expect(re.test("afoobarb")).toBe(true);
  });

  test("* matches single segment", () => {
    const re = fileGlobToRegex("src/*.ts");
    expect(re.test("src/file.ts")).toBe(true);
    expect(re.test("src/nested/file.ts")).toBe(false);
  });

  test("? matches single character", () => {
    const re = fileGlobToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file12.ts")).toBe(false);
  });

  test("exact match", () => {
    const re = fileGlobToRegex(".env");
    expect(re.test(".env")).toBe(true);
    expect(re.test("src/.env")).toBe(false);
  });

  test("case insensitive option", () => {
    const re = fileGlobToRegex("*.ENV", true);
    expect(re.test("config.env")).toBe(true);
    expect(re.test("config.ENV")).toBe(true);
  });

  test("consecutive globstars are normalized to prevent ReDoS", () => {
    const re = fileGlobToRegex("**/**/**/**/a");
    expect(re.test("x/y/z/a")).toBe(true);
    expect(re.test("x/y/z/b")).toBe(false);
  });
});

describe("readToolDenyPatterns", () => {
  test("reads deny patterns from project settings", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "security-test-"));
    try {
      const claudeDir = join(tmp, ".claude");
      const settingsPath = join(claudeDir, "settings.json");

      // Create .claude/settings.json with deny patterns
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: {
            deny: ["Read(.env)", "Read(**/*.secret)", "Edit(**/*.key)"],
            allow: ["Bash(echo *)"],
          },
        }),
      );

      const patterns = await readToolDenyPatterns("Read", tmp);
      // Should find Read patterns but not Edit or Bash
      expect(patterns.length).toBeGreaterThan(0);
      const flat = patterns.flat();
      expect(flat).toContain(".env");
      expect(flat).toContain("**/*.secret");
      expect(flat).not.toContain("**/*.key"); // Edit, not Read
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns empty when no settings exist", async () => {
    const patterns = await readToolDenyPatterns(
      "Read",
      "/nonexistent/path",
      "/nonexistent/global/settings.json",
    );
    expect(patterns).toEqual([]);
  });
});

describe("evaluateFilePath", () => {
  test("denies matching paths", () => {
    const result = evaluateFilePath("/project/.env", [[".env", "**/*.key"]]);
    expect(result.denied).toBe(true);
    expect(result.matchedPattern).toBe(".env");
  });

  test("allows non-matching paths", () => {
    const result = evaluateFilePath(
      "/project/src/app.ts",
      [[".env", "**/*.key"]],
    );
    expect(result.denied).toBe(false);
  });

  test("normalizes backslashes", () => {
    const result = evaluateFilePath(
      "C:\\Users\\dev\\.env",
      [["**/.env"]],
    );
    expect(result.denied).toBe(true);
  });

  test("handles empty deny lists", () => {
    const result = evaluateFilePath("/project/file.ts", []);
    expect(result.denied).toBe(false);
  });

  test("relative path pattern with / matches as suffix", () => {
    // "src/.env" should match "/project/src/.env"
    const result = evaluateFilePath("/project/src/.env", [["src/.env"]]);
    expect(result.denied).toBe(true);
    expect(result.matchedPattern).toBe("src/.env");
  });

  test("relative path pattern does not match wrong suffix", () => {
    const result = evaluateFilePath("/project/other/.env", [["src/.env"]]);
    expect(result.denied).toBe(false);
  });

  test("suffix matching respects caseInsensitive flag", () => {
    const result = evaluateFilePath(
      "/project/SRC/.Env",
      [["src/.env"]],
      true,
    );
    expect(result.denied).toBe(true);
  });
});
