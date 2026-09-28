import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { processPostToolUseEvent } from "../../hooks/posttooluse.js";

const TRUELINE_EDIT_TOOL = "mcp__plugin_trueline-mcp_mcp__trueline_edit";
const FAKE_CWD = "/tmp/test-project";
const FAKE_FILE = "/tmp/test-project/src/example.ts";
const cwdHash = createHash("sha256").update(`${FAKE_CWD}\0${FAKE_FILE}`).digest("hex").slice(0, 12);
const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);
const DEL_LINE = "\x1b[48;2;255;220;220m";
const ADD_LINE = "\x1b[48;2;220;255;220m";
const DEL_MARK = "\x1b[38;2;207;34;46m";
const ADD_MARK = "\x1b[38;2;36;138;61m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NORMAL = "\x1b[22m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

function cleanup() {
  try {
    if (existsSync(diffPath)) unlinkSync(diffPath);
  } catch {}
}

describe("PostToolUse hook", () => {
  afterEach(cleanup);

  test("renders header, line-number gutter, and hunk gaps", async () => {
    const fakeDiff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -8,3 +8,3 @@",
      " keep",
      "-old line",
      "+new longer line",
      " tail",
      "@@ -20,2 +20,3 @@",
      " before",
      "+inserted",
      " after",
      "",
    ].join("\n");
    writeFileSync(diffPath, fakeDiff);

    const result = await processPostToolUseEvent({
      tool_name: TRUELINE_EDIT_TOOL,
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });

    expect(result).not.toBeNull();
    // Tinted rows pad to the widest row so their backgrounds form one block.
    expect(stripVTControlCharacters(result!.systemMessage).split("\n")).toEqual([
      "Updated src/foo.ts (+2 -1)",
      " 8   keep",
      " 9 - old line".padEnd(20),
      " 9 + new longer line",
      "10   tail",
      "...",
      "20   before",
      "21 + inserted".padEnd(20),
      "22   after",
    ]);
    expect(result!.suppressOutput).toBe(true);
    expect(existsSync(diffPath)).toBe(false);
  });

  test("tints changed rows with Claude Code's light-theme diff colors", async () => {
    writeFileSync(diffPath, "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n");

    const result = await processPostToolUseEvent({
      tool_name: TRUELINE_EDIT_TOOL,
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });

    expect(result!.systemMessage.split("\n")).toEqual([
      `Updated ${BOLD}src/foo.ts${NORMAL} ${DIM}(+1 -1)${NORMAL}`,
      `${DEL_LINE}${DEL_MARK}1 -${FG_RESET} old${BG_RESET}`,
      `${ADD_LINE}${ADD_MARK}1 +${FG_RESET} new${BG_RESET}`,
      `${DIM}2${NORMAL}   ctx`,
    ]);
  });

  // A deleted "-- comment" line reads "--- comment", same prefix as the file header.
  test("keeps content lines that look like file headers", async () => {
    writeFileSync(diffPath, "--- a/q.sql\n+++ b/q.sql\n@@ -1 +1 @@\n--- drop me\n+++ add me\n");

    const result = await processPostToolUseEvent({
      tool_name: TRUELINE_EDIT_TOOL,
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });

    expect(stripVTControlCharacters(result!.systemMessage).split("\n")).toEqual([
      "Updated q.sql (+1 -1)",
      "1 - -- drop me",
      "1 + ++ add me".padEnd(14),
    ]);
  });

  // Claude Code swaps a systemMessage over 10,000 chars for a persisted-file preview.
  test("truncates rows to stay under Claude Code's systemMessage cap", async () => {
    const added = Array.from({ length: 300 }, (_, i) => `+const handler${i} = registerRoute("/api/orders/${i}");`);
    writeFileSync(
      diffPath,
      ["--- a/src/routes.ts", "+++ b/src/routes.ts", "@@ -0,0 +1,300 @@", ...added, ""].join("\n"),
    );

    const result = await processPostToolUseEvent({
      tool_name: TRUELINE_EDIT_TOOL,
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });

    const message = result!.systemMessage;
    expect(message.length).toBeLessThanOrEqual(10_000);
    const lines = stripVTControlCharacters(message).split("\n");
    expect(lines[0]).toBe("Updated src/routes.ts (+300 -0)");
    const shown = lines.length - 2;
    expect(lines.at(-1)).toBe(`... +${300 - shown} lines not shown`);
  });

  test("returns null when no diff file exists", async () => {
    cleanup();
    const result = await processPostToolUseEvent({
      tool_name: TRUELINE_EDIT_TOOL,
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });
    expect(result).toBeNull();
  });

  test("returns null for non-trueline-edit tools", async () => {
    const fakeDiff = "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
    writeFileSync(diffPath, fakeDiff);

    const result = await processPostToolUseEvent({
      tool_name: "Write",
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });

    expect(result).toBeNull();
    // File should still exist since it wasn't consumed
    expect(existsSync(diffPath)).toBe(true);
  });
});

test("hooks.json registers PostToolUse for trueline_edit", () => {
  const hooksJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/hooks.json");
  const config = JSON.parse(readFileSync(hooksJsonPath, "utf-8"));

  expect(config.hooks.PostToolUse).toBeDefined();
  expect(config.hooks.PostToolUse).toBeArray();

  const entry = config.hooks.PostToolUse[0];
  expect(entry.matcher).toContain("trueline_edit");
  expect(entry.hooks[0].command).toContain("posttooluse.js");
});
