import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const TRUELINE_EDIT_TOOL = "mcp__plugin_trueline-mcp_mcp__trueline_edit";

/** Strip --- / +++ file header lines, keep @@ hunk headers and content. */
function stripDiffHeaders(diff) {
  return diff
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "))
    .join("\n")
    .trim();
}

/**
 * Process a PostToolUse event. Returns JSON output for stdout, or null
 * if there's nothing to display.
 *
 * @param {{ tool_name: string }} event
 * @returns {Promise<{ systemMessage: string; suppressOutput: boolean } | null>}
 */
export async function processPostToolUseEvent(event) {
  if (event.tool_name !== TRUELINE_EDIT_TOOL) return null;

  const cwd = event.cwd;
  const filePath = event.tool_input?.file_path;
  if (!cwd || !filePath) return null;

  const cwdHash = createHash("sha256").update(`${cwd}\0${filePath}`).digest("hex").slice(0, 12);
  const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);
  if (!existsSync(diffPath)) return null;

  let diff;
  try {
    diff = readFileSync(diffPath, "utf-8");
    unlinkSync(diffPath);
  } catch {
    return null;
  }

  if (!diff.trim()) return null;

  return {
    systemMessage: stripDiffHeaders(diff),
    suppressOutput: true,
  };
}

// Main: read hook event from stdin, write result to stdout.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", async () => {
    let event;
    try {
      event = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      process.exit(0);
    }

    const result = await processPostToolUseEvent(event);
    if (result) {
      process.stdout.write(JSON.stringify(result));
    }
  });
}
