import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleEdit } from "../src/tools/edit.ts";
import { handleRead } from "../src/tools/read.ts";
import { validateEdits } from "../src/tools/shared.ts";
import { getText, lineHash, rangeChecksum, useTestDir, writeTestFile } from "./helpers.ts";

const testDir = useTestDir("trueline-bughunt3-edit-");

function refOf(text: string): string {
  const match = text.match(/(?:^|\n)ref: (\S+)/);
  if (!match) throw new Error(`no ref in: ${text}`);
  return match[1];
}

async function readText(file: string, encoding?: string): Promise<string> {
  return getText(await handleRead({ file_path: file, projectDir: testDir(), encoding }));
}

async function readRef(file: string): Promise<string> {
  return refOf(await readText(file));
}

// The 2-letter hash trueline_read printed for a line; hashes raw bytes, so it also works for invalid UTF-8.
function hashShownFor(readOutput: string, lineNumber: number): string {
  const match = readOutput.match(new RegExp(`^([a-z]{2})${lineNumber}\\t`, "m"));
  if (!match) throw new Error(`no hashLine for line ${lineNumber} in: ${readOutput}`);
  return match[1];
}

describe("edit engine bug hunt, round 3", () => {
  // flushWriteBuf() and writeBytes() never look at fd.write()'s bytesWritten. A short write (RLIMIT_FSIZE
  // here; ENOSPC on a full disk behaves the same) leaves a truncated temp file that is fsynced and renamed
  // over the original, and the call still answers ok. The comment at the fsync says ENOSPC must propagate.
  describe.skipIf(process.platform === "win32")("short write", () => {
    const EDIT_IN_CHILD = `
const { streamingEdit } = await import(process.env.STREAMING_EDIT_URL);
const job = JSON.parse(process.env.EDIT_JOB);
try {
  const result = await streamingEdit(job.file, job.ops, job.checksumRefs, job.mtimeMs);
  console.log(JSON.stringify({ ok: result.ok }));
} catch (err) {
  console.log(JSON.stringify({ threw: err.code ?? String(err) }));
}
`;

    // src/streaming-edit.ts:155 — fd.write() short count ignored, so a truncated temp file replaces the original
    test("a write the OS cuts short never replaces the original with a truncated file", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line number ${i + 1}`);
      const original = `${lines.join("\n")}\n`;
      const f = writeTestFile(testDir(), "ledger.txt", original);
      const { mtimeMs, size } = statSync(f);
      const validated = validateEdits([
        { ref: rangeChecksum(lines, 1, lines.length), range: `${lineHash(lines[0])}1`, content: "CHANGED" },
      ]);
      if (!validated.ok) throw new Error(`validateEdits failed: ${validated.error.content[0].text}`);

      // `ulimit -f 1` caps any file at one block (512 or 1024 bytes), far below the 3 KB output.
      const job = { file: f, ops: validated.ops, checksumRefs: validated.checksumRefs, mtimeMs };
      const child = spawnSync("sh", ["-c", 'ulimit -f 1 && exec "$0" -e "$1"', process.execPath, EDIT_IN_CHILD], {
        env: {
          ...process.env,
          STREAMING_EDIT_URL: new URL("../src/streaming-edit.ts", import.meta.url).href,
          EDIT_JOB: JSON.stringify(job),
        },
        encoding: "utf-8",
      });
      if (child.status !== 0) throw new Error(`child exited ${child.status}: ${child.stderr}`);

      // The full output cannot be written, so the only correct outcomes are an error and an untouched file.
      expect(statSync(f).size).toBe(size);
      expect(readFileSync(f, "utf-8")).toBe(original);
      expect(JSON.parse(child.stdout).ok).not.toBe(true);
    });
  });

  // startsWithBomBytes only recognises EF BB BF. FF FE / FE FF at byte 0 is a UTF-16 BOM to transcodedLines,
  // so the rewritten file reads back as UTF-16 garbage and the ref the edit returned never matches again.
  describe("UTF-16 BOM bytes at the start of a BOM-less file", () => {
    // src/streaming-edit.ts:218 — only EF BB BF is guarded; deleting the line before FF FE / FE FF exposes a UTF-16 BOM
    test.each([
      ["FF FE", [0xff, 0xfe]],
      ["FE FF", [0xfe, 0xff]],
    ])("deleting line 1 never leaves the file opening with %s", async (_label, bomBytes) => {
      const f = join(testDir(), "legacy.txt");
      writeFileSync(f, Buffer.concat([Buffer.from("first\n"), Buffer.from(bomBytes), Buffer.from("rest\n")]));
      const ref = await readRef(f);

      const result = await handleEdit({
        file_path: f,
        projectDir: testDir(),
        edits: [{ ref, range: `${lineHash("first")}1`, content: "" }],
      });

      if (!result.isError) {
        expect(refOf(getText(result))).toBe(await readRef(f));
      }
    });

    // src/streaming-edit.ts:218 — same guard gap, reached by latin1 content instead of a deletion
    test("latin1 content starting with U+00FF U+00FE never leaves the file opening with FF FE", async () => {
      const f = writeTestFile(testDir(), "latin.txt", "abc\ndef\n");
      const ref = refOf(await readText(f, "latin1"));

      const result = await handleEdit({
        file_path: f,
        projectDir: testDir(),
        encoding: "latin1",
        edits: [{ ref, range: `${lineHash("abc")}1`, content: "ÿþx" }],
      });

      if (!result.isError) {
        expect(refOf(getText(result))).toBe(refOf(await readText(f, "latin1")));
      }
    });
  });

  // trueline_read shows an invalid UTF-8 byte as U+FFFD. writeReplaceOrOriginal keeps head/tail lines the edit
  // re-sends unchanged, but compares the re-sent text's UTF-8 bytes (EF BF BD) with the original bytes (E9),
  // so the line is rewritten while the dry-run diff, which compares decoded text, prints it as context.
  // src/streaming-edit.ts:274 — unchanged line with an invalid UTF-8 byte is rewritten as U+FFFD, diff says context
  test("an invalid-UTF-8 line re-sent unchanged at the head of a replaced range keeps its original byte", async () => {
    const f = join(testDir(), "legacy.txt");
    writeFileSync(f, Buffer.concat([Buffer.from("alpha\ncaf"), Buffer.from([0xe9]), Buffer.from("\nomega\n")]));
    const read = await readText(f);
    const edits = [
      {
        ref: refOf(read),
        range: `${hashShownFor(read, 2)}2-${hashShownFor(read, 3)}3`,
        content: "caf�\nOMEGA",
      },
    ];

    const preview = getText(await handleEdit({ file_path: f, projectDir: testDir(), dry_run: true, edits }));
    expect(preview).toContain("\n caf�\n");

    const result = await handleEdit({ file_path: f, projectDir: testDir(), edits });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(f).toString("latin1")).toBe("alpha\ncafé\nOMEGA\n");
  });

  // The deleted-line preview cuts at 80 UTF-16 code units. An astral character straddling the cut leaves a lone
  // high surrogate in the tool result, which JSON serialises as "\ud83d" and strict consumers reject.
  // src/tools/edit.ts:200 — deleted-line preview slices through a surrogate pair
  test("deleted-line preview does not cut a surrogate pair in half", async () => {
    const doomed = `${"x".repeat(79)}\u{1F600}tail`;
    const f = writeTestFile(testDir(), "emoji.txt", `${doomed}\nkeep\n`);
    const ref = await readRef(f);

    const result = await handleEdit({
      file_path: f,
      projectDir: testDir(),
      edits: [{ ref, range: `${lineHash(doomed)}1`, content: "" }],
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result).isWellFormed()).toBe(true);
  });
});
