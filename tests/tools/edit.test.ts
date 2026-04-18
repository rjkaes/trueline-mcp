import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, rawLineHash, issueTestRef, issueTestRefRaw, getText } from "../helpers.ts";

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
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h2}.2-${h3}.3`,
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
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `+${h1}.1`,
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
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h1}.1`,
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
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `+${h1}.1`,
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
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h1}.1-${h2}.2`,
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
    const staleRef = issueTestRef(testFile, ["wrong", "content", "here", "now"], 1, 4);
    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref: staleRef,
          range: "aa.1-aa.1",
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
    const ref = issueTestRef(testFile, lines, 1, 4);

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: "zz.1-zz.1",
          content: "nope",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mismatch");
  });

  test("preserves CRLF line endings after edit", async () => {
    const crlfFile = join(testDir, "crlf.ts");
    writeFileSync(crlfFile, "line 1\r\nline 2\r\nline 3\r\n");

    const lines = ["line 1", "line 2", "line 3"];
    const ref = issueTestRef(crlfFile, lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: crlfFile,
      edits: [{ ref, range: `${h2}.2-${h2}.2`, content: "replaced" }],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const written = readFileSync(crlfFile, "utf-8");
    // All line endings must be \r\n
    expect(written).toBe("line 1\r\nreplaced\r\nline 3\r\n");
    expect(written).not.toMatch(/(?<!\r)\n/);
  });

  test("mixed endings: majority LF preserves LF", async () => {
    const mixedFile = join(testDir, "mixed-lf.ts");
    // 2 LF, 1 CRLF → LF wins
    writeFileSync(mixedFile, "line 1\nline 2\r\nline 3\n");

    const lines = ["line 1", "line 2", "line 3"];
    const ref = issueTestRef(mixedFile, lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: mixedFile,
      edits: [{ ref, range: `${h2}.2-${h2}.2`, content: "replaced" }],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const written = readFileSync(mixedFile, "utf-8");
    expect(written).toBe("line 1\nreplaced\nline 3\n");
    expect(written).not.toContain("\r\n");
  });

  test("mixed endings: majority CRLF preserves CRLF", async () => {
    const mixedFile = join(testDir, "mixed-crlf.ts");
    // 2 CRLF, 1 LF → CRLF wins
    writeFileSync(mixedFile, "line 1\r\nline 2\nline 3\r\n");

    const lines = ["line 1", "line 2", "line 3"];
    const ref = issueTestRef(mixedFile, lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: mixedFile,
      edits: [{ ref, range: `${h2}.2-${h2}.2`, content: "replaced" }],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const written = readFileSync(mixedFile, "utf-8");
    expect(written).toBe("line 1\r\nreplaced\r\nline 3\r\n");
    expect(written).not.toMatch(/(?<!\r)\n/);
  });

  test("preserves LF line endings after edit (no CRLF introduced)", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2-${h2}.2`, content: "replaced" }],
      projectDir: testDir,
    });
    const written = readFileSync(testFile, "utf-8");
    expect(written).not.toContain("\r\n");
  });

  test("rejects directory path", async () => {
    const staleRef = "aa.1-aa.1:aaaaaa";
    const result = await handleEdit({
      file_path: testDir,
      edits: [{ ref: staleRef, range: "aa.1-aa.1", content: "x" }],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a regular file");
  });

  test("rejects binary files", async () => {
    const binFile = join(testDir, "binary.bin");
    writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const staleRef = "aa.1-aa.1:aaaaaa";
    const result = await handleEdit({
      file_path: binFile,
      edits: [{ ref: staleRef, range: "aa.1-aa.1", content: "x" }],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("binary");
  });

  test("rejects nonexistent projectDir", async () => {
    const staleRef = "aa.1-aa.1:aaaaaa";
    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref: staleRef, range: "aa.1-aa.1", content: "x" }],
      projectDir: "/nonexistent/does/not/exist",
    });
    expect(result.isError).toBe(true);
    // realpath on a nonexistent dir throws, caught as inaccessible.
    expect(result.content[0].text).toContain("Project directory not found or inaccessible");
  });

  test("rejects overlapping ranges", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        { ref, range: `${h1}.1-${h2}.2`, content: "A" },
        { ref, range: `${h2}.2-${h2}.2`, content: "B" },
      ],
      projectDir: testDir,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Overlapping");
  });

  test("rejects checksum that does not cover edit range", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const partialRef = issueTestRef(testFile, lines, 1, 2);
    const h4 = lineHash("line 4");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref: partialRef,
          range: `${h4}.4-${h4}.4`,
          content: "replaced",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not cover");
  });

  test("preserves absence of trailing newline", async () => {
    const noTrailingFile = join(testDir, "no-trailing.ts");
    writeFileSync(noTrailingFile, "line 1\nline 2");

    const lines = ["line 1", "line 2"];
    const ref = issueTestRef(noTrailingFile, lines, 1, 2);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: noTrailingFile,
      edits: [{ ref, range: `${h1}.1-${h1}.1`, content: "replaced" }],
      projectDir: testDir,
    });
    expect(result.isError).toBeUndefined();
    const written = readFileSync(noTrailingFile, "utf-8");
    expect(written).toBe("replaced\nline 2");
  });

  test("edits an empty file via insert-after with empty-file sentinel", async () => {
    const emptyFile = join(testDir, "empty.ts");
    writeFileSync(emptyFile, "");

    const emptyRef = "0-0:aaaaaa";

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
    const filePath = join(testDir, "noop.txt");
    writeFileSync(filePath, "aaa\nbbb\nccc\n");
    const { mtimeMs: before } = statSync(filePath);

    const lines = ["aaa", "bbb", "ccc"];
    const ref = issueTestRef(filePath, lines, 1, 3);

    const result = await handleEdit({
      file_path: filePath,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
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
    const filePath = join(testDir, "stale-broad.txt");
    writeFileSync(filePath, "aaa\nbbb\nccc\nddd\neee\n");

    const original = ["aaa", "bbb", "ccc", "ddd", "eee"];
    const ref = issueTestRef(filePath, original, 1, 5);

    // Externally modify line 4, outside our edit target
    writeFileSync(filePath, "aaa\nbbb\nccc\nDDD\neee\n");

    // Attempt to edit line 2, which hasn't changed
    const result = await handleEdit({
      file_path: filePath,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
          content: "BBB",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("ranges="); // suggests narrow re-read
    expect(text).toContain("end:");
  });

  test("checksum failure with changed edit-target lines gives standard error", async () => {
    const filePath = join(testDir, "stale-target.txt");
    writeFileSync(filePath, "aaa\nbbb\nccc\n");

    const original = ["aaa", "bbb", "ccc"];
    const ref = issueTestRef(filePath, original, 1, 3);

    // Externally modify line 2, which IS our edit target
    writeFileSync(filePath, "aaa\nBBB\nccc\n");

    const result = await handleEdit({
      file_path: filePath,
      edits: [
        {
          ref,
          range: `${lineHash("bbb")}.2`,
          content: "xxx",
        },
      ],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Should NOT suggest narrow re-read since target lines changed too
    expect(text).not.toContain("ranges=");
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
    const envFile = join(testDir, ".env");
    writeFileSync(envFile, "SECRET=x\n");

    const lines = ["SECRET=x"];
    const ref = issueTestRef(envFile, lines, 1, 1);
    const h = lineHash("SECRET=x");

    const result = await handleEdit({
      file_path: envFile,
      edits: [{ ref, range: `${h}.1-${h}.1`, content: "hacked" }],
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

    const ref = issueTestRefRaw(latin1File, [line1, line2], 1, 2);
    const h1 = rawLineHash(line1);

    const result = await handleEdit({
      file_path: latin1File,
      encoding: "latin1",
      edits: [
        {
          ref,
          range: `${h1}.1-${h1}.1`,
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
      const ref = issueTestRef(testFile, lines, 1, 3);
      const h2 = lineHash("line 2");

      const result = await handleEdit({
        file_path: testFile,
        dry_run: true,
        edits: [{ ref, range: `${h2}.2-${h2}.2`, content: "CHANGED" }],
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
      const ref = issueTestRef(testFile, lines, 1, 3);
      const h2 = lineHash("line 2");

      const result = await handleEdit({
        file_path: testFile,
        dry_run: true,
        edits: [{ ref, range: `${h2}.2-${h2}.2`, content: "line 2" }],
        projectDir: testDir,
      });

      expect(result.content[0].text).toBe("(no changes)");
    });

    test("rejects stale checksum same as non-dry-run", async () => {
      const staleRef = issueTestRef(testFile, ["wrong", "content", "here", "now"], 1, 4);
      const result = await handleEdit({
        file_path: testFile,
        dry_run: true,
        edits: [{ ref: staleRef, range: "zz.1-zz.1", content: "nope" }],
        projectDir: testDir,
      });

      expect(result.isError).toBe(true);
    });
  });

  // ===========================================================================
  // Omitted range — derive edit target from checksum
  // ===========================================================================

  test("explicit range narrows edit within wider checksum", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2-${h3}.3`, content: "replaced 2\nreplaced 3" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toBe("line 1\nreplaced 2\nreplaced 3\nline 4\n");
  });

  test("rejects insert_after with empty content", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: "", action: "insert_after" }],
      projectDir: testDir,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("insert_after with empty content");
  });

  test("warns when content contains hash.line identifiers", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: "zm.82" }],
      projectDir: testDir,
    });

    // Edit succeeds but includes a warning
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("WARNING");
    expect(result.content[0].text).toContain("hash.line identifiers");
    // Content was actually written (not blocked)
    const written = readFileSync(testFile, "utf-8");
    expect(written).toContain("zm.82");
  });

  test("warns on multi-line content with embedded hash.line identifiers", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");
    const h3 = lineHash("line 3");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2-${h3}.3`, content: "good line\nbc.80\nanother good line" }],
      projectDir: testDir,
    });

    // Edit succeeds but includes a warning about bc.80
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("WARNING");
    expect(result.content[0].text).toContain("bc.80");
  });

  test("allows content that resembles hash.line but has additional text", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: "ab.12 is a valid version string" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const written = readFileSync(testFile, "utf-8");
    expect(written).toContain("ab.12 is a valid version string");
  });

  test("context_lines returns hash.line context around edit", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: "replaced 2" }],
      context_lines: 2,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("context near line 2:");
    // Should have hash.line formatted lines
    expect(text).toMatch(/^[a-z]{2}\.\d+\t/m);
  });

  test("context_lines collapses large insertions", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");
    const inserted = Array.from({ length: 20 }, (_, i) => `new ${i + 1}`).join("\n");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: inserted, action: "insert_after" }],
      context_lines: 3,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("context near lines");
    // Should collapse the middle: 3 before + 3 first + collapse marker + 3 last + 3 after
    expect(text).toContain("── 14 lines ──");
  });

  test("context_lines 0 produces no context", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: "replaced 2" }],
      context_lines: 0,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).not.toContain("context near");
  });

  test("context_lines with multiple edits shows separate blocks", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");
    const h4 = lineHash("line 4");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        { ref, range: `${h1}.1`, content: "replaced 1" },
        { ref, range: `${h4}.4`, content: "replaced 4" },
      ],
      context_lines: 1,
      projectDir: testDir,
    });

    const text = getText(result);
    // Two separate context blocks
    const contextMatches = text.match(/context near/g);
    expect(contextMatches).toHaveLength(2);
  });

  test("context_lines at file boundaries does not overflow", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h1 = lineHash("line 1");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h1}.1`, content: "replaced 1" }],
      context_lines: 5, // more than lines above/below
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("context near");
    expect(result.isError).toBeUndefined();
  });

  test("auto context_lines when multiple edits and context_lines omitted", async () => {
    writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n");
    const lines = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"];
    const ref = issueTestRef(testFile, lines, 1, 6);
    const h2 = lineHash("line 2");
    const h5 = lineHash("line 5");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        { ref, range: `${h2}.2`, content: "replaced 2" },
        { ref, range: `${h5}.5`, content: "replaced 5" },
      ],
      // context_lines intentionally omitted
      projectDir: testDir,
    });

    const text = getText(result);
    // Auto context_lines=2 should produce context blocks
    expect(text).toContain("context near");
    expect(text).toMatch(/^[a-z]{2}\.\d+\t/m);
  });

  test("auto context_lines does not activate for single edit", async () => {
    const lines = ["line 1", "line 2", "line 3"];
    const ref = issueTestRef(testFile, lines, 1, 3);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [{ ref, range: `${h2}.2`, content: "replaced 2" }],
      // context_lines intentionally omitted
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).not.toContain("context near");
  });

  test("explicit context_lines=0 suppresses auto context_lines", async () => {
    writeFileSync(testFile, "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n");
    const lines = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"];
    const ref = issueTestRef(testFile, lines, 1, 6);
    const h2 = lineHash("line 2");
    const h5 = lineHash("line 5");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        { ref, range: `${h2}.2`, content: "replaced 2" },
        { ref, range: `${h5}.5`, content: "replaced 5" },
      ],
      context_lines: 0,
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).not.toContain("context near");
  });

  test("writes diff to temp file after successful edit", async () => {
    const lines = ["line 1", "line 2", "line 3", "line 4"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("line 2");

    const result = await handleEdit({
      file_path: testFile,
      edits: [
        {
          ref,
          range: `${h2}.2`,
          content: "replaced 2",
        },
      ],
      projectDir: testDir,
    });

    const text = getText(result);
    expect(text).toContain("Edit applied");

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
