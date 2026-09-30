import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueTestRef } from "./helpers.ts";
import { createSandbox, type Reply, readReplies, SERVER, spawnServer } from "./server-helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let sandbox: string;
let fakeHome: string;

beforeAll(() => {
  ({ sandbox, fakeHome } = createSandbox("trueline-bughunt2-"));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// =============================================================================
// server.ts
// =============================================================================

describe("server.ts dispatch", () => {
  // JSON-RPC 2.0: an id is a string, a number or null. dispatch echoes any value back in a result
  // instead of rejecting the request, so the reply carries an id no conforming client can have sent.
  test.each([
    ["boolean", true],
    ["object", { nested: 1 }],
  ])("bug: a request with a %s id is an invalid request, not answered as if valid", async (_name, badId) => {
    const proc = spawnServer({ HOME: fakeHome, CLAUDE_PROJECT_DIR: sandbox });
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
    const proc = spawnServer({ HOME: fakeHome, CLAUDE_PROJECT_DIR: sandbox });
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

  // Exiting from a stdout.write callback is not a flush under Bun: with large replies queued the
  // process dies with them unsent, so the client sees missing and truncated replies. The server has
  // to leave through the event loop instead. A slow reader is a shell pipe that sleeps before reading,
  // which makes the server's stdout back up; Bun.spawn drains its pipe eagerly, so it cannot.
  async function repliesAfterImmediateEof(slowReader: boolean) {
    const bigFile = join(sandbox, "large-read.txt");
    writeFileSync(bigFile, `${Array.from({ length: 2000 }, (_, i) => `line${i} ${"x".repeat(1000)}`).join("\n")}\n`);
    const proc = spawnServer(
      { HOME: fakeHome, CLAUDE_PROJECT_DIR: sandbox },
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
