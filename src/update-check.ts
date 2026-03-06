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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
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
 *                 Defaults to writing a notice to stderr.
 */
export function scheduleUpdateCheck(
  currentVersion: string,
  onUpdate?: (info: { current: string; latest: string }) => void,
): void {
  const notify = onUpdate ?? defaultNotify;

  // Fire-and-forget — never delays startup or rejects into the event loop
  void (async () => {
    const cached = await readCache();

    if (cached && Date.now() - cached.timestamp < CHECK_INTERVAL_MS) {
      if (compareVersions(cached.latestVersion, currentVersion) > 0) {
        notify({ current: currentVersion, latest: cached.latestVersion });
      }
      return;
    }

    const latest = await fetchLatestVersion();
    if (!latest) return;

    await writeCache({ timestamp: Date.now(), latestVersion: latest });
    if (compareVersions(latest, currentVersion) > 0) {
      notify({ current: currentVersion, latest });
    }
  })();
}

function defaultNotify({ current, latest }: { current: string; latest: string }): void {
  process.stderr.write(`[trueline-mcp] update available: ${current} → ${latest} (npm i -g trueline-mcp)\n`);
}

/** Simple semver comparison: returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
