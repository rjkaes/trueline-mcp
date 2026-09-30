import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { handleRead, handleReadMulti } from "../src/tools/read.ts";
import { handleSearch } from "../src/tools/search.ts";
import { getText, useTestDir } from "./helpers.ts";

const testDir = useTestDir("trueline-bughunt2-read-search-");

describe("read: 2000-line cap counts boundary context against requested lines", () => {
  // read.ts:148-152 drops only a trailing boundary line at the cap. A leading boundary line
  // (start-1) is output first and uses one of the 2000 slots, so a mid-file range of exactly
  // 2000 lines loses its last line and reports truncation, while 1-2000 is served whole.
  test("bug: a mid-file range of exactly 2000 lines is served whole", async () => {
    const file = join(testDir(), "migrations.sql");
    writeFileSync(file, `${Array.from({ length: 2100 }, (_, i) => `-- step ${i + 1}`).join("\n")}\n`);

    const text = getText(await handleRead({ file_path: file, ranges: ["2-2001"], projectDir: testDir() }));

    expect(text).toMatch(/^[a-z]{2}2001\t-- step 2001$/m);
    expect(text).not.toContain("truncated");
  });
});

describe("read: a skipped past-EOF range", () => {
  // read.ts:30-37 expands every range by one line before the EOF check, so a skipped range that
  // starts one line past EOF still emits the last line (and its own ref) as "boundary context".
  // A lone "6" on a 5-line file is an error for exactly this reason (read.test.ts:349).
  test("bug: does not leak the last line as boundary context", async () => {
    const file = join(testDir(), "ten-lines.txt");
    writeFileSync(file, `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`);

    const text = getText(await handleRead({ file_path: file, ranges: ["5-6", "11"], projectDir: testDir() }));

    expect(text).toContain("range 11 skipped");
    expect(text).not.toMatch(/^[a-z]{2}10\tl10$/m);
    expect([...text.matchAll(/^ref: /gm)]).toHaveLength(1);
  });
});

describe("read: inline range suffix", () => {
  // read.ts:249-251 / parse.ts:320-327 split "<path>:<digits>" unconditionally, so an existing file
  // whose name ends in ":<digits>" is read as line <digits> of a sibling (or reported not found).
  // trueline_search takes the same entry as the file it names, and expandGlobs stats the literal first.
  test("bug: an existing file named with a trailing :<digits> is read as that file", async () => {
    const named = join(testDir(), "snapshot-10:30");
    writeFileSync(named, "only line\n");
    writeFileSync(join(testDir(), "snapshot-10"), "l1\nl2\nl3\n");

    const result = await handleReadMulti({ file_paths: [named], projectDir: testDir(), requireAbsolutePath: true });

    expect(getText(result)).toContain("only line");
  });
});

describe("search: error text", () => {
  // search.ts:61-64 reports an empty array whenever expansion finds no file, so a glob that
  // matches nothing blames a file_paths array that was not empty.
  test("bug: a glob matching no file does not claim file_paths is empty", async () => {
    const result = await handleSearch({
      file_paths: [join(testDir(), "*.nomatch")],
      pattern: "needle",
      projectDir: testDir(),
      requireAbsolutePath: true,
    });

    expect(getText(result)).not.toContain("non-empty array");
  });

  // search.ts:97-102 rejects a real newline in a line-mode pattern and points to multiline=true.
  // The escaped form in regex mode can never match either, but only says "No matches".
  test("bug: an escaped \\n in a line-mode regex points to multiline instead of a bare No matches", async () => {
    const file = join(testDir(), "names.txt");
    writeFileSync(file, "alpha\nbeta\n");

    const result = await handleSearch({
      file_paths: [file],
      pattern: "alpha\\nbeta",
      regex: true,
      projectDir: testDir(),
    });

    expect(getText(result)).toContain("multiline");
  });
});

describe("batch reads keep other files when one cannot be opened", () => {
  // Bun's realpath fails on an unreadable file (reported as "outside the project directory"), so
  // the shipped runtime, node, is used: its realpath succeeds, open() throws EACCES, and nothing
  // in read.ts:277-281 or search.ts:121-125 catches it (only binary errors degrade per file).
  // The server then answers "Internal error" and the readable files' results are lost.
  const READ_URL = JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "src", "tools", "read.ts")).href);
  const SEARCH_URL = JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "src", "tools", "search.ts")).href);

  function underNode(call: string): { threw?: string; text?: string; status: number | null } {
    const script = `
      import { handleReadMulti } from ${READ_URL};
      import { handleSearch } from ${SEARCH_URL};
      try {
        const result = await ${call};
        console.log(JSON.stringify({ text: result.content[0].text }));
      } catch (err) {
        console.log(JSON.stringify({ threw: String(err.message) }));
      }`;
    const run = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      {
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
    const line = run.stdout.trim().split("\n").at(-1) ?? "{}";
    return { ...(JSON.parse(line) as { threw?: string; text?: string }), status: run.status };
  }

  function batch(): { readable: string; locked: string } {
    const readable = join(testDir(), "readable.txt");
    const locked = join(testDir(), "locked.txt");
    writeFileSync(readable, "needle in readable\n");
    writeFileSync(locked, "needle in locked\n");
    chmodSync(locked, 0o000);
    return { readable, locked };
  }

  test("bug: read of [readable, unreadable] returns the readable file", () => {
    const { readable, locked } = batch();
    try {
      const out = underNode(
        `handleReadMulti({ file_paths: [${JSON.stringify(readable)}, ${JSON.stringify(locked)}], projectDir: ${JSON.stringify(testDir())} })`,
      );

      expect(out.status).toBe(0);
      expect(out.threw).toBeUndefined();
      expect(out.text).toContain("needle in readable");
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("bug: search of [readable, unreadable] returns the readable file's matches", () => {
    const { readable, locked } = batch();
    try {
      const out = underNode(
        `handleSearch({ file_paths: [${JSON.stringify(readable)}, ${JSON.stringify(locked)}], pattern: "needle", projectDir: ${JSON.stringify(testDir())} })`,
      );

      expect(out.status).toBe(0);
      expect(out.threw).toBeUndefined();
      expect(out.text).toContain("needle in readable");
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});
