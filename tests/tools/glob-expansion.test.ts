import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { handleReadMulti } from "../../src/tools/read.ts";
import { handleOutline } from "../../src/tools/outline.ts";
import { handleSearch } from "../../src/tools/search.ts";

let testDir: string;

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-glob-test-")));

  // Create a nested structure for glob testing
  mkdirSync(join(testDir, "src"), { recursive: true });
  mkdirSync(join(testDir, "lib"), { recursive: true });
  writeFileSync(join(testDir, "src", "alpha.ts"), "export function alpha(): void {}\n");
  writeFileSync(join(testDir, "src", "beta.ts"), "export function beta(): void {}\n");
  writeFileSync(join(testDir, "src", "gamma.js"), "function gamma() {}\n");
  writeFileSync(join(testDir, "lib", "delta.ts"), "export function delta(): void {}\n");
  writeFileSync(join(testDir, "config.json"), '{"key": "value"}\n');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function getText(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

// =============================================================================
// trueline_read glob expansion
// =============================================================================

describe("read glob expansion", () => {
  test("expands glob to matching files", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("--- src/alpha.ts ---");
    expect(text).toContain("--- src/beta.ts ---");
    expect(text).not.toContain("gamma"); // .js not matched by *.ts
  });

  test("mixes globs with literal paths", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.ts", "config.json"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("--- src/alpha.ts ---");
    expect(text).toContain("--- src/beta.ts ---");
    expect(text).toContain("--- config.json ---");
  });

  test("recursive glob with **", async () => {
    const result = await handleReadMulti({
      file_paths: ["**/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("delta"); // lib/delta.ts
  });

  test("non-glob paths pass through unchanged", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/alpha.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("function alpha");
    expect(text).not.toContain("---"); // single file, no header
  });

  test("glob with no matches returns empty result", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.xyz"],
      projectDir: testDir,
    });
    // No matches = empty output (not an error)
    expect(getText(result)).toBe("");
  });

  test("deduplicates overlapping globs", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/alpha.ts", "src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    // alpha.ts should appear exactly once
    const alphaCount = (text.match(/--- src\/alpha\.ts ---/g) || []).length;
    expect(alphaCount).toBe(1);
  });

  test("multi-file read skips missing files and continues", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/alpha.ts", "src/nonexistent.ts", "src/beta.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    // Should contain both valid files
    expect(text).toContain("--- src/alpha.ts ---");
    expect(text).toContain("--- src/beta.ts ---");
    // Should show error for missing file, not abort
    expect(text).toContain("--- src/nonexistent.ts ---");
    expect(text).toContain("error:");
    expect(text).toContain("not found");
    // Should NOT be an error result overall
    expect(result.isError).toBeUndefined();
  });
});

// =============================================================================
// trueline_outline glob expansion
// =============================================================================

describe("outline glob expansion", () => {
  test("expands glob to matching files", async () => {
    const result = await handleOutline({
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("gamma");
  });

  test("recursive glob", async () => {
    const result = await handleOutline({
      file_paths: ["**/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("delta");
  });
});

// =============================================================================
// trueline_search glob expansion
// =============================================================================

describe("search glob expansion", () => {
  test("expands glob to matching files", async () => {
    const result = await handleSearch({
      pattern: "export function",
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("gamma"); // .js not matched
  });

  test("recursive glob", async () => {
    const result = await handleSearch({
      pattern: "export function",
      file_paths: ["**/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("delta");
  });

  test("search results from glob have refs", async () => {
    const result = await handleSearch({
      pattern: "alpha",
      file_paths: ["src/*.ts"],
      projectDir: testDir,
    });
    const text = getText(result);
    expect(text).toMatch(/ref: \S+/);
  });
});

// =============================================================================
// gitignore-aware glob expansion
// =============================================================================

describe("gitignore-aware globs", () => {
  let gitDir: string;
  // Strip inherited GIT_* env vars: under `git commit -a`, lefthook runs this
  // with an absolute GIT_INDEX_FILE, and `git add -A` would rewrite the parent
  // repo's pending commit.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

  beforeAll(() => {
    const { execSync } = require("node:child_process");
    gitDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-glob-git-")));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: gitDir, env: cleanEnv });

    // Create a git repo with .gitignore
    git("init");
    git("config user.email test@test.com");
    git("config user.name test");

    mkdirSync(join(gitDir, "src"), { recursive: true });
    mkdirSync(join(gitDir, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(gitDir, "dist"), { recursive: true });

    writeFileSync(join(gitDir, "src", "main.ts"), "export function main(): void {}\n");
    writeFileSync(join(gitDir, "src", "util.ts"), "export function util(): void {}\n");
    writeFileSync(join(gitDir, "node_modules", "dep", "index.ts"), "export const dep = 1;\n");
    writeFileSync(join(gitDir, "dist", "bundle.ts"), "export const bundle = 1;\n");
    writeFileSync(join(gitDir, ".gitignore"), "node_modules/\ndist/\n");

    // Stage files so git ls-files sees them
    git("add -A");
  });

  afterAll(() => {
    rmSync(gitDir, { recursive: true, force: true });
  });

  test("recursive glob respects .gitignore", async () => {
    const result = await handleReadMulti({
      file_paths: ["**/*.ts"],
      projectDir: gitDir,
    });
    const text = getText(result);
    // Should find src/ files
    expect(text).toContain("main");
    expect(text).toContain("util");
    // Should NOT find gitignored files
    expect(text).not.toContain("dep");
    expect(text).not.toContain("bundle");
  });

  test("recursive glob ignores an inherited GIT_DIR", async () => {
    const { execSync } = require("node:child_process");
    const decoyDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-glob-decoy-")));
    execSync("git init", { cwd: decoyDir, env: cleanEnv });
    writeFileSync(join(decoyDir, "decoy.ts"), "export const decoy = 1;\n");
    execSync("git add -A", { cwd: decoyDir, env: cleanEnv });

    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoyDir, ".git");
    try {
      const text = getText(await handleReadMulti({ file_paths: ["**/*.ts"], projectDir: gitDir }));
      expect(text).toContain("main");
      expect(text).not.toContain("decoy");
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  test("non-recursive glob in non-ignored dir works", async () => {
    const result = await handleReadMulti({
      file_paths: ["src/*.ts"],
      projectDir: gitDir,
    });
    const text = getText(result);
    expect(text).toContain("main");
    expect(text).toContain("util");
  });

  test("outline with recursive glob respects .gitignore", async () => {
    const result = await handleOutline({
      file_paths: ["**/*.ts"],
      projectDir: gitDir,
    });
    const text = getText(result);
    expect(text).toContain("main");
    expect(text).not.toContain("dep");
  });

  test("search with recursive glob respects .gitignore", async () => {
    const result = await handleSearch({
      pattern: "export",
      file_paths: ["**/*.ts"],
      projectDir: gitDir,
    });
    const text = getText(result);
    expect(text).toContain("main");
    expect(text).not.toContain("dep");
    expect(text).not.toContain("bundle");
  });

  // MCP tools require absolute paths, so this is the form agents actually send.
  test("absolute recursive glob expands like its relative form", async () => {
    const relative = getText(await handleReadMulti({ file_paths: ["src/**/*.ts"], projectDir: gitDir }));
    const absolute = getText(
      await handleReadMulti({
        file_paths: [join(gitDir, "src", "**", "*.ts")],
        projectDir: gitDir,
        requireAbsolutePath: true,
      }),
    );
    expect(relative).toContain("--- src/main.ts ---");
    expect(absolute).toBe(relative);
  });

  test("absolute recursive glob respects .gitignore", async () => {
    const text = getText(
      await handleReadMulti({
        file_paths: [join(gitDir, "**", "*.ts")],
        projectDir: gitDir,
        requireAbsolutePath: true,
      }),
    );
    expect(text).toContain("main");
    expect(text).toContain("util");
    expect(text).not.toContain("dep");
    expect(text).not.toContain("bundle");
  });

  test("absolute non-recursive glob expands", async () => {
    const text = getText(
      await handleReadMulti({
        file_paths: [join(gitDir, "src", "*.ts")],
        projectDir: gitDir,
        requireAbsolutePath: true,
      }),
    );
    expect(text).toContain("--- src/main.ts ---");
    expect(text).toContain("--- src/util.ts ---");
  });

  test("absolute recursive glob outside projectDir matches nothing", async () => {
    const text = getText(
      await handleReadMulti({
        file_paths: [join(testDir, "**", "*.ts")],
        projectDir: gitDir,
        requireAbsolutePath: true,
      }),
    );
    expect(text).toBe("");
  });
});

// =============================================================================
// absolute globs: alternate spellings, other allowed dirs, allow-list boundary
// =============================================================================

describe("absolute globs and allowed dirs", () => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const canSymlink = process.platform !== "win32";
  const created: string[] = [];

  // As mkdtemp returns it: /var/... on macOS, whose realpath is /private/var/...
  let projectRaw: string;
  let projectDir: string;
  let nonGitProject: string;
  let notesRepo: string;
  let claudeHome: string;
  let outsideDir: string;
  let aliasRoot: string;

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "trueline-glob-abs-"));
    created.push(dir);
    return dir;
  }

  function writeTree(dir: string, files: Record<string, string>): void {
    for (const [relPath, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, relPath)), { recursive: true });
      writeFileSync(join(dir, relPath), content);
    }
  }

  function initRepo(dir: string): void {
    const { execSync } = require("node:child_process");
    execSync("git init", { cwd: dir, env: cleanEnv });
    execSync("git add -A", { cwd: dir, env: cleanEnv });
  }

  beforeAll(() => {
    projectRaw = makeDir();
    writeTree(projectRaw, {
      "src/main.ts": "export function main(): void {}\n",
      "src/util.ts": "export function util(): void {}\n",
      "dist/bundle.ts": "export const bundle = 1;\n",
      ".gitignore": "dist/\n",
    });
    initRepo(projectRaw);
    projectDir = realpathSync(projectRaw);

    nonGitProject = realpathSync(makeDir());
    writeTree(nonGitProject, { "src/app.ts": "export function app(): void {}\n" });

    notesRepo = realpathSync(makeDir());
    writeTree(notesRepo, {
      "docs/guide.md": "# Guide\n",
      "docs/faq.md": "# Faq\n",
      "scratch/draft.md": "# Draft\n",
      ".gitignore": "scratch/\n",
    });
    initRepo(notesRepo);

    claudeHome = realpathSync(makeDir());
    writeTree(claudeHome, {
      "agents/reviewer.md": "# Reviewer\n",
      "agents/planner.md": "# Planner\n",
      "node_modules/dep/readme.md": "# Dep\n",
    });

    outsideDir = realpathSync(makeDir());
    writeTree(outsideDir, {
      "payroll-secrets.conf": "secret\n",
      "nested/vault-keys.conf": "secret\n",
    });

    if (canSymlink) {
      aliasRoot = makeDir();
      symlinkSync(projectDir, join(aliasRoot, "project-alias"));
      symlinkSync(outsideDir, join(projectDir, "linked-out"));
      symlinkSync(outsideDir, join(nonGitProject, "linked-out"));
    }
  });

  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  function readGlob(pattern: string, dir: string, allowedDirs: string[] = []) {
    return handleReadMulti({ file_paths: [pattern], projectDir: dir, allowedDirs, requireAbsolutePath: true });
  }

  const relativeSrcGlob = (glob: string) => handleReadMulti({ file_paths: [glob], projectDir }).then(getText);

  test.skipIf(!canSymlink)(
    "absolute recursive glob via a symlinked alias of projectDir expands like the relative form",
    async () => {
      const relative = await relativeSrcGlob("src/**/*.ts");
      const viaAlias = getText(await readGlob(join(aliasRoot, "project-alias", "src", "**", "*.ts"), projectDir));
      expect(relative).toContain("--- src/main.ts ---");
      expect(viaAlias).toBe(relative);
    },
  );

  test.skipIf(!canSymlink)(
    "absolute non-recursive glob via a symlinked alias of projectDir expands like the relative form",
    async () => {
      const relative = await relativeSrcGlob("src/*.ts");
      const viaAlias = getText(await readGlob(join(aliasRoot, "project-alias", "src", "*.ts"), projectDir));
      expect(relative).toContain("--- src/main.ts ---");
      expect(viaAlias).toBe(relative);
    },
  );

  // Differs from the canonical spelling on macOS (/var vs /private/var);
  // elsewhere it is a plain control.
  test("absolute recursive glob in the tmpdir spelling of projectDir expands like the relative form", async () => {
    const relative = await relativeSrcGlob("src/**/*.ts");
    const viaRaw = getText(await readGlob(join(projectRaw, "src", "**", "*.ts"), projectDir));
    expect(relative).toContain("--- src/main.ts ---");
    expect(viaRaw).toBe(relative);
  });

  test("absolute recursive glob expands files in a second allowed dir that is not a repo", async () => {
    const text = getText(await readGlob(join(claudeHome, "**", "*.md"), projectDir, [claudeHome]));
    const root = claudeHome.replaceAll("\\", "/");
    expect(text).toContain(`--- ${root}/agents/reviewer.md ---`);
    expect(text).toContain(`--- ${root}/agents/planner.md ---`);
    // Node-glob fallback exclusions still apply
    expect(text).not.toContain("# Dep");
  });

  test("absolute recursive glob expands a second allowed dir that is a repo, honoring .gitignore", async () => {
    const text = getText(await readGlob(join(notesRepo, "**", "*.md"), projectDir, [notesRepo]));
    expect(text).toContain("# Guide");
    expect(text).toContain("# Faq");
    expect(text).not.toContain("# Draft");
  });

  test("absolute non-recursive glob expands files in a second allowed dir", async () => {
    const text = getText(await readGlob(join(claudeHome, "agents", "*.md"), projectDir, [claudeHome]));
    expect(text).toContain("# Reviewer");
    expect(text).toContain("# Planner");
  });

  // A denied read must not have named the file: a listing leaks even when
  // validatePath refuses every entry.
  const outsideName = () => basename(outsideDir);
  const outsideForms: Record<string, (project: string) => string> = {
    "non-recursive": () => join(outsideDir, "*.conf"),
    recursive: () => join(outsideDir, "**", "*.conf"),
    "dot-dot in the literal prefix": (project) => `${project}/../${outsideName()}/*.conf`,
    "dot-dot in a brace, non-recursive": (project) => `${project}/{..,none}/${outsideName()}/*.conf`,
    "dot-dot in a brace, recursive": (project) => `${project}/{..,none}/${outsideName()}/**/*.conf`,
    "symlink to outside": (project) => join(project, "linked-out", "*.conf"),
  };

  for (const [kind, project] of [
    ["git", () => projectDir],
    ["non-git", () => nonGitProject],
  ] as const) {
    for (const [form, toPattern] of Object.entries(outsideForms)) {
      test.skipIf(!canSymlink && form === "symlink to outside")(
        `${kind} project: ${form} glob outside every allowed dir lists nothing`,
        async () => {
          const pattern = toPattern(project());
          const params = { file_paths: [pattern], projectDir: project(), requireAbsolutePath: true };
          const texts = [
            getText(await handleReadMulti(params)),
            getText(await handleOutline(params)),
            getText(await handleSearch({ ...params, pattern: "secret" })),
          ];
          expect(texts[0]).toBe("");
          for (const text of texts) {
            expect(text).not.toContain("payroll-secrets");
            expect(text).not.toContain("vault-keys");
            expect(text).not.toContain(outsideName());
          }
        },
      );
    }
  }
});
