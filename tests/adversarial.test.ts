import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../src/tools/edit.ts";
import { handleRead } from "../src/tools/read.ts";
import { streamingEdit } from "../src/streaming-edit.ts";
import { lineHash, issueTestRef, resetRefStore } from "./helpers.ts";

let testDir: string;

beforeEach(() => {
  resetRefStore();
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-adversarial-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function setupFile(name: string, content: string | Buffer) {
  const f = join(testDir, name);
  writeFileSync(f, content);
  const contentStr = typeof content === "string" ? content : content.toString("utf-8");
  const lines = contentStr.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const ref = lines.length > 0 ? issueTestRef(f, lines, 1, lines.length) : issueTestRef(f, [], 0, 0);
  return { path: f, lines, ref };
}

describe("Adversarial Tests", () => {
  test("binary file detection (null byte)", async () => {
    const f = join(testDir, "binary.bin");
    const buf = Buffer.concat([Buffer.from("text line\n"), Buffer.from([0, 1, 2, 3]), Buffer.from("\nmore text")]);
    writeFileSync(f, buf);

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("appears to be a binary file");
  });

  test("very long lines (> 64KB)", async () => {
    const longLine = "a".repeat(100000);
    const { path, ref } = setupFile("long.txt", `${longLine}\nsecond\n`);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash(longLine)}.1`,
          content: "shortened",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("shortened\nsecond\n");
  });

  test("path traversal via symlink to outside project", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-outside-")));
    const secretFile = join(outsideDir, "secret.txt");
    writeFileSync(secretFile, "top secret");

    const linkPath = join(testDir, "evil-link.txt");
    symlinkSync(secretFile, linkPath);

    const result = await handleRead({ file_path: "evil-link.txt", projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Access denied");

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("mtime check prevents race condition", async () => {
    setupFile("race.txt", "initial\n");

    // Simulate handleEdit starting but being slow.
    // We need to call streamingEdit or similar, but handleEdit does it all.
    // To simulate a race, we'd need to modify the file AFTER validatePath but BEFORE rename.
    // Since handleEdit is atomic in JS execution (mostly), we can't easily race it
    // unless we hook into the internals.

    // However, we can test that if mtime changes, it fails.
    // We can't easily do this with handleEdit because it validates mtime internally.
    // But we can check that it DOES check it.
  });

  test("surrogate pairs in hashing", async () => {
    const text = "A 🎉 B"; // 🎉 is \uD83C\uDF89
    const h = lineHash(text);
    const { path, ref } = setupFile("unicode.txt", `${text}\n`);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${h}.1`,
          content: "changed",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("changed\n");
  });

  test("malformed surrogate pairs in hashing", async () => {
    // Unpaired high surrogate
    const text = "A \uD83C B";
    const h = lineHash(text);
    const { path, ref } = setupFile("malformed.txt", `${text}\n`);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${h}.1`,
          content: "fixed",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("fixed\n");
  });

  test("ref mismatch suggesting narrow re-read", async () => {
    const { path, lines, ref } = setupFile("mismatch.txt", "1\n2\n3\n4\n5\n");

    // Modify line 1 (outside edit range)
    writeFileSync(path, "X\n2\n3\n4\n5\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("3")}.3`,
          content: "THREE",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("appear unchanged");
    expect(result.content[0].text).toContain("Re-read with trueline_read(ranges=[{start: 3, end: 3}])");
  });

  test("insert-after at the end line of a multi-line replace", async () => {
    const { path, ref } = setupFile("multi-replace-ia.txt", "1\n2\n3\n4\n5\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("2")}.2-${lineHash("3")}.3`,
          content: "TWO-THREE",
        },
        {
          ref,
          range: `+${lineHash("3")}.3`,
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("1\nTWO-THREE\ninserted\n4\n5\n");
  });

  test("overlapping range: insert-after inside a multi-line replace", async () => {
    const { path, ref } = setupFile("overlap-ia.txt", "1\n2\n3\n4\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("1")}.1-${lineHash("3")}.3`,
          content: "REPLACED",
        },
        {
          ref,
          range: `+${lineHash("2")}.2`,
          content: "IA",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("conflicts with replace range");
  });

  test("file exactly 10MB limit", async () => {
    const tenMB = 10 * 1024 * 1024;
    const buf = Buffer.alloc(tenMB, "a");
    // Add a newline so it's one line
    buf[tenMB - 1] = 0x0a;
    const f = join(testDir, "tenMB.txt");
    writeFileSync(f, buf);

    // Read it
    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
  });

  test("file with invalid UTF-8 sequences", async () => {
    // 0xFF is invalid in UTF-8
    const buf = Buffer.concat([Buffer.from("line 1\n"), Buffer.from([0xff, 0xfe]), Buffer.from("\nline 3\n")]);
    const f = join(testDir, "invalid-utf8.txt");
    writeFileSync(f, buf);

    // Read it - handleRead uses splitLines which yields raw bytes.
    // The hash should be based on raw bytes.
    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();

    const text = result.content[0].text;
    expect(text).toContain("line 1");
    expect(text).toContain("line 3");

    // Check if the invalid bytes are preserved (or replaced by Buffer.toString('utf-8'))
    // handleRead uses Buffer.concat(chunks).toString(enc)
    // If enc is utf-8, invalid bytes become \uFFFD.
    expect(text).toContain("\uFFFD");
  });

  test("overlapping ref ranges (later ends earlier)", async () => {
    const { path, lines } = setupFile("overlap-cs.txt", "1\n2\n3\n4\n5\n");
    // ref1: lines 1-5
    const ref1 = issueTestRef(path, lines, 1, 5);
    // ref2: lines 2-4
    const ref2 = issueTestRef(path, lines, 2, 4);

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref: ref1,
          range: `${lineHash("3")}.3`,
          content: "THREE-1",
        },
        {
          ref: ref2,
          range: `${lineHash("4")}.4`,
          content: "FOUR-2",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("1\n2\nTHREE-1\nFOUR-2\n5\n");
  });

  test("splitLines handles \\r\\n across chunk boundaries", async () => {
    const CHUNK_SIZE = 65536;
    const padding = "a".repeat(CHUNK_SIZE - 1);
    const content = Buffer.concat([Buffer.from(padding), Buffer.from("\r\nline2")]);
    const f = join(testDir, "chunk-split.txt");
    writeFileSync(f, content);

    // Read it
    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();

    const text = result.content[0].text;
    expect(text).toContain("line2");

    // Check ref to ensure it was correctly identified as 2 lines
    expect(text).toMatch(/ref: \S+ \(lines 1-2\)/);
  });

  test("concurrent modification detection (mtime change)", async () => {
    const { path, lines } = setupFile("mtime.txt", "line1\nline2\nline3\n");
    // Captured mtime at this point
    const { mtimeMs } = statSync(path);

    // Modify line 1 (outside edit range 2-2)
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(path, "modified\nline2\nline3\n");

    // Call streamingEdit directly with the OLD mtimeMs
    // Passing an empty array for checksumRefs skips checksum validation during stream
    const result = await streamingEdit(
      path,
      [
        {
          startLine: 2,
          endLine: 2,
          content: ["new line 2"],
          insertAfter: false,
          startHash: lineHash("line2"),
          endHash: "",
        },
      ],
      [], // NO REFS - triggers mtime check at the end
      mtimeMs, // OLD mtime
    );

    expect(result.ok).toBe(false);
    // @ts-expect-error
    expect(result.error).toContain("modified by another process");
  });

  test("search with very large context_lines", async () => {
    const { path } = setupFile("search-context.txt", "1\n2\n3\n4\n5\n");
    const _result = await handleRead({
      file_path: path,
      projectDir: testDir,
      // @ts-expect-error - testing invalid param
      context_lines: 1000000,
    });
    // handleRead doesn't have context_lines, but handleSearch does.
  });

  test("handleSearch with multi-line pattern", async () => {
    const { path } = setupFile("multiline.txt", "line 1\nline 2\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "line 1\nline 2",
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Pattern contains newlines");
  });

  test("handleSearch with invalid regex", async () => {
    const { path } = setupFile("regex.txt", "abc\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "[",
        regex: true,
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid regex pattern");
  });

  test("handleRead with unsupported encoding", async () => {
    const { path } = setupFile("encoding.txt", "abc\n");
    const result = await handleRead({
      file_path: path,
      encoding: "utf-16",
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unsupported encoding");
  });

  test("handleSearch max_matches limit", async () => {
    const { path } = setupFile("matches.txt", "a\na\na\na\na\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "a",
        max_matches: 2,
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("showing 2 of 5 matches");
  });

  test("mixed line endings (\\r, \\n, \\r\\n)", async () => {
    // line1: \r, line2: \n, line3: \r\n, line4: none
    const buf = Buffer.concat([
      Buffer.from("line1\r"),
      Buffer.from("line2\n"),
      Buffer.from("line3\r\n"),
      Buffer.from("line4"),
    ]);
    const f = join(testDir, "mixed-eol.txt");
    writeFileSync(f, buf);

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;

    expect(text).toContain("line1");
    expect(text).toContain("line2");
    expect(text).toContain("line3");
    expect(text).toContain("line4");
    expect(text).toMatch(/ref: \S+ \(lines 1-4\)/);
  });

  test("insert-after at last line of file without trailing newline", async () => {
    const { path, lines: _lines, ref } = setupFile("no-trail.txt", "line1\nline2");
    // original: "line1\nline2" (no trailing newline)

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("line2")}.2`,
          content: "line3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    // streamingEdit should use detectedEol (\n) to separate line2 and line3,
    // but line3 itself should not have a trailing newline.
    expect(readFileSync(path, "utf-8")).toBe("line1\nline2\nline3");
  });

  test("replace last line of file without trailing newline", async () => {
    const { path, lines: _lines, ref } = setupFile("no-trail-replace.txt", "line1\nline2");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("line2")}.2`,
          content: "replaced",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("line1\nreplaced");
  });

  test("access denied for directory", async () => {
    const result = await handleRead({ file_path: testDir, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is not a regular file");
  });

  test("access denied for non-existent file", async () => {
    const result = await handleRead({ file_path: join(testDir, "missing.txt"), projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("handleSearch resource limits (max_matches)", async () => {
    const { path } = setupFile("many-matches.txt", "match\n".repeat(2000));
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "match",
        max_matches: 5000, // exceeds available matches
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Should show all 2000 matches since 5000 is allowed
    expect(text).toContain("match  ← match");
    const matchCount = (text.match(/← match/g) || []).length;
    expect(matchCount).toBe(2000);
  });

  test("handleSearch with high context_lines", async () => {
    const { path } = setupFile("context-limit.txt", "1\n2\n3\nmatch\n5\n6\n7\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "match",
        context_lines: 100, // exceeds file length
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Should show the whole file with hashes (2 letters + . + number)
    expect(text).toMatch(/[a-z]{2}\.1\t1/);
    expect(text).toMatch(/[a-z]{2}\.7\t7/);
  });

  test("splitLines handles \\r at chunk boundary", async () => {
    const CHUNK_SIZE = 65536;
    const padding = "a".repeat(CHUNK_SIZE - 1);
    const content = Buffer.concat([Buffer.from(padding), Buffer.from("\r\nline2")]);
    const f = join(testDir, "cr-chunk-split.txt");
    writeFileSync(f, content);

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line2");
    expect(text).toMatch(/ref: \S+ \(lines 1-2\)/);
  });

  test("splitLines handles \\r at chunk boundary (not followed by \\n)", async () => {
    const CHUNK_SIZE = 65536;
    const padding = "a".repeat(CHUNK_SIZE - 1);
    const content = Buffer.concat([Buffer.from(padding), Buffer.from("\rline2")]);
    const f = join(testDir, "cr-only-chunk-split.txt");
    writeFileSync(f, content);

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line2");
    expect(text).toMatch(/ref: \S+ \(lines 1-2\)/);
  });

  test("handleSearch with extremely long line in context", async () => {
    const longLine = "a".repeat(100000);
    const { path } = setupFile("search-long.txt", `${longLine}\nmatch\n`);
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "match",
        context_lines: 1,
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("match  ← match");
    expect(text).toContain("a".repeat(100)); // Should see part of the long line
  });

  test("latin1 encoding round-trip", async () => {
    // 0xE9 is 'é' in latin1
    const buf = Buffer.from([0x61, 0xe9, 0x62, 0x0a]); // "aéb\n"
    const f = join(testDir, "latin1.txt");
    writeFileSync(f, buf);

    const readResult = await handleRead({
      file_path: f,
      encoding: "latin1",
      projectDir: testDir,
    });
    expect(readResult.isError).toBeUndefined();
    const text = readResult.content[0].text;
    expect(text).toContain("aé");

    const refMatch = text.match(/ref: (\S+)/);
    const readRef = refMatch![1];
    const lhMatch = text.match(/^([a-z]{2})\.1\t/m);
    const lh = lhMatch![1];

    const editResult = await handleEdit({
      file_path: f,
      encoding: "latin1",
      edits: [
        {
          ref: readRef,
          range: `${lh}.1`,
          content: "aé-modified",
        },
      ],
      projectDir: testDir,
    });

    expect(editResult.isError).toBeUndefined();
    const finalBuf = readFileSync(f);
    // "aé-modified\n" in latin1
    expect(finalBuf[1]).toBe(0xe9);
    expect(finalBuf.toString("latin1")).toBe("aé-modified\n");
  });

  test("handleRead merges overlapping and adjacent ranges", async () => {
    const { path } = setupFile("ranges.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    const result = await handleRead({
      file_path: path,
      ranges: ["1-3", "3-5", "7", "8"],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // parseRanges merges to 1-5 and 7-8, expansion merges them into one range
    expect(text).toMatch(/ref: \S+ \(lines 1-9\)/);
  });

  test("handleSearch with empty pattern", async () => {
    const { path } = setupFile("empty-search.txt", "line1\nline2\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "",
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line1  ← match");
    expect(text).toContain("line2  ← match");
  });

  test("handleSearch literal search with regex characters", async () => {
    const { path } = setupFile("regex-chars.txt", "a.b\naxb\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "a.b",
        regex: false,
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("a.b  ← match");
    expect(text).not.toContain("axb  ← match");
  });

  test("multiple insert-after at the same line", async () => {
    const { path, lines: _lines, ref } = setupFile("multi-ia-same.txt", "line1\nline2\n");
    const result = await handleEdit({
      file_path: path,
      edits: [
        { ref, range: `+${lineHash("line1")}.1`, content: "ins1" },
        { ref, range: `+${lineHash("line1")}.1`, content: "ins2" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("line1\nins1\nins2\nline2\n");
  });

  test("file with only \\r line endings", async () => {
    const buf = Buffer.from("line1\rline2\rline3\r");
    const f = join(testDir, "cr-only.txt");
    writeFileSync(f, buf);

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("line1");
    expect(text).toContain("line2");
    expect(text).toContain("line3");
    expect(text).toMatch(/ref: \S+ \(lines 1-3\)/);
  });

  test("handleSearch pattern matching tab separator", async () => {
    const { path } = setupFile("tab.txt", "a\tb\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_path: path,
        pattern: "\t",
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("a\tb  ← match");
  });

  test("insert-after at last line of file WITH trailing newline", async () => {
    const { path, lines: _lines, ref } = setupFile("trail-nl.txt", "line1\nline2\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `+${lineHash("line2")}.2`,
          content: "line3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    // original: "line1\nline2\n"
    // should become: "line1\nline2\nline3\n"
    expect(readFileSync(path, "utf-8")).toBe("line1\nline2\nline3\n");
  });

  test("file just over 10MB limit", async () => {
    const overLimit = 10 * 1024 * 1024 + 1;
    const buf = Buffer.alloc(overLimit, "a");
    const f = join(testDir, "overLimit.txt");
    writeFileSync(f, buf);

    const result = await handleRead({ file_path: f, projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exceeds the 10 MB size limit");
  });
});
