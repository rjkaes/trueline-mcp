import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSymbols, extractSymbols } from "../src/semantic-diff.ts";
import { handleDiff } from "../src/tools/diff.ts";
import { run } from "./cli/helpers.ts";
import { cleanEnv, makeGitRepo } from "./helpers.ts";

let scratch: string[] = [];

function makeRepo(prefix = "trueline-bughunt-changes-") {
  const repo = makeGitRepo(prefix);
  scratch.push(repo.dir);
  return repo;
}

async function changes(params: Parameters<typeof handleDiff>[0]) {
  const result = await handleDiff(params);
  return { text: result.content.map((c) => (c as { text: string }).text).join(""), isError: !!result.isError };
}

beforeEach(() => {
  scratch = [];
});

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("compare_against ':0' is advertised for staged content (server.ts changes schema)", () => {
  test("':0' diffs an explicit file against its staged copy instead of failing as 'not a commit'", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "billing.ts");
    writeFileSync(file, "function charge() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(file, "function charge() {\n  return 2;\n}\n");
    git("add", ".");
    writeFileSync(file, "function charge() {\n  return 2;\n}\nfunction refund() {\n  return 3;\n}\n");

    const { text, isError } = await changes({
      file_paths: [file],
      compare_against: ":0",
      projectDir: dir,
      allowedDirs: [dir],
    });

    expect(text).not.toContain("is not a commit");
    expect(isError).toBe(false);
    expect(text).toContain("function refund");
    expect(text).not.toContain("return 1");
  });

  test("':0' with '*' lists files changed since the index instead of failing as 'not a commit'", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "billing.ts");
    writeFileSync(file, "function charge() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(file, "function charge() {\n  return 1;\n}\nfunction refund() {\n  return 3;\n}\n");

    const { text, isError } = await changes({
      file_paths: ["*"],
      compare_against: ":0",
      projectDir: dir,
      allowedDirs: [dir],
    });

    expect(text).not.toContain("is not a commit");
    expect(isError).toBe(false);
    expect(text).toContain("billing.ts");
  });
});

describe("extractName: a keyword followed by another keyword, a type, or a qualifier is not the name", () => {
  // Each case removes nothing, adds one symbol before an existing one, and changes the
  // existing one's first line. With a shared bogus name the two pair in document order.
  test.each([
    {
      label: "C function with a const parameter (`const char` -> `char`)",
      ext: ".c",
      oldSource: "int parse(const char *s) {\n  return 0;\n}\n",
      newSource: "int count(const char *s) {\n  return 1;\n}\nint parse(const char *s, int n) {\n  return 0;\n}\n",
      added: "int count(const char *s) {",
      modified: "int parse(const char *s, int n) {",
    },
    {
      label: "Kotlin `const val` -> `val`",
      ext: ".kt",
      oldSource: "const val TIMEOUT = 30\n",
      newSource: "const val RETRIES = 3\nconst val TIMEOUT = 60\n",
      added: "const val RETRIES = 3",
      modified: "const val TIMEOUT = 60",
    },
    {
      label: "Kotlin `enum class` -> `class`",
      ext: ".kt",
      oldSource: "enum class Color {\n  RED\n}\n",
      newSource: "enum class Size {\n  SMALL\n}\nenum class Color(val rgb: Int) {\n  RED\n}\n",
      added: "enum class Size {",
      modified: "enum class Color(val rgb: Int) {",
    },
    {
      label: "C++ `enum class` -> `class`",
      ext: ".cpp",
      oldSource: "enum class Color {\n  Red,\n};\n",
      newSource: "enum class Size {\n  Small,\n};\nenum class Color : int {\n  Red,\n};\n",
      added: "enum class Size {",
      modified: "enum class Color : int {",
    },
    {
      label: "Rust `const fn` -> `fn`",
      ext: ".rs",
      oldSource: "pub const fn max_len() -> usize {\n    8\n}\n",
      newSource:
        "pub const fn min_len() -> usize {\n    1\n}\npub const fn max_len(extra: usize) -> usize {\n    8\n}\n",
      added: "pub const fn min_len() -> usize {",
      modified: "pub const fn max_len(extra: usize) -> usize {",
    },
    {
      label: "Swift `class func` -> `func`",
      ext: ".swift",
      oldSource: "class Factory {\n  class func make() -> Int {\n    return 1\n  }\n}\n",
      newSource:
        "class Factory {\n  class func reset() -> Int {\n    return 0\n  }\n  class func make(size: Int) -> Int {\n    return 1\n  }\n}\n",
      added: "class func reset() -> Int {",
      modified: "class func make(size: Int) -> Int {",
    },
    {
      label: "Ruby `def self.find` -> `self`",
      ext: ".rb",
      oldSource: "class User\n  def self.find(id)\n    1\n  end\nend\n",
      newSource: "class User\n  def self.where(q)\n    3\n  end\n  def self.find(id, scope)\n    1\n  end\nend\n",
      added: "def self.where(q)",
      modified: "def self.find(id, scope)",
    },
    {
      label: "C function returning `const char *` (`const char` -> `char`)",
      ext: ".c",
      oldSource: 'static const char *label(void) {\n  return "a";\n}\n',
      newSource:
        'static const char *title(void) {\n  return "t";\n}\nstatic const char *label(int n) {\n  return "a";\n}\n',
      added: "static const char *title(void) {",
      modified: "static const char *label(int n) {",
    },
    {
      label: "C++ function returning `const std::string&` (`const std` -> `std`)",
      ext: ".cpp",
      oldSource: "const std::string& name() const {\n  return s;\n}\n",
      newSource:
        "const std::string& title() const {\n  return t;\n}\nconst std::string& name(int n) const {\n  return s;\n}\n",
      added: "const std::string& title() const {",
      modified: "const std::string& name(int n) const {",
    },
    {
      label: "C++ function returning `const Foo*` (`const Foo` -> `Foo`)",
      ext: ".cpp",
      oldSource: "const Foo* lookup(int id) {\n  return nullptr;\n}\n",
      newSource:
        "const Foo* find(int id) {\n  return nullptr;\n}\nconst Foo* lookup(int id, int flags) {\n  return nullptr;\n}\n",
      added: "const Foo* find(int id) {",
      modified: "const Foo* lookup(int id, int flags) {",
    },
    {
      label: "Rust `const MAX: u32` keeps the name after `const` (control: no C-family rule)",
      ext: ".rs",
      oldSource: "const MAX: u32 = 5;\n",
      newSource: "const MIN: u32 = 1;\nconst MAX: u32 = 6;\n",
      added: "const MIN: u32 = 1;",
      modified: "const MAX: u32 = 6;",
    },
    {
      label: "JS `const handler = (...) =>` keeps the name after `const` (control: no C-family rule)",
      ext: ".js",
      oldSource: "const handler = (req) => {\n  return 1;\n};\n",
      newSource: "const parser = (req) => {\n  return 0;\n};\nconst handler = (req, res) => {\n  return 1;\n};\n",
      added: "const parser = (req) => {",
      modified: "const handler = (req, res) => {",
    },
    {
      label: "TS `const MAX` keeps the name after `const` (control: no C-family rule)",
      ext: ".ts",
      oldSource: "export const MAX = 5;\n",
      newSource: "export const MIN = 1;\nexport const MAX = 6;\n",
      added: "export const MIN = 1;",
      modified: "export const MAX = 6;",
    },
  ])(
    "$label: the added symbol is reported as added, not as the other's new signature",
    async ({ ext, oldSource, newSource, added, modified }) => {
      const diff = diffSymbols(await extractSymbols(oldSource, ext), await extractSymbols(newSource, ext));

      expect(diff.added.map((s) => s.signature.trim())).toEqual([added]);
      expect(diff.signatureChanged.map((s) => s.newSig.trim())).toEqual([modified]);
    },
  );

  test("Kotlin backtick-named tests are not all named `fun`: removing one and adding another is not a signature change", async () => {
    const diff = diffSymbols(
      await extractSymbols(
        "class CartTest {\n  fun `adds item`() {\n    check(1)\n  }\n  fun `removes item`() {\n    check(2)\n  }\n}\n",
        ".kt",
      ),
      await extractSymbols(
        "class CartTest {\n  fun `removes item`() {\n    check(2)\n  }\n  fun `clears cart`() {\n    check(3)\n  }\n}\n",
        ".kt",
      ),
    );

    expect(diff.removed.map((s) => s.signature.trim())).toEqual(["fun `adds item`() {"]);
    expect(diff.added.map((s) => s.signature.trim())).toEqual(["fun `clears cart`() {"]);
  });
});

describe("normalizeBody preserve-indent", () => {
  test("aligning a Python assignment with extra spaces on both sides of `=` is not a logic change", async () => {
    const diff = diffSymbols(
      await extractSymbols("def f(price):\n    total = price\n    return total\n", ".py"),
      await extractSymbols("def f(price):\n    total  =  price\n    return total\n", ".py"),
    );

    expect(diff.logicChanged.map((s) => s.name)).toEqual([]);
  });
});

describe("signature vs body classification", () => {
  test("a body-only edit to a one-line function is not a signature change", async () => {
    const diff = diffSymbols(
      await extractSymbols("function rate() { return 1; }\n", ".ts"),
      await extractSymbols("function rate() { return 2; }\n", ".ts"),
    );

    expect(diff.signatureChanged.map((s) => s.name)).toEqual([]);
  });

  test("a parameter-type edit in a wrapped signature is not a logic change", async () => {
    const diff = diffSymbols(
      await extractSymbols(
        "function charge(\n  amount: number,\n  currency: string,\n): void {\n  send(amount, currency);\n}\n",
        ".ts",
      ),
      await extractSymbols(
        "function charge(\n  amount: bigint,\n  currency: string,\n): void {\n  send(amount, currency);\n}\n",
        ".ts",
      ),
    );

    expect(diff.signatureChanged.map((s) => s.name)).toEqual(["charge"]);
    expect(diff.logicChanged.map((s) => s.name)).toEqual([]);
  });
});

describe("symbol pairing", () => {
  test("a method moved between two classes is not reported as a rename to its own name", async () => {
    const diff = diffSymbols(
      await extractSymbols("class A {\n  run() {\n    return 1;\n  }\n}\nclass B {\n}\n", ".ts"),
      await extractSymbols("class A {\n}\nclass B {\n  run() {\n    return 1;\n  }\n}\n", ".ts"),
    );

    expect(diff.renamed.filter((r) => r.oldName === r.newName)).toEqual([]);
  });

  test("adding a second Go init() before an unchanged one does not report the old one as logic-changed", async () => {
    const diff = diffSymbols(
      await extractSymbols("package p\nfunc init() {\n\tsetupA()\n}\n", ".go"),
      await extractSymbols("package p\nfunc init() {\n\tsetupB()\n}\nfunc init() {\n\tsetupA()\n}\n", ".go"),
    );

    expect(diff.logicChanged.map((s) => s.name)).toEqual([]);
    expect(diff.added.length).toBe(1);
  });

  test("a rename that also changes a parameter type still reports the new signature", async () => {
    const { dir, git } = makeRepo();
    const file = join(dir, "parse.ts");
    writeFileSync(file, "function parse(input: number) {\n  return input;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(file, "function load(input: string) {\n  return input;\n}\n");

    const { text } = await changes({ file_paths: [file], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("load");
    expect(text).toContain("input: string");
  });
});

describe("renames", () => {
  test("an explicit path to a git-mv'd file is not reported as all symbols added ('*' pairs it with its old path)", async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, "old.ts"), "function keep() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    git("mv", "old.ts", "new.ts");

    const star = await changes({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });
    const explicit = await changes({ file_paths: [join(dir, "new.ts")], projectDir: dir, allowedDirs: [dir] });

    expect(star.text).not.toContain("+:");
    expect(explicit.text).not.toContain("+:");
  });
});

describe("'*' expansion lists only files", () => {
  test("an untracked nested git repository is not reported as an access-denied file", async () => {
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, "app.ts"), "function app() {\n  return 1;\n}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "app.ts"), "function app() {\n  return 2;\n}\n");
    const vendor = join(dir, "vendor");
    mkdirSync(vendor);
    execFileSync("git", ["init", "-q"], { cwd: vendor, stdio: "pipe", env: cleanEnv });
    writeFileSync(join(vendor, "lib.ts"), "function lib() {}\n");

    const { text } = await changes({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).toContain("## app.ts (vs HEAD)");
    expect(text).not.toContain("Access denied");
  });

  test("a dirty submodule is not reported as an access-denied file", async () => {
    const dep = makeRepo("trueline-bughunt-dep-");
    writeFileSync(join(dep.dir, "lib.ts"), "function lib() {\n  return 1;\n}\n");
    dep.git("add", ".");
    dep.git("commit", "-q", "-m", "dep");
    const { dir, git } = makeRepo();
    writeFileSync(join(dir, "app.ts"), "function app() {\n  return 1;\n}\n");
    git("add", ".");
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", dep.dir, "dep");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "dep", "lib.ts"), "function lib() {\n  return 2;\n}\n");

    const { text } = await changes({ file_paths: ["*"], projectDir: dir, allowedDirs: [dir] });

    expect(text).not.toContain("Access denied");
  });
});

describe("cli changes", () => {
  test("a missing project directory yields a result, not a crash from an unawaited realpath rejection", () => {
    const allowed = realpathSync(mkdtempSync(join(tmpdir(), "trueline-bughunt-cli-")));
    scratch.push(allowed);
    const file = join(allowed, "x.ts");
    writeFileSync(file, "function x() {}\n");

    // `trueline outline`/`read` with the same env exit 2 with "Project directory not found or inaccessible".
    const { stderr, exitCode } = run(allowed, { CLAUDE_PROJECT_DIR: join(allowed, "gone") }, "changes", file);

    expect(stderr).not.toContain("ENOENT");
    expect([0, 2]).toContain(exitCode);
  });
});

async function symbolDiff(ext: string, oldSource: string, newSource: string) {
  return diffSymbols(await extractSymbols(oldSource, ext), await extractSymbols(newSource, ext));
}

describe("signature/body split follows the body node, not a text heuristic", () => {
  test.each([
    {
      label: "object type inside a generic return type",
      oldSource: "function load(): Promise<{ ok: boolean }> {\n  return fetchIt();\n}\n",
      newSource: "function load(): Promise<{ ok: boolean; id: string }> {\n  return fetchIt();\n}\n",
    },
    {
      label: "object type as the return type",
      oldSource: "function load(): { a: number } {\n  return fetchIt();\n}\n",
      newSource: "function load(): { a: number; b: string } {\n  return fetchIt();\n}\n",
    },
    {
      label: "object type in a generic constraint",
      oldSource: "function load<T extends { id: number }>(x: T) {\n  return fetchIt();\n}\n",
      newSource: "function load<T extends { id: number; tag: string }>(x: T) {\n  return fetchIt();\n}\n",
    },
  ])("$label: editing it is a signature change, not a logic change", async ({ oldSource, newSource }) => {
    const diff = await symbolDiff(".ts", oldSource, newSource);

    expect(diff.signatureChanged.map((s) => s.name)).toEqual(["load"]);
    expect(diff.logicChanged.map((s) => s.name)).toEqual([]);
  });

  test("a comment edited inside a wrapped signature is neither a signature nor a logic change", async () => {
    const diff = await symbolDiff(
      ".ts",
      "function charge(\n  amount: number,\n): void {\n  send(amount);\n}\n",
      "function charge(\n  amount: number, // in cents\n): void {\n  send(amount);\n}\n",
    );

    expect(diff.signatureChanged).toEqual([]);
    expect(diff.logicChanged).toEqual([]);
  });

  test("a multi-line decorator does not stop a renamed function from pairing", async () => {
    const diff = await symbolDiff(
      ".py",
      "@app.route(\n    '/x',\n)\ndef a():\n    return 1\n",
      "@app.route(\n    '/x',\n)\ndef b():\n    return 1\n",
    );

    expect(diff.renamed).toEqual([{ oldName: "a", newName: "b" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("empty bodies carry no identity", () => {
  test.each([
    {
      label: "empty TS classes",
      ext: ".ts",
      oldSource: "class NotFoundError extends Error {}\n",
      newSource: "class ConflictError extends Error {}\n",
    },
    {
      label: "empty Rust impls",
      ext: ".rs",
      oldSource: "impl Copy for A {}\n",
      newSource: "impl Clone for B {}\n",
    },
    {
      label: "empty functions",
      ext: ".ts",
      oldSource: "function a() {}\n",
      newSource: "function b() {}\n",
    },
    {
      label: "empty multi-line functions",
      ext: ".ts",
      oldSource: "function a() {\n}\n",
      newSource: "function b() {\n}\n",
    },
  ])("$label with different names are removed and added, not renamed", async ({ ext, oldSource, newSource }) => {
    const diff = await symbolDiff(ext, oldSource, newSource);

    expect(diff.renamed).toEqual([]);
    expect(diff.removed.length).toBe(1);
    expect(diff.added.length).toBe(1);
  });
});

describe("names survive long decorators", () => {
  const component = (extra: string) =>
    `@Component({\n  selector: 'app-hero-detail',\n  templateUrl: './hero-detail.component.html',\n  styleUrls: ['./hero-detail.component.css', './hero-detail.theme.css'],\n  changeDetection: ChangeDetectionStrategy.OnPush,${extra}\n})\nexport class HeroDetailComponent {\n  run() {\n    return 1;\n  }\n}\n`;

  test("adding a decorator property to a long @Component is a signature change of the class", async () => {
    const symbols = await extractSymbols(component(""), ".ts");
    const diff = await symbolDiff(".ts", component(""), component("\n  standalone: true,"));

    expect(symbols.map((s) => s.name)).toEqual(["HeroDetailComponent", "run"]);
    expect(diff.renamed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.signatureChanged.map((s) => s.name)).toEqual(["HeroDetailComponent"]);
    expect(diff.logicChanged).toEqual([]);
  });
});

describe("member names", () => {
  test.each([
    {
      label: "TS optional readonly properties",
      ext: ".ts",
      source: "interface Opts {\n  readonly host?: string;\n  readonly port?: number;\n}\n",
      names: ["Opts", "host", "port"],
    },
    {
      label: "TS function-typed property",
      ext: ".ts",
      source: "interface Handlers {\n  cb: (e: Event) => void;\n}\n",
      names: ["Handlers", "cb"],
    },
    {
      label: "TS optional generic method signature",
      ext: ".ts",
      source: "interface Api {\n  m?<T>(x: T): void;\n}\n",
      names: ["Api", "m"],
    },
    {
      label: "TS quoted property",
      ext: ".ts",
      source: 'interface Headers {\n  "content-type": string;\n}\n',
      names: ["Headers", "content-type"],
    },
    {
      label: "Swift failable initializer",
      ext: ".swift",
      source: "struct Color {\n  init?(rawValue: Int) {\n    return nil\n  }\n}\n",
      names: ["Color", "init"],
    },
    {
      label: "C++ operators",
      ext: ".cpp",
      source:
        "struct P {\n  bool operator==(const P& o) const {\n    return true;\n  }\n  bool operator<(const P& o) const {\n    return false;\n  }\n  bool operator()(int a) const { return true; }\n};\n",
      names: ["P", "operator==", "operator<", "operator()"],
    },
    {
      label: "C function-pointer declarations",
      ext: ".c",
      source: "typedef void (*handler)(int);\nvoid (*table[4])(int);\n",
      names: ["handler", "table"],
    },
    {
      label: "C function returning a function pointer, and a pointer variable with an initializer",
      ext: ".c",
      source: "static int (*pick(int n))(int) {\n  return 0;\n}\nstatic void (*hook)(int) = NULL;\n",
      names: ["pick", "hook"],
    },
    {
      label: "Ruby call with a splat argument (not a function pointer)",
      ext: ".rb",
      source: "Bundler.require(*Rails.groups)\n",
      names: ["require"],
    },
    {
      label: "C function with `operator` inside its name",
      ext: ".c",
      source: "int is_operator_char(int c) {\n  return c;\n}\nint operator_precedence(int op) {\n  return op;\n}\n",
      names: ["is_operator_char", "operator_precedence"],
    },
    {
      label: "Java method starting with `operator`",
      ext: ".java",
      source: "class Calc {\n  int operatorPrecedence(int op) {\n    return op;\n  }\n}\n",
      names: ["Calc", "operatorPrecedence"],
    },
    {
      label: "C++ qualified function starting with `operator`",
      ext: ".cpp",
      source: "int Foo::operatorName(int a) {\n  return a;\n}\n",
      names: ["Foo::operatorName"],
    },
  ])("$label are named by their identifier", async ({ ext, source, names }) => {
    expect((await extractSymbols(source, ext)).map((s) => s.name)).toEqual([...names]);
  });

  test("removing one of two optional readonly members reports that member", async () => {
    const diff = await symbolDiff(
      ".ts",
      "interface Opts {\n  readonly host?: string;\n  readonly port?: number;\n}\n",
      "interface Opts {\n  readonly port?: number;\n}\n",
    );

    expect(diff.removed.map((s) => s.signature.trim())).toEqual(["readonly host?: string;"]);
  });

  test("a generic impl renamed keeps its generics without a spurious signature change", async () => {
    const diff = await symbolDiff(
      ".rs",
      "impl<T> Foo<T> {\n    fn run() {\n        1;\n    }\n}\n",
      "impl<T> Bar<T> {\n    fn run() {\n        1;\n    }\n}\n",
    );

    expect(diff.renamed.length).toBe(1);
    expect(diff.signatureChanged).toEqual([]);
  });
});

describe("a node with no body node splits at its first brace, like a plain statement", () => {
  test.each([
    {
      label: "describe block",
      oldSource: 'describe("thing", () => {\n  it("works", () => {\n    expect(1).toBe(1);\n  });\n});\n',
      newSource: 'describe("thing", () => {\n  it("works", () => {\n    expect(1).toBe(2);\n  });\n});\n',
    },
    {
      label: "schema initializer",
      oldSource: "const user = z.object({\n  name: z.string(),\n});\n",
      newSource: "const user = z.object({\n  name: z.number(),\n});\n",
    },
    {
      label: "slice factory",
      oldSource: 'export const cart = createSlice({\n  name: "cart",\n  initialState: [],\n});\n',
      newSource: 'export const cart = createSlice({\n  name: "cart",\n  initialState: [1],\n});\n',
    },
    {
      label: "route registration",
      oldSource: 'app.get("/x", (req, res) => {\n  res.send(1);\n});\n',
      newSource: 'app.get("/x", (req, res) => {\n  res.send(2);\n});\n',
    },
    {
      label: "IIFE",
      oldSource: "(function () {\n  run(1);\n})();\n",
      newSource: "(function () {\n  run(2);\n})();\n",
    },
  ])("$label: editing the body is a logic change only", async ({ oldSource, newSource }) => {
    const diff = await symbolDiff(".ts", oldSource, newSource);

    expect(diff.signatureChanged).toEqual([]);
    expect(diff.logicChanged.length).toBe(1);
  });
});

describe("a wrapped signature on a node with no body node stays a signature", () => {
  test.each([
    {
      label: "C prototype",
      ext: ".c",
      oldSource: "int parse(const char *s,\n          int n);\n",
      newSource: "int parse(const char *s,\n          size_t n);\n",
      name: "parse",
    },
    {
      label: "Kotlin expression-bodied function",
      ext: ".kt",
      oldSource: "fun add(a: Int,\n        b: Int) = a + b\n",
      newSource: "fun add(a: Int,\n        b: Long) = a + b\n",
      name: "add",
    },
    {
      label: "C++ template function with a wrapped signature",
      ext: ".cpp",
      oldSource: "template <typename T>\nint parse(const T& s,\n          int n) {\n  return n;\n}\n",
      newSource: "template <typename T>\nint parse(const T& s,\n          size_t n) {\n  return n;\n}\n",
      name: "parse",
    },
  ])("$label: a parameter edit on a continuation line is a signature change only", async (c) => {
    const diff = await symbolDiff(c.ext, c.oldSource, c.newSource);

    expect(diff.signatureChanged.map((s) => s.name)).toEqual([c.name]);
    expect(diff.logicChanged).toEqual([]);
  });
});
