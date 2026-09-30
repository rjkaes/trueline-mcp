import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { handleSearch } from "../src/tools/search.ts";
import { getText, useTestDir } from "./helpers.ts";

const testDir = useTestDir("trueline-bughunt3-read-search-");

describe("search: multiline anchors", () => {
  // src/tools/search.ts:90 — the `m` flag also anchors ^ and $ at U+2028/U+2029 inside a line,
  // which line mode (and the splitter) never treat as line breaks
  test("multiline ^ and $ do not anchor at a U+2028 or U+2029 inside a line", async () => {
    const file = join(testDir(), "release-notes.txt");
    writeFileSync(file, "intro\nsummary\u2028heading\nfooter\u2029end\ntail\n");

    for (const pattern of ["^heading", "footer$"]) {
      const lineMode = getText(await handleSearch({ file_paths: [file], pattern, regex: true, projectDir: testDir() }));
      expect(lineMode).toContain("No matches");

      const multiline = getText(
        await handleSearch({ file_paths: [file], pattern, multiline: true, projectDir: testDir() }),
      );
      expect(multiline).toContain("No matches");
    }
  });

  // Known gap: zero-length multiline matches are skipped on purpose (search-multiline.ts:53).
  test.failing("multiline ^$ finds a blank line as line-mode regex search does", async () => {
    const file = join(testDir(), "changelog.md");
    writeFileSync(file, "# Title\n\nbody\n");

    const lineMode = getText(
      await handleSearch({ file_paths: [file], pattern: "^$", regex: true, context_lines: 0, projectDir: testDir() }),
    );
    expect(lineMode).toMatch(/^->[a-z]{2}2\t$/m);

    const multiline = getText(
      await handleSearch({
        file_paths: [file],
        pattern: "^$",
        multiline: true,
        context_lines: 0,
        projectDir: testDir(),
      }),
    );
    expect(multiline).toMatch(/^->[a-z]{2}2\t$/m);
  });
});

describe("verify: unreadable file", () => {
  // Bun's realpath fails on an unreadable file, so node (the shipped runtime) is used, as in
  // bughunt2-read-search.test.ts: its realpath succeeds and open() throws EACCES.
  const VERIFY_URL = JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "src", "tools", "verify.ts")).href);

  // src/tools/verify.ts:76-77 — a non-binary read error is rethrown, so the server answers
  // "Internal error: EACCES ... open '<resolved path>'"; read and search return an error result
  // that carries only the errno code
  // chmod 0o000 does not deny reads on Windows or to root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "verify of an unreadable file returns an error result instead of throwing",
    () => {
      const locked = join(testDir(), "locked.txt");
      writeFileSync(locked, "needle in locked\n");
      chmodSync(locked, 0o000);
      try {
        const script = `
        import { handleVerify } from ${VERIFY_URL};
        try {
          const result = await handleVerify({
            file_path: ${JSON.stringify(locked)},
            refs: ["aa1-aa1/aaaaaa"],
            projectDir: ${JSON.stringify(testDir())},
          });
          console.log(JSON.stringify({ isError: result.isError === true, text: result.content[0].text }));
        } catch (err) {
          console.log(JSON.stringify({ threw: String(err.message) }));
        }`;
        const run = spawnSync(
          "node",
          ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
          {
            encoding: "utf-8",
            timeout: 30_000,
          },
        );
        const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
          threw?: string;
          isError?: boolean;
          text?: string;
        };

        expect(out.threw).toBeUndefined();
        expect(out.isError).toBe(true);
      } finally {
        chmodSync(locked, 0o644);
      }
    },
  );
});
