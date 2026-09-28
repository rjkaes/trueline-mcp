import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const TRUELINE_EDIT_TOOL = "mcp__plugin_trueline-mcp_mcp__trueline_edit";

// Light-theme defaults of Claude Code's native diff renderer (2.1.283). Its theme
// table has diffAdded* colors too, but the native view doesn't use them.
// TODO: dark and daltonized themes; a hook can't see which theme is active.
const DEL_LINE = "\x1b[48;2;255;220;220m";
const ADD_LINE = "\x1b[48;2;220;255;220m";
const DEL_MARK = "\x1b[38;2;207;34;46m";
const ADD_MARK = "\x1b[38;2;36;138;61m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NORMAL = "\x1b[22m";
// Reset only what we set, so styling Claude Code wraps around the message survives.
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Claude Code (2.1.283) swaps a longer systemMessage for a persisted-file
// preview, so the diff is truncated to fit.
const MAX_MESSAGE_CHARS = 10_000;

// TODO: front ends that don't render ANSI (VS Code, desktop, SDK) show the escapes literally.
/**
 * Render a unified diff like Claude Code's native changed-file view: an
 * "Updated <path> (+N -M)" header, then line-numbered rows with tinted backgrounds.
 */
function formatDiff(diff) {
  // DiffCollector always emits the header pair first. Strip by position: a
  // deleted "-- comment" line also starts with "--- ".
  const [, newHeader, ...body] = diff.trimEnd().split("\n");
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of body) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      if (rows.length > 0) rows.push(null);
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith("-")) {
      rows.push({ mark: "-", num: oldLine++, text: line.slice(1) });
    } else if (line.startsWith("+")) {
      rows.push({ mark: "+", num: newLine++, text: line.slice(1) });
    } else {
      // Context rows show new-file numbers, as the native view does.
      rows.push({ mark: " ", num: newLine++, text: line.slice(1) });
      oldLine++;
    }
  }

  const numbered = rows.filter((row) => row !== null);
  const gutterWidth = Math.max(...numbered.map((row) => String(row.num).length));
  // Pad tinted rows to the widest row so their backgrounds form one block; the
  // hook can't see the terminal width to fill the line like the native view.
  // TODO: .length miscounts tabs and wide characters.
  const textWidth = Math.max(...numbered.map((row) => row.text.length));
  const added = numbered.filter((row) => row.mark === "+").length;
  const removed = numbered.filter((row) => row.mark === "-").length;

  const lines = rows.map((row) => {
    if (row === null) return `${DIM}...${NORMAL}`;
    const num = String(row.num).padStart(gutterWidth);
    if (row.mark === " ") return `${DIM}${num}${NORMAL}   ${row.text}`;
    const [bg, fg] = row.mark === "+" ? [ADD_LINE, ADD_MARK] : [DEL_LINE, DEL_MARK];
    return `${bg}${fg}${num} ${row.mark}${FG_RESET} ${row.text.padEnd(textWidth)}${BG_RESET}`;
  });
  const path = newHeader.slice("+++ b/".length);
  const kept = [`Updated ${BOLD}${path}${NORMAL} ${DIM}(+${added} -${removed})${NORMAL}`];
  let length = kept[0].length;
  for (const [i, line] of lines.entries()) {
    // 64 leaves room for the trailer line.
    if (length + 1 + line.length > MAX_MESSAGE_CHARS - 64) {
      kept.push(`${DIM}... +${lines.length - i} lines not shown${NORMAL}`);
      break;
    }
    kept.push(line);
    length += 1 + line.length;
  }
  return kept.join("\n");
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
    systemMessage: formatDiff(diff),
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
