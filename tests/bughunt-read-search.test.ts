import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coerceParams } from "../src/coerce.ts";
import { handleEdit } from "../src/tools/edit.ts";
import { handleReadMulti, handleRead } from "../src/tools/read.ts";
import { handleSearch } from "../src/tools/search.ts";
import { expandGlobs } from "../src/tools/shared.ts";
import { getText, issueTestRef, lineHash, useTestDir } from "./helpers.ts";

const testDir = useTestDir("trueline-bughunt-read-search-");

function refOf(readText: string): string {
  return readText.match(/ref: (\S+)/)![1];
}

function hashLineOf(readText: string, lineNumber: number): string {
  const line = readText.split("\n").find((l) => new RegExp(`^[a-z]{2}${lineNumber}\t`).test(l));
  return line!.split("\t")[0];
}

describe("multiline search at EOF", () => {
  test("a match ending on the file's final newline is found", async () => {
    const file = join(testDir(), "handler.ts");
    writeFileSync(file, "function handler() {\n  return 1;\n}\n");

    const result = await handleSearch({
      file_paths: [file],
      pattern: "\\}\\n",
      multiline: true,
      projectDir: testDir(),
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).not.toContain("No matches");
    expect(text).toMatch(/^->[a-z]{2}3\t\}$/m);
  });

  test("a match spanning the trailing blank line is found", async () => {
    const file = join(testDir(), "notes.txt");
    writeFileSync(file, "last entry\n\n");

    const result = await handleSearch({
      file_paths: [file],
      pattern: "\\n\\n",
      multiline: true,
      projectDir: testDir(),
    });

    const text = getText(result);
    expect(text).not.toContain("No matches");
    expect(text).toMatch(/^->[a-z]{2}2\t$/m);
  });

  test("a final line without a newline has no EOL to match", async () => {
    const file = join(testDir(), "handler.ts");
    writeFileSync(file, "function handler() {\n}");

    const result = await handleSearch({
      file_paths: [file],
      pattern: "\\}\\n",
      multiline: true,
      projectDir: testDir(),
    });

    expect(getText(result)).toContain("No matches");
  });
});

describe("single-match glob output names the file", () => {
  test("search output identifies the file a one-file glob expanded to", async () => {
    mkdirSync(join(testDir(), "config"));
    writeFileSync(join(testDir(), "config", "database.ts"), "export const poolSize = 10;\n");

    const result = await handleSearch({
      file_paths: [join(testDir(), "config", "*.ts")],
      pattern: "poolSize",
      projectDir: testDir(),
      requireAbsolutePath: true,
    });

    const text = getText(result);
    expect(text).toContain("poolSize");
    expect(text).toContain("database.ts");
  });

  test("read output identifies the file a one-file glob expanded to", async () => {
    mkdirSync(join(testDir(), "config"));
    writeFileSync(join(testDir(), "config", "database.ts"), "export const poolSize = 10;\n");

    const result = await handleReadMulti({
      file_paths: [join(testDir(), "config", "*.ts")],
      projectDir: testDir(),
      requireAbsolutePath: true,
    });

    const text = getText(result);
    expect(text).toContain("poolSize");
    expect(text).toContain("database.ts");
  });

  // A path that exists is a literal even when it contains glob characters (Next.js routes).
  describe("existing literal path containing brackets", () => {
    const writeRoute = (name: string, content: string | Buffer) => {
      mkdirSync(join(testDir(), "app", "[id]"), { recursive: true });
      const file = join(testDir(), "app", "[id]", name);
      writeFileSync(file, content);
      return file;
    };

    test("read output has no file header", async () => {
      const file = writeRoute("page.tsx", "export default 1;\n");

      const text = getText(
        await handleReadMulti({ file_paths: [file], projectDir: testDir(), requireAbsolutePath: true }),
      );

      expect(text).toContain("export default 1;");
      expect(text).not.toMatch(/^--- /m);
    });

    test("read of an out-of-range inline range is an error, as for a plain path", async () => {
      const file = writeRoute("page.tsx", "export default 1;\n");

      const result = await handleReadMulti({
        file_paths: [`${file}:9-10`],
        projectDir: testDir(),
        requireAbsolutePath: true,
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("out of range");
    });

    test("search output has no file header", async () => {
      const file = writeRoute("page.tsx", "export default 1;\n");

      const text = getText(
        await handleSearch({
          file_paths: [file],
          pattern: "default",
          projectDir: testDir(),
          requireAbsolutePath: true,
        }),
      );

      expect(text).toContain("default");
      expect(text).not.toContain("page.tsx");
    });

    test("search of a binary file is an error, as for a plain path", async () => {
      const file = writeRoute("page.bin", Buffer.from([0x00, 0x01, 0x02, 0x0a]));

      const result = await handleSearch({
        file_paths: [file],
        pattern: "x",
        projectDir: testDir(),
        requireAbsolutePath: true,
      });

      expect(result.isError).toBe(true);
    });
  });
});

describe("read truncation notice", () => {
  test("no truncation notice when every requested line was returned", async () => {
    const file = join(testDir(), "migrations.sql");
    writeFileSync(file, `${Array.from({ length: 2100 }, (_, i) => `-- step ${i + 1}`).join("\n")}\n`);

    const result = await handleRead({ file_path: file, ranges: ["1-2000"], projectDir: testDir() });

    const text = getText(result);
    expect(text).toMatch(/^[a-z]{2}1\t-- step 1$/m);
    expect(text).toMatch(/^[a-z]{2}2000\t-- step 2000$/m);
    expect(text).not.toContain("truncated");
  });

  test("truncation is still reported when a requested line is dropped", async () => {
    const file = join(testDir(), "migrations.sql");
    writeFileSync(file, `${Array.from({ length: 2100 }, (_, i) => `-- step ${i + 1}`).join("\n")}\n`);

    const result = await handleRead({ file_path: file, ranges: ["1-2001"], projectDir: testDir() });

    const text = getText(result);
    expect(text).toMatch(/^[a-z]{2}2000\t-- step 2000$/m);
    expect(text).not.toContain("-- step 2001");
    expect(text).toContain("truncated at 2000 line limit");
  });

  test("a past-EOF range is still named after a read that hit the line cap exactly", async () => {
    const file = join(testDir(), "migrations.sql");
    writeFileSync(file, `${Array.from({ length: 2100 }, (_, i) => `-- step ${i + 1}`).join("\n")}\n`);

    const result = await handleRead({ file_path: file, ranges: ["1-2000", "5000"], projectDir: testDir() });

    const text = getText(result);
    expect(text).not.toContain("truncated");
    expect(text).toContain("range 5000 skipped");
  });
});

describe("search windowing parity", () => {
  test("line and multiline modes group touching context windows the same way", async () => {
    const file = join(testDir(), "routes.txt");
    const lines = ["get /", "get /a", "TODO auth", "get /b", "get /c", "get /d", "get /e", "TODO rate", "get /f"];
    writeFileSync(file, `${lines.join("\n")}\n`);

    const refsOf = (text: string) => [...text.matchAll(/^ref: (\S+)$/gm)].map((m) => m[1]);
    const lineMode = getText(
      await handleSearch({ file_paths: [file], pattern: "TODO", context_lines: 2, projectDir: testDir() }),
    );
    const multilineMode = getText(
      await handleSearch({
        file_paths: [file],
        pattern: "TODO",
        multiline: true,
        context_lines: 2,
        projectDir: testDir(),
      }),
    );

    expect(refsOf(multilineMode).length).toBeGreaterThan(0);
    expect(refsOf(lineMode)).toEqual(refsOf(multilineMode));
  });

  test("windows separated by more than context_lines stay separate in both modes", async () => {
    const file = join(testDir(), "routes.txt");
    const lines = Array.from({ length: 12 }, (_, i) => (i === 2 || i === 8 ? "TODO" : `get /${i + 1}`));
    writeFileSync(file, `${lines.join("\n")}\n`);

    const refsOf = (text: string) => [...text.matchAll(/^ref: (\S+)$/gm)].map((m) => m[1]);
    const search = async (multiline: boolean) =>
      getText(
        await handleSearch({ file_paths: [file], pattern: "TODO", multiline, context_lines: 2, projectDir: testDir() }),
      );
    const lineMode = refsOf(await search(false));

    expect(lineMode).toHaveLength(2);
    expect(lineMode).toEqual(refsOf(await search(true)));
  });
});

describe("coerce: edit with range + new_string but no content", () => {
  test("new_string alongside a range becomes the replacement content", async () => {
    const file = join(testDir(), "notes.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    const readText = getText(await handleRead({ file_path: file, allowedDirs: [testDir()] }));

    const coerced = coerceParams({
      file_path: file,
      range: hashLineOf(readText, 2),
      ref: refOf(readText),
      new_string: "BETA",
    }) as { edits: Array<Record<string, unknown>> };

    // editSchema (zod z.object) strips unknown keys such as new_string.
    const edits = coerced.edits.map(({ ref, range, content, action }) => ({ ref, range, content, action }));
    const result = await handleEdit({ file_path: file, edits: edits as never, allowedDirs: [testDir()] });

    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("an explicit content wins over new_string", () => {
    const coerced = coerceParams({
      file_path: "/abs/notes.txt",
      range: "ab2",
      ref: "ab2-ab2/abcdef",
      content: "X",
      new_string: "Y",
    });
    expect((coerced as { edits: Array<{ content: string }> }).edits[0].content).toBe("X");
  });
});

describe("coerce: numeric keys", () => {
  test.each(["", "   "])("blank string %p for depth is treated as absent, not 0", (blank) => {
    const coerced = coerceParams({ file_paths: ["/abs/app.ts"], depth: blank }) as Record<string, unknown>;
    expect("depth" in coerced).toBe(false);
  });

  test.each(["0x10", "1e1", "10.0", "-1"])("non-decimal %p for depth is not coerced", (text) => {
    const coerced = coerceParams({ file_paths: ["/abs/app.ts"], depth: text }) as Record<string, unknown>;
    expect(coerced.depth).toBe(text);
  });

  test("padded decimal digits are coerced", () => {
    const coerced = coerceParams({ file_paths: ["/abs/app.ts"], depth: " 2 " }) as Record<string, unknown>;
    expect(coerced.depth).toBe(2);
  });
});

describe.skipIf(process.platform === "win32")("expandGlobs: backslash is a filename character on POSIX", () => {
  // Asserted on expandGlobs, not handleRead: Bun's realpath maps "\" to "/" on POSIX,
  // so end-to-end reads of such a file only work under Node, the shipped runtime.
  test("a literal entry named with a backslash is returned unchanged", async () => {
    const entry = join(testDir(), "a\\b.txt");
    writeFileSync(entry, "backslash file\n");

    expect(await expandGlobs([entry], testDir(), [])).toEqual([entry]);
  });
});

describe("UTF-32 files are refused", () => {
  function utf32(text: string, littleEndian: boolean): Buffer {
    const codePoints = [0xfeff, ...[...text].map((ch) => ch.codePointAt(0) ?? 0)];
    const buf = Buffer.alloc(codePoints.length * 4);
    for (const [i, cp] of codePoints.entries()) {
      if (littleEndian) buf.writeUInt32LE(cp, i * 4);
      else buf.writeUInt32BE(cp, i * 4);
    }
    return buf;
  }

  // Refused at open, before streaming, so it must not escape as an exception: the server
  // would answer "Internal error" and a multi-file read would lose every other file.
  test("UTF-32 refusal is an error result, and a batch read keeps the other files", async () => {
    const wide = join(testDir(), "wide.txt");
    writeFileSync(wide, utf32("hi\n", true));
    const notes = join(testDir(), "notes.txt");
    writeFileSync(notes, "kept\n");

    const single = await handleRead({ file_path: wide, projectDir: testDir() });
    expect(single.isError).toBe(true);
    expect(getText(single)).toContain("UTF-32 is not supported");

    const edit = { ref: issueTestRef(["hi"], 1, 1), range: `${lineHash("hi")}1`, content: "hello" };
    const edited = await handleEdit({ file_path: wide, projectDir: testDir(), edits: [edit] });
    expect(edited.isError).toBe(true);
    expect(getText(edited)).toContain("UTF-32 is not supported");

    const batch = getText(await handleReadMulti({ file_paths: [wide, notes], projectDir: testDir() }));
    expect(batch).toContain("UTF-32 is not supported");
    expect(batch).toContain("kept");
  });
});
