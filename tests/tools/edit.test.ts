import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  chmodSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { handleEdit } from "../../src/tools/edit.ts";
import { handleRead } from "../../src/tools/read.ts";
import type { EditInput } from "../../src/tools/shared.ts";
import { coerceParams } from "../../src/coerce.ts";
import { FNV_OFFSET_BASIS, checksumToLetters, fnv1aHashBytes, foldHash, hashToLetters } from "../../src/hash.ts";
import { lineHash, issueTestRef, getText, writeTestFile, hashLine } from "../helpers.ts";

let testDir: string;
let testFile: string;

// Fresh file before each test
beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-edit-test-")));
  testFile = join(testDir, "target.ts");
  writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\n");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("handleEdit", () => {
  test("replaces a range of lines", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h2}2-${h3}3`,
          content: "replaced 2\nreplaced 3",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  test("inserts after a line", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `+${h1}1`,
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\ninserted\nline 2\nline 3\nline 4\n");
  });

  test("action insert_after inserts without + prefix", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h1}1`,
          action: "insert_after",
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\ninserted\nline 2\nline 3\nline 4\n");
  });

  test("action replace overrides + prefix", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `+${h1}1`,
          action: "replace",
          content: "replaced 1",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("replaced 1\nline 2\nline 3\nline 4\n");
  });

  test("action insert_after rejects multi-line range", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h1 = lineHash("line 1");
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h1}1-${h2}2`,
          action: "insert_after",
          content: "inserted",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
  });

  test("rejects stale checksum", async () => {
    // Issue a ref with wrong content to simulate stale checksum
    const staleRef = issueTestRef(["wrong", "content", "here", "now"], 1, 4);
    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref: staleRef,
          range: "aa1-aa1",
          content: "nope",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("rejects wrong line hash", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: "zz1-zz1",
          content: "nope",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test.each([
    { name: "CRLF", content: "line 1\r\nline 2\r\nline 3\r\n", expected: "line 1\r\nreplaced\r\nline 3\r\n" },
    // 2 LF, 1 CRLF: LF wins
    { name: "mixed, majority LF", content: "line 1\nline 2\r\nline 3\n", expected: "line 1\nreplaced\nline 3\n" },
    // 2 CRLF, 1 LF: CRLF wins
    {
      name: "mixed, majority CRLF",
      content: "line 1\r\nline 2\nline 3\r\n",
      expected: "line 1\r\nreplaced\r\nline 3\r\n",
    },
    { name: "LF", content: "line 1\nline 2\nline 3\nline 4\n", expected: "line 1\nreplaced\nline 3\nline 4\n" },
  ])("$name endings survive an edit", async ({ content, expected }) => {
    const file = writeTestFile(testDir, "eol.ts", content);
    const lines = content.split(/\r?\n/).slice(0, -1);
    const ref = issueTestRef(lines, 1, lines.length);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: file,
      edits: [{ ref, range: `${h2}2-${h2}2`, content: "replaced" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe(expected);
  });

  test("rejects directory path", async () => {
    const staleRef = "aa1-aa1/aaaaaa";
    const result = await handleEdit({
      file_path: testDir,
      edits: [{ ref: staleRef, range: "aa1-aa1", content: "x" }],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a regular file");
  });

  test("rejects nonexistent projectDir", async () => {
    const staleRef = "aa1-aa1/aaaaaa";
    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref: staleRef, range: "aa1-aa1", content: "x" }],
      projectDir: "/nonexistent/does/not/exist",
    });
    expect(result.isError).toBe(true);
    // realpath on a nonexistent dir throws, caught as inaccessible.
    expect(result.content[0].text).toContain("Project directory not found or inaccessible");
  });

  test("rejects overlapping ranges", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h1 = lineHash("line 1");
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        { ref, range: `${h1}1-${h2}2`, content: "A" },
        { ref, range: `${h2}2-${h2}2`, content: "B" },
      ],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Overlapping");
  });

  // Each ref covers its own edit; lines 2-3 fall inside both checksum ranges.
  test("verifies partially overlapping refs", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        { ref: issueTestRef(lines, 1, 3), range: hashLine("line 3", 3), content: "new line 3" },
        { ref: issueTestRef(lines, 2, 4), range: hashLine("line 4", 4), content: "new line 4" },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(testFile, "utf-8")).toBe("line 1\nline 2\nnew line 3\nnew line 4\n");
  });

  test("rejects checksum that does not cover edit range", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const partialRef = issueTestRef(lines, 1, 2);
    const h4 = lineHash("line 4");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref: partialRef,
          range: `${h4}4-${h4}4`,
          content: "replaced",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("preserves absence of trailing newline", async () => {
    const noTrailingFile = writeTestFile(testDir, "no-trailing.ts", "line 1\nline 2");

    const lines = ["line 1", "line 2"];
    const ref = issueTestRef(lines, 1, 2);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: noTrailingFile,
      edits: [{ ref, range: `${h1}1-${h1}1`, content: "replaced" }],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const written = readFileSync(noTrailingFile, "utf-8");
    expect(written).toBe("replaced\nline 2");
  });

  test("edits an empty file via insert-after with empty-file sentinel", async () => {
    const emptyFile = writeTestFile(testDir, "empty.ts", "");

    const emptyRef = "0-0/aaaaaa";

    const result = await handleEdit({
      file_path: emptyFile,
      edits: [
        {
          ref: emptyRef,
          range: "+0",
          content: "new content",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(emptyFile, "utf-8");
    expect(written).toContain("new content");
  });

  test("skips write and reports no changes for no-op edit", async () => {
    const filePath = writeTestFile(testDir, "noop.txt", "aaa\nbbb\nccc\n");
    const { mtimeMs: before } = statSync(filePath);

    const lines = ["aaa", "bbb", "ccc"];
    const ref = issueTestRef(lines, 1, 3);

    const result = await handleEdit({
      file_path: filePath,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}2`,
          content: "bbb", // same content
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no changes");
    const { mtimeMs: after } = statSync(filePath);
    expect(after).toBe(before);
  });

  test("checksum failure suggests narrow re-read when edit-target lines are unchanged", async () => {
    const filePath = writeTestFile(testDir, "stale-broad.txt", "aaa\nbbb\nccc\nddd\neee\n");

    const original = ["aaa", "bbb", "ccc", "ddd", "eee"];
    const ref = issueTestRef(original, 1, 5);

    // Externally modify line 4, outside our edit target
    writeFileSync(filePath, "aaa\nbbb\nccc\nDDD\neee\n");

    // Attempt to edit line 2, which hasn't changed
    const result = await handleEdit({
      file_path: filePath,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}2`,
          content: "BBB",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/trueline_read\(file_paths=\["[^"]+:2-2"\]\)/); // suggests narrow re-read
    expect(text).not.toContain("{start");
  });

  test("checksum failure with changed edit-target lines gives standard error", async () => {
    const filePath = writeTestFile(testDir, "stale-target.txt", "aaa\nbbb\nccc\n");

    const original = ["aaa", "bbb", "ccc"];
    const ref = issueTestRef(original, 1, 3);

    // Externally modify line 2, which IS our edit target
    writeFileSync(filePath, "aaa\nBBB\nccc\n");

    const result = await handleEdit({
      file_path: filePath,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}2`,
          content: "xxx",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Should NOT suggest narrow re-read since target lines changed too
    expect(text).not.toContain("appear unchanged");
  });

  test("denies editing .env file", async () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Edit(.env)", "Edit(**/.env)"] },
      }),
    );
    const envFile = writeTestFile(testDir, ".env", "SECRET=x\n");

    const lines = ["SECRET=x"];
    const ref = issueTestRef(lines, 1, 1);
    const h = lineHash("SECRET=x");

    const result = await handleEdit({
      file_path: envFile,
      edits: [{ ref, range: `${h}1-${h}1`, content: "hacked" }],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied");
  });

  test("edits a latin1 file preserving encoding", async () => {
    // "café\nnaïve\n" in latin1
    const line1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // café
    const line2 = Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65]); // naïve
    const fileBytes = Buffer.concat([line1, Buffer.from("\n"), line2, Buffer.from("\n")]);
    const latin1File = join(testDir, "latin1.txt");
    writeFileSync(latin1File, fileBytes);

    const lineHashes = [line1, line2].map((line) => fnv1aHashBytes(line));
    const [h1, h2] = lineHashes.map((h) => hashToLetters(h));
    const ref = `${h1}1-${h2}2/${checksumToLetters(lineHashes.reduce((acc, h) => foldHash(acc, h), FNV_OFFSET_BASIS))}`;

    const result = await handleEdit({
      file_path: latin1File,
      encoding: "latin1",
      edits: [
        {
          ref,
          range: `${h1}1-${h1}1`,
          content: "résumé",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    // Verify the written file uses latin1 encoding
    const written = readFileSync(latin1File);
    // "résumé" in latin1: r=0x72, é=0xe9, s=0x73, u=0x75, m=0x6d, é=0xe9
    expect(written[0]).toBe(0x72); // r
    expect(written[1]).toBe(0xe9); // é (latin1, not UTF-8's 0xc3 0xa9)
  });
  describe("dry_run", () => {
    test("returns unified diff without modifying file", async () => {
      writeFileSync(testFile, "line 1\nline 2\nline 3\n");
      const lines = ["line 1", "line 2", "line 3"];
      const ref = issueTestRef(lines, 1, 3);
      const h2 = lineHash("line 2");

      const result = await handleEdit({
        file_path: testFile,
        dry_run: true,
        edits: [{ ref, range: `${h2}2-${h2}2`, content: "CHANGED" }],
        projectDir: testDir,
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("-line 2");
      expect(text).toContain("+CHANGED");
      expect(text).toMatch(/^@@.+@@/m);

      // File must be unchanged
      const content = readFileSync(testFile, "utf-8");
      expect(content).toBe("line 1\nline 2\nline 3\n");
    });

    test("returns no-changes marker when edit is identity", async () => {
      writeFileSync(testFile, "line 1\nline 2\nline 3\n");
      const lines = ["line 1", "line 2", "line 3"];
      const ref = issueTestRef(lines, 1, 3);
      const h2 = lineHash("line 2");

      const result = await handleEdit({
        file_path: testFile,
        dry_run: true,
        edits: [{ ref, range: `${h2}2-${h2}2`, content: "line 2" }],
        projectDir: testDir,
      });

      expect(result.content[0].text).toBe("(no changes)");
    });

    test("rejects stale checksum same as non-dry-run", async () => {
      const staleRef = issueTestRef(["wrong", "content", "here", "now"], 1, 4);
      const result = await handleEdit({
        file_path: testFile,
        dry_run: true,
        edits: [{ ref: staleRef, range: "zz1-zz1", content: "nope" }],
        projectDir: testDir,
      });

      expect(result.isError).toBe(true);
    });

    test("dry-run diff headers stay relative when projectDir is a symlinked alias", async () => {
      // Windows reaches the same mismatch via 8.3 names: realpath expands RUNNER~1.
      const alias = `${testDir}-alias`;
      symlinkSync(testDir, alias, "junction");
      try {
        writeTestFile(testDir, "invoice.ts", "line 1\nline 2\nline 3\n");
        const ref = issueTestRef(["line 1", "line 2", "line 3"], 1, 3);
        const h2 = lineHash("line 2");

        const result = await handleEdit({
          file_path: join(alias, "invoice.ts"),
          dry_run: true,
          edits: [{ ref, range: `${h2}2-${h2}2`, content: "CHANGED" }],
          projectDir: alias,
          allowedDirs: [alias],
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0].text;
        expect(text).toContain("--- a/invoice.ts");
        expect(text).not.toContain("../");
      } finally {
        rmSync(alias, { force: true });
      }
    });
  });

  // ===========================================================================
  // Omitted range — derive edit target from checksum
  // ===========================================================================

  test("explicit range narrows edit within wider checksum", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}2-${h3}3`, content: "replaced 2\nreplaced 3" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  // Cases go through coerceParams, as the MCP server does, so array content
  // and the trailing-"\n" terminator are exercised end to end.
  test.each([
    ["insert_after", "", "line 1\nline 2\n\nline 3\nline 4\n"],
    ["insert_after", "\n", "line 1\nline 2\n\nline 3\nline 4\n"],
    ["replace", "", "line 1\nline 3\nline 4\n"],
    ["replace", "\n", "line 1\n\nline 3\nline 4\n"],
    ["replace", "replaced 2\n", "line 1\nreplaced 2\nline 3\nline 4\n"],
    ["replace", "replaced 2\n\n", "line 1\nreplaced 2\n\nline 3\nline 4\n"],
    ["replace", [""], "line 1\n\nline 3\nline 4\n"],
    ["replace", ["replaced 2", ""], "line 1\nreplaced 2\n\nline 3\nline 4\n"],
  ])("%s line 2 with content %j", async (action, content, expected) => {
    const ref = issueTestRef(["line 1", "line 2", "line 3", "line 4"], 1, 4);
    const coerced = coerceParams({
      edits: [{ ref, range: `${lineHash("line 2")}2`, content, action }],
    }) as { edits: EditInput[] };

    const result = await handleEdit({ file_path: testFile, edits: coerced.edits, projectDir: testDir });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(testFile, "utf-8")).toBe(expected);
  });

  test("dry_run: insert_after with empty content shows blank line in diff", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      dry_run: true,
      edits: [{ ref, range: `${h2}2`, content: "", action: "insert_after" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text.split("\n")).toContain("+");
    expect(text).toMatch(/^@@.+@@/m);

    // File must be unchanged
    const content = readFileSync(testFile, "utf-8");
    expect(content).toBe("line 1\nline 2\nline 3\nline 4\n");
  });

  test("warns when content contains hashLine identifiers", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}2`, content: "zm82" }],
      projectDir: testDir,
    });

    // Edit succeeds but includes a warning
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("WARNING");
    expect(result.content[0].text).toContain("hashLine identifiers");
    // Content was actually written (not blocked)
    const written = readFileSync(testFile, "utf-8");
    expect(written).toContain("zm82");
  });

  test("warns on multi-line content with embedded hashLine identifiers", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}2-${h3}3`, content: "good line\nbc80\nanother good line" }],
      projectDir: testDir,
    });

    // Edit succeeds but includes a warning about bc80
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("WARNING");
    expect(result.content[0].text).toContain("bc80");
  });

  test("allows content that resembles hashLine but has additional text", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}2`, content: "ab12 is a valid version string" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toContain("ab12 is a valid version string");
  });

  test("context_lines returns hashLine context around edit", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}2`, content: "replaced 2" }],
      context_lines: 2,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("context near line 2:");
    // Should have hashLine formatted lines
    expect(text).toMatch(/^[a-z]{2}\d+\t/m);
  });

  test("context_lines collapses large insertions", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");
    const inserted = Array.from({ length: 20 }, (_, i) => `new ${i + 1}`).join("\n");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}2`, content: inserted, action: "insert_after" }],
      context_lines: 3,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("context near lines");
    // Should collapse the middle: 3 before + 3 first + collapse marker + 3 last + 3 after
    expect(text).toContain("── 14 lines ──");
  });

  // Two or more edits get context_lines=2 unless the caller passes it; one edit gets none.
  test.each([
    { name: "context_lines 0 produces no context", lineCount: 4, editedLines: [2], context_lines: 0, blocks: 0 },
    { name: "multiple edits show separate blocks", lineCount: 4, editedLines: [1, 4], context_lines: 1, blocks: 2 },
    { name: "file boundaries do not overflow", lineCount: 4, editedLines: [1], context_lines: 5, blocks: 1 },
    { name: "auto when multiple edits and omitted", lineCount: 6, editedLines: [2, 5], blocks: 2 },
    { name: "auto does not activate for a single edit", lineCount: 4, refEnd: 3, editedLines: [2], blocks: 0 },
    { name: "explicit 0 suppresses auto", lineCount: 6, editedLines: [2, 5], context_lines: 0, blocks: 0 },
  ])("context_lines: $name", async ({ lineCount, refEnd, editedLines, context_lines, blocks }) => {
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`);
    writeFileSync(testFile, `${lines.join("\n")}\n`);
    const ref = issueTestRef(lines, 1, refEnd ?? lineCount);

    const result = await handleEdit({
      file_path: testFile,
      edits: editedLines.map((n) => ({ ref, range: hashLine(lines[n - 1], n), content: `replaced ${n}` })),
      context_lines,
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text.match(/context near/g) ?? []).toHaveLength(blocks);
    expect(/^[a-z]{2}\d+\t/m.test(text)).toBe(blocks > 0);
  });

  test("writes diff to temp file after successful edit", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h2}2`,
          content: "replaced 2",
        },
      ],
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("ms)");

    const { existsSync, readFileSync: readFs } = await import("node:fs");
    const cwdHash = createHash("sha256").update(`${testDir}\0${testFile}`).digest("hex").slice(0, 12);
    const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);
    expect(existsSync(diffPath)).toBe(true);

    const diff = readFs(diffPath, "utf-8");
    expect(diff).toContain("-line 2");
    expect(diff).toContain("+replaced 2");

    // Clean up
    const { unlinkSync } = await import("node:fs");
    unlinkSync(diffPath);
  });
});

// Edit-engine regressions. Refs come from handleRead, as they do for real callers.
async function holdRefs(file: string) {
  const text = getText(await handleRead({ file_path: file, projectDir: testDir }));
  const ref = /^ref: (\S+)$/m.exec(text)?.[1];
  if (!ref) throw new Error(`setup: no ref in read output:\n${text}`);
  return { ref, hashLines: [...text.matchAll(/^([a-z]{2}\d+)\t/gm)].map((m) => m[1]) };
}

type EditSpec = { range: string; content: string; action?: "replace" | "insert_after" };

async function runEdit(
  file: string,
  ref: string,
  edits: EditSpec[],
  opts: { dry_run?: boolean; context_lines?: number } = {},
) {
  return handleEdit({ file_path: file, projectDir: testDir, edits: edits.map((e) => ({ ref, ...e })), ...opts });
}

const returnedRef = (result: { content: Array<{ text: string }> }) => /^ref: (\S+)/m.exec(getText(result))?.[1];

// A hash prefix that differs from `letters`.
const otherHash = (letters: string) => (letters === "zz" ? "yy" : "zz");

describe("line-0 insert keeps the file's EOL on every inserted line", () => {
  const encodings: Record<string, (text: string) => Buffer> = {
    "utf-8": (text) => Buffer.from(text),
    "utf-8 BOM": (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    "utf-16le": (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    "utf-16be": (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
  };

  for (const [name, encode] of Object.entries(encodings)) {
    test(`CRLF file, ${name}`, async () => {
      const file = join(testDir, "prepend.txt");
      writeFileSync(file, encode("a\r\nb\r\n"));
      const { ref } = await holdRefs(file);

      const result = await runEdit(file, ref, [{ range: "0", action: "insert_after", content: "h1\nh2\nh3" }]);

      expect(result.isError).toBeUndefined();
      expect(readFileSync(file).toString("hex")).toBe(encode("h1\r\nh2\r\nh3\r\na\r\nb\r\n").toString("hex"));
    });
  }
});

describe("the last line keeps its own EOL", () => {
  test("an LF last line in a file whose first line is CRLF stays LF", async () => {
    const file = writeTestFile(testDir, "mixed.txt", "first\r\nsecond\nthird\n");
    const { ref, hashLines } = await holdRefs(file);

    await runEdit(file, ref, [{ range: hashLines[0], content: "FIRST" }]);

    expect(readFileSync(file, "utf-8")).toBe("FIRST\r\nsecond\nthird\n");
  });

  // The insert forces the write; the identity replace of line 2 must not pick up the file's CRLF.
  test("a no-op replace keeps its LF when an insert after it forces the write", async () => {
    const file = writeTestFile(testDir, "noop-eol.txt", "line1\r\nline2\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [
      { range: hashLines[1], content: "line2" },
      { range: hashLines[1], action: "insert_after", content: "inserted" },
    ]);

    expect(getText(result)).not.toContain("(no changes)");
    expect(readFileSync(file, "utf-8")).toMatch(/^line1\r\nline2\n/);
  });
});

describe("a blank last line without a trailing newline is not dropped", () => {
  test("insert_after the last line with an empty string", async () => {
    const file = writeTestFile(testDir, "blank-insert.txt", "a\nb");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: hashLines[1], action: "insert_after", content: "" }]);

    expect(readFileSync(file, "utf-8")).toBe("a\nb\n\n");
    expect(returnedRef(result)).toBe((await holdRefs(file)).ref);
  });

  test("replacing the last line with content ending in a blank line", async () => {
    const file = writeTestFile(testDir, "blank-replace.txt", "a\nb");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: hashLines[1], content: "x\n\n" }]);

    expect(readFileSync(file, "utf-8")).toBe("a\nx\n\n");
    expect(returnedRef(result)).toBe((await holdRefs(file)).ref);
  });
});

describe("line endings inside edit content are normalized to the file's EOL", () => {
  test("CRLF content into a CRLF file", async () => {
    const file = writeTestFile(testDir, "crlf.txt", "one\r\ntwo\r\nthree\r\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: `${hashLines[0]}-${hashLines[1]}`, content: "X\r\nY\r\n" }]);

    expect(readFileSync(file, "utf-8")).toBe("X\r\nY\r\nthree\r\n");
    expect(returnedRef(result)).toBe((await holdRefs(file)).ref);
  });

  test("CRLF content into an LF file", async () => {
    const file = writeTestFile(testDir, "lf.txt", "one\ntwo\nthree\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: `${hashLines[0]}-${hashLines[1]}`, content: "X\r\nY\r\n" }]);

    expect(readFileSync(file, "utf-8")).toBe("X\nY\nthree\n");
    expect(returnedRef(result)).toBe((await holdRefs(file)).ref);
  });

  test("a lone CR in content is a line break, as it is when the file is read", async () => {
    const file = writeTestFile(testDir, "cr.txt", "one\ntwo\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: hashLines[0], content: "X\rY" }]);

    expect(readFileSync(file, "utf-8")).toBe("X\nY\ntwo\n");
    expect(returnedRef(result)).toBe((await holdRefs(file)).ref);
  });
});

describe("a single-line range verifies its end hash", () => {
  test("replace with a valid start hash and a wrong end hash is rejected", async () => {
    const file = writeTestFile(testDir, "end-hash.txt", "a\nb\nc\n");
    const { ref, hashLines } = await holdRefs(file);
    const start = hashLines[1];
    const wrongEnd = otherHash(start.slice(0, 2));

    const rejected = await runEdit(file, ref, [{ range: `${start}-${wrongEnd}2`, content: "B" }]);

    expect(rejected.isError).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a\nb\nc\n");

    const accepted = await runEdit(file, ref, [{ range: `${start}-${start}`, content: "B" }]);
    expect(accepted.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("a\nB\nc\n");
  });

  test("insert_after with a wrong end hash is rejected", async () => {
    const file = writeTestFile(testDir, "end-hash-insert.txt", "a\nb\nc\n");
    const { ref, hashLines } = await holdRefs(file);
    const start = hashLines[1];

    const rejected = await runEdit(file, ref, [
      { range: `${start}-${otherHash(start.slice(0, 2))}2`, action: "insert_after", content: "X" },
    ]);

    expect(rejected.isError).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a\nb\nc\n");
  });
});

describe("insert_after verifies its own hash when a replace shares the line", () => {
  test("single-line replace plus insert_after with a wrong hash", async () => {
    const file = writeTestFile(testDir, "shared.txt", "a\nb\nc\n");
    const { ref, hashLines } = await holdRefs(file);
    const wrong = `${otherHash(hashLines[1].slice(0, 2))}2`;

    const rejected = await runEdit(file, ref, [
      { range: hashLines[1], content: "B" },
      { range: wrong, action: "insert_after", content: "X" },
    ]);

    expect(rejected.isError).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a\nb\nc\n");

    const accepted = await runEdit(file, ref, [
      { range: hashLines[1], content: "B" },
      { range: hashLines[1], action: "insert_after", content: "X" },
    ]);
    expect(accepted.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("a\nB\nX\nc\n");
  });

  test("insert_after at the end line of a multi-line replace with a wrong hash", async () => {
    const file = writeTestFile(testDir, "shared-multi.txt", "a\nb\nc\nd\n");
    const { ref, hashLines } = await holdRefs(file);
    const wrong = `${otherHash(hashLines[2].slice(0, 2))}3`;

    const rejected = await runEdit(file, ref, [
      { range: `${hashLines[1]}-${hashLines[2]}`, content: "BC" },
      { range: wrong, action: "insert_after", content: "X" },
    ]);

    expect(rejected.isError).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("a\nb\nc\nd\n");
  });
});

describe("edit summary positions do not depend on the order edits are listed", () => {
  const twelveLines = `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

  test("a later-in-file edit listed first does not shift an earlier one", async () => {
    const file = writeTestFile(testDir, "order.txt", twelveLines);
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(
      file,
      ref,
      [
        { range: hashLines[9], content: "ten a\nten b\nten c" },
        { range: hashLines[2], content: "three" },
      ],
      { context_lines: 1 },
    );

    const text = getText(result);
    expect(text).toContain(`~3 -> ${hashLine("three", 3)} (1->1)`);
    expect(text).toContain(`~10 -> ${hashLine("ten a", 10)}-${hashLine("ten c", 12)} (1->3)`);
    expect(text).toContain("context near line 3:");
    expect(text).toContain("context near lines 10-12:");
    expect(text).not.toContain("context near line 5");
  });

  test("a line-0 insert listed after another edit is still reported at line 1", async () => {
    const file = writeTestFile(testDir, "order-start.txt", "a\nb\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [
      { range: hashLines[0], content: "A1\nA2" },
      { range: "0", action: "insert_after", content: "top" },
    ]);

    expect(readFileSync(file, "utf-8")).toBe("top\nA1\nA2\nb\n");
    const text = getText(result);
    expect(text).toContain(`+1 @start -> ${hashLine("top", 1)}`);
    expect(text).toContain(`~1 -> ${hashLine("A1", 2)}-${hashLine("A2", 3)} (1->2)`);
  });

  test("an insert_after listed before a replace on the same line lands after it", async () => {
    const file = writeTestFile(testDir, "order-tie.txt", "a\nb\nc\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [
      { range: hashLines[1], action: "insert_after", content: "X" },
      { range: hashLines[1], content: "B1\nB2" },
    ]);

    expect(readFileSync(file, "utf-8")).toBe("a\nB1\nB2\nX\nc\n");
    const text = getText(result);
    expect(text).toContain(`+1 @2 -> ${hashLine("X", 4)}`);
    expect(text).toContain(`~2 -> ${hashLine("B1", 2)}-${hashLine("B2", 3)} (1->2)`);
  });
});

describe("unified diff hunk header for an empty side, through dry_run", () => {
  test("insert into an empty file", async () => {
    const file = writeTestFile(testDir, "empty.txt", "");
    const { ref } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: "0", action: "insert_after", content: "x" }], { dry_run: true });

    expect(getText(result)).toContain("@@ -0,0 +1 @@");
  });

  test("delete the only line", async () => {
    const file = writeTestFile(testDir, "only.txt", "only\n");
    const { ref, hashLines } = await holdRefs(file);

    const result = await runEdit(file, ref, [{ range: hashLines[0], content: "" }], { dry_run: true });

    expect(getText(result)).toContain("@@ -1 +0,0 @@");
  });
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("dry_run in a read-only directory", () => {
  test("returns the diff instead of failing to create a temp file", async () => {
    const roDir = join(testDir, "ro");
    mkdirSync(roDir);
    const file = join(roDir, "f.txt");
    writeFileSync(file, "a\nb\n");
    const { ref, hashLines } = await holdRefs(file);

    chmodSync(roDir, 0o555);
    try {
      const result = await runEdit(file, ref, [{ range: hashLines[0], content: "A" }], { dry_run: true });

      expect(result.isError).toBeUndefined();
      expect(getText(result)).toContain("-a\n+A");
      expect(readdirSync(roDir)).toEqual(["f.txt"]);
    } finally {
      chmodSync(roDir, 0o755);
    }
  });
});

describe("checksum-mismatch hint only claims what was verified", () => {
  test("interior line of a multi-line replace changed", async () => {
    const file = writeTestFile(testDir, "interior.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\n");
    const { ref, hashLines } = await holdRefs(file);
    writeFileSync(file, "l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n");

    const result = await runEdit(file, ref, [{ range: `${hashLines[1]}-${hashLines[5]}`, content: "new" }]);

    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).not.toContain("appear unchanged");
    // The hint names the canonical path; Windows tmpdir is the 8.3 alias (RUNNER~1).
    expect(text).toContain(`trueline_read(file_paths=["${await realpath(file)}:2-6"])`);
  });

  test("line between two separate edits changed", async () => {
    const file = writeTestFile(testDir, "gap.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\n");
    const { ref, hashLines } = await holdRefs(file);
    writeFileSync(file, "l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n");

    const result = await runEdit(file, ref, [
      { range: hashLines[1], content: "L2" },
      { range: hashLines[5], content: "L6" },
    ]);

    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).not.toContain("appear unchanged");
    expect(text).toContain(`trueline_read(file_paths=["${await realpath(file)}:2-6"])`);
  });

  test("still reports the lines as unchanged when every line in the span was verified", async () => {
    const file = writeTestFile(testDir, "verified.txt", "l1\nl2\nl3\nl4\nl5\n");
    const { ref, hashLines } = await holdRefs(file);
    writeFileSync(file, "CHANGED\nl2\nl3\nl4\nl5\n");

    const result = await runEdit(file, ref, [{ range: hashLines[2], content: "L3" }]);

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("lines 3–3 appear unchanged");
  });
});
