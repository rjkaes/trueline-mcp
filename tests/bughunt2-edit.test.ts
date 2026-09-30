import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { handleEdit } from "../src/tools/edit.ts";
import { handleRead } from "../src/tools/read.ts";
import { getText, lineHash, writeTestFile, useTestDir } from "./helpers.ts";

const SERVER = join(import.meta.dir, "..", "src", "server.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const testDir = useTestDir("trueline-bughunt2-edit-");

function refOf(text: string): string {
  const match = text.match(/(?:^|\n)ref: (\S+)/);
  if (!match) throw new Error(`no ref in: ${text}`);
  return match[1];
}

async function readRef(file: string): Promise<string> {
  return refOf(getText(await handleRead({ file_path: file, projectDir: testDir() })));
}

describe("edit engine bug hunt, round 2", () => {
  // DESIGN.md: "Unchanged lines preserve their original raw bytes exactly, so mixed-EOL files only
  // normalize the lines that were actually edited." A replacement that re-sends a line unchanged is
  // shown as context by the dry-run diff, yet writeReplaceOrOriginal re-terminates it with the
  // file's first EOL because only a fully identical range takes the byte-preserving path.
  test("bug: an unchanged line inside a replaced range keeps its own EOL in a mixed-EOL file", async () => {
    const f = writeTestFile(testDir(), "mixed.txt", "one\ntwo\r\nthree\nfour\n");
    const ref = await readRef(f);
    const edits = [{ ref, range: `${lineHash("two")}2-${lineHash("three")}3`, content: "two\nTHREE" }];

    const preview = getText(await handleEdit({ file_path: f, projectDir: testDir(), dry_run: true, edits }));
    expect(preview).toContain("\n two\n");

    const result = await handleEdit({ file_path: f, projectDir: testDir(), edits });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(f).toString("latin1")).toBe("one\ntwo\r\nTHREE\nfour\n");
  });

  // Deleting a line and inserting the same text after it nets out to no change. The no-op check works
  // per op, so the engine reports changed=true and the diff, realigned at format time, comes out
  // empty: the tool answers "" instead of the documented "(no changes)".
  test("bug: dry_run of edits that cancel out answers (no changes), not an empty string", async () => {
    const f = writeTestFile(testDir(), "names.txt", "alpha\nbeta\ngamma\n");
    const ref = await readRef(f);

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir(),
      dry_run: true,
      edits: [
        { ref, range: `${lineHash("beta")}2`, content: "" },
        { ref, range: `+${lineHash("beta")}2`, content: "beta" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toBe("(no changes)");
  });

  // streaming-edit.ts promises "skip the atomic rename when nothing actually changed".
  test("bug: edits that cancel out do not rewrite the file", async () => {
    const f = writeTestFile(testDir(), "names.txt", "alpha\nbeta\ngamma\n");
    const past = new Date("2001-01-01T00:00:00Z");
    utimesSync(f, past, past);
    const mtimeBefore = statSync(f).mtimeMs;
    const ref = await readRef(f);

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir(),
      edits: [
        { ref, range: `${lineHash("beta")}2`, content: "" },
        { ref, range: `+${lineHash("beta")}2`, content: "beta" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("alpha\nbeta\ngamma\n");
    expect(statSync(f).mtimeMs).toBe(mtimeBefore);
  });

  // Nothing checks edit content for NUL. The written file trips the binary check that trueline_read,
  // trueline_edit and trueline_search all apply, so trueline can never touch it again.
  test("bug: an edit never leaves a file that trueline itself refuses to read as binary", async () => {
    const f = writeTestFile(testDir(), "notes.txt", "alpha\nbeta\n");
    const ref = await readRef(f);

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir(),
      edits: [{ ref, range: `${lineHash("beta")}2`, content: "be\u0000ta" }],
    });

    if (!result.isError) {
      const reread = await handleRead({ file_path: f, projectDir: testDir() });
      expect(reread.isError).toBeUndefined();
    }
  });

  // A U+FEFF opening line 1 of a BOM-less file becomes a real BOM on disk. transcodedLines strips it
  // on the next read, so the ref the edit returned (hashed with the BOM bytes) never matches again.
  test("bug: ref returned after writing U+FEFF into line 1 matches a fresh read", async () => {
    const f = writeTestFile(testDir(), "notes.txt", "alpha\nbeta\n");
    const ref = await readRef(f);

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir(),
      edits: [{ ref, range: `${lineHash("alpha")}1`, content: "\uFEFFalpha" }],
    });

    if (!result.isError) {
      expect(refOf(getText(result))).toBe(await readRef(f));
    }
  });

  // The server dispatches every request without waiting for the previous one. Two edits on one
  // file both pass the mtime check before either renames, and the second rename discards the first
  // edit's result while both calls answer success. The fix is the per-path queue in src/tools/edit.ts;
  // the handler sits behind the stdio dispatch unchanged, so this covers the server path too.
  test("bug: concurrent handleEdit calls on one file never lose an edit they reported as applied", async () => {
    const lost: string[] = [];

    for (let trial = 0; trial < 10; trial++) {
      const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
      const f = writeTestFile(testDir(), `race-${trial}.txt`, `${lines.join("\n")}\n`);
      const ref = await readRef(f);
      const edit = (n: number) =>
        handleEdit({
          file_path: f,
          projectDir: testDir(),
          edits: [{ ref, range: `${lineHash(`line${n}`)}${n}`, content: `EDITED${n}` }],
        });

      const [first, second] = await Promise.all([edit(3), edit(20)]);
      const final = readFileSync(f, "utf-8");
      if (!first.isError && !final.includes("EDITED3\n")) lost.push(`trial ${trial}: edit of line 3 lost`);
      if (!second.isError && !final.includes("EDITED20\n")) lost.push(`trial ${trial}: edit of line 20 lost`);
    }

    expect(lost).toEqual([]);
  });

  // The flat --ref/--range/--content flags are wrapped into a one-element --edits array before
  // validation, so a forgotten --ref is reported as a problem with a flag the user never passed.
  test("bug: a missing --ref names the flat flag, not --edits", () => {
    const f = writeTestFile(testDir(), "names.txt", "alpha\nbeta\n");
    const home = join(testDir(), "home");
    mkdirSync(home);

    const child = spawnSync("bun", [CLI, "edit", f, "--range", `${lineHash("beta")}2`, "--content", "BETA"], {
      cwd: testDir(),
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: testDir() },
    });

    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("--ref");
    expect(child.stderr).not.toContain("--edits");
  });

  // The file_path property says relative paths are rejected (they resolve against a stale project
  // root), and requireAbsolutePath enforces it, yet the description's own example uses "foo.ts".
  test("bug: the trueline_edit description example uses a path the tool accepts", () => {
    const home = join(testDir(), "home");
    mkdirSync(home);

    const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`;
    const child = spawnSync("bun", [SERVER], {
      input: request,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: testDir() },
    });
    const reply = JSON.parse(child.stdout.split("\n")[0]) as {
      result: { tools: { name: string; description: string }[] };
    };
    const editTool = reply.result.tools.find((tool) => tool.name === "trueline_edit");

    const examplePath = /file_path:\s*"([^"]+)"/.exec(editTool?.description ?? "")?.[1];
    if (examplePath !== undefined) expect(isAbsolute(examplePath)).toBe(true);
  });
});
