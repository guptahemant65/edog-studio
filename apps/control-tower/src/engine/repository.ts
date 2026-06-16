/**
 * Repository loader (architecture §3.3–§3.4): turns ADO git history into the
 * `FlagCommit[]` the miner consumes, then runs attribution mining per flag.
 *
 * This is the seam between the ADO client and the pure engine. Content is
 * fetched per immutable commitId so a future warm store can cache it forever.
 */
import type { AdoClient } from './ado-client.ts';
import { mapLimit } from './concurrency.ts';
import { discoverFlagPaths, flagIdFromPath } from './flag-discovery.ts';
import { mineFlag, type FlagCommit, type MineEvent } from './miner.ts';

/** Max concurrent ADO content fetches (architecture §3.1, mitigation 2). */
const CONTENT_CONCURRENCY = 10;

/**
 * Load a single flag's full history as oldest-first `FlagCommit[]`.
 * ADO returns commits newest-first; we reverse so commit[0] is file creation.
 */
export async function loadFlagHistory(
  client: AdoClient,
  flagPath: string,
  branch = 'master',
): Promise<FlagCommit[]> {
  const commits = await client.getPathCommits(flagPath, branch);
  const oldestFirst = [...commits].reverse();
  return mapLimit(oldestFirst, CONTENT_CONCURRENCY, async (commit) => {
    const rawJson = await client.getContent(flagPath, {
      versionType: 'commit',
      version: commit.commitId,
    });
    return {
      commitId: commit.commitId,
      author: commit.author?.name ?? null,
      date: commit.author?.date ?? '',
      comment: commit.comment ?? '',
      rawJson,
    } satisfies FlagCommit;
  });
}

export interface FlagMineResult {
  flagId: string;
  flagPath: string;
  events: MineEvent[];
}

/**
 * Discover every FLT flag, load its history, and mine attribution events.
 * Returns one result per flag, in deterministic (path-sorted) order.
 */
export async function mineRepository(
  client: AdoClient,
  branch = 'master',
): Promise<FlagMineResult[]> {
  const flagPaths = await discoverFlagPaths(client);
  return mapLimit(flagPaths, CONTENT_CONCURRENCY, async (flagPath) => {
    const flagId = flagIdFromPath(flagPath);
    const history = await loadFlagHistory(client, flagPath, branch);
    return { flagId, flagPath, events: mineFlag(flagId, history) };
  });
}
