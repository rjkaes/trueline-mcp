import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { handleDiff } from "../../src/tools/diff.ts";
import { writeTestFile } from "../helpers.ts";

let testDir: string;

// Strip inherited GIT_* env vars so git init in temp dirs
// does not pollute the parent worktree's HEAD.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function git(cmd: string) {
  execSync(`git ${cmd}`, { cwd: testDir, stdio: "pipe", env: cleanEnv });
}

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-sdiff-")));
  git("init");
  git("config user.email test@test.com");
  git("config user.name Test");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("semantic trueline_changes", () => {
  test("detects added function", async () => {
    const file = writeTestFile(testDir, "test.ts", "function foo() { return 1; }\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function foo() { return 1; }\nfunction bar() { return 2; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("+:");
    expect(text).toContain("bar");
  });

  test("detects removed function", async () => {
    const file = writeTestFile(testDir, "test.ts", "function foo() { return 1; }\nfunction bar() { return 2; }\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function foo() { return 1; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("-:");
    expect(text).toContain("bar");
  });

  test("detects logic modification", async () => {
    const file = writeTestFile(testDir, "test.ts", "function foo() {\n  return 1;\n}\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function foo() {\n  return 2;\n}\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("foo");
    expect(text).toContain("return");
  });

  test("detects rename via body hash", async () => {
    const file = writeTestFile(testDir, "test.ts", "function oldName() {\n  return 42;\n}\n");
    git("add test.ts");
    git("commit -m init");
    writeFileSync(file, "function newName() {\n  return 42;\n}\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("~:");
    expect(text).toContain("oldName");
    expect(text).toContain("newName");
  });

  test("handles untracked file (all symbols are Added)", async () => {
    const file = writeTestFile(testDir, "new.ts", "function fresh() { return 1; }\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("+:");
    expect(text).toContain("fresh");
  });

  test("reports unsupported file type", async () => {
    const file = writeTestFile(testDir, "data.json", '{"key": "value"}\n');
    git("add data.json");
    git("commit -m init");
    writeFileSync(file, '{"key": "changed"}\n');

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("not supported");
  });

  test("binary file of an unsupported type does not abort other files", async () => {
    const logo = join(testDir, "logo.png");
    const source = writeTestFile(testDir, "invoice.ts", "function total() { return 1; }\n");
    writeFileSync(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    git("add .");
    git("commit -m init");
    writeFileSync(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(source, "function total() { return 1; }\nfunction tax() { return 2; }\n");

    const result = await handleDiff({
      file_paths: [logo, source],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("## logo.png\n\nFile type not supported");
    expect(text).toContain("tax");
  });

  test("binary file of a supported type does not abort other files", async () => {
    const firmware = join(testDir, "firmware.ts");
    const source = writeTestFile(testDir, "invoice.ts", "function total() { return 1; }\n");
    writeFileSync(firmware, Buffer.from("const header = 1;\n\x00\x01\x02\n"));
    git("add .");
    git("commit -m init");
    writeFileSync(firmware, Buffer.from("const header = 2;\n\x00\x01\x03\n"));
    writeFileSync(source, "function total() { return 1; }\nfunction tax() { return 2; }\n");

    const result = await handleDiff({
      file_paths: [firmware, source],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("## firmware.ts\n\nBinary file");
    expect(text).toContain("tax");
  });

  test("headers stay relative when projectDir is a symlinked alias", async () => {
    // Windows reaches the same mismatch via 8.3 names: realpath expands RUNNER~1.
    const alias = `${testDir}-alias`;
    symlinkSync(testDir, alias, "junction");
    try {
      const source = writeTestFile(testDir, "invoice.ts", "function total() { return 1; }\n");
      git("add .");
      git("commit -m init");
      writeFileSync(source, "function total() { return 1; }\nfunction tax() { return 2; }\n");

      const result = await handleDiff({
        file_paths: [join(alias, "invoice.ts")],
        projectDir: alias,
        allowedDirs: [alias],
      });

      expect(result.content[0].text).toContain("## invoice.ts (vs HEAD)");
    } finally {
      rmSync(alias, { force: true });
    }
  });

  test("star expands to all unstaged changed files", async () => {
    const f1 = join(testDir, "a.ts");
    const f2 = join(testDir, "b.ts");
    writeFileSync(f1, "function a() { return 1; }\n");
    writeFileSync(f2, "function b() { return 2; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(f1, "function a() { return 99; }\n");
    writeFileSync(f2, "function b() { return 99; }\n");

    const result = await handleDiff({
      file_paths: ["*"],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
  });

  test("no structural changes returns appropriate message", async () => {
    const file = writeTestFile(testDir, "test.ts", "function foo() {\n  return 1;\n}\n");
    git("add test.ts");
    git("commit -m init");
    // Only whitespace change (collapse mode)
    writeFileSync(file, "function foo() {\n  return   1;\n}\n");

    const result = await handleDiff({
      file_paths: [file],
      projectDir: testDir,
      allowedDirs: [testDir],
    });

    const text = result.content[0].text;
    expect(text).toContain("No structural changes");
  });
});

const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// beforeEach already initialised a fresh repo in testDir.
function makeRepo() {
  return { dir: testDir, git };
}

async function changesText(params: Parameters<typeof handleDiff>[0]): Promise<string> {
  const result = await handleDiff(params).catch((err: Error) => ({ content: [{ text: `THROWN: ${err.message}` }] }));
  return result.content[0].text;
}

describe("trueline_changes git and path edge cases", () => {
  test("same-named methods in two classes are not reported as changed when nothing changed", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(
      dir,
      "models.ts",
      [
        "class Invoice {",
        "  constructor(id: string) {",
        "    this.id = id;",
        "  }",
        "}",
        "",
        "class Receipt {",
        "  constructor(id: string, total: number) {",
        "    this.id = id;",
        "    this.total = total;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    git("add .");
    git("commit -m init");
    writeFileSync(file, `${readFileSync(file, "utf-8")}\nfunction unrelated() {\n  return 1;\n}\n`);

    const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("unrelated");
    expect(text).not.toContain("constructor");
  });

  test("compare_against cannot inject git options: '*' expansion", async () => {
    const { dir, git } = makeRepo();
    writeTestFile(dir, "a.ts", "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");
    const outside = scratchDir("trueline-changes-outside-");

    await changesText({
      file_paths: ["*"],
      projectDir: dir,
      allowedDirs: [dir],
      compare_against: `--output=${join(outside, "pwned.txt")}`,
    });

    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  test("compare_against cannot inject git options: explicit file", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(dir, "a.ts", "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");
    const outside = scratchDir("trueline-changes-outside-");

    await changesText({
      file_paths: [file],
      projectDir: dir,
      allowedDirs: [dir],
      compare_against: `--output=${join(outside, "pwned")}`,
    });

    expect(readdirSync(outside)).toEqual([]);
  });

  test("an unknown ref is not treated as an empty baseline: explicit file", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(dir, "a.ts", "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");

    const text = await changesText({
      file_paths: [file],
      projectDir: dir,
      allowedDirs: [dir],
      compare_against: "no-such-branch",
    });

    expect(text).not.toContain("+:");
  });

  test("an unknown ref is not reported as 'no changed files': '*'", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(dir, "a.ts", "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function a() { return 2; }\n");

    const text = await changesText({
      file_paths: ["*"],
      projectDir: dir,
      allowedDirs: [dir],
      compare_against: "no-such-branch",
    });

    expect(text).not.toContain("No changed files found");
  });

  test("'*' resolves changed files when projectDir is a repo subdirectory", async () => {
    const { dir, git } = makeRepo();
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    const file = writeTestFile(pkg, "a.ts", "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function a() { return 2; }\nfunction b() { return 3; }\n");

    const text = await changesText({ file_paths: ["*"], projectDir: pkg, allowedDirs: [pkg] });

    expect(text).toContain("## a.ts (vs HEAD)");
  });

  test("'*' reports the symbols of a deleted file as removed", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(dir, "gone.ts", "function gone() { return 1; }\n");
    git("add .");
    git("commit -m init");
    rmSync(file);

    const text = await changesText({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("-:");
    expect(text).toContain("function gone");
  });

  test("'*' does not report a pure rename as all symbols added", async () => {
    const { dir, git } = makeRepo();
    writeTestFile(dir, "old.ts", "function keep() { return 1; }\nfunction other() { return 2; }\n");
    git("add .");
    git("commit -m init");
    git("mv old.ts new.ts");

    const text = await changesText({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).not.toContain("+:");
  });

  test("'*' handles a changed file with non-ASCII characters in its name", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(dir, "café.ts", "function a() { return 1; }\n");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function a() { return 2; }\n");

    const text = await changesText({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).not.toContain("Access denied");
    expect(text).toContain("return 2");
  });

  test("file extension match is case-insensitive, as in trueline_outline", async () => {
    const { dir } = makeRepo();
    const file = writeTestFile(dir, "Upper.TS", "function upper() { return 1; }\n");

    const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).not.toContain("not supported");
  });

  test("a UTF-8 BOM on the committed copy is not a structural change", async () => {
    const { dir, git } = makeRepo();
    const bom = String.fromCharCode(0xfeff);
    // Python keeps leading whitespace in body hashes, so a BOM is not trimmed away.
    const file = writeTestFile(dir, "bom.py", `${bom}def first(): return 1\ndef second(): return 2\n`);
    git("add .");
    git("commit -m init");
    writeFileSync(file, "def first(): return 1\ndef second(): return 3\n");

    const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("second");
    expect(text).not.toContain("first");
  });

  test("'*' lists only changed files under projectDir", async () => {
    const { dir, git } = makeRepo();
    const pkg = join(dir, "pkg");
    const empty = join(dir, "empty");
    mkdirSync(pkg);
    mkdirSync(empty);
    const file = writeTestFile(pkg, "a.ts", "function a() { return 1; }\n");
    const outside = writeTestFile(dir, "root.ts", "function root() { return 1; }\n");
    writeTestFile(empty, ".gitkeep", "");
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function a() { return 2; }\n");
    writeFileSync(outside, "function root() { return 2; }\n");
    writeTestFile(dir, "fresh.ts", "function fresh() { return 1; }\n");

    const inPkg = await changesText({ file_paths: ["*"], projectDir: pkg, allowedDirs: [pkg] });
    const inEmpty = await changesText({ file_paths: ["*"], projectDir: empty, allowedDirs: [empty] });

    expect(inPkg).toContain("## a.ts (vs HEAD)");
    expect(inPkg).not.toContain("root");
    expect(inPkg).not.toContain("fresh");
    expect(inPkg).not.toContain("Access denied");
    expect(inEmpty).toBe("No changed files found.");
  });

  test("a deleted file matching a Read deny pattern is refused", async () => {
    const { dir, git } = makeRepo();
    mkdirSync(join(dir, ".claude"));
    writeTestFile(
      join(dir, ".claude"),
      "settings.json",
      JSON.stringify({ permissions: { deny: ["Read(**/vault.ts)"] } }),
    );
    const file = writeTestFile(dir, "vault.ts", "function unseal() { return 1; }\n");
    git("add .");
    git("commit -m init");
    rmSync(file);

    const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("Access denied");
    expect(text).not.toContain("unseal");
  });

  test("a deleted file outside allowedDirs is refused", async () => {
    const { dir, git } = makeRepo();
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    const sibling = writeTestFile(dir, "sibling.ts", "function sibling() { return 1; }\n");
    writeTestFile(pkg, "keep.ts", "function keep() { return 1; }\n");
    git("add .");
    git("commit -m init");
    rmSync(sibling);

    const text = await changesText({ file_paths: [sibling], projectDir: pkg, allowedDirs: [pkg] });

    expect(text).toContain("Access denied");
    expect(text).not.toContain("function sibling");
  });

  // A deny rule that names the symlink (`vault/**`) must hold once the target is gone,
  // as it does while the file exists (validatePath checks the pre-symlink path too).
  test("a deleted file reached through a symlink matching a Read deny pattern is refused", async () => {
    const { dir, git } = makeRepo();
    mkdirSync(join(dir, ".claude"));
    writeTestFile(
      join(dir, ".claude"),
      "settings.json",
      JSON.stringify({ permissions: { deny: ["Read(**/vault/**)"] } }),
    );
    mkdirSync(join(dir, "data"));
    const file = writeTestFile(join(dir, "data"), "gone.ts", "function unseal() { return 1; }\n");
    git("add .");
    git("commit -m init");
    symlinkSync("data", join(dir, "vault"));
    rmSync(file);

    const text = await changesText({
      file_paths: [join(dir, "vault", "gone.ts")],
      projectDir: dir,
      allowedDirs: [dir],
    });

    expect(text).toContain("Access denied");
    expect(text).not.toContain("unseal");
  });

  test("'*' lists staged and untracked files in a repo with no commits", async () => {
    const { dir, git } = makeRepo();
    writeTestFile(dir, "staged.ts", "function staged() { return 1; }\n");
    git("add staged.ts");
    writeTestFile(dir, "loose.ts", "function loose() { return 1; }\n");

    const text = await changesText({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("function staged");
    expect(text).toContain("function loose");
  });

  // `git show <ref>:<path>` prints the commit itself when the path is glob-ish, exiting 0.
  test("a glob-like path absent from disk and from the ref is not diffed against the commit", async () => {
    const { dir, git } = makeRepo();
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    writeTestFile(pkg, "zzone.ts", "function zzone() { return 1; }\n");
    git("add .");
    git("commit -m init");

    const text = await changesText({ file_paths: [join(pkg, "zz*.ts")], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("File not found");
    expect(text).not.toContain("-:");
  });

  test("an untracked file with a bracketed name reports all its symbols as added", async () => {
    const { dir, git } = makeRepo();
    writeTestFile(dir, "seed.ts", "function seed() { return 1; }\n");
    git("add .");
    git("commit -m init");
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    const file = writeTestFile(pkg, "[id].ts", "function routeId() { return 1; }\n");

    const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("+:");
    expect(text).toContain("function routeId");
    expect(text).not.toContain("-:");
  });

  // NTFS forbids ":" in file names.
  test.skipIf(process.platform === "win32")(
    "a committed file whose name starts with a colon is still diffed against its commit",
    async () => {
      const { dir, git } = makeRepo();
      const file = writeTestFile(dir, ":odd.ts", "function odd() { return 1; }\nfunction even() { return 2; }\n");
      git("add .");
      git("commit -m init");
      writeFileSync(file, "function odd() { return 1; }\nfunction even() { return 3; }\n");

      const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

      expect(text).toContain("even");
      expect(text).not.toContain("+:");
    },
  );

  test("a committed file over the git output limit is an error, not an empty baseline", async () => {
    const { dir, git } = makeRepo();
    const file = writeTestFile(dir, "big.ts", `${"// padding\n".repeat(1_000_000)}function big() { return 1; }\n`);
    git("add .");
    git("commit -m init");
    writeFileSync(file, "function big() { return 2; }\n");

    const text = await changesText({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("Could not read");
    expect(text).not.toContain("+:");
  });

  test("a rename out of a Read-denied directory does not leak the old content", async () => {
    const { dir, git } = makeRepo();
    mkdirSync(join(dir, ".claude"));
    writeTestFile(
      join(dir, ".claude"),
      "settings.json",
      JSON.stringify({ permissions: { deny: ["Read(**/vault/**)"] } }),
    );
    mkdirSync(join(dir, "vault"));
    const source = (token: string) =>
      [
        "function unseal() {",
        `  const key = "${token}";`,
        "  return key;",
        "}",
        "function other() {",
        "  return 2;",
        "}",
        "",
      ].join("\n");
    writeTestFile(join(dir, "vault"), "keys.ts", source("alpha-secret"));
    git("add .");
    git("commit -m init");
    mkdirSync(join(dir, "pkg"));
    git("mv vault/keys.ts pkg/keys.ts");
    writeFileSync(join(dir, "pkg", "keys.ts"), source("beta-public"));

    const text = await changesText({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("pkg/keys.ts");
    expect(text).not.toContain("alpha-secret");
  });
});
