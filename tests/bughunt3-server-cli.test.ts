import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearCaches, evaluateFilePath } from "../src/security.js";
import { validatePath } from "../src/tools/shared.ts";
import { createSandbox, readReplies, spawnServer } from "./server-helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let sandbox: string;
let fakeHome: string;

beforeAll(() => {
  ({ sandbox, fakeHome } = createSandbox("trueline-bughunt3-"));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// =============================================================================
// security.js
// =============================================================================

describe("security.js case-insensitive deny matching", () => {
  // APFS folds names with Unicode simple case folding (U+017F LATIN SMALL LETTER LONG S -> "s"),
  // but the regex is built with the `i` flag and no `u`, so JS folds only ASCII and the
  // cases toUpperCase() maps. NFC cannot bridge it: U+017F has no canonical decomposition.

  // src/security.js:97 — `i` without `u` misses Unicode simple case folds the filesystem applies
  test("bug: a long-s (U+017F) spelling dodges Read(secrets/**) though APFS treats it as the same name", () => {
    expect(evaluateFilePath("/work/ſecrets/key.txt", [["secrets/**"]], true).denied).toBe(true);
  });

  // realpath canonicalizes an existing target, so only a rule that names a symlink is exposed:
  // the lexical spelling is the one place the filesystem's folding is not already applied.
  // src/security.js:97 — a deny rule naming a symlink is bypassed through a folded spelling of the link
  test.skipIf(process.platform === "win32")(
    "bug: validatePath allows a file behind a symlink named by a deny rule when the link is spelled with U+017F",
    async () => {
      const dir = mkdtempSync(join(sandbox, "deny-fold-"));
      mkdirSync(join(dir, ".claude"));
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { deny: ["Read(secrets/**)"] } }),
      );
      clearCaches();
      mkdirSync(join(dir, "data"));
      writeFileSync(join(dir, "data", "key.txt"), "k\n");
      symlinkSync(join(dir, "data"), join(dir, "secrets"));

      const exact = await validatePath(join(dir, "secrets", "key.txt"), "Read", dir, []);
      expect(exact.ok).toBe(false);

      // Only a filesystem that folds U+017F to "s" (macOS APFS/HFS+ default) can reach the link this way.
      const folded = join(dir, "ſecrets", "key.txt");
      if (!existsSync(folded)) return;
      const result = await validatePath(folded, "Read", dir, []);
      expect(result.ok).toBe(false);
    },
  );
});

describe.skipIf(process.platform === "win32")("security.js absolute deny rules and symlinked directories", () => {
  // posixForms lets a "/"- or "~/"-anchored rule match through both spellings of the project or home
  // directory. A "//" rule is taken verbatim, so one that names the project through a symlinked
  // spelling (macOS /var -> /private/var, ~/code -> /Volumes/Data/code) never matches the canonical
  // spelling, which is the only form validatePath is guaranteed to test.
  // src/security.js:243 — a "//" rule spelled through a symlink misses the same file under its real path
  test("bug: Read(//<symlinked project spelling>/secrets/**) does not deny the file requested by its real path", async () => {
    const root = mkdtempSync(join(sandbox, "abs-rule-"));
    const real = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(join(real, ".claude"), { recursive: true });
    mkdirSync(join(real, "secrets"));
    writeFileSync(join(real, "secrets", "key.txt"), "k\n");
    symlinkSync(real, alias);
    writeFileSync(
      join(real, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: [`Read(//${alias.slice(1)}/secrets/**)`] } }),
    );
    clearCaches();

    const viaAlias = await validatePath(join(alias, "secrets", "key.txt"), "Read", real, []);
    expect(viaAlias.ok).toBe(false);

    const viaReal = await validatePath(join(real, "secrets", "key.txt"), "Read", real, []);
    expect(viaReal.ok).toBe(false);
  });
});

// =============================================================================
// server.ts
// =============================================================================

describe("server.ts tool descriptions", () => {
  // Sends each message to a fresh server and returns the reply to the last one. One reader per
  // process: readReplies cancels the pipe when it stops, so a second call on it would see nothing.
  async function call(message: unknown) {
    const proc = spawnServer({ HOME: fakeHome, CLAUDE_PROJECT_DIR: sandbox });
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
      const replies = await readReplies(proc, (all) => all.length > 0);
      return replies[0];
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  // The description of trueline_read carries a complete call as its example. Every path in it is
  // relative, which the same server rejects (requireAbsolutePath), so an agent that copies the
  // example gets an error for each entry. trueline_edit's example was already made absolute.
  // src/server.ts:359 — trueline_read description example uses relative paths the tool rejects
  test("bug: the example call in the trueline_read description is not rejected as relative paths", async () => {
    const list = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = list.result?.tools as { name: string; description: string }[];
    const description = tools.find((tool) => tool.name === "trueline_read")?.description ?? "";
    const example = /Example: (\{.*\})\.?$/.exec(description)?.[1];
    expect(example).toBeDefined();

    const reply = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "trueline_read", arguments: JSON.parse(example as string) },
    });
    const text = reply.result?.content?.[0].text ?? "";

    expect(text).not.toBe("");
    expect(text).not.toContain("must be an absolute path");
  });
});

// =============================================================================
// cli/edit.ts
// =============================================================================

describe("cli/edit.ts schema parity with trueline_edit", () => {
  // editSchema requires edits.min(1), and parseIntFlag's contract is that the CLI enforces the
  // minimums the MCP schemas do. `--edits '[]'` slips through: handleEdit has no edits to apply and
  // answers "(no changes)" with exit 0, so a script that built an empty list never hears about it.
  // src/cli/edit.ts:51 — an empty --edits array is accepted (exit 0) though trueline_edit rejects it
  test("bug: --edits '[]' is rejected like trueline_edit's edits.min(1), not reported as a clean no-op", () => {
    const dir = join(sandbox, "empty-edits");
    mkdirSync(dir);
    writeFileSync(join(dir, "greeting.txt"), "hello\n");
    const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome };
    for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "TRUELINE_ALLOWED_DIRS"]) {
      delete env[name];
    }

    const result = spawnSync("bun", [CLI, "edit", "greeting.txt", "--edits", "[]"], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 20_000,
    });

    expect(readFileSync(join(dir, "greeting.txt"), "utf-8")).toBe("hello\n");
    expect(result.status).not.toBe(0);
  });
});

// =============================================================================
// cli/io.ts
// =============================================================================

describe("cli/io.ts exit codes", () => {
  // io.ts exit scheme: 1 = "valid pattern but zero matches", 2 = tool error. With one unreadable path
  // the handler answers with an error result (exit 2), but with two it answers "No matches ... across
  // 2 files" plus a per-file error section, and emitResult keys the exit code on that text prefix
  // alone. A script treats 1 as "searched, nothing there" when nothing was searched.
  // src/cli/io.ts:218 — search exits 1 (no matches) when every file failed to open
  test("bug: search over paths that all fail to read exits 2, not the zero-matches code 1", () => {
    const dir = join(sandbox, "search-all-missing");
    mkdirSync(dir);
    const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome };
    for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "TRUELINE_ALLOWED_DIRS"]) {
      delete env[name];
    }

    const result = spawnSync("bun", [CLI, "search", "needle", "missing-a.txt", "missing-b.txt"], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 20_000,
    });

    expect(`${result.stdout}${result.stderr}`).toContain("not found");
    expect(result.status).toBe(2);
  });
});
