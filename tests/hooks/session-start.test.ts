import { describe, expect, test } from "bun:test";
import { getInstructions, getSessionStartInstructions } from "../../hooks/session-start.js";

describe("getInstructions", () => {
  test("starts with trueline heading", () => {
    const out = getInstructions();
    expect(out).toContain("### trueline MCP");
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

  test("has exploration rules for outline and changes", () => {
    const out = getInstructions();
    expect(out).toContain("trueline_outline");
    expect(out).toContain("trueline_changes");
  });

  test("has editing paths: surgical, exploratory, small-edit guidance", () => {
    const out = getInstructions();
    expect(out).toContain("trueline_search");
    expect(out).toContain("trueline_read");
    expect(out).toContain("trueline_edit");
  });

  test("includes workflow guidance", () => {
    const out = getInstructions();
    expect(out).toContain("trueline_search -> trueline_edit");
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

  test("does not include redundant tools section", () => {
    const out = getInstructions();
    expect(out).not.toContain("<tools>");
    expect(out).not.toContain("</tools>");
  });

  test("includes search-then-edit example", () => {
    const out = getInstructions();
    expect(out).toContain("search-then-edit");
  });

  test("getSessionStartInstructions is a backwards-compatible alias", () => {
    expect(getSessionStartInstructions).toBe(getInstructions);
  });
});
