import { describe, expect, test } from "bun:test";
import { processHookEvent } from "../../hooks/pretooluse.js";

describe("PreToolUse hook", () => {
  test("blocks Edit and redirects to trueline_edit", () => {
    const result = processHookEvent({
      tool_name: "Edit",
      tool_input: { file_path: "app.ts", old_string: "x", new_string: "y" },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_edit");
  });

  test("blocks MultiEdit and redirects to trueline_edit", () => {
    const result = processHookEvent({
      tool_name: "MultiEdit",
      tool_input: { file_path: "app.ts", edits: [] },
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("trueline_edit");
  });

  test("approves all other tools", () => {
    for (const tool of ["Read", "Write", "Bash", "Glob"]) {
      const result = processHookEvent({ tool_name: tool, tool_input: {} });
      expect(result.decision).toBe("approve");
    }
  });
});
