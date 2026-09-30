import { describe, expect, test } from "bun:test";
import { getInstructions } from "../../hooks/core/instructions.js";

describe("getInstructions", () => {
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
});
