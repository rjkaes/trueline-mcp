// The streaming edit engine reports a replaced range as every original line
// deleted followed by every replacement line inserted — it never holds both
// file versions in memory to compare them.  Standard unified diff (git, GNU
// diff) only marks lines that actually differ, because a shortest edit script
// never pays a delete plus an insert for a line it can match for free.  These
// tests pin that behavior for the diff DiffCollector.format() produces.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleEdit } from "../../src/tools/edit.ts";
import { lineHash, issueTestRef } from "../helpers.ts";

let testDir: string;
let testFile: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-diff-align-test-")));
  testFile = join(testDir, "target.ts");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("unified diff alignment", () => {
  test("keeps a retained line as context when a line is added beside it", async () => {
    writeFileSync(testFile, "class Tenants {\n  const a = 70;\n  return a;\n}\n");
    const lines = ["class Tenants {", "  const a = 70;", "  return a;", "}"];
    const ref = issueTestRef(testFile, lines, 1, 4);
    const h2 = lineHash("  const a = 70;");

    const result = await handleEdit({
      file_path: testFile,
      dry_run: true,
      edits: [{ ref, range: `${h2}2-${h2}2`, content: "  const a = 70;\n  const b = 71;" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).not.toContain("-  const a = 70;");
    expect(text).toContain("   const a = 70;");
    expect(text).toContain("+  const b = 71;");
    expect(text).toContain("@@ -1,4 +1,5 @@");
  });

  test("keeps a retained trailing line as context when a line is added above it", async () => {
    writeFileSync(testFile, "alpha\nomega\n");
    const lines = ["alpha", "omega"];
    const ref = issueTestRef(testFile, lines, 1, 2);
    const h2 = lineHash("omega");

    const result = await handleEdit({
      file_path: testFile,
      dry_run: true,
      edits: [{ ref, range: `${h2}2-${h2}2`, content: "inserted\nomega" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("+inserted");
    expect(text).toContain(" omega");
    expect(text).not.toContain("-omega");
  });

  test("shows unchanged interior lines of a replaced block as context", async () => {
    writeFileSync(testFile, "alpha\nbravo\ncharlie\ndelta\necho\n");
    const lines = ["alpha", "bravo", "charlie", "delta", "echo"];
    const ref = issueTestRef(testFile, lines, 1, 5);
    const h1 = lineHash("alpha");
    const h5 = lineHash("echo");

    const result = await handleEdit({
      file_path: testFile,
      dry_run: true,
      edits: [{ ref, range: `${h1}1-${h5}5`, content: "ALPHA\nbravo\ncharlie\ndelta\nECHO" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("-alpha");
    expect(text).toContain("+ALPHA");
    expect(text).toContain("-echo");
    expect(text).toContain("+ECHO");
    for (const kept of ["bravo", "charlie", "delta"]) {
      expect(text).toContain(` ${kept}`);
      expect(text).not.toContain(`-${kept}`);
      expect(text).not.toContain(`+${kept}`);
    }
  });

  test("still reports a pure replacement as delete then insert", async () => {
    writeFileSync(testFile, "alpha\nbravo\n");
    const lines = ["alpha", "bravo"];
    const ref = issueTestRef(testFile, lines, 1, 2);
    const h1 = lineHash("alpha");
    const h2 = lineHash("bravo");

    const result = await handleEdit({
      file_path: testFile,
      dry_run: true,
      edits: [{ ref, range: `${h1}1-${h2}2`, content: "one\ntwo" }],
      projectDir: testDir,
    });

    expect(result.isError).toBeUndefined();
    const body = result.content[0].text.split("\n").slice(3);
    expect(body.filter((l: string) => l.startsWith("-"))).toEqual(["-alpha", "-bravo"]);
    expect(body.filter((l: string) => l.startsWith("+"))).toEqual(["+one", "+two"]);
  });
});
