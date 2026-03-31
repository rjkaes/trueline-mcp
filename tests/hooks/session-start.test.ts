import { describe, expect, test } from "bun:test";
import { getInstructions, getSessionStartInstructions } from "../../hooks/session-start.js";

describe("getInstructions", () => {
  test("wraps output in trueline_mcp_instructions tag", () => {
    const out = getInstructions();
    expect(out).toContain("<trueline_mcp_instructions>");
    expect(out).toContain("</trueline_mcp_instructions>");
  });

  test("documents all six trueline tools", () => {
    const out = getInstructions();
    expect(out).toContain("trueline_read");
    expect(out).toContain("trueline_edit");
    expect(out).toContain("trueline_changes");
    expect(out).toContain("trueline_outline");
    expect(out).toContain("trueline_search");
    expect(out).toContain("trueline_verify");
  });

  test("has exploration rules for outline and diff", () => {
    const out = getInstructions();
    expect(out).toContain("<exploration>");
    expect(out).toContain("trueline_outline instead of");
    expect(out).toContain("trueline_changes");
  });

  test("has editing paths: surgical, exploratory, small-edit", () => {
    const out = getInstructions();
    expect(out).toContain("<editing>");
    expect(out).toContain("surgical");
    expect(out).toContain("exploratory");
    expect(out).toContain("small-edit");
  });

  test("includes a workflow element", () => {
    const out = getInstructions();
    expect(out).toContain("<workflow>");
  });

  test("does not claim tools are blocked", () => {
    const out = getInstructions();
    expect(out).not.toContain("blocked");
    expect(out).not.toContain("rejected");
    expect(out).not.toContain("Never use");
  });

  test("mentions ref from trueline_read", () => {
    const out = getInstructions();
    expect(out).toContain("ref");
  });

  test("getSessionStartInstructions is a backwards-compatible alias", () => {
    expect(getSessionStartInstructions).toBe(getInstructions);
  });
});
