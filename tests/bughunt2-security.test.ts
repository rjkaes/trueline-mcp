import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCaches } from "../src/security.js";
import { handleEdit } from "../src/tools/edit.ts";
import { handleOutline } from "../src/tools/outline.ts";
import { handleRead, handleReadMulti } from "../src/tools/read.ts";
import { handleSearch } from "../src/tools/search.ts";
import { validatePath } from "../src/tools/shared.ts";

// Machine-level ~/.claude/settings.json is also read by validatePath; fixtures use names
// such global rules do not commonly target.
function makeDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function writeProjectSettings(project: string, deny: string[], prefix = ""): void {
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.json"), prefix + JSON.stringify({ permissions: { deny } }));
  clearCaches();
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content[0].text ?? "";
}

async function readRef(file: string, project: string): Promise<{ ref: string; firstHash: string; lastHash: string }> {
  const out = textOf(await handleRead({ file_path: file, ranges: ["1-2"], projectDir: project }));
  const ref = /ref: (\S+)/.exec(out)?.[1] ?? "";
  const firstHash = /^([a-z]{2})1\t/m.exec(out)?.[1] ?? "";
  const lastHash = /^([a-z]{2})2\t/m.exec(out)?.[1] ?? "";
  return { ref, firstHash, lastHash };
}

describe.skipIf(process.platform === "win32")("deny-pattern semantics", () => {
  // `**` compiles to `.*`, which does not match \n, \r, U+2028 or U+2029, while `*` compiles to
  // `[^/]*`, which does. A rule that covers a directory therefore stops covering names with them.
  test("bug: Read(secrets/**) does not deny a file whose name contains a newline", async () => {
    const project = makeDir("bh2-nl-file-");
    try {
      mkdirSync(join(project, "secrets"));
      const file = join(project, "secrets", "key\nfile.txt");
      writeFileSync(file, "hunter2\n");
      writeProjectSettings(project, ["Read(secrets/**)"]);

      const result = await validatePath(file, "Read", project, []);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("bug: Read(**/.zzvault) does not deny a .zzvault below a directory whose name contains U+2028", async () => {
    const project = makeDir("bh2-nl-dir-");
    try {
      const dir = join(project, "deploy\u2028prod");
      mkdirSync(dir);
      const file = join(dir, ".zzvault");
      writeFileSync(file, "API_TOKEN=abc123\n");
      writeProjectSettings(project, ["Read(**/.zzvault)"]);

      const result = await validatePath(file, "Read", project, []);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  // APFS treats NFC and NFD spellings as one name (realpath returns the on-disk form), just as it
  // ignores case; evaluateFilePath folds case on darwin but not normalization.
  test.skipIf(process.platform !== "darwin")(
    "bug: a deny pattern typed in NFD does not match the same file reached by its NFC on-disk name",
    async () => {
      const project = makeDir("bh2-nfd-");
      try {
        const nfc = "caf\u00e9.key";
        const nfd = "cafe\u0301.key";
        expect(nfc).not.toBe(nfd);
        writeFileSync(join(project, nfc), "k\n");
        writeProjectSettings(project, [`Read(${nfd})`]);

        const result = await validatePath(join(project, nfc), "Read", project, []);
        expect(result.ok).toBe(false);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    },
  );

  // JSON.parse rejects a leading U+FEFF and readToolDenyPatterns treats any parse failure as
  // "no rules", so a BOM-prefixed settings file (Windows editors) silently disables every deny rule.
  test("bug: a BOM-prefixed settings.json silently drops all deny rules", async () => {
    const project = makeDir("bh2-bom-");
    try {
      const file = join(project, "vault.txt");
      writeFileSync(file, "hunter2\n");
      writeProjectSettings(project, ["Read(vault.txt)"], "\uFEFF");

      const result = await validatePath(file, "Read", project, []);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  // Non-dry-run trueline_edit consults only Edit rules, yet its streaming pass reads the file and
  // reports the actual 2-letter hash of the addressed line (and the line count) on a mismatch.
  test("bug: trueline_edit answers about the content of a Read-denied file", async () => {
    const project = makeDir("bh2-readdeny-edit-");
    try {
      const file = join(project, "vault.txt");
      writeFileSync(file, "line one\nroot-password=hunter2\nline three\n");
      writeProjectSettings(project, ["Read(vault.txt)"]);

      const result = await handleEdit({
        file_path: file,
        projectDir: project,
        edits: [{ range: "aa2-aa2", ref: "aa1-aa3/aaaaaa", content: "x" }],
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("deny pattern");
      expect(textOf(result)).not.toContain("file has");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("edit temp files", () => {
  // streamingEdit opens the temp file with the default mode (0666 & ~umask) and chmods the
  // destination only after the rename, so the plaintext of a 0600 file sits in a 0644 file
  // in the same directory for the whole edit.
  test("bug: trueline_edit streams a 0600 file into a group/world-readable temp file", async () => {
    const previousUmask = process.umask(0o022);
    const project = makeDir("bh2-tmpmode-");
    try {
      const file = join(project, "prod.env");
      const lines = Array.from({ length: 200_000 }, (_, i) => `SECRET_${i}=value${i}`);
      writeFileSync(file, `${lines.join("\n")}\n`);
      chmodSync(file, 0o600);
      const { ref, firstHash, lastHash } = await readRef(file, project);

      const modes: number[] = [];
      let finished = false;
      const edit = handleEdit({
        file_path: file,
        projectDir: project,
        edits: [{ range: `${firstHash}1-${lastHash}2`, ref, content: "A=1\nB=2" }],
      }).finally(() => {
        finished = true;
      });
      while (!finished) {
        for (const name of readdirSync(project)) {
          if (!name.startsWith(".trueline-tmp-")) continue;
          try {
            modes.push(statSync(join(project, name)).mode & 0o777);
          } catch {
            // renamed away between readdir and stat
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const result = await edit;

      expect(result.isError).toBeUndefined();
      expect(modes.length).toBeGreaterThan(0);
      for (const mode of modes) expect(mode & 0o077).toBe(0);
    } finally {
      process.umask(previousUmask);
      rmSync(project, { recursive: true, force: true });
    }
  });

  // The PostToolUse hand-off file holds the old and new lines of every edit, sits at a name
  // derived only from cwd + file_path, and is written with the default mode. In a shared /tmp
  // (Linux) any local user can read it; update-check.ts already assumes /tmp is hostile.
  test("bug: trueline_edit leaves its diff hand-off file readable by group and others", async () => {
    const previousUmask = process.umask(0o022);
    const project = makeDir("bh2-diffmode-");
    const file = join(project, "prod.env");
    const cwdHash = createHash("sha256").update(`${project}\0${file}`).digest("hex").slice(0, 12);
    const diffPath = join(tmpdir(), `trueline-edit-${cwdHash}.diff`);
    try {
      rmSync(diffPath, { force: true });
      writeFileSync(file, "DB_PASSWORD=hunter2\nPORT=80\n", { mode: 0o600 });
      const { ref, firstHash } = await readRef(file, project);

      const result = await handleEdit({
        file_path: file,
        projectDir: project,
        edits: [{ range: `${firstHash}1-${firstHash}1`, ref, content: "DB_PASSWORD=changed" }],
      });
      expect(result.isError).toBeUndefined();

      expect(statSync(diffPath).mode & 0o077).toBe(0);
    } finally {
      process.umask(previousUmask);
      rmSync(diffPath, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("path oracle", () => {
  // An entry with glob characters that names an existing path is passed through to validatePath
  // ("existing literal wins"); one that does not exist and lies outside the boundary is dropped
  // by expandGlobs. The two answers differ, so an outside path's existence can be probed.
  test("bug: an outside path with glob characters answers differently when it exists", async () => {
    const root = makeDir("bh2-oracle-");
    try {
      const project = join(root, "proj");
      const outside = join(root, "out");
      mkdirSync(project);
      mkdirSync(outside);
      writeFileSync(join(outside, "[x].ts"), "export const a = 1;\n");

      const existing = join(outside, "[x].ts");
      const missing = join(outside, "[y].ts");
      const norm = (text: string) => text.replaceAll(root, "<root>").replaceAll("[x]", "[N]").replaceAll("[y]", "[N]");
      const ctx = { projectDir: project, allowedDirs: [] as string[], requireAbsolutePath: true };

      const readExisting = textOf(await handleReadMulti({ file_paths: [existing], ...ctx }));
      const readMissing = textOf(await handleReadMulti({ file_paths: [missing], ...ctx }));
      expect(norm(readExisting)).toBe(norm(readMissing));

      const searchExisting = textOf(await handleSearch({ file_paths: [existing], pattern: "a", ...ctx }));
      const searchMissing = textOf(await handleSearch({ file_paths: [missing], pattern: "a", ...ctx }));
      expect(norm(searchExisting)).toBe(norm(searchMissing));

      const outlineExisting = textOf(await handleOutline({ file_paths: [existing], ...ctx }));
      const outlineMissing = textOf(await handleOutline({ file_paths: [missing], ...ctx }));
      expect(norm(outlineExisting)).toBe(norm(outlineMissing));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
