import { describe, expect, test } from "bun:test";
import { getInstructions, getSessionStartInstructions } from "../../hooks/session-start.js";

describe("getInstructions", () => {
  test("wraps output in trueline_mcp_instructions tag", () => {
    const out = getInstructions();
    expect(out).toContain("<trueline_mcp_instructions>");
    expect(out).toContain("</trueline_mcp_instructions>");
  });

  test("documents all three trueline tools", () => {
    const out = getInstructions();
    expect(out).toContain("trueline_read");
    expect(out).toContain("trueline_edit");
    expect(out).toContain("trueline_diff");
  });

  test("includes a workflow element", () => {
    const out = getInstructions();
    expect(out).toContain("<workflow>");
  });

  test("instructs agent that Edit is blocked", () => {
    const out = getInstructions();
    expect(out).toContain("blocked");
  });

  test("instructs agent to relay instructions to subagents", () => {
    const out = getInstructions();
    expect(out).toContain("subagents");
  });

  test("mentions per-edit checksum and multi-range read", () => {
    const out = getInstructions();
    expect(out).toContain("checksum per range");
    expect(out).toContain("checksum (from trueline_read");
  });

  test("getSessionStartInstructions is a backwards-compatible alias", () => {
    expect(getSessionStartInstructions).toBe(getInstructions);
  });
});
