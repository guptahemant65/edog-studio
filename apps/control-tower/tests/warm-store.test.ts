import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AdoClient, AdoCommit, AdoItem, VersionDescriptor } from '../src/engine/ado-client.ts';
import { WarmStore } from '../src/engine/warm-store.ts';
import type { AttributionEvent } from '../src/engine/miner.ts';

const BASE = '/Features/Configuration/Features';

interface FlagFixture {
  commits: AdoCommit[]; // newest-first
  contents: Map<string, string>; // commitId -> rawJson
}

/** Mutable spy ADO client: counts content fetches, supports appending commits and forced failures. */
class MutableFakeAdoClient implements AdoClient {
  getContentCalls = 0;
  private readonly flags = new Map<string, FlagFixture>();
  private readonly failContent = new Set<string>();

  addFlag(path: string): void {
    if (!this.flags.has(path)) this.flags.set(path, { commits: [], contents: new Map() });
  }

  /** Prepend a newer commit (newest-first order) with its content. */
  addCommit(path: string, commit: AdoCommit, rawJson: string): void {
    this.addFlag(path);
    const f = this.flags.get(path)!;
    f.commits.unshift(commit);
    f.contents.set(commit.commitId, rawJson);
  }

  failContentFor(commitId: string): void {
    this.failContent.add(commitId);
  }

  async listItems(): Promise<AdoItem[]> {
    return [...this.flags.keys()].map((path) => ({ path, isFolder: false }));
  }

  async getPathCommits(path: string): Promise<AdoCommit[]> {
    return this.flags.get(path)?.commits ?? [];
  }

  async getContent(path: string, version: VersionDescriptor): Promise<string> {
    this.getContentCalls++;
    if (this.failContent.has(version.version)) {
      throw new Error(`forced failure for ${version.version}`);
    }
    const raw = this.flags.get(path)?.contents.get(version.version);
    if (raw === undefined) throw new Error(`no content for ${path}@${version.version}`);
    return raw;
  }
}

function flagJson(id: string, envs: Record<string, unknown>): string {
  return JSON.stringify({ Id: id, Environments: envs });
}

function seededClient(): MutableFakeAdoClient {
  const c = new MutableFakeAdoClient();
  const alpha = `${BASE}/FLTAlpha.json`;
  const beta = `${BASE}/FLTBeta.json`;
  // Alpha: 2 commits (creation + msit). Add oldest first so newest ends up at front.
  c.addCommit(alpha, { commitId: 'a1'.padEnd(40, '0'), author: { name: 'Ann', date: '2026-02-01T00:00:00Z' }, comment: 'Merged PR 1: create' }, flagJson('FLTAlpha', { test: { Enabled: true } }));
  c.addCommit(alpha, { commitId: 'a2'.padEnd(40, '0'), author: { name: 'Ann', date: '2026-02-05T00:00:00Z' }, comment: 'Merged PR 2: msit' }, flagJson('FLTAlpha', { test: { Enabled: true }, msit: { Enabled: true } }));
  // Beta: 1 commit (creation).
  c.addCommit(beta, { commitId: 'b1'.padEnd(40, '0'), author: { name: 'Ben', date: '2026-02-03T00:00:00Z' }, comment: 'Merged PR 3: create' }, flagJson('FLTBeta', { test: { Enabled: true } }));
  return c;
}

const alpha = `${BASE}/FLTAlpha.json`;
const beta = `${BASE}/FLTBeta.json`;

describe('WarmStore.build (cold-load)', () => {
  it('builds a snapshot and caches every commit content', async () => {
    const client = seededClient();
    const store = new WarmStore();
    await store.build(client);
    assert.ok(store.isBuilt);
    assert.equal(store.cacheSize, 3); // a1, a2, b1
    assert.equal(client.getContentCalls, 3);
    assert.equal(store.current()?.flags.size, 2);
    assert.equal(store.getEvents('FLTAlpha').length > 0, true);
    assert.equal(store.current()?.headCommitId, 'a2'.padEnd(40, '0')); // newest by date
  });
});

describe('WarmStore.refresh (immutable cache — §3.4.5)', () => {
  it('fetches ZERO new content when nothing changed', async () => {
    const client = seededClient();
    const store = new WarmStore();
    await store.build(client);
    const before = client.getContentCalls;
    const res = await store.refresh(client);
    assert.ok(res.ok);
    assert.equal(client.getContentCalls - before, 0); // all cache hits
  });

  it('fetches exactly one new content for one new commit and updates head + events', async () => {
    const client = seededClient();
    const store = new WarmStore();
    await store.build(client);
    const before = client.getContentCalls;
    const beforeAlphaEvents = store.getEvents('FLTAlpha').length;

    // New commit on Alpha: prod enabled.
    client.addCommit(alpha, { commitId: 'a3'.padEnd(40, '0'), author: { name: 'Ann', date: '2026-02-10T00:00:00Z' }, comment: 'Merged PR 9: prod' }, flagJson('FLTAlpha', { test: { Enabled: true }, msit: { Enabled: true }, prod: { Enabled: true } }));

    const res = await store.refresh(client);
    assert.ok(res.ok);
    assert.equal(client.getContentCalls - before, 1); // only the new commit fetched
    assert.equal(store.current()?.headCommitId, 'a3'.padEnd(40, '0'));
    const prod = store.getEvents('FLTAlpha').filter(
      (e): e is AttributionEvent => e.kind === 'transition' && e.env === 'prod',
    );
    assert.equal(prod.length, 1);
    assert.equal(prod[0]?.currState, 'on');
    assert.ok(store.getEvents('FLTAlpha').length > beforeAlphaEvents);
  });
});

describe('WarmStore.refresh (atomic rollback — §6.2)', () => {
  it('preserves the last-good snapshot when a flag fails mid-refresh', async () => {
    const client = seededClient();
    const store = new WarmStore();
    await store.build(client);
    const goodHead = store.current()?.headCommitId;
    const goodAlpha = store.getEvents('FLTAlpha').length;

    // Add a new Beta commit whose content fetch will throw.
    client.addCommit(beta, { commitId: 'bad'.padEnd(40, '0'), author: { name: 'Ben', date: '2026-02-20T00:00:00Z' }, comment: 'Merged PR 99: boom' }, flagJson('FLTBeta', { prod: { Enabled: true } }));
    client.failContentFor('bad'.padEnd(40, '0'));

    const res = await store.refresh(client);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /forced failure/);
    // Snapshot unchanged — last-good vintage preserved.
    assert.equal(store.current()?.headCommitId, goodHead);
    assert.equal(store.getEvents('FLTAlpha').length, goodAlpha);
    assert.equal(store.freshness().status, 'failed');
  });
});

describe('WarmStore.freshness (metadata only, no ADO)', () => {
  it('is empty before any build', () => {
    const store = new WarmStore();
    const f = store.freshness();
    assert.equal(f.status, 'empty');
    assert.equal(f.isStale, true);
    assert.equal(f.syncedAt, null);
  });

  it('is fresh right after build and stale past 60 minutes', async () => {
    const client = seededClient();
    const store = new WarmStore();
    await store.build(client);
    const syncedAt = Date.parse(store.freshness().syncedAt!);
    assert.equal(store.freshness(syncedAt + 59 * 60000).isStale, false);
    assert.equal(store.freshness(syncedAt + 61 * 60000).isStale, true);
    assert.equal(store.freshness(syncedAt).status, 'ok');
  });
});
