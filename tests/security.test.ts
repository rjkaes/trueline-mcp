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

  test("escapes regex metacharacters in glob literals", () => {
    const re = fileGlobToRegex("file[1].ts");
    expect(re.test("file[1].ts")).toBe(true);
    expect(re.test("fileX.ts")).toBe(false); // would match if [] were treated as char class
  });

  test("dot is literal not regex wildcard", () => {
    const re = fileGlobToRegex("*.env");
    expect(re.test("app.env")).toBe(true);
    expect(re.test("appXenv")).toBe(false); // would match if . were regex any-char
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
