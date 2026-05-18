// Shared subprocess spawn helper for CLI subprocess tests.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn `bun src/cli.ts <args>` as a subprocess and capture output.
 *
 * Uses TRUELINE_ALLOWED_DIRS to allow the given extra directory.
 * Pass extraEnv to inject additional environment variables (e.g. CLAUDE_PROJECT_DIR).
 */
export function run(extraAllowedDir: string, ...args: string[]): RunResult;
export function run(extraAllowedDir: string, extraEnv: Record<string, string>, ...args: string[]): RunResult;
export function run(extraAllowedDir: string, ...rest: unknown[]): RunResult {
  // Detect overload: second arg is env record (plain object, not a string)
  let extraEnv: Record<string, string> = {};
  let args: string[];
  if (rest.length > 0 && typeof rest[0] === "object" && rest[0] !== null) {
    extraEnv = rest[0] as Record<string, string>;
    args = rest.slice(1) as string[];
  } else {
    args = rest as string[];
  }
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, TRUELINE_ALLOWED_DIRS: extraAllowedDir, ...extraEnv },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""),
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? ""),
      exitCode: e.status ?? 1,
    };
  }
}
