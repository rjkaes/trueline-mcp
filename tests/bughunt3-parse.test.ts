import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBinaryError } from "../src/encoding.ts";
import { displayPath, expandGlobs } from "../src/tools/shared.ts";
import { makeGitRepo, useTestDir } from "./helpers.ts";

describe("isBinaryError", () => {
  // src/encoding.ts:61 — isBinaryError matched "binary" anywhere in the message, so an fs error naming a path with "binary" was reported as a binary file
  test("an EACCES error for a path containing 'binary' is not a binary-file error", () => {
    const fromLineSplitter = new Error("File appears to be binary (contains null bytes)");
    expect(isBinaryError(fromLineSplitter)).toBe(true);

    const permissionDenied = Object.assign(
      new Error("EACCES: permission denied, open '/srv/exports/binary-blobs/q3-report.csv'"),
      { code: "EACCES" },
    );
    expect(isBinaryError(permissionDenied)).toBe(false);
  });
});

describe("displayPath", () => {
  // src/tools/shared.ts:566 — every backslash becomes "/" even on POSIX, where it is a filename character, so the header names a different file
  test.skipIf(process.platform === "win32")("keeps a backslash in a POSIX file name", () => {
    expect(displayPath("/work/app/reports\\q3.txt", "/work/app")).toBe("reports\\q3.txt");
  });
});

describe("expandGlobs", () => {
  const plainDir = useTestDir("trueline-bh3-glob-");
  const repoDirs: string[] = [];

  afterEach(() => {
    for (const dir of repoDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // src/tools/shared.ts:504-510 — `git ls-files --cached` keeps tracked files deleted from the working tree, so a recursive glob lists a file that no longer exists
  test("a recursive glob does not list a tracked file deleted from the working tree", async () => {
    const { dir, git } = makeGitRepo("trueline-bh3-deleted-");
    repoDirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "kept.ts"), "export const kept = 1;\n");
    writeFileSync(join(dir, "src", "removed.ts"), "export const removed = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    rmSync(join(dir, "src", "removed.ts"));

    expect(await expandGlobs(["**/*.ts"], dir)).toEqual(["src/kept.ts"]);
  });

  // src/tools/shared.ts:512-523 — the Node-glob branches return directories, while the git-backed recursive branch returns files only
  test.each<{ pattern: string; expected: string[] }>([
    { pattern: "src/*", expected: ["src/orders.ts"] },
    { pattern: "**/*", expected: ["src/orders.ts", "src/sub/invoices.ts"] },
  ])("glob $pattern outside a git repo lists files, not directories", async ({ pattern, expected }) => {
    const dir = plainDir();
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    writeFileSync(join(dir, "src", "orders.ts"), "export const orders = 1;\n");
    writeFileSync(join(dir, "src", "sub", "invoices.ts"), "export const invoices = 2;\n");

    expect(await expandGlobs([pattern], dir)).toEqual(expected);
  });

  // src/tools/shared.ts:411-414,490-492 — splitGlob leaves "[staging]" in the pattern, so the literal prefix is the project's parent, which no allowed root contains; the glob silently matches nothing
  test("an absolute glob expands when the project directory name contains brackets", async () => {
    const dir = join(plainDir(), "client [staging]");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "orders.ts"), "export const orders = 1;\n");

    // expandGlobs returns forward slashes on Windows.
    expect(await expandGlobs([join(dir, "src", "*.ts")], dir)).toEqual([
      join(dir, "src", "orders.ts").replaceAll("\\", "/"),
    ]);
  });

  // src/tools/shared.ts:504-510,551-557 — a project directory a parent repo ignores makes `git ls-files` print nothing, and that empty list is taken as the answer
  test("a recursive glob finds files when a parent repo gitignores the project directory", async () => {
    const { dir: parent } = makeGitRepo("trueline-bh3-parent-");
    repoDirs.push(parent);
    writeFileSync(join(parent, ".gitignore"), "scratch/\n");
    const project = join(parent, "scratch");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "orders.ts"), "export const orders = 1;\n");

    expect(await expandGlobs(["**/*.ts"], project)).toEqual(["src/orders.ts"]);
  });
});
