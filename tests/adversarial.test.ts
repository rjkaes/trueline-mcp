import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../src/tools/edit.ts";
import { handleRead } from "../src/tools/read.ts";
import { lineHash, issueTestRef, setupFile, writeTestFile } from "./helpers.ts";

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-adversarial-")));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

interface EditCase {
  name: string;
  content: string;
  // refLines narrows that edit's ref to a line span; omitted means the whole file.
  edits: { range: string; content: string; refLines?: [number, number] }[];
  expected: string;
}

async function expectEditResult({ content, edits, expected }: EditCase) {
  const { path, lines, ref } = setupFile(testDir, "fixture.txt", content);

  const result = await handleEdit({
    file_path: path,
    edits: edits.map(({ refLines, ...edit }) => ({ ref: refLines ? issueTestRef(lines, ...refLines) : ref, ...edit })),
    projectDir: testDir,
  });

  expect(result.isError).toBeUndefined();
  expect(readFileSync(path, "utf-8")).toBe(expected);
}
describe("Adversarial Tests", () => {
  const longLine = "a".repeat(100000);

  test.each<EditCase>([
    {
      name: "very long lines (> 64KB)",
      content: `${longLine}\nsecond\n`,
      edits: [{ range: `${lineHash(longLine)}1`, content: "shortened" }],
      expected: "shortened\nsecond\n",
    },
    {
      // 🎉 is \uD83C\uDF89
      name: "surrogate pairs in hashing",
      content: "A 🎉 B\n",
      edits: [{ range: `${lineHash("A 🎉 B")}1`, content: "changed" }],
      expected: "changed\n",
    },
    {
      // Unpaired high surrogate
      name: "malformed surrogate pairs in hashing",
      content: "A \uD83C B\n",
      edits: [{ range: `${lineHash("A \uD83C B")}1`, content: "fixed" }],
      expected: "fixed\n",
    },
    {
      name: "insert-after at the end line of a multi-line replace",
      content: "1\n2\n3\n4\n5\n",
      edits: [
        { range: `${lineHash("2")}2-${lineHash("3")}3`, content: "TWO-THREE" },
        { range: `+${lineHash("3")}3`, content: "inserted" },
      ],
      expected: "1\nTWO-THREE\ninserted\n4\n5\n",
    },
    {
      // Refs cover lines 1-5 and 2-4
      name: "overlapping ref ranges (later ends earlier)",
      content: "1\n2\n3\n4\n5\n",
      edits: [
        { range: `${lineHash("3")}3`, content: "THREE-1", refLines: [1, 5] },
        { range: `${lineHash("4")}4`, content: "FOUR-2", refLines: [2, 4] },
      ],
      expected: "1\n2\nTHREE-1\nFOUR-2\n5\n",
    },
    {
      // streamingEdit should use detectedEol (\n) to separate line2 and line3,
      // but line3 itself should not have a trailing newline.
      name: "insert-after at last line of file without trailing newline",
      content: "line1\nline2",
      edits: [{ range: `+${lineHash("line2")}2`, content: "line3" }],
      expected: "line1\nline2\nline3",
    },
    {
      name: "replace last line of file without trailing newline",
      content: "line1\nline2",
      edits: [{ range: `${lineHash("line2")}2`, content: "replaced" }],
      expected: "line1\nreplaced",
    },
    {
      name: "multiple insert-after at the same line",
      content: "line1\nline2\n",
      edits: [
        { range: `+${lineHash("line1")}1`, content: "ins1" },
        { range: `+${lineHash("line1")}1`, content: "ins2" },
      ],
      expected: "line1\nins1\nins2\nline2\n",
    },
    {
      name: "insert-after at last line of file WITH trailing newline",
      content: "line1\nline2\n",
      edits: [{ range: `+${lineHash("line2")}2`, content: "line3" }],
      expected: "line1\nline2\nline3\n",
    },
  ])("$name", expectEditResult);
  test("path traversal via symlink to outside project", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-outside-")));
    const secretFile = writeTestFile(outsideDir, "secret.txt", "top secret");

    const linkPath = join(testDir, "evil-link.txt");
    symlinkSync(secretFile, linkPath);

    const result = await handleRead({ file_path: "evil-link.txt", projectDir: testDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Access denied");

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("overlapping range: insert-after inside a multi-line replace", async () => {
    const { path, ref } = setupFile(testDir, "overlap-ia.txt", "1\n2\n3\n4\n");

    const result = await handleEdit({
      file_path: path,
      edits: [
        {
          ref,
          range: `${lineHash("1")}1-${lineHash("3")}3`,
          content: "REPLACED",
        },
        {
          ref,
          range: `+${lineHash("2")}2`,
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

    // Read it - handleRead uses transcodedLines which yields raw bytes.
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

  test("handleRead with unsupported encoding", async () => {
    const { path } = setupFile(testDir, "encoding.txt", "abc\n");
    const result = await handleRead({
      file_path: path,
      encoding: "utf-16",
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unsupported encoding");
  });

  test("handleSearch resource limits (max_matches)", async () => {
    const { path } = setupFile(testDir, "many-matches.txt", "match\n".repeat(2000));
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_paths: [path],
        pattern: "match",
        max_matches: 5000, // exceeds available matches
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Should show all 2000 matches since 5000 is allowed
    expect(text).toMatch(/->\w+\d+\tmatch/);
    const matchCount = (text.match(/->/g) || []).length;
    expect(matchCount).toBe(2000);
  });

  test("handleSearch with high context_lines", async () => {
    const { path } = setupFile(testDir, "context-limit.txt", "1\n2\n3\nmatch\n5\n6\n7\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_paths: [path],
        pattern: "match",
        context_lines: 100, // exceeds file length
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Should show the whole file with hashes (2 letters + . + number)
    expect(text).toMatch(/[a-z]{2}1\t1/);
    expect(text).toMatch(/[a-z]{2}7\t7/);
  });

  test("handleSearch with extremely long line in context", async () => {
    const longLine = "a".repeat(100000);
    const { path } = setupFile(testDir, "search-long.txt", `${longLine}\nmatch\n`);
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_paths: [path],
        pattern: "match",
        context_lines: 1,
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/->\w+\d+\tmatch/);
    expect(text).toContain("a".repeat(100)); // Should see part of the long line
  });

  test("handleSearch with empty pattern", async () => {
    const { path } = setupFile(testDir, "empty-search.txt", "line1\nline2\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_paths: [path],
        pattern: "",
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/->\w+\d+\tline1/);
    expect(text).toMatch(/->\w+\d+\tline2/);
  });

  test("handleSearch literal search with regex characters", async () => {
    const { path } = setupFile(testDir, "regex-chars.txt", "a.b\naxb\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_paths: [path],
        pattern: "a.b",
        regex: false,
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/->\w+\d+\ta\.b/);
    expect(text).not.toMatch(/->\w+\d+\taxb/);
  });

  test("handleSearch pattern matching tab separator", async () => {
    const { path } = setupFile(testDir, "tab.txt", "a\tb\n");
    const result = await import("../src/tools/search.ts").then((m) =>
      m.handleSearch({
        file_paths: [path],
        pattern: "\t",
        projectDir: testDir,
      }),
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toMatch(/->\w+\d+\ta\tb/);
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
