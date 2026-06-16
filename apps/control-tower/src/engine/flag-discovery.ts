/**
 * Flag discovery (architecture §3.2): find the ~42 FLT flag files under the
 * FeatureManagement Features config path.
 */
import type { AdoClient } from './ado-client.ts';

/** The canonical scope path for FLT flag configs. */
export const FLAG_SCOPE_PATH = '/Features/Configuration/Features';

/** Matches a top-level FLT flag file, e.g. ".../FLTArtifactBasedThrottling.json". */
const FLAG_PATH_RE = /\/FLT[^/]+\.json$/;

export function isFlagPath(path: string): boolean {
  return FLAG_PATH_RE.test(path);
}

/** Derive the flag id from its path: ".../FLTFoo.json" -> "FLTFoo". */
export function flagIdFromPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  return base.replace(/\.json$/, '');
}

/** Discover all FLT flag file paths (sorted, deterministic). */
export async function discoverFlagPaths(
  client: AdoClient,
  scopePath: string = FLAG_SCOPE_PATH,
): Promise<string[]> {
  const items = await client.listItems(scopePath);
  return items
    .filter((i) => !i.isFolder && isFlagPath(i.path))
    .map((i) => i.path)
    .sort();
}
