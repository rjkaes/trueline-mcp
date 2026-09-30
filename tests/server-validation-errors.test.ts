import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueTestRef } from "./helpers.ts";
import { type Reply, readReplies, spawnServer } from "./server-helpers.ts";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ text: string; isError: boolean }> {
  const proc = spawnServer(env);
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    proc.stdin.flush();

    const replies = await readReplies(proc, (all) => all.some((reply) => reply.id === 1));
    const result = replies.find((reply) => reply.id === 1)?.result;
    if (!result?.content) throw new Error("server exited without responding");
    return { text: result.content[0].text, isError: result.isError === true };
  } finally {
    proc.kill();
  }
}

describe("tool param validation errors", () => {
  test("missing required field surfaces the custom message, not a zod JSON dump", async () => {
    const result = await callTool("trueline_search", { file_paths: ["/nonexistent/app.ts"] });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Invalid parameters: pattern: pattern is required");
  });

  describe("single-file tools", () => {
    let fixtureDir: string;
    let retryConfigPath: string;
    let retryConfigRef: string;

    beforeAll(() => {
      fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-server-test-")));
      retryConfigPath = join(fixtureDir, "retry-config.ts");
      const lines = ["export const maxRetries = 3;", "export const backoffMs = 250;"];
      writeFileSync(retryConfigPath, `${lines.join("\n")}\n`);
      retryConfigRef = issueTestRef(lines, 1, 2);
    });

    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    test("trueline_verify accepts file_path and validates its refs", async () => {
      const result = await callTool(
        "trueline_verify",
        { file_path: retryConfigPath, refs: [retryConfigRef] },
        { TRUELINE_ALLOWED_DIRS: fixtureDir },
      );

      expect(result.text).toBe("all refs valid");
      expect(result.isError).toBeFalsy();
    });

    test("trueline_verify rejects multiple paths like trueline_edit does", async () => {
      const result = await callTool(
        "trueline_verify",
        { file_paths: [retryConfigPath, retryConfigPath], refs: [retryConfigRef] },
        { TRUELINE_ALLOWED_DIRS: fixtureDir },
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("This tool accepts a single file path; received 2");
    });
  });

  test("nested field errors name the offending path", async () => {
    const result = await callTool("trueline_edit", {
      file_path: "/nonexistent/app.ts",
      edits: [{ range: "ab1-cd2", content: "const retries = 3;" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toStartWith('Invalid parameters: edits.0.ref: Missing "ref"');
    expect(result.text).not.toContain('"code"');
  });
});

describe("JSON-RPC framing and protocol errors", () => {
  const sentinelId = "done";
  const sentinel = `${JSON.stringify({ jsonrpc: "2.0", id: sentinelId, method: "ping" })}\n`;
  let sandbox: string;

  beforeAll(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "trueline-rpc-")));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // Writes each chunk in order, then a ping sentinel, and returns every reply that came before the
  // sentinel's. With closeStdin the sentinel is skipped and replies are read until the server exits.
  async function exchange(chunks: (string | Uint8Array)[], closeStdin = false): Promise<Reply[]> {
    const proc = spawnServer({ CLAUDE_PROJECT_DIR: sandbox });
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      for (const chunk of chunks) {
        proc.stdin.write(chunk);
        proc.stdin.flush();
        await Bun.sleep(20);
      }
      if (closeStdin) {
        proc.stdin.end();
      } else {
        proc.stdin.write(sentinel);
        proc.stdin.flush();
      }

      const replies = await readReplies(proc, (all) => !closeStdin && all.some((reply) => reply.id === sentinelId));
      return replies.filter((reply) => reply.id !== sentinelId);
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  const ping = (id: number, params?: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params })}\n`;
  const line = (message: unknown) => `${JSON.stringify(message)}\n`;

  // U+2028/U+2029 are legal raw inside JSON strings and JSON.stringify does not escape them, but
  // readline treats them as line breaks.
  test.each([
    ["U+2028", String.fromCharCode(0x2028)],
    ["U+2029", String.fromCharCode(0x2029)],
  ])("a request containing a raw %s is one message", async (_name, separator) => {
    const request = ping(1, { note: `before${separator}after` });
    expect(request).toContain(separator);

    expect(await exchange([request])).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  test("a message split mid-codepoint across writes is reassembled", async () => {
    const bytes = new TextEncoder().encode(ping(2, { note: `a${String.fromCharCode(0x2028)}b` }));
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte U+2028 sequence

    expect(await exchange([bytes.slice(0, cut), bytes.slice(cut)])).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
  });

  test("CRLF terminates a message", async () => {
    expect(await exchange([ping(3).replace(/\n$/, "\r\n")])).toEqual([{ jsonrpc: "2.0", id: 3, result: {} }]);
  });

  test("a final message without a newline is handled at EOF", async () => {
    expect(await exchange([ping(4).trimEnd()], true)).toEqual([{ jsonrpc: "2.0", id: 4, result: {} }]);
  });

  test("invalid JSON gets -32700 with a null id", async () => {
    const replies = await exchange(["{not json\n"]);

    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBeNull();
    expect(replies[0].error?.code).toBe(-32700);
  });

  test.each([["null"], ["42"], ['"text"'], ["true"], ['[{"jsonrpc":"2.0","id":7,"method":"ping"}]']])(
    "non-object message %s gets -32600 with a null id",
    async (raw) => {
      const replies = await exchange([`${raw}\n`]);

      expect(replies).toHaveLength(1);
      expect(replies[0].id).toBeNull();
      expect(replies[0].error?.code).toBe(-32600);
    },
  );

  test("a request without a method is an invalid request, not an unknown method", async () => {
    const replies = await exchange([line({ jsonrpc: "2.0", id: 8 })]);

    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(8);
    expect(replies[0].error?.code).toBe(-32600);
  });

  // MCP spec, Tools > Error Handling: unknown tools are protocol errors, code -32602.
  test("an unknown tool is invalid params", async () => {
    const replies = await exchange([
      line({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "trueline_nope", arguments: {} } }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0].id).toBe(9);
    expect(replies[0].error?.code).toBe(-32602);
    expect(replies[0].error?.message).toContain("trueline_nope");
  });

  test("an unsupported method is still -32601", async () => {
    const replies = await exchange([line({ jsonrpc: "2.0", id: 12, method: "resources/list" })]);

    expect(replies).toHaveLength(1);
    expect(replies[0].error?.code).toBe(-32601);
  });
});
