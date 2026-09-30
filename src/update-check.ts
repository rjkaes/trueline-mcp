import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE_NAME = "trueline-mcp";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILE = join(tmpdir(), "trueline-mcp-update-check.json");
const REGISTRY_TIMEOUT_MS = 3000;

interface CachedCheck {
  timestamp: number;
  latestVersion: string;
}

async function readCache(): Promise<CachedCheck | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as CachedCheck;
  } catch {
    return null;
  }
}

async function writeCache(entry: CachedCheck): Promise<void> {
  await writeFile(CACHE_FILE, JSON.stringify(entry)).catch(() => {});
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Non-blocking update check. Compares the running version against the latest
 * on npm and notifies via the provided callback if a newer version is available.
 * Checks at most once per 24 hours (cached in a temp file).
 *
 * @param onUpdate Called with `{ current, latest }` when a newer version exists.
 */
export function scheduleUpdateCheck(
  currentVersion: string,
  onUpdate: (info: { current: string; latest: string }) => void,
): void {
  // Fire-and-forget — never delays startup or rejects into the event loop
  void (async () => {
    const cached = await readCache();

    let latest = cached && Date.now() - cached.timestamp < CHECK_INTERVAL_MS ? cached.latestVersion : null;
    if (!latest) {
      latest = await fetchLatestVersion();
      if (!latest) return;
      await writeCache({ timestamp: Date.now(), latestVersion: latest });
    }
    if (compareVersions(latest, currentVersion) > 0) {
      onUpdate({ current: currentVersion, latest });
    }
  })();
}

// >0 if a > b. Numeric collation makes 2.10.0 > 2.9.0 and rc.10 > rc.9. Per semver a
// prerelease sorts before its release, so a running 2.10.0-rc.1 is told about 2.10.0.
function compareVersions(a: string, b: string): number {
  const byNumber = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
  const [coreA, preA] = a.split(/-(.*)/s);
  const [coreB, preB] = b.split(/-(.*)/s);

  const core = byNumber(coreA, coreB);
  if (core !== 0 || preA === preB) return core;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return byNumber(preA, preB);
}
