/**
 * Warm store (architecture §3.4.4, §3.4.5, §6).
 *
 * Holds the mined corpus in memory for a server lifetime:
 *  - an immutable commit-content cache (a commitId maps to one content snapshot
 *    forever) so incremental refreshes only fetch NEW commits;
 *  - the current "vintage" snapshot (per-flag events + head + syncedAt);
 *  - atomic refresh: stage a full rebuild, swap only if every flag succeeds;
 *    on any failure the last-good snapshot is preserved.
 *
 * Freshness is metadata-only and never calls ADO (§6.2/§6.3). The cheap
 * `$top=1` updates poll belongs to the API layer, not here.
 */
import { type AdoClient, AdoNotFoundError } from './ado-client.ts';
import { mapLimit } from './concurrency.ts';
import { discoverFlagPaths, flagIdFromPath } from './flag-discovery.ts';
import { mineFlag, parseFlagContent, type FlagCommit, type MineEvent, type ParsedFlagContent } from './miner.ts';

const CONCURRENCY = 10;
const STALE_AFTER_MINUTES = 60;

/** Immutable content cache. Key is path+commitId — a snapshot never changes. */
export class CommitContentCache {
  private readonly map = new Map<string, ParsedFlagContent>();

  private key(path: string, commitId: string): string {
    return `${path}\u0000${commitId}`;
  }

  has(path: string, commitId: string): boolean {
    return this.map.has(this.key(path, commitId));
  }

  get size(): number {
    return this.map.size;
  }

  async getOrFetch(client: AdoClient, path: string, commitId: string): Promise<ParsedFlagContent> {
    const k = this.key(path, commitId);
    const hit = this.map.get(k);
    if (hit) return hit;
    const raw = await client.getContent(path, { versionType: 'commit', version: commitId });
    const parsed = parseFlagContent(raw);
    this.map.set(k, parsed);
    return parsed;
  }
}

export interface FlagVintage {
  flagId: string;
  flagPath: string;
  /** human-readable description from the newest commit's content. */
  description: string;
  /** oldest-first commit ids for this flag. */
  commitIds: string[];
  newestCommit: { commitId: string; date: string } | null;
  events: MineEvent[];
}

export interface WarmSnapshot {
  flags: Map<string, FlagVintage>;
  headCommitId: string | null;
  /** ISO-8601 timestamp of the build/refresh that produced this snapshot. */
  syncedAt: string;
}

export interface FreshnessInfo {
  syncedAt: string | null;
  headCommitId: string | null;
  ageMinutes: number | null;
  isStale: boolean;
  status: 'ok' | 'failed' | 'empty';
}

export interface RefreshResult {
  ok: boolean;
  headCommitId: string | null;
  /** total events across all flags in the new vintage (when ok). */
  totalEvents: number;
  error?: string;
}

function pickHead(vintages: FlagVintage[]): string | null {
  let best: { commitId: string; date: string } | null = null;
  for (const v of vintages) {
    if (v.newestCommit && (!best || v.newestCommit.date > best.date)) best = v.newestCommit;
  }
  return best ? best.commitId : null;
}

export class WarmStore {
  private readonly cache = new CommitContentCache();
  private snapshot: WarmSnapshot | null = null;
  private lastError: string | null = null;

  get isBuilt(): boolean {
    return this.snapshot !== null;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  current(): WarmSnapshot | null {
    return this.snapshot;
  }

  getEvents(flagId: string): MineEvent[] {
    return this.snapshot?.flags.get(flagId)?.events ?? [];
  }

  /** Load a single flag's vintage, fetching only commits not already cached. */
  private async loadVintage(client: AdoClient, flagPath: string): Promise<FlagVintage> {
    const commits = await client.getPathCommits(flagPath, 'master'); // newest-first
    const oldestFirst = [...commits].reverse();
    const fetched = await mapLimit(oldestFirst, CONCURRENCY, async (c): Promise<FlagCommit | null> => {
      let content: ParsedFlagContent;
      try {
        content = await this.cache.getOrFetch(client, flagPath, c.commitId);
      } catch (err) {
        // The file didn't exist at this path/commit (pre-creation or pre-rename);
        // skip it rather than failing the whole cold-load.
        if (err instanceof AdoNotFoundError) return null;
        throw err;
      }
      return {
        commitId: c.commitId,
        author: c.author?.name ?? null,
        date: c.author?.date ?? '',
        comment: c.comment ?? '',
        rawJson: content.rawJson,
      };
    });
    const flagCommits = fetched.filter((c): c is FlagCommit => c !== null);
    const flagId = flagIdFromPath(flagPath);
    const newestContent = flagCommits[flagCommits.length - 1];
    return {
      flagId,
      flagPath,
      description: newestContent ? parseFlagContent(newestContent.rawJson).description : '',
      commitIds: flagCommits.map((c) => c.commitId),
      newestCommit: newestContent ? { commitId: newestContent.commitId, date: newestContent.date } : null,
      events: mineFlag(flagId, flagCommits),
    };
  }

  /** Build all vintages into a fresh, un-applied snapshot. */
  private async buildSnapshot(client: AdoClient): Promise<WarmSnapshot> {
    const flagPaths = await discoverFlagPaths(client);
    const vintages = await mapLimit(flagPaths, CONCURRENCY, (p) => this.loadVintage(client, p));
    const flags = new Map<string, FlagVintage>();
    for (const v of vintages) flags.set(v.flagId, v);
    return { flags, headCommitId: pickHead(vintages), syncedAt: new Date().toISOString() };
  }

  /** Cold-load: full build. Replaces any existing snapshot. */
  async build(client: AdoClient): Promise<void> {
    this.snapshot = await this.buildSnapshot(client);
    this.lastError = null;
  }

  /**
   * Atomic incremental refresh. Stages a full rebuild (cheap — cached content is
   * reused, only new commits fetched) and swaps only on full success. On any
   * failure the current snapshot is preserved and `ok:false` is returned.
   */
  async refresh(client: AdoClient): Promise<RefreshResult> {
    try {
      const staged = await this.buildSnapshot(client);
      this.snapshot = staged;
      this.lastError = null;
      let totalEvents = 0;
      for (const v of staged.flags.values()) totalEvents += v.events.length;
      return { ok: true, headCommitId: staged.headCommitId, totalEvents };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        headCommitId: this.snapshot?.headCommitId ?? null,
        totalEvents: 0,
        error: this.lastError,
      };
    }
  }

  /** Metadata-only freshness (no ADO call). */
  freshness(now: number = Date.now()): FreshnessInfo {
    if (!this.snapshot) {
      return {
        syncedAt: null,
        headCommitId: null,
        ageMinutes: null,
        isStale: true,
        status: this.lastError ? 'failed' : 'empty',
      };
    }
    const ageMinutes = (now - Date.parse(this.snapshot.syncedAt)) / 60000;
    return {
      syncedAt: this.snapshot.syncedAt,
      headCommitId: this.snapshot.headCommitId,
      ageMinutes,
      isStale: ageMinutes > STALE_AFTER_MINUTES,
      status: this.lastError ? 'failed' : 'ok',
    };
  }
}
