// Shared subprocess spawn helper for CLI subprocess tests.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

export interface Invocation {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

// Unlike run() this supports cwd and stdin, and strips an inherited
// CLAUDE_PROJECT_DIR so results do not depend on the shell the suite runs from.
export function trueline(tmpDir: string, args: string[], opts: Invocation = {}): RunResult {
  const env: Record<string, string | undefined> = { ...process.env, TRUELINE_ALLOWED_DIRS: tmpDir, ...opts.env };
  if (opts.env?.CLAUDE_PROJECT_DIR === undefined) delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync("bun", [CLI, ...args], {
    cwd: opts.cwd ?? tmpDir,
    env,
    input: opts.input ?? "",
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? -1 };
}

export function scratch(tmpDir: string, name: string, files: Record<string, string>): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) writeFileSync(join(dir, fileName), content);
  return dir;
}

/** Per-line hashLines (e.g. "ab1") and the whole-file ref from `trueline read <file>`. */
export function holdRefs(tmpDir: string, file: string) {
  const { stdout } = trueline(tmpDir, ["read", file]);
  const hashLines = [...stdout.matchAll(/^([a-z]{2}\d+)\t/gm)].map((m) => m[1]);
  const ref = /^ref: (\S+)$/m.exec(stdout)?.[1];
  if (!ref || hashLines.length === 0) throw new Error(`setup: could not parse read output:\n${stdout}`);
  return { hashLines, ref };
}
