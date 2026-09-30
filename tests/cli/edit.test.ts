import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./helpers.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { writeTestFile } from "../helpers.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

let tmpDir: string;
let testFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trueline-cli-edit-"));
});

beforeEach(() => {
  testFile = join(tmpDir, `edit-${Date.now()}.txt`);
  writeFileSync(testFile, "alpha\nbeta\ngamma\n");
});

/**
 * Read testFile via the CLI and extract the ref for a given range.
 */
function readRef(range: string): { ref: string; hashRange: string } {
  const { stdout } = run(tmpDir, "read", `${testFile}:${range}`);
  const refMatch = stdout.match(/ref:\s*(\S+)/);
  if (!refMatch) throw new Error(`No ref found in read output: ${stdout}`);
  const fullRef = refMatch[1];
  // hashRange is the part before `/` in ref, e.g. "ab1-cd1"
  const slashIdx = fullRef.lastIndexOf("/");
  const hashRange = fullRef.slice(0, slashIdx);
  return { ref: fullRef, hashRange };
}

describe("edit subcommand", () => {
  test("golden path via @file: edits file content", () => {
    const { ref, hashRange } = readRef("2-2");
    const editsFile = writeTestFile(tmpDir, "edits.json", JSON.stringify([{ ref, range: hashRange, content: "BETA" }]));

    const { exitCode } = run(tmpDir, "edit", testFile, "--edits", `@${editsFile}`);
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toContain("BETA");
  });

  test("--dry-run: produces diff, does not modify file", () => {
    const { ref, hashRange } = readRef("1-1");
    const editsFile = writeTestFile(
      tmpDir,
      "edits-dry.json",
      JSON.stringify([{ ref, range: hashRange, content: "ALPHA_NEW" }]),
    );

    const { stdout, exitCode } = run(tmpDir, "edit", testFile, "--edits", `@${editsFile}`, "--dry-run");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ALPHA_NEW");
    // File unchanged
    expect(readFileSync(testFile, "utf-8")).toContain("alpha");
  });

  test("via flat flags: --ref --range --content", () => {
    const { ref, hashRange } = readRef("3-3");
    const { exitCode } = run(tmpDir, "edit", testFile, "--ref", ref, "--range", hashRange, "--content", "GAMMA_NEW");
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toContain("GAMMA_NEW");
  });

  test.each(["- item", "-1"])("--content %p starting with '-' is a literal value", (content) => {
    const { ref, hashRange } = readRef("3-3");
    const { exitCode } = run(tmpDir, "edit", testFile, "--ref", ref, "--range", hashRange, "--content", content);
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toBe(`alpha\n${content}\n`);
  });

  test("--content with a trailing newline is a terminator, not an extra blank line", () => {
    // readRef("3-3") returns a ref widened with 1 line of context (covers lines 2-3:
    // "beta"/"gamma"), so the edit below replaces both lines with one.
    const { ref, hashRange } = readRef("3-3");
    const { exitCode } = run(tmpDir, "edit", testFile, "--ref", ref, "--range", hashRange, "--content", "GAMMA_NEW\n");
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nGAMMA_NEW\n");
  });

  test("via stdin: pipe edits JSON via --edits -", () => {
    const { ref, hashRange } = readRef("1-1");
    const editsJson = JSON.stringify([{ ref, range: hashRange, content: "STDIN_CONTENT" }]);

    // Use spawn directly to pipe stdin
    let exitCode = 0;
    try {
      execFileSync("bun", [CLI, "edit", testFile, "--edits", "-"], {
        input: editsJson,
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir },
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
    }
    expect(exitCode).toBe(0);
    expect(readFileSync(testFile, "utf-8")).toContain("STDIN_CONTENT");
  });

  test("--edits and flat flags are mutually exclusive (exit 3)", () => {
    const { exitCode, stderr } = run(
      tmpDir,
      "edit",
      testFile,
      "--edits",
      "[]",
      "--ref",
      "ab1",
      "--range",
      "ab1",
      "--content",
      "x",
    );
    expect(exitCode).toBe(3);
    expect(stderr).toContain("mutually exclusive");
  });

  test("unknown flag exits 3 without editing (typo of --dry-run)", () => {
    const { ref, hashRange } = readRef("1-1");
    const { exitCode, stderr } = run(
      tmpDir,
      "edit",
      testFile,
      "--ref",
      ref,
      "--range",
      hashRange,
      "--content",
      "ALPHA_NEW",
      "--dryrun",
    );
    expect(exitCode).toBe(3);
    expect(stderr).toContain("unknown option --dryrun");
    expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  test("string option without a value exits 3", () => {
    const { exitCode, stderr } = run(tmpDir, "edit", testFile, "--content");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("option --content requires a value");
  });

  test("--json shape: {ok, result}", () => {
    const { ref, hashRange } = readRef("2-2");
    const editsFile = writeTestFile(
      tmpDir,
      "edits-json.json",
      JSON.stringify([{ ref, range: hashRange, content: "BETA_JSON", action: "replace" }]),
    );

    const { stdout, exitCode } = run(tmpDir, "edit", testFile, "--edits", `@${editsFile}`, "--json");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.content[0].text).toBeTruthy();
  });
});

interface Invocation {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

// Unlike run() this supports cwd and stdin, and strips an inherited
// CLAUDE_PROJECT_DIR so results do not depend on the shell the suite runs from.
function trueline(args: string[], opts: Invocation = {}) {
  const env: Record<string, string | undefined> = { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir, ...opts.env };
  if (opts.env?.CLAUDE_PROJECT_DIR === undefined) delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync("bun", [CLI, ...args], {
    cwd: opts.cwd ?? tmpDir,
    env,
    input: opts.input ?? "",
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? -1 };
}

/** Per-line hashLines (e.g. "ab1") and the whole-file ref from `trueline read <file>`. */
function holdRefs(file: string) {
  const { stdout } = trueline(["read", file]);
  const hashLines = [...stdout.matchAll(/^([a-z]{2}\d+)\t/gm)].map((m) => m[1]);
  const ref = /^ref: (\S+)$/m.exec(stdout)?.[1];
  if (!ref || hashLines.length === 0) throw new Error(`setup: could not parse read output:\n${stdout}`);
  return { hashLines, ref };
}

function scratch(name: string, files: Record<string, string>): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) writeFileSync(join(dir, fileName), content);
  return dir;
}

// CLAUDE_PROJECT_DIR pins the security boundary; relative arguments still mean the shell cwd.
describe("relative paths resolve against the shell cwd", () => {
  test("edit: from a project subdirectory, a relative path edits that directory's file", () => {
    const projectDir = scratch("edit-project", { "f.txt": "x\ny\nroot\n" });
    const cwd = scratch("edit-project/sub", { "f.txt": "x\ny\nsub\n" });
    // Lines 1-2 are identical in both files, so a ref from a 1-line read is valid for either.
    const { hashLines, ref } = holdRefs(`${join(cwd, "f.txt")}:1`);
    trueline(["edit", "f.txt", "--ref", ref, "--range", hashLines[0], "--content", "CHANGED"], {
      cwd,
      env: { CLAUDE_PROJECT_DIR: projectDir },
    });
    expect(readFileSync(join(cwd, "f.txt"), "utf-8")).toBe("CHANGED\ny\nsub\n");
    expect(readFileSync(join(projectDir, "f.txt"), "utf-8")).toBe("x\ny\nroot\n");
  });
});

describe("option values", () => {
  test("a string flag with no value must not swallow the next flag (--content --dry-run)", () => {
    const dir = scratch("swallow", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const { exitCode } = trueline(["edit", file, "--ref", ref, "--range", hashLines[0], "--content", "--dry-run"]);
    expect(readFileSync(file, "utf-8")).toBe("one\ntwo\n");
    expect(exitCode).toBe(3);
  });

  test("edit --context-lines with a non-number is rejected", () => {
    const dir = scratch("nan-context", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const { exitCode } = trueline([
      "edit",
      file,
      "--ref",
      ref,
      "--range",
      hashLines[0],
      "--content",
      "NEW",
      "--context-lines",
      "abc",
      "--dry-run",
    ]);
    expect(exitCode).not.toBe(0);
  });
});

// Zod enforces these minimums for the MCP tools; the CLI skips zod, so io.ts does.
describe("numeric flags", () => {
  test.each(["1e3", "12abc", "-1"])("edit --context-lines %s exits 3", (value) => {
    const dir = scratch("edit-context-lines", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const { exitCode, stderr } = trueline([
      "edit",
      file,
      "--ref",
      ref,
      "--range",
      hashLines[0],
      "--content",
      "NEW",
      "--context-lines",
      value,
      "--dry-run",
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("--context-lines");
  });

  test("edit accepts --context-lines 0", () => {
    const dir = scratch("edit-context-lines-zero", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const { exitCode } = trueline([
      "edit",
      file,
      "--ref",
      ref,
      "--range",
      hashLines[0],
      "--content",
      "NEW",
      "--context-lines",
      "0",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
  });
});

describe("flag-like option values", () => {
  function editContent(name: string, ...contentArgs: string[]) {
    const dir = scratch(name, { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const result = trueline(["edit", file, "--ref", ref, "--range", hashLines[0], ...contentArgs]);
    return { ...result, text: readFileSync(file, "utf-8") };
  }

  test("a typo'd flag after --content is a missing value, not the literal text", () => {
    const { exitCode, stderr, text } = editContent("typo-flag", "--content", "--dryrun");
    expect(exitCode).toBe(3);
    expect(stderr).toContain("option --content requires a value");
    expect(text).toBe("one\ntwo\n");
  });

  test("--content=--dryrun still writes the flag-like literal", () => {
    const { exitCode, text } = editContent("inline-flag-literal", "--content=--dryrun");
    expect(exitCode).toBe(0);
    expect(text).toBe("--dryrun\ntwo\n");
  });

  test.each(["---", "- item"])("--content %p is content, not a flag", (content) => {
    const { exitCode, text } = editContent(`dash-content-${content.length}`, "--content", content);
    expect(exitCode).toBe(0);
    expect(text).toBe(`${content}\ntwo\n`);
  });
});

describe("edit flag combinations", () => {
  test("--action alongside --edits is rejected instead of ignored", () => {
    const dir = scratch("action-with-edits", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const edits = JSON.stringify([{ ref, range: hashLines[0], content: "NEW" }]);
    const { exitCode } = trueline(["edit", file, "--edits", edits, "--action", "insert_after"]);
    expect(readFileSync(file, "utf-8")).toBe("one\ntwo\n");
    expect(exitCode).toBe(3);
  });

  test("edit with two path arguments is rejected instead of ignoring the second", () => {
    const dir = scratch("edit-two-paths", { "a.txt": "one\ntwo\n", "b.txt": "uno\ndos\n" });
    const first = join(dir, "a.txt");
    const { hashLines, ref } = holdRefs(first);
    const { exitCode } = trueline([
      "edit",
      first,
      join(dir, "b.txt"),
      "--ref",
      ref,
      "--range",
      hashLines[0],
      "--content",
      "NEW",
      "--dry-run",
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("--content @@text inserts a literal @text", () => {
    const dir = scratch("at-literal", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const { exitCode } = trueline(["edit", file, "--ref", ref, "--range", hashLines[0], "--content", "@@Override"]);
    expect(readFileSync(file, "utf-8")).toBe("@Override\ntwo\n");
    expect(exitCode).toBe(0);
  });

  test("--content @path with no such file is an error, not a literal", () => {
    const dir = scratch("at-missing", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const { exitCode } = trueline(["edit", file, "--ref", ref, "--range", hashLines[0], "--content", "@Override"]);
    expect(readFileSync(file, "utf-8")).toBe("one\ntwo\n");
    expect(exitCode).toBe(3);
  });
});

describe("content read from stdin or @file", () => {
  test("CRLF stdin into a CRLF file does not produce CR CR LF", () => {
    const dir = scratch("crlf-into-crlf", { "f.txt": "one\r\ntwo\r\nthree\r\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    trueline(["edit", file, "--ref", ref, "--range", `${hashLines[0]}-${hashLines[1]}`, "--content", "-"], {
      input: "X\r\nY\r\n",
    });
    expect(readFileSync(file, "utf-8")).toBe("X\r\nY\r\nthree\r\n");
  });

  test("CRLF @file into an LF file does not inject carriage returns", () => {
    const dir = scratch("crlf-into-lf", { "f.txt": "one\ntwo\nthree\n", "content.txt": "X\r\nY\r\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    trueline([
      "edit",
      file,
      "--ref",
      ref,
      "--range",
      `${hashLines[0]}-${hashLines[1]}`,
      "--content",
      `@${join(dir, "content.txt")}`,
    ]);
    expect(readFileSync(file, "utf-8")).toBe("X\nY\nthree\n");
  });

  test("--edits @file with a UTF-8 BOM parses", () => {
    const dir = scratch("bom-edits", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const editsFile = join(dir, "edits.json");
    writeFileSync(editsFile, `\uFEFF${JSON.stringify([{ ref, range: hashLines[0], content: "NEW" }])}`);
    const { exitCode, stderr } = trueline(["edit", file, "--edits", `@${editsFile}`, "--dry-run"]);
    expect(stderr).not.toContain("invalid JSON");
    expect(exitCode).toBe(0);
  });

  test("--content @file with a UTF-8 BOM does not write U+FEFF into the target", () => {
    const dir = scratch("bom-content", { "f.txt": "one\ntwo\n", "content.txt": "\uFEFFNEW\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    trueline(["edit", file, "--ref", ref, "--range", hashLines[0], "--content", `@${join(dir, "content.txt")}`]);
    expect(readFileSync(file, "utf-8")).toBe("NEW\ntwo\n");
  });

  // The stdin path strips the BOM separately from the @file path.
  test("--content - with a UTF-8 BOM does not write U+FEFF into the target", () => {
    const dir = scratch("bom-stdin-content", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const bom = String.fromCharCode(0xfeff);
    trueline(["edit", file, "--ref", ref, "--range", hashLines[0], "--content", "-"], { input: `${bom}NEW\n` });
    expect(readFileSync(file, "utf-8")).toBe("NEW\ntwo\n");
  });

  test("--edits - with a UTF-8 BOM parses", () => {
    const dir = scratch("bom-stdin-edits", { "f.txt": "one\ntwo\n" });
    const file = join(dir, "f.txt");
    const { hashLines, ref } = holdRefs(file);
    const edits = JSON.stringify([{ ref, range: hashLines[0], content: "NEW" }]);
    const bom = String.fromCharCode(0xfeff);
    const { exitCode, stderr } = trueline(["edit", file, "--edits", "-", "--dry-run"], { input: `${bom}${edits}` });
    expect(stderr).not.toContain("invalid JSON");
    expect(exitCode).toBe(0);
  });
});
