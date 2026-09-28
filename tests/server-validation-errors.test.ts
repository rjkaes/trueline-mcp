import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// server.ts starts listening on import, so drive it over stdio like an MCP client.
const serverPath = join(import.meta.dir, "..", "src", "server.ts");

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const proc = Bun.spawn(["bun", serverPath], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
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
