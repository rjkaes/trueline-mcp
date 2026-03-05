import { fileURLToPath } from "node:url";

export function getInstructions() {
  return `<trueline_mcp_instructions>
  <tools>
    <tool name="trueline_read">Read a file; returns content with per-line hashes and a checksum. Call before editing.</tool>
    <tool name="trueline_edit">Edit a file with hash verification. Replaces the built-in Edit tool, which is blocked. Each edit needs: range (startLine:hash..endLine:hash or +startLine:hash for insert-after), content (replacement lines as a newline-separated string; empty string to delete). Checksum from trueline_read goes at the top level, not per-edit. Supports multiple edits in one call — pass all changes to the same file in the edits array.</tool>
    <tool name="trueline_diff">Preview edits as a unified diff without writing to disk.</tool>
  </tools>
  <workflow>trueline_read \u2192 trueline_diff (optional) \u2192 trueline_edit</workflow>
  <rules>
    <rule>Never use the built-in Edit or MultiEdit tools \u2014 they are blocked and will be rejected.</rule>
    <rule>When spawning subagents, include these trueline_mcp_instructions in their task prompt.</rule>
  </rules>
</trueline_mcp_instructions>`;
}

// Backwards-compatible alias
export const getSessionStartInstructions = getInstructions;

// Main: detect hook event from stdin and format output accordingly.
// SessionStart: plain stdout is added as context.
// SubagentStart: requires JSON with hookSpecificOutput.additionalContext.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    const instructions = getInstructions();
    let event = "SessionStart";
    try {
      const parsed = JSON.parse(input);
      if (parsed.hook_event_name) event = parsed.hook_event_name;
    } catch {
      // No JSON on stdin (or empty) \u2014 default to SessionStart behavior
    }

    if (event === "SubagentStart") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SubagentStart",
            additionalContext: instructions,
          },
        }),
      );
    } else {
      process.stdout.write(instructions);
    }
  });
}
