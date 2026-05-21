import { describe, expect, test } from "bun:test";
import { getInstructions } from "../../hooks/core/instructions.js";

// ==============================================================================
// Instructions content tests
// ==============================================================================
//
// Validates that getInstructions() produces correct markdown for every platform.

const PLATFORMS = ["claude-code", "gemini-cli", "vscode-copilot", "opencode", "codex"] as const;

describe("instructions markdown content", () => {
  for (const platform of PLATFORMS) {
    test(`${platform}: contains trueline heading`, () => {
      const out = getInstructions(platform);
      expect(out).toContain("### trueline MCP");
    });

    test(`${platform}: documents all six trueline tools`, () => {
      const out = getInstructions(platform);
      expect(out).toContain("trueline_read");
      expect(out).toContain("trueline_edit");
      expect(out).toContain("trueline_changes");
      expect(out).toContain("trueline_outline");
      expect(out).toContain("trueline_search");
      expect(out).toContain("trueline_verify");
    });
  }

  test("unknown platform falls back without error", () => {
    const out = getInstructions("unknown-platform");
    expect(out).toContain("### trueline MCP");
    expect(out).toContain("trueline_edit");
  });
});
