import { describe, expect, test } from "bun:test";
import { formatDecision } from "../../hooks/core/formatters.js";
describe("formatDecision — block", () => {
  test("claude-code: block returns block with reason", () => {
    const result = formatDecision("claude-code", { action: "block", reason: "use trueline_read" });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "use trueline_read",
      },
    });
  });

  test("gemini-cli: block returns deny with reason", () => {
    const result = formatDecision("gemini-cli", { action: "block", reason: "use trueline_read" });
    expect(result).toEqual({ decision: "deny", reason: "use trueline_read" });
  });

  test("vscode-copilot: block returns deny with reason", () => {
    const result = formatDecision("vscode-copilot", { action: "block", reason: "use trueline_read" });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "use trueline_read",
      },
    });
  });
});

describe("formatDecision — null (passthrough)", () => {
  test("claude-code: null returns approve without reason", () => {
    const result = formatDecision("claude-code", null);
    expect(result).toBeNull();
  });

  test("gemini-cli: null returns empty object", () => {
    const result = formatDecision("gemini-cli", null);
    expect(result).toEqual({});
  });

  test("vscode-copilot: null returns null", () => {
    const result = formatDecision("vscode-copilot", null);
    expect(result).toBeNull();
  });
});
