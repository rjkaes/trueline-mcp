import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { issueTestRef } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const SERVER = join(import.meta.dir, "..", "src", "server.ts");
const UPDATE_CHECK_URL = pathToFileURL(join(import.meta.dir, "..", "src", "update-check.ts")).href;

let sandbox: string;
// Empty HOME, so the machine's ~/.claude/settings.json deny rules never leak into a subprocess.
let fakeHome: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "trueline-bughunt2-")));
  fakeHome = join(sandbox, "home");
  mkdirSync(fakeHome);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// A fresh cache entry keeps the child off the network and its stdout free of update notices.
function freshUpdateCache(dir: string, latestVersion: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trueline-mcp-update-check.json"), JSON.stringify({ timestamp: Date.now(), latestVersion }));
  return dir;
}

interface Reply {
  jsonrpc?: string;
  id: unknown;
  result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

// Reads newline-delimited replies from the server until `done` accepts the list so far.
async function readReplies(
  proc: { stdout: ReadableStream<Uint8Array> },
  done: (replies: Reply[]) => boolean,
): Promise<Reply[]> {
  const replies: Reply[] = [];
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of proc.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line) replies.push(JSON.parse(line) as Reply);
    if (done(replies)) break;
  }
  return replies;
}

function spawnServer(
  projectDir: string,
  tmp: string,
  extraEnv: Record<string, string> = {},
  command: string[] = ["bun", SERVER],
) {
  return Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // os.tmpdir() reads TEMP/TMP on Windows and TMPDIR elsewhere; set all so the update cache stays in tmp.
    env: {
      ...process.env,
      HOME: fakeHome,
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      CLAUDE_PROJECT_DIR: projectDir,
      ...extraEnv,
    },
  });
}

// =============================================================================
// server.ts
// =============================================================================

describe("server.ts dispatch", () => {
  // handleLine starts dispatch() for every line without waiting for the previous one, so two edits
  // to one file run streamingEdit side by side. Each passes the mtime check before either renames,
  // then the second rename replaces the first's result: both calls answer success, one edit is gone.
  // A client that fans out subagent edits over one server connection hits this.
  test("bug: concurrent trueline_edit calls on one file never lose an edit they reported as applied", async () => {
    const tmp = freshUpdateCache(join(sandbox, "race-cache"), "0.0.1");
    const lost: string[] = [];

    for (let trial = 0; trial < 3; trial++) {
      const dir = join(sandbox, `race-${trial}`);
      mkdirSync(dir);
      const lines = ["alpha", "bravo", "charlie", "delta"];
      const file = join(dir, "names.txt");
      writeFileSync(file, `${lines.join("\n")}\n`);
      const edit = (id: number, line: number, content: string) => {
        const ref = issueTestRef(lines, line, line);
        const args = { file_path: file, edits: [{ range: ref.split("/")[0], ref, content }] };
        return `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "trueline_edit", arguments: args } })}\n`;
      };

      const proc = spawnServer(dir, tmp);
      const timer = setTimeout(() => proc.kill(), 10_000);
      let replies: Reply[];
      try {
        // One write, so both requests are dispatched before either finishes.
        proc.stdin.write(edit(1, 1, "ALPHA") + edit(2, 3, "CHARLIE"));
        proc.stdin.flush();
        replies = await readReplies(proc, (all) => all.length >= 2);
      } finally {
        clearTimeout(timer);
        proc.kill();
      }

      const final = readFileSync(file, "utf-8");
      const applied = new Map<number, string>([
        [1, "ALPHA"],
        [2, "CHARLIE"],
      ]);
      for (const reply of replies) {
        const succeeded = !reply.result?.isError;
        const content = applied.get(reply.id as number) as string;
        if (succeeded && !final.includes(content))
          lost.push(`trial ${trial}: ${content} reported applied, file is ${JSON.stringify(final)}`);
      }
    }

    expect(lost).toEqual([]);
  });

  // JSON-RPC 2.0: an id is a string, a number or null. dispatch echoes any value back in a result
  // instead of rejecting the request, so the reply carries an id no conforming client can have sent.
  test.each([
    ["boolean", true],
    ["object", { nested: 1 }],
  ])("bug: a request with a %s id is an invalid request, not answered as if valid", async (_name, badId) => {
    const tmp = freshUpdateCache(join(sandbox, "id-cache"), "0.0.1");
    const proc = spawnServer(sandbox, tmp);
    const timer = setTimeout(() => proc.kill(), 10_000);
    let replies: Reply[];
    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: badId, method: "ping" })}\n`);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "done", method: "ping" })}\n`);
      proc.stdin.flush();
      replies = await readReplies(proc, (all) => all.some((reply) => reply.id === "done"));
    } finally {
      clearTimeout(timer);
      proc.kill();
    }

    const first = replies[0];
    expect(first.result).toBeUndefined();
    expect(first.error?.code).toBe(-32600);
  });

  // ZodError is reported as "Invalid parameters: ...", but the Errors coerceParams throws for bad
  // client input (built-in Edit shape, several paths for a single-file tool) fall into the generic
  // catch, so the agent is told the server broke and the stderr log records a server fault.
  test("bug: a rejected old_string/new_string edit is not reported as an internal error", async () => {
    const tmp = freshUpdateCache(join(sandbox, "label-cache"), "0.0.1");
    const proc = spawnServer(sandbox, tmp);
    const timer = setTimeout(() => proc.kill(), 10_000);
    let replies: Reply[];
    try {
      const args = { file_path: join(sandbox, "notes.txt"), edits: [{ old_string: "alpha", new_string: "ALPHA" }] };
      proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "trueline_edit", arguments: args } })}\n`,
      );
      proc.stdin.flush();
      replies = await readReplies(proc, (all) => all.some((reply) => reply.id === 1));
    } finally {
      clearTimeout(timer);
      proc.kill();
    }

    const text = replies[0].result?.content?.[0].text ?? "";
    expect(replies[0].result?.isError).toBe(true);
    expect(text).toContain("old_string/new_string");
    expect(text).not.toStartWith("Internal error");
  });

  // The update check is fire-and-forget, but its fetch keeps the event loop alive after stdin
  // closes. A client that closes stdin to shut the server down waits out the registry timeout
  // (3 s) instead of seeing the process exit. A proxy that accepts and never answers stands in for
  // a slow or unreachable registry.
  test("bug: the server exits promptly after stdin closes while the update check is still pending", async () => {
    const tmp = join(sandbox, "empty-cache");
    mkdirSync(tmp);
    const blackhole = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {}, close() {} } });
    const proxy = `http://127.0.0.1:${blackhole.port}`;
    const proc = spawnServer(sandbox, tmp, {
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      NO_PROXY: "",
      no_proxy: "",
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      proc.stdin.flush();
      await readReplies(proc, (all) => all.length >= 1);

      const closedAt = Date.now();
      proc.stdin.end();
      await proc.exited;

      expect(Date.now() - closedAt).toBeLessThan(1500);
    } finally {
      clearTimeout(timer);
      proc.kill();
      blackhole.stop(true);
    }
  });

  // Exiting from a stdout.write callback is not a flush under Bun: with large replies queued the
  // process dies with them unsent, so the client sees missing and truncated replies. The server has
  // to leave through the event loop instead. A slow reader is a shell pipe that sleeps before reading,
  // which makes the server's stdout back up; Bun.spawn drains its pipe eagerly, so it cannot.
  async function repliesAfterImmediateEof(slowReader: boolean) {
    const bigFile = join(sandbox, "large-read.txt");
    writeFileSync(bigFile, `${Array.from({ length: 2000 }, (_, i) => `line${i} ${"x".repeat(1000)}`).join("\n")}\n`);
    const tmp = freshUpdateCache(join(sandbox, `eof-cache-${slowReader}`), "0.0.1");
    const proc = spawnServer(
      sandbox,
      tmp,
      {},
      slowReader ? ["sh", "-c", 'bun "$0" | { sleep 1.5; cat; }', SERVER] : undefined,
    );
    const timer = setTimeout(() => proc.kill(), 20_000);
    try {
      const call = (id: number) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "trueline_read", arguments: { file_path: bigFile } },
        });
      const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      proc.stdin.write(`${[init, call(2), call(3), call(4), call(5)].join("\n")}\n`);
      proc.stdin.end();
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      const ids = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return (JSON.parse(line) as Reply).id as string | number;
          } catch {
            return `truncated:${line.length}`;
          }
        })
        .sort();
      return { ids, bytes: output.length };
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  // Each read answers with ~2 MB (the 2000-line output cap); bytes guards against a vacuous pass if replies shrink.
  test("bug: large responses pending at stdin EOF are all delivered", async () => {
    const { ids, bytes } = await repliesAfterImmediateEof(false);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(bytes).toBeGreaterThan(1_000_000);
  });

  test.skipIf(process.platform === "win32")(
    "bug: large responses pending at stdin EOF are all delivered to a slow reader",
    async () => {
      const { ids, bytes } = await repliesAfterImmediateEof(true);
      expect(ids).toEqual([1, 2, 3, 4, 5]);
      expect(bytes).toBeGreaterThan(1_000_000);
    },
  );
});

// =============================================================================
// update-check.ts
// =============================================================================

describe("update-check.ts", () => {
  // Runs scheduleUpdateCheck in a child whose TMPDIR holds the cache, with the registry faked to
  // answer 99.0.0, and returns every onUpdate call.
  function runUpdateCheck(current: string, cacheDir: string): { current: string; latest: string }[] {
    const script = join(cacheDir, "run-update-check.ts");
    writeFileSync(
      script,
      `import { scheduleUpdateCheck } from ${JSON.stringify(UPDATE_CHECK_URL)};
globalThis.fetch = (async () => new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 })) as typeof fetch;
const seen: unknown[] = [];
scheduleUpdateCheck(process.argv[2], (info) => seen.push(info));
await Bun.sleep(400);
console.log(JSON.stringify(seen));
`,
    );
    const result = spawnSync("bun", [script, current], {
      cwd: sandbox,
      env: { ...process.env, HOME: fakeHome, TMPDIR: cacheDir, TEMP: cacheDir, TMP: cacheDir },
      encoding: "utf-8",
      timeout: 20_000,
    });
    return JSON.parse(result.stdout);
  }

  // A cache entry is fresh when `now - timestamp < 24h`; a timestamp ahead of the clock makes that
  // difference negative, so the entry stays fresh until the clock catches up. The file sits in a
  // temp dir other users can write, and a clock that was briefly wrong leaves the same entry.
  test("bug: a cache entry stamped in the future does not suppress the registry check", () => {
    const cacheDir = join(sandbox, "future-cache");
    mkdirSync(cacheDir);
    const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(cacheDir, "trueline-mcp-update-check.json"),
      JSON.stringify({ timestamp: Date.now() + tenYears, latestVersion: "0.0.1" }),
    );

    expect(runUpdateCheck("1.0.0", cacheDir)).toEqual([{ current: "1.0.0", latest: "99.0.0" }]);
  });

  // isVersion accepts "+build" suffixes on purpose, but compareVersions treats them as part of the
  // core version: semver says build metadata is ignored when ordering.
  test("bug: build metadata does not make the same version look newer", () => {
    const cacheDir = freshUpdateCache(join(sandbox, "build-meta-cache"), "1.0.0+build.7");

    expect(runUpdateCheck("1.0.0", cacheDir)).toEqual([]);
  });

  // writeFile follows a symlink at the cache path, so anyone who can plant one in a shared temp
  // dir gets the next successful check to overwrite the target with the cache JSON.
  test.skipIf(process.platform === "win32")("bug: the cache write does not follow a planted symlink", () => {
    const cacheDir = join(sandbox, "symlink-cache");
    mkdirSync(cacheDir);
    const victim = join(sandbox, "victim-notes.txt");
    writeFileSync(victim, "precious notes\n");
    symlinkSync(victim, join(cacheDir, "trueline-mcp-update-check.json"));

    runUpdateCheck("1.0.0", cacheDir);

    expect(readFileSync(victim, "utf-8")).toBe("precious notes\n");
  });
});

// =============================================================================
// cli/io.ts
// =============================================================================

describe("cli/io.ts @file operands", () => {
  // `trueline read` refuses a file a Read deny rule covers, but @path operands go straight to
  // readFileSync, so the same file can be pulled into a diff, or into an error message, by naming
  // it as the value of --content, --edits or --refs.
  test("bug: edit --content @file refuses a file a project deny rule covers", () => {
    const dir = join(sandbox, "deny-at-file");
    mkdirSync(join(dir, "secrets"), { recursive: true });
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, "greeting.txt"), "hello\n");
    writeFileSync(join(dir, "secrets", "api-key.txt"), "sk-live-4f9a1c\n");
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Read(secrets/**)"] } }),
    );
    const ref = issueTestRef(["hello"], 1, 1);

    const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome };
    for (const name of ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "TRUELINE_ALLOWED_DIRS"]) {
      delete env[name];
    }
    const result = spawnSync(
      "bun",
      [
        CLI,
        "edit",
        "greeting.txt",
        "--ref",
        ref,
        "--range",
        ref.split("/")[0],
        "--content",
        "@secrets/api-key.txt",
        "--dry-run",
      ],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: 20_000 },
    );

    expect(`${result.stdout}${result.stderr}`).not.toContain("sk-live-4f9a1c");
    expect(result.status).not.toBe(0);
  });
});

describe("cli/io.ts stdin under node", () => {
  // io.ts asks process.stdin.isTTY before readFileSync(0). Under node that getter opens the fd as a
  // non-blocking stream, so the synchronous read throws EAGAIN whenever the pipe is empty at that
  // moment: any producer slower than the CLI, or any input past the pipe buffer. scripts/resolve-binary.cjs
  // runs dist/cli.js under node when bun is not installed.
  test("bug: --content - waits for a producer that writes after the CLI starts, under node", async () => {
    const outDir = join(sandbox, "node-cli");
    const bundle = spawnSync("bun", ["build", CLI, "--target=node", "--outfile", join(outDir, "cli.js")], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(bundle.status).toBe(0);

    const dir = join(sandbox, "slow-stdin");
    mkdirSync(dir);
    const lines = ["alpha", "bravo", "charlie"];
    writeFileSync(join(dir, "names.txt"), `${lines.join("\n")}\n`);
    const ref = issueTestRef(lines, 2, 2);
    const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, CLAUDE_PROJECT_DIR: dir };
    for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "TRUELINE_ALLOWED_DIRS"]) delete env[name];

    const proc = Bun.spawn(
      [
        "node",
        join(outDir, "cli.js"),
        "edit",
        "names.txt",
        "--ref",
        ref,
        "--range",
        ref.split("/")[0],
        "--content",
        "-",
        "--dry-run",
      ],
      { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), 20_000);
    try {
      // Long enough for node to start and reach the stdin read with nothing in the pipe.
      await Bun.sleep(800);
      try {
        proc.stdin.write("BRAVO\n");
        proc.stdin.end();
      } catch {
        // The CLI already exited; the assertions below report why.
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).not.toContain("EAGAIN");
      expect(stdout).toContain("+BRAVO");
      expect(exitCode).toBe(0);
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  });
});
