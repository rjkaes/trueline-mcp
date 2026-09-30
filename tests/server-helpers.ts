import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SERVER = join(import.meta.dir, "..", "src", "server.ts");

export interface Reply {
  jsonrpc?: string;
  id: unknown;
  result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

// Empty HOME, so the machine's ~/.claude/settings.json deny rules never leak into a subprocess.
export function createSandbox(prefix: string): { sandbox: string; fakeHome: string } {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const fakeHome = join(sandbox, "home");
  mkdirSync(fakeHome);
  return { sandbox, fakeHome };
}

// server.ts starts listening on import, so tests drive it over stdio like an MCP client.
export function spawnServer(env: Record<string, string>, command: string[] = ["bun", SERVER]) {
  return Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
}

// Reads newline-delimited replies from the server until `done` accepts the list so far.
export async function readReplies(
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
