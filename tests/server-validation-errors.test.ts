import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueTestRef } from "./helpers.ts";

// server.ts starts listening on import, so drive it over stdio like an MCP client.
const serverPath = join(import.meta.dir, "..", "src", "server.ts");

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ text: string; isError: boolean }> {
  const proc = Bun.spawn(["bun", serverPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...env },
  });
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    proc.stdin.flush();

    // Skip notifications (no id) until the response to our request arrives.
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.id === 1) return { text: msg.result.content[0].text, isError: msg.result.isError };
      }
    }
    throw new Error("server exited without responding");
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
