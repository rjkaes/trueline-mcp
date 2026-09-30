import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  parseToolPattern,
  fileGlobToRegex,
  readToolDenyPatterns,
  evaluateFilePath,
  clearCaches,
} from "../src/security.js";
import { expandGlobs, validateEncoding, validatePath } from "../src/tools/shared.ts";

describe("parseToolPattern", () => {
  test("parses Read(.env)", () => {
    const result = parseToolPattern("Read(.env)");
    expect(result).toEqual({ tool: "Read", glob: ".env" });
  });

  test("parses Edit(**/*.secret)", () => {
    const result = parseToolPattern("Edit(**/*.secret)");
    expect(result).toEqual({ tool: "Edit", glob: "**/*.secret" });
  });

  test("handles nested parens", () => {
    const result = parseToolPattern("Read(some(path))");
    expect(result).toEqual({ tool: "Read", glob: "some(path)" });
  });

  test("returns null for non-pattern", () => {
    expect(parseToolPattern("justAString")).toBeNull();
  });

  test("returns null for Bash patterns", () => {
    // We still parse them, but tool will be "Bash"
    const result = parseToolPattern("Bash(sudo *)");
    expect(result?.tool).toBe("Bash");
  });
});

describe("fileGlobToRegex", () => {
  test("** matches any depth", () => {
    const re = fileGlobToRegex("**/*.env");
    expect(re.test("src/config/.env")).toBe(true);
    expect(re.test(".env")).toBe(true);
    expect(re.test("deep/nested/path/.env")).toBe(true);
  });

  test("** mid-segment is not globstar (boundary check)", () => {
    // "a**b" should not match across directories — the ** is not at a boundary
    const re = fileGlobToRegex("a**b");
    expect(re.test("a/foo/b")).toBe(false); // ** not at boundary, just single-segment wildcards
    expect(re.test("afoobarb")).toBe(true);
  });

  test("* matches single segment", () => {
    const re = fileGlobToRegex("src/*.ts");
    expect(re.test("src/file.ts")).toBe(true);
    expect(re.test("src/nested/file.ts")).toBe(false);
  });

  test("? matches single character", () => {
    const re = fileGlobToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("file12.ts")).toBe(false);
  });

  test("exact match", () => {
    const re = fileGlobToRegex(".env");
    expect(re.test(".env")).toBe(true);
    expect(re.test("src/.env")).toBe(false);
  });

  test("case insensitive option", () => {
    const re = fileGlobToRegex("*.ENV", true);
    expect(re.test("config.env")).toBe(true);
    expect(re.test("config.ENV")).toBe(true);
  });

  test("consecutive globstars are normalized to prevent ReDoS", () => {
    const re = fileGlobToRegex("**/**/**/**/a");
    expect(re.test("x/y/z/a")).toBe(true);
    expect(re.test("x/y/z/b")).toBe(false);
  });

  // A mid-segment "**" is a plain star (gitignore), so only globstars at a boundary may collapse:
  // "a**/**/x" folded to "a**/x" would stop matching below the first directory.
  test("globstar collapse does not narrow a rule whose first ** is mid-segment", () => {
    const re = fileGlobToRegex("vault**/**/key.pem");
    expect(re.test("vault-prod/eu/west/key.pem")).toBe(true);
    expect(re.test("vault-prod/key.pem")).toBe(true);
  });

  // Updated for the bracket-class change: "[1]" used to be literal here and is now a one-character
  // class (see "bracket classes" below), so this asserts on the metacharacters that stay literal.
  test("escapes regex metacharacters in glob literals", () => {
    const re = fileGlobToRegex("a+b(c){2}$^|.ts");
    expect(re.test("a+b(c){2}$^|.ts")).toBe(true);
    expect(re.test("aab(c)(c).ts")).toBe(false);
  });

  test("dot is literal not regex wildcard", () => {
    const re = fileGlobToRegex("*.env");
    expect(re.test("app.env")).toBe(true);
    expect(re.test("appXenv")).toBe(false); // would match if . were regex any-char
  });
});

// Claude Code's Read/Edit rules are gitignore patterns in which "[", "]" and "*" are pattern characters
// and a backslash escapes one: https://code.claude.com/docs/en/permissions ("Read and Edit").
describe("fileGlobToRegex bracket classes", () => {
  test("[12] matches exactly one listed character", () => {
    const re = fileGlobToRegex("key[12].pem");
    expect(re.test("key1.pem")).toBe(true);
    expect(re.test("key2.pem")).toBe(true);
    expect(re.test("key3.pem")).toBe(false);
    expect(re.test("key12.pem")).toBe(false);
    expect(re.test("key.pem")).toBe(false);
  });

  test("ranges and [!..] / [^..] negation", () => {
    const range = fileGlobToRegex("v[a-c]");
    expect(["va", "vb", "vc"].every((name) => range.test(name))).toBe(true);
    expect(range.test("vd")).toBe(false);

    for (const glob of ["log[!0-9].txt", "log[^0-9].txt"]) {
      const re = fileGlobToRegex(glob);
      expect(re.test("logx.txt")).toBe(true);
      expect(re.test("log5.txt")).toBe(false);
      expect(re.test("log.txt")).toBe(false);
    }
  });

  test("a class never matches a path separator", () => {
    expect(fileGlobToRegex("a[!x]b").test("a/b")).toBe(false);
    expect(fileGlobToRegex("a[/]b").test("a/b")).toBe(false);
    // "!-~" spans U+002F
    expect(fileGlobToRegex("a[!-~]b").test("a/b")).toBe(false);
    expect(fileGlobToRegex("a[!-~]b").test("a!b")).toBe(true);
  });

  test("a backslash escapes the next character", () => {
    const re = fileGlobToRegex("\\[2024-06\\] Reports/**");
    expect(re.test("[2024-06] Reports/q3.csv")).toBe(true);
    expect(re.test("2024-06 Reports/q3.csv")).toBe(false);
    expect(re.test("0 Reports/q3.csv")).toBe(false);

    expect(fileGlobToRegex("a\\*b").test("a*b")).toBe(true);
    expect(fileGlobToRegex("a\\*b").test("axb")).toBe(false);
    expect(fileGlobToRegex("a\\sb").test("asb")).toBe(true); // not the regex class \\s
    expect(fileGlobToRegex("a\\sb").test("a b")).toBe(false);
  });

  test("an unclosed [ and a trailing backslash are literal", () => {
    expect(fileGlobToRegex("file[1.ts").test("file[1.ts")).toBe(true);
    expect(fileGlobToRegex("file[1.ts").test("file1.ts")).toBe(false);
    expect(fileGlobToRegex("a[]b").test("a[]b")).toBe(true);
    expect(fileGlobToRegex("dir\\").test("dir\\")).toBe(true);
  });

  test("regex-special characters inside a class stay literal", () => {
    const specials = fileGlobToRegex("[$^.+(){}|]x");
    for (const char of "$^.+(){}|") expect(specials.test(`${char}x`)).toBe(true);
    expect(specials.test("ax")).toBe(false);

    expect(fileGlobToRegex("[]a]").test("]")).toBe(true); // a leading "]" is a member
    expect(fileGlobToRegex("[]a]").test("a")).toBe(true);
    expect(fileGlobToRegex("[a\\]b]").test("]")).toBe(true);
    expect(fileGlobToRegex("[a\\-z]").test("-")).toBe(true);
    expect(fileGlobToRegex("[a\\-z]").test("b")).toBe(false);
    expect(fileGlobToRegex("[[:x:]").test(":")).toBe(true);
  });

  test("an out-of-order range does not throw; its brackets stay literal", () => {
    expect(fileGlobToRegex("f[z-a]").test("fm")).toBe(false);
    expect(fileGlobToRegex("f[z-a]").test("f[z-a]")).toBe(true);
  });

  test("case-insensitive mode folds class members, Unicode simple folds included", () => {
    expect(fileGlobToRegex("key[a-c].pem", true).test("KEYB.pem")).toBe(true);
    expect(fileGlobToRegex("key[a-c].pem").test("KEYB.pem")).toBe(false);
    expect(fileGlobToRegex("[s]ecrets", true).test("ſecrets")).toBe(true);
    expect(fileGlobToRegex("[!s]ecrets", true).test("ſecrets")).toBe(false);
  });

  test("compiling and matching stay linear on adversarial classes", () => {
    const start = performance.now();
    expect(fileGlobToRegex(`${"[a-z]".repeat(300)}!`).test("a".repeat(20_000))).toBe(false);
    expect(fileGlobToRegex(`${"[".repeat(20_000)}\\]`).test("[")).toBe(false);
    expect(fileGlobToRegex(`${"[\\]".repeat(5_000)}x`).test("x")).toBe(false);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("readToolDenyPatterns", () => {
  test("reads deny patterns from project settings", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "security-test-"));
    try {
      const claudeDir = join(tmp, ".claude");
      const settingsPath = join(claudeDir, "settings.json");

      // Create .claude/settings.json with deny patterns
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: {
            deny: ["Read(.env)", "Read(**/*.secret)", "Edit(**/*.key)"],
            allow: ["Bash(echo *)"],
          },
        }),
      );

      const patterns = await readToolDenyPatterns("Read", tmp);
      // Should find Read patterns but not Edit or Bash
      expect(patterns.length).toBeGreaterThan(0);
      const flat = patterns.flat();
      expect(flat).toContain(".env");
      expect(flat).toContain("**/*.secret");
      expect(flat).not.toContain("**/*.key"); // Edit, not Read
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns empty when no settings exist", async () => {
    const patterns = await readToolDenyPatterns("Read", "/nonexistent/path", "/nonexistent/global/settings.json");
    expect(patterns).toEqual([]);
  });
});

describe("evaluateFilePath", () => {
  test("denies matching paths", () => {
    const result = evaluateFilePath("/project/.env", [[".env", "**/*.key"]]);
    expect(result.denied).toBe(true);
    expect(result.matchedPattern).toBe(".env");
  });

  test("allows non-matching paths", () => {
    const result = evaluateFilePath("/project/src/app.ts", [[".env", "**/*.key"]]);
    expect(result.denied).toBe(false);
  });

  test("normalizes backslashes", () => {
    const result = evaluateFilePath("C:\\Users\\dev\\.env", [["**/.env"]]);
    expect(result.denied).toBe(true);
  });

  test("handles empty deny lists", () => {
    const result = evaluateFilePath("/project/file.ts", []);
    expect(result.denied).toBe(false);
  });

  test("relative path pattern with / matches as suffix", () => {
    // "src/.env" should match "/project/src/.env"
    const result = evaluateFilePath("/project/src/.env", [["src/.env"]]);
    expect(result.denied).toBe(true);
    expect(result.matchedPattern).toBe("src/.env");
  });

  test("relative path pattern does not match wrong suffix", () => {
    const result = evaluateFilePath("/project/other/.env", [["src/.env"]]);
    expect(result.denied).toBe(false);
  });

  test("suffix matching respects caseInsensitive flag", () => {
    const result = evaluateFilePath("/project/SRC/.Env", [["src/.env"]], true);
    expect(result.denied).toBe(true);
  });

  test("bare pattern with metacharacters uses glob matching not string suffix", () => {
    // Pattern "file[1].ts" should NOT match "fileX.ts" (would happen with naive suffix check)
    const result = evaluateFilePath("/project/file[1].ts", [["file[1].ts"]]);
    expect(result.denied).toBe(true);
    const noMatch = evaluateFilePath("/project/fileX.ts", [["file[1].ts"]]);
    expect(noMatch.denied).toBe(false);
  });
});

// Fail closed: a rule denies a path when ANY reading of it matches. Claude Code reads Read/Edit rules
// as gitignore patterns (classes, backslash escapes); the literal-bracket and Windows-separator
// readings predate that and still guard files named like the rule.
// https://code.claude.com/docs/en/permissions ("Read and Edit")
describe("bracket classes in deny rules", () => {
  test("Read(key[12].pem) denies key1.pem and key2.pem, not key3.pem, and still the literal name", () => {
    const rules = [["key[12].pem"]];
    expect(evaluateFilePath("/project/key1.pem", rules).denied).toBe(true);
    expect(evaluateFilePath("/project/certs/key2.pem", rules).denied).toBe(true);
    expect(evaluateFilePath("/project/key3.pem", rules).denied).toBe(false);
    expect(evaluateFilePath("/project/key[12].pem", rules).denied).toBe(true);
  });

  test("[!0-9] and [^0-9] negate, and the literal name stays denied", () => {
    for (const glob of ["log[!0-9].txt", "log[^0-9].txt"]) {
      expect(evaluateFilePath("/project/logx.txt", [[glob]]).denied).toBe(true);
      expect(evaluateFilePath("/project/log5.txt", [[glob]]).denied).toBe(false);
      expect(evaluateFilePath(`/project/${glob}`, [[glob]]).denied).toBe(true);
    }
  });

  test("a class never matches a separator", () => {
    expect(evaluateFilePath("/project/src/app.ts", [["src[!x]app.ts"]]).denied).toBe(false);
    expect(evaluateFilePath("/project/src/app.ts", [["src[/]app.ts"]]).denied).toBe(false);
  });

  test("escaped brackets denote a directory whose name holds them", () => {
    const rules = [["\\[2024-06\\] Reports/**"]];
    expect(evaluateFilePath("/project/[2024-06] Reports/q3.csv", rules).denied).toBe(true);
    expect(evaluateFilePath("/project/2024-06 Reports/q3.csv", rules).denied).toBe(false);
    expect(evaluateFilePath("/project/0 Reports/q3.csv", rules).denied).toBe(false);
  });

  test("Read(file[1].ts) still denies the file literally named file[1].ts", () => {
    expect(evaluateFilePath("/project/file[1].ts", [["file[1].ts"]]).denied).toBe(true);
    expect(evaluateFilePath("/project/file1.ts", [["file[1].ts"]]).denied).toBe(true);
  });

  test("an unclosed [ is literal", () => {
    expect(evaluateFilePath("/project/file[1.ts", [["file[1.ts"]]).denied).toBe(true);
    expect(evaluateFilePath("/project/file1.ts", [["file[1.ts"]]).denied).toBe(false);
  });

  test("classes work under ~/, // and absolute anchors", () => {
    const home = homedir();
    expect(evaluateFilePath(`${home}/.ssh/id_rsa`, [["~/.ssh/id_[rd]sa"]]).denied).toBe(true);
    expect(evaluateFilePath(`${home}/.ssh/id_xsa`, [["~/.ssh/id_[rd]sa"]]).denied).toBe(false);
    expect(evaluateFilePath("/etc/ssl/key2.pem", [["//etc/ssl/key[12].pem"]]).denied).toBe(true);
    expect(evaluateFilePath("/etc/ssl/key3.pem", [["//etc/ssl/key[12].pem"]]).denied).toBe(false);
    expect(evaluateFilePath("/work/billing/key1.pem", [["/work/billing/key[12].pem"]]).denied).toBe(true);
  });

  test("backslash stays a Windows separator beside literal brackets", () => {
    expect(evaluateFilePath("C:\\secrets\\[q3]\\a.pem", [["C:\\secrets\\[q3]\\**"]]).denied).toBe(true);
    expect(evaluateFilePath("C:\\secrets\\vault\\a.pem", [["C:\\secrets\\**"]]).denied).toBe(true);
  });

  test("case-insensitive mode applies to classes, Unicode simple folds included", () => {
    expect(evaluateFilePath("/project/KEYB.pem", [["key[a-c].pem"]], true).denied).toBe(true);
    expect(evaluateFilePath("/project/KEYB.pem", [["key[a-c].pem"]], false).denied).toBe(false);
    expect(evaluateFilePath("/work/ſecrets/key.txt", [["[s]ecrets/**"]], true).denied).toBe(true);
  });

  test("validatePath enforces Read(key[12].pem) from project settings", async () => {
    const project = makeProject("trueline-bracket-class-");
    try {
      writeProjectDeny(project, ["Read(key[12].pem)"]);
      for (const name of ["key1.pem", "key2.pem", "key3.pem"]) writeFileSync(join(project, name), "k\n");

      expect((await validatePath(join(project, "key1.pem"), "Read", project, [])).ok).toBe(false);
      expect((await validatePath(join(project, "key2.pem"), "Read", project, [])).ok).toBe(false);
      expect((await validatePath(join(project, "key3.pem"), "Read", project, [])).ok).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// Machine-level ~/.claude/settings.json is also read by validatePath and cannot be redirected
// in-process (Bun caches homedir()), so fixtures avoid names such global rules commonly target
// (.env, *secret*, *credentials*).
function makeProject(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function writeProjectDeny(project: string, deny: string[]): void {
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { deny } }));
  clearCaches();
}

// Path forms: https://code.claude.com/docs/en/permissions ("Read and Edit")
describe("deny pattern path anchors", () => {
  test("./ is relative to the project, like a bare pattern", () => {
    expect(evaluateFilePath("/work/billing/.env", [["./.env"]]).denied).toBe(true);
    expect(evaluateFilePath("/work/billing/secrets/key.pem", [["./secrets/**"]]).denied).toBe(true);
    expect(evaluateFilePath("/work/billing/src/app.ts", [["./secrets/**"]]).denied).toBe(false);
  });

  test("~/ is anchored at the home directory", () => {
    const home = homedir();
    expect(evaluateFilePath(`${home}/.ssh/id_rsa`, [["~/.ssh/**"]]).denied).toBe(true);
    expect(evaluateFilePath(`${home}/projects/.ssh/id_rsa`, [["~/.ssh/**"]]).denied).toBe(false);
    expect(evaluateFilePath("/srv/other-user/.ssh/id_rsa", [["~/.ssh/**"]]).denied).toBe(false);
  });

  test("// is the filesystem root", () => {
    expect(evaluateFilePath("/etc/shadow", [["//etc/shadow"]]).denied).toBe(true);
    expect(evaluateFilePath("/work/billing/etc/shadow", [["//etc/shadow"]]).denied).toBe(false);
  });

  test("// patterns match Windows paths in POSIX form (C:\\Users -> /c/Users)", () => {
    expect(evaluateFilePath("C:\\Users\\alice\\.env", [["//c/**/.env"]]).denied).toBe(true);
    expect(evaluateFilePath("D:\\Users\\alice\\.env", [["//c/**/.env"]]).denied).toBe(false);
  });

  test.each(["C:/secrets/**", "C:\\secrets\\**", "c:/secrets/**"])(
    "drive-letter pattern %s denies that drive's paths",
    (glob) => {
      expect(evaluateFilePath("C:\\secrets\\vault\\a.pem", [[glob]]).denied).toBe(true);
      expect(evaluateFilePath("C:/secrets/a.pem", [[glob]]).denied).toBe(true);
      expect(evaluateFilePath("D:\\secrets\\a.pem", [[glob]]).denied).toBe(false);
      expect(evaluateFilePath("C:\\projects\\a.pem", [[glob]]).denied).toBe(false);
    },
  );

  // The first form is what readToolDenyPatterns anchors a UNC project dir to; the second is the
  // documented spelling of the same absolute path.
  test.each(["/srv/share/billing/secrets/**", "//srv/share/billing/secrets/**"])(
    "UNC path is denied by pattern %s",
    (glob) => {
      expect(evaluateFilePath("\\\\srv\\share\\billing\\secrets\\key.pem", [[glob]]).denied).toBe(true);
      expect(evaluateFilePath("\\\\srv\\share\\billing\\src\\app.ts", [[glob]]).denied).toBe(false);
    },
  );

  // Claude Code follows gitignore: a rule that matches a directory matches everything under it.
  test.each([
    ["./secrets", "/work/billing/secrets/key.pem"],
    ["./secrets/", "/work/billing/secrets/key.pem"],
    ["secrets", "/work/billing/vendor/secrets/nested/key.pem"],
    ["config/keys", "/work/billing/config/keys/prod/key.pem"],
    ["/work/billing/secrets", "/work/billing/secrets/key.pem"],
    ["~/.ssh", `${homedir()}/.ssh/keys/id_rsa`],
    ["//etc/ssl", "/etc/ssl/private/server.key"],
    ["C:/secrets", "C:\\secrets\\vault\\a.pem"],
  ])("directory rule %s denies %s", (glob, path) => {
    expect(evaluateFilePath(path, [[glob]]).denied).toBe(true);
  });

  test.each([
    ["./secrets", "/work/billing/secrets-old/key.pem"],
    ["./secrets", "/work/billing/src/app.ts"],
    ["config/keys", "/work/billing/config/keystore/a.pem"],
    ["~/.ssh", `${homedir()}/projects/.ssh/id_rsa`],
    ["//etc/ssl", "/etc/ssl-old/server.key"],
    ["//etc/ssl", "/work/etc/ssl/server.key"],
    ["C:/secrets", "D:\\secrets\\a.pem"],
  ])("directory rule %s allows %s", (glob, path) => {
    expect(evaluateFilePath(path, [[glob]]).denied).toBe(false);
  });

  describe("/ is relative to the settings source", () => {
    let project: string;
    let userDir: string;

    beforeAll(() => {
      project = makeProject("trueline-anchor-project-");
      userDir = makeProject("trueline-anchor-user-");
    });

    afterAll(() => {
      rmSync(project, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    });

    test("project settings anchor at the project directory, not nested copies or the filesystem root", async () => {
      writeProjectDeny(project, ["Read(/secrets/**)"]);
      const denyGlobs = await readToolDenyPatterns("Read", project, join(userDir, "settings.json"));

      expect(evaluateFilePath(`${project}/secrets/key.pem`, denyGlobs).denied).toBe(true);
      expect(evaluateFilePath(`${project}/vendor/secrets/key.pem`, denyGlobs).denied).toBe(false);
      expect(evaluateFilePath("/secrets/key.pem", denyGlobs).denied).toBe(false);
    });

    test("user settings anchor at the directory holding the settings file (~/.claude)", async () => {
      writeFileSync(join(userDir, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(/keys/**)"] } }));
      clearCaches();
      const denyGlobs = await readToolDenyPatterns("Read", project, join(userDir, "settings.json"));

      expect(evaluateFilePath(`${userDir}/keys/id.pem`, denyGlobs).denied).toBe(true);
      expect(evaluateFilePath(`${project}/keys/id.pem`, denyGlobs).denied).toBe(false);
    });
  });

  // Deny rules must hold whichever spelling of the home directory a path arrives by.
  describe.skipIf(process.platform === "win32")("symlinked home directory", () => {
    let realHome: string;
    let linkHome: string;

    beforeAll(() => {
      realHome = makeProject("trueline-real-home-");
      linkHome = join(makeProject("trueline-link-parent-"), "home");
      symlinkSync(realHome, linkHome);
      mkdirSync(join(realHome, ".claude"));
    });

    afterAll(() => {
      rmSync(realHome, { recursive: true, force: true });
      rmSync(dirname(linkHome), { recursive: true, force: true });
    });

    test("the ~/.claude anchor matches through the lexical and the real home", async () => {
      writeFileSync(
        join(realHome, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Read(/keys/**)"] } }),
      );
      clearCaches();
      const denyGlobs = await readToolDenyPatterns("Read", undefined, join(linkHome, ".claude", "settings.json"));

      expect(evaluateFilePath(`${linkHome}/.claude/keys/id.pem`, denyGlobs).denied).toBe(true);
      expect(evaluateFilePath(`${realHome}/.claude/keys/id.pem`, denyGlobs).denied).toBe(true);
      expect(evaluateFilePath(`${realHome}/keys/id.pem`, denyGlobs).denied).toBe(false);
    });

    // homedir() is fixed per process, so ~/ is expanded in a child started with HOME set to the link.
    test("~/ patterns match through the lexical and the real home", () => {
      const probe = {
        glob: "~/.ssh",
        paths: [`${linkHome}/.ssh/id_rsa`, `${realHome}/.ssh/id_rsa`, `${realHome}/projects/.ssh/id_rsa`],
      };
      const script = `
        const { evaluateFilePath } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "security.js"))});
        const { glob, paths } = JSON.parse(process.env.PROBE);
        console.log(JSON.stringify(paths.map((path) => evaluateFilePath(path, [[glob]]).denied)));
      `;
      const run = spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, HOME: linkHome, PROBE: JSON.stringify(probe) },
        encoding: "utf8",
      });

      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toEqual([true, true, false]);
    });
  });

  describe("validatePath honours prefixed project deny rules", () => {
    let project: string;

    beforeAll(() => {
      project = makeProject("trueline-deny-project-");
      for (const dir of ["secrets", "src"]) mkdirSync(join(project, dir));
      writeFileSync(join(project, "secrets", "key.pem"), "-----BEGIN-----\n");
      writeFileSync(join(project, "src", "app.ts"), "export const port = 8080;\n");
    });

    afterAll(() => {
      rmSync(project, { recursive: true, force: true });
    });

    // "//" plus the project's absolute path is the documented spelling of an absolute path.
    for (const spelling of [
      "./secrets/**",
      "/secrets/**",
      "//<project>/secrets/**",
      "./secrets",
      "./secrets/",
      "/secrets",
      "//<project>/secrets",
    ]) {
      test.skipIf(process.platform === "win32")(`Read(${spelling}) blocks secrets/key.pem only`, async () => {
        writeProjectDeny(project, [`Read(${spelling.replace("<project>", project.slice(1))})`]);

        const denied = await validatePath(join(project, "secrets", "key.pem"), "Read", project, []);
        expect(denied.ok).toBe(false);
        if (!denied.ok) expect((denied.error.content[0] as { text: string }).text).toContain("deny pattern");

        const allowed = await validatePath(join(project, "src", "app.ts"), "Read", project, []);
        expect(allowed.ok).toBe(true);
      });
    }
  });
});

describe.skipIf(process.platform === "win32")("validatePath deny check on symlinked paths", () => {
  let project: string;

  beforeAll(() => {
    project = makeProject("trueline-symlink-deny-");
    mkdirSync(join(project, "data"));
    writeFileSync(join(project, "data", "keystore.txt"), "k\n");
    symlinkSync(join(project, "data"), join(project, "vault"));
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  for (const glob of ["**/vault/**", "vault/**"]) {
    test(`Read(${glob}) blocks the file reached through the vault symlink`, async () => {
      writeProjectDeny(project, [`Read(${glob})`]);

      const viaLink = await validatePath(join(project, "vault", "keystore.txt"), "Read", project, []);
      expect(viaLink.ok).toBe(false);

      const relative = await validatePath("vault/keystore.txt", "Read", project, []);
      expect(relative.ok).toBe(false);

      // The rule names the link, so the real location stays readable.
      const direct = await validatePath(join(project, "data", "keystore.txt"), "Read", project, []);
      expect(direct.ok).toBe(true);
    });
  }

  test("a rule on the link target still blocks reads through the link", async () => {
    writeProjectDeny(project, ["Read(**/data/**)"]);

    const viaLink = await validatePath(join(project, "vault", "keystore.txt"), "Read", project, []);
    expect(viaLink.ok).toBe(false);
  });
});

describe("expandGlobs with literal bracket paths", () => {
  let project: string;

  beforeAll(() => {
    project = makeProject("trueline-bracket-");
    mkdirSync(join(project, "app", "[id]"), { recursive: true });
    writeFileSync(join(project, "app", "[id]", "page.tsx"), "export default function Page() {}\n");
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test("an existing literal path wins over glob interpretation", async () => {
    const literal = join(project, "app", "[id]", "page.tsx").replaceAll("\\", "/");
    expect(await expandGlobs([literal], project)).toEqual([literal]);
    expect(await expandGlobs(["app/[id]/page.tsx"], project)).toEqual(["app/[id]/page.tsx"]);
  });

  test("a pattern that is not an existing path still expands", async () => {
    expect(await expandGlobs(["app/*/page.tsx"], project)).toEqual(["app/[id]/page.tsx"]);
  });
});

describe("validateEncoding", () => {
  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("rejects Object.prototype key %s", (name) => {
    expect(() => validateEncoding(name)).toThrow(/Unsupported encoding/);
  });

  test("still normalizes supported names", () => {
    expect(validateEncoding("UTF8")).toBe("utf-8");
    expect(validateEncoding(undefined)).toBe("utf-8");
  });
});
