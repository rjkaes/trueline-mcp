import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { processPostToolUseEvent } from "../../hooks/posttooluse.js";

const TRUELINE_EDIT_TOOL = "mcp__plugin_trueline-mcp_mcp__trueline_edit";
const FAKE_CWD = "/tmp/test-project";
const FAKE_FILE = "/tmp/test-project/src/example.ts";
const cwdHash = createHash("sha256").update(`${FAKE_CWD}\0${FAKE_FILE}`).digest("hex").slice(0, 12);
const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);

function cleanup() {
  try {
    if (existsSync(diffPath)) unlinkSync(diffPath);
  } catch {}
}

describe("PostToolUse hook", () => {
  afterEach(cleanup);

  test("returns systemMessage with diff when diff file exists", async () => {
    const fakeDiff = "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line\n";
    writeFileSync(diffPath, fakeDiff);

    const result = await processPostToolUseEvent({
      tool_name: TRUELINE_EDIT_TOOL,
      cwd: FAKE_CWD,
      tool_input: { file_path: FAKE_FILE },
    });

    expect(result).not.toBeNull();
    expect(result!.systemMessage).toBe("@@ -1,3 +1,3 @@\n-old line\n+new line");
    expect(result!.suppressOutput).toBe(true);
    expect(existsSync(diffPath)).toBe(false);
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
