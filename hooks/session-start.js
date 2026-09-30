import { text } from "node:stream/consumers";
import { getInstructions } from "./core/instructions.js";

// Main: detect hook event from stdin and format output accordingly.
// SessionStart: plain stdout is added as context.
// SubagentStart: requires JSON with hookSpecificOutput.additionalContext.
const instructions = getInstructions("claude-code");
let event = "SessionStart";
try {
  const parsed = JSON.parse(await text(process.stdin));
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
