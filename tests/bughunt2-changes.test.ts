import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSymbols, extractSymbols } from "../src/semantic-diff.ts";
import { handleDiff } from "../src/tools/diff.ts";

// Strip inherited GIT_* env vars so fixture repos do not touch the parent worktree.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

let scratch: string[] = [];

function makeRepo(prefix = "trueline-bughunt2-changes-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", env: cleanEnv, encoding: "utf-8" });
  git("init", "-q");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}

async function changes(params: Parameters<typeof handleDiff>[0]) {
  const result = await handleDiff(params);
  return { text: result.content.map((c) => (c as { text: string }).text).join(""), isError: !!result.isError };
}

async function symbolDiff(ext: string, oldSource: string, newSource: string) {
  return diffSymbols(await extractSymbols(oldSource, ext), await extractSymbols(newSource, ext));
}

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

// extractName matches identifiers with `\w`, which is ASCII-only (semantic-diff.ts DECLARED_NAME and
// the method/field fallbacks). Java, Kotlin, Swift, Go, C#, JS, TS and Python all allow Unicode names.
describe("non-ASCII identifiers", () => {
  test("bug: a non-ASCII name is cut at its first non-ASCII letter, so two declarations pair under one name", async () => {
    // `größe` and `grün` both read as `gr`; the removed one is paired with the edited one.
    const diff = await symbolDiff(".ts", "const größe = 5;\nconst grün = 6;\n", "const grün = 7;\n");

    expect(diff.removed.map((s) => s.signature.trim())).toEqual(["const größe = 5;"]);
  });

  test("bug: a function whose name has no ASCII letters is named `def`", async () => {
    const diff = await symbolDiff(".py", "def привет(x):\n    return 1\n", "def привет(x, y):\n    return 1\n");

    expect(diff.signatureChanged.map((s) => s.name)).toEqual(["привет"]);
  });
});

// DECLARED_NAME captures `(\w+)` after the keyword, so a qualified declarator keeps only its first segment:
// `Admin::UsersController` -> `Admin`, `String.shout` -> `String`, `Billing.Invoices` -> `Billing`.
// Renaming the last segment then leaves the identity unchanged: a rename reads as a signature change.
describe("qualified declarator names", () => {
  test.each([
    {
      label: "Ruby `class Admin::UsersController`",
      ext: ".rb",
      oldSource: "class Admin::UsersController < Base\n  def index\n    1\n  end\nend\n",
      newSource: "class Admin::AccountsController < Base\n  def index\n    1\n  end\nend\n",
    },
    {
      label: "Kotlin extension function `fun String.shout()`",
      ext: ".kt",
      oldSource: "fun String.shout(): String {\n    return this.uppercase()\n}\n",
      newSource: "fun String.yell(): String {\n    return this.uppercase()\n}\n",
    },
    {
      label: "Elixir `defmodule Billing.Invoices`",
      ext: ".ex",
      oldSource: "defmodule Billing.Invoices do\n  def total(items) do\n    Enum.sum(items)\n  end\nend\n",
      newSource: "defmodule Billing.Receipts do\n  def total(items) do\n    Enum.sum(items)\n  end\nend\n",
    },
  ])(
    "bug: $label renamed at its last segment is a rename, not a signature change",
    async ({ ext, oldSource, newSource }) => {
      const diff = await symbolDiff(ext, oldSource, newSource);

      expect(diff.renamed).toHaveLength(1);
    },
  );
});

// `typedef struct {` ends before the type name, so the field regex reads the keyword as the name and every
// anonymous typedef in a file shares one identity and one signature.
describe("anonymous C typedefs", () => {
  test("bug: deleting one anonymous typedef struct while editing another reports the edited one as removed", async () => {
    const diff = await symbolDiff(
      ".c",
      "typedef struct {\n  int x;\n} point_t;\n\ntypedef struct {\n  int w;\n  int h;\n} rect_t;\n",
      "typedef struct {\n  int w;\n  int h;\n  int depth;\n} rect_t;\n",
    );

    const removedText = diff.removed.map((s) => s.bodyText).join("\n");
    expect(removedText).toContain("point_t");
    expect(removedText).not.toContain("rect_t");
  });
});

// Operator methods have no identifier before `(`: Ruby's `def ==(o)` is read as `def`, Swift's
// `static func + (lhs: V, rhs: V)` as its first parameter. Every operator of a type collides.
describe("operator method names", () => {
  test.each([
    {
      label: "Ruby `def ==` / `def <=>`",
      ext: ".rb",
      oldSource:
        "class Money\n  def ==(other)\n    amount == other.amount\n  end\n\n  def <=>(other)\n    amount <=> other.amount\n  end\nend\n",
      newSource: "class Money\n  def <=>(other, strict)\n    strict ? amount <=> other.amount : 0\n  end\nend\n",
      removed: "def ==(other)",
    },
    {
      label: "Swift `static func +` / `static func -`",
      ext: ".swift",
      oldSource:
        "struct Vec {\n    static func + (lhs: Vec, rhs: Vec) -> Vec {\n        return Vec(x: lhs.x + rhs.x)\n    }\n\n    static func - (lhs: Vec, rhs: Vec) -> Vec {\n        return Vec(x: lhs.x - rhs.x)\n    }\n}\n",
      newSource:
        "struct Vec {\n    static func - (lhs: Vec, rhs: Vec, clamp: Bool) -> Vec {\n        return Vec(x: max(0, lhs.x - rhs.x))\n    }\n}\n",
      removed: "static func + (lhs: Vec, rhs: Vec) -> Vec {",
    },
  ])(
    "bug: $label: removing one operator while editing the other reports the edited one as removed",
    async ({ ext, oldSource, newSource, removed }) => {
      const diff = await symbolDiff(ext, oldSource, newSource);

      expect(diff.removed.map((s) => s.signature.trim())).toEqual([removed]);
    },
  );
});

// A container's bodyHash covers its members, so any member edit also marks every enclosing symbol as
// logic-changed, and the container's mini-diff repeats the member's.
describe("nested changes", () => {
  // Not fixing this round: a container's bodyHash covers its members by design.
  test.failing("bug: editing a method body reports the method, not also its class", async () => {
    const diff = await symbolDiff(
      ".ts",
      "class Cart {\n  total() {\n    return 1;\n  }\n}\n",
      "class Cart {\n  total() {\n    return 2;\n  }\n}\n",
    );

    expect(diff.logicChanged.map((s) => s.name)).toEqual(["Cart.total"]);
  });
});

// computeMiniDiff compares raw body lines, while the logic-change test hashes whitespace-normalized text.
// A difference the hash ignores (CR, blank lines, indentation) still counts against the 5-line budget.
describe("inline mini-diff", () => {
  const oldSource =
    "function total(items: number[]) {\n  const base = 0;\n  const sum = items.length;\n  return sum + base;\n}\n";

  test("bug: a line-ending conversion plus a one-line edit loses the inline diff", async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, "cart.ts"), oldSource);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(
      join(dir, "cart.ts"),
      "function total(items: number[]) {\r\n  const base = 0;\r\n  const sum = items.length + 1;\r\n  return sum + base;\r\n}\r\n",
    );

    const { text } = await changes({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("-const sum = items.length;");
    expect(text).toContain("+const sum = items.length + 1;");
  });

  test("bug: a blank line added next to a one-line edit is printed as an empty '+' line", async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, "cart.ts"), oldSource);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(
      join(dir, "cart.ts"),
      "function total(items: number[]) {\n  const base = 0;\n\n  const sum = items.length + 1;\n  return sum + base;\n}\n",
    );

    const { text } = await changes({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("+const sum = items.length + 1;");
    expect(text.split("\n")).not.toContain("+");
  });

  // Indentation is the Python logic hash's whole signal: normalizing it away leaves a logic change with no lines.
  test("bug: a Python statement dedented out of an if shows the moved line in the inline diff", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "billing.py");
    writeFileSync(
      file,
      "def charge(order):\n    if order.paid:\n        ship(order)\n        notify(order)\n    return order\n",
    );
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(
      file,
      "def charge(order):\n    if order.paid:\n        ship(order)\n    notify(order)\n    return order\n",
    );

    const { text } = await changes({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    const lines = text.split("\n");
    expect(lines).toContain("-        notify(order)");
    expect(lines).toContain("+    notify(order)");
  });
});

// The Lua grammar's parse result depends on earlier parses in the same process (scanner state survives the
// parser being deleted): the first Lua file parsed is right, later ones lose functions. A diff parses two.
describe("Lua", () => {
  // Known Lua grammar scanner state bug, tracked by the test.failing in tests/outline/languages.test.ts.
  test.failing("bug: adding a function to a Lua file reports it as added and nothing else", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "util.lua");
    const before = "local function helper(a)\n  return a\nend\n\nfunction M.run(x)\n  return x\nend\n";
    writeFileSync(file, before);
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(file, `${before}\nfunction M.other()\n  return 1\nend\n`);

    const { text } = await changes({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("function M.other()");
    expect(text).not.toContain("helper");
  });
});

describe("per-file messages and headers", () => {
  test("bug: a denied file listed by '*' gets an absolute header while every other section is project-relative", async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, "app.ts"), "function app() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "app.ts"), "function app() {\n  return 2;\n}\n");
    writeFileSync(join(dir, ".env"), "TOKEN=1\n");

    const { text } = await changes({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("## app.ts (vs HEAD)");
    expect(text).toContain("## .env\n");
    expect(text).not.toContain(dir);
  });

  test("bug: a directory passed as a path is reported as 'Access denied' instead of not being a file", async () => {
    const { dir, git } = makeRepo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "function app() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const { text } = await changes({ file_paths: [join(dir, "src")], projectDir: dir, allowedDirs: [dir] });

    expect(text).not.toContain("Access denied");
  });
});

describe("'*' expansion failures", () => {
  // Windows CI needs ~46 s to create the files and times out removing them; the fix is
  // platform-independent, so POSIX runs cover it.
  test.skipIf(process.platform === "win32")(
    "bug: git output over the 10 MB buffer makes handleDiff reject instead of returning a result",
    async () => {
      const { dir, git } = makeRepo();
      writeFileSync(join(dir, "app.ts"), "function app() {\n  return 1;\n}\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      writeFileSync(join(dir, "app.ts"), "function app() {\n  return 2;\n}\n");
      // An un-ignored build directory: `git ls-files --others -z` prints ~10.7 MB of names.
      const bulk = join(dir, "d".repeat(250));
      mkdirSync(bulk);
      const stem = "f".repeat(240);
      for (let i = 0; i < 21_500; i++) writeFileSync(join(bulk, `${stem}${String(i).padStart(10, "0")}`), "");

      const outcome = await handleDiff({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] }).then(
        () => "result",
        (err: Error) => `threw: ${err.message}`,
      );

      expect(outcome).toBe("result");
    },
    60_000,
  );
});
