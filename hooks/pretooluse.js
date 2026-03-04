import { fileURLToPath } from "node:url";

export function processHookEvent(event) {
  if (event.tool_name === "Edit" || event.tool_name === "MultiEdit") {
    return {
      decision: "block",
      reason:
        "<trueline_redirect>" +
        "Edit is blocked. Use trueline_read then trueline_edit." +
        "</trueline_redirect>",
    };
  }
  return { decision: "approve" };
}

// Main: read hook event from stdin, write result to stdout.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    let event;
    try {
      event = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      process.stdout.write(JSON.stringify({ decision: "block", reason: "hook: failed to parse stdin" }));
      return;
    }
    process.stdout.write(JSON.stringify(processHookEvent(event)));
  });
}
