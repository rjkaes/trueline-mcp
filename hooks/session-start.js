import { fileURLToPath } from "node:url";
import { getInstructions } from "./core/instructions.js";

// Re-export for backwards compatibility — other code may import this directly.
export { getInstructions };

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
    const instructions = getInstructions("claude-code");
    let event = "SessionStart";
    try {
      const parsed = JSON.parse(input);
      if (parsed.hook_event_name) event = parsed.hook_event_name;
    } catch {
      // No JSON on stdin (or empty) — default to SessionStart behavior
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
