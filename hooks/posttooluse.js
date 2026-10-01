import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { text } from "node:stream/consumers";
import { createHash } from "node:crypto";

const TRUELINE_EDIT_TOOL = "mcp__plugin_trueline-mcp_mcp__trueline_edit";

// The terminal palette's red and green, not Claude Code's tinted backgrounds:
// a hook can't see the theme ("auto" follows the terminal), and a fixed
// background is unreadable under one of light/dark default text. Terminal
// palettes tune these two for their own background.
const DEL_MARK = "\x1b[31m";
const ADD_MARK = "\x1b[32m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NORMAL = "\x1b[22m";
// Reset only what we set, so styling Claude Code wraps around the message survives.
const FG_RESET = "\x1b[39m";

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
  const added = numbered.filter((row) => row.mark === "+").length;
  const removed = numbered.filter((row) => row.mark === "-").length;

  const lines = rows.map((row) => {
    if (row === null) return `${DIM}...${NORMAL}`;
    const num = String(row.num).padStart(gutterWidth);
    if (row.mark === " ") return `${DIM}${num}${NORMAL}   ${row.text}`;
    const fg = row.mark === "+" ? ADD_MARK : DEL_MARK;
    return `${fg}${num} ${row.mark} ${row.text}${FG_RESET}`;
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
  let event;
  try {
    event = JSON.parse(await text(process.stdin));
  } catch {
    process.exit(0);
  }

  const result = await processPostToolUseEvent(event);
  if (result) {
    process.stdout.write(JSON.stringify(result));
  }
}
