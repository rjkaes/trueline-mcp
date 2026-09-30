import { readFile, unlink, writeFile } from "node:fs/promises";
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

// The cache sits in a temp dir other users can write (Linux /tmp), and the version is relayed
// verbatim to stderr and the agent, so only a semver string passes.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const isVersion = (value: unknown): value is string => typeof value === "string" && SEMVER.test(value);

async function readCache(): Promise<CachedCheck | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CachedCheck> | null;
    return typeof parsed?.timestamp === "number" && isVersion(parsed.latestVersion)
      ? { timestamp: parsed.timestamp, latestVersion: parsed.latestVersion }
      : null;
  } catch {
    return null;
  }
}

async function writeCache(entry: CachedCheck): Promise<void> {
  // writeFile follows a symlink planted at the path (shared temp dir). Unlink it, then create
  // exclusively, so a link replanted in between fails the write instead.
  await unlink(CACHE_FILE).catch(() => {});
  await writeFile(CACHE_FILE, JSON.stringify(entry), { flag: "wx" }).catch(() => {});
}

async function fetchLatestVersion(cancel?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.any([AbortSignal.timeout(REGISTRY_TIMEOUT_MS), ...(cancel ? [cancel] : [])]),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return isVersion(data.version) ? data.version : null;
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
 * @param cancel Abandons the registry request when aborted, so it cannot hold the process open.
 */
export function scheduleUpdateCheck(
  currentVersion: string,
  onUpdate: (info: { current: string; latest: string }) => void,
  cancel?: AbortSignal,
): void {
  // Fire-and-forget — never delays startup or rejects into the event loop
  void (async () => {
    const cached = await readCache();

    // A timestamp ahead of the clock (planted, or a clock that was once wrong) would stay fresh until
    // the clock caught up, so it counts as expired.
    const now = Date.now();
    let latest =
      cached && cached.timestamp <= now && now - cached.timestamp < CHECK_INTERVAL_MS ? cached.latestVersion : null;
    if (!latest) {
      latest = await fetchLatestVersion(cancel);
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
// Build metadata (+...) never takes part in the ordering.
function compareVersions(a: string, b: string): number {
  const byNumber = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
  const [coreA, preA] = a.replace(/\+.*/s, "").split(/-(.*)/s);
  const [coreB, preB] = b.replace(/\+.*/s, "").split(/-(.*)/s);

  const core = byNumber(coreA, coreB);
  if (core !== 0 || preA === preB) return core;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return byNumber(preA, preB);
}
