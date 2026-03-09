import { describe, expect, test } from "bun:test";
import { formatDecision } from "../../hooks/core/formatters.js";

describe("formatDecision — advise", () => {
  test("claude-code: advise returns approve with reason", () => {
    const result = formatDecision("claude-code", { action: "advise", reason: "use trueline" });
    expect(result).toEqual({ decision: "approve", reason: "use trueline" });
  });

  test("gemini-cli: advise returns allow with reason", () => {
    const result = formatDecision("gemini-cli", { action: "advise", reason: "use trueline" });
    expect(result).toEqual({ decision: "allow", reason: "use trueline" });
  });

  test("vscode-copilot: advise returns allow with reason", () => {
    const result = formatDecision("vscode-copilot", { action: "advise", reason: "use trueline" });
    expect(result).toEqual({ permissionDecision: "allow", reason: "use trueline" });
  });

  test("unknown platform falls back to claude-code format", () => {
    const result = formatDecision("unknown", { action: "advise", reason: "use trueline" });
    expect(result).toEqual({ decision: "approve", reason: "use trueline" });
  });
});

describe("formatDecision — block", () => {
  test("claude-code: block returns block with reason", () => {
    const result = formatDecision("claude-code", { action: "block", reason: "use trueline_read" });
    expect(result).toEqual({ decision: "block", reason: "use trueline_read" });
  });

  test("gemini-cli: block returns deny with reason", () => {
    const result = formatDecision("gemini-cli", { action: "block", reason: "use trueline_read" });
    expect(result).toEqual({ decision: "deny", reason: "use trueline_read" });
  });

  test("vscode-copilot: block returns deny with reason", () => {
    const result = formatDecision("vscode-copilot", { action: "block", reason: "use trueline_read" });
    expect(result).toEqual({ permissionDecision: "deny", reason: "use trueline_read" });
  });
});

describe("formatDecision — null (passthrough)", () => {
  test("claude-code: null returns approve without reason", () => {
    const result = formatDecision("claude-code", null);
    expect(result).toEqual({ decision: "approve" });
  });

  test("gemini-cli: null returns null", () => {
    const result = formatDecision("gemini-cli", null);
    expect(result).toBeNull();
  });

  test("vscode-copilot: null returns null", () => {
    const result = formatDecision("vscode-copilot", null);
    expect(result).toBeNull();
  });
});
