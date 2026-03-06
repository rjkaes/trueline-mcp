import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CACHE_FILE = join(tmpdir(), "trueline-mcp-update-check.json");

async function clearCache() {
  await unlink(CACHE_FILE).catch(() => {});
}

describe("scheduleUpdateCheck", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let stderrOutput: string;

  beforeEach(async () => {
    await clearCache();
    stderrOutput = "";
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    });
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await clearCache();
  });

  it("notifies when a newer version is available", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
    );

    const { scheduleUpdateCheck } = await import("../src/update-check.ts");
    scheduleUpdateCheck("1.0.0");

    // Wait for the async fire-and-forget to complete
    await Bun.sleep(100);

    expect(stderrOutput).toContain("update available");
    expect(stderrOutput).toContain("1.0.0");
    expect(stderrOutput).toContain("99.0.0");

    fetchMock.mockRestore();
  });

  it("stays silent when already on the latest version", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
    );

    const { scheduleUpdateCheck } = await import("../src/update-check.ts");
    scheduleUpdateCheck("1.0.0");

    await Bun.sleep(100);

    expect(stderrOutput).toBe("");

    fetchMock.mockRestore();
  });

  it("stays silent when on a newer version than registry", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
    );

    const { scheduleUpdateCheck } = await import("../src/update-check.ts");
    scheduleUpdateCheck("2.0.0");

    await Bun.sleep(100);

    expect(stderrOutput).toBe("");

    fetchMock.mockRestore();
  });

  it("stays silent when the registry is unreachable", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));

    const { scheduleUpdateCheck } = await import("../src/update-check.ts");
    scheduleUpdateCheck("1.0.0");

    await Bun.sleep(100);

    expect(stderrOutput).toBe("");

    fetchMock.mockRestore();
  });

  it("caches the check result", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }),
    );

    const { scheduleUpdateCheck } = await import("../src/update-check.ts");
    scheduleUpdateCheck("1.0.0");

    await Bun.sleep(100);

    const cached = JSON.parse(await readFile(CACHE_FILE, "utf-8"));
    expect(cached).toHaveProperty("timestamp");
    expect(cached).toHaveProperty("latestVersion", "99.0.0");

    fetchMock.mockRestore();
  });
});
