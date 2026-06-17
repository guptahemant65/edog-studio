import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGridResponse } from '../src/api/grid.ts';
import { WarmStore } from '../src/engine/warm-store.ts';
import { FLAG_SCOPE_PATH } from '../src/engine/flag-discovery.ts';
import type { AdoClient, AdoCommit, AdoItem, VersionDescriptor } from '../src/engine/ado-client.ts';

/** A flag's commit history, oldest-first, with the raw JSON at each commit. */
interface FlagSpec {
  id: string;
  commits: Array<{ commitId: string; date: string; comment?: string; envs: Record<string, unknown>; description?: string }>;
}

class FakeAdoClient implements AdoClient {
  private readonly byPath = new Map<string, FlagSpec>();

  constructor(specs: FlagSpec[]) {
    for (const s of specs) this.byPath.set(`${FLAG_SCOPE_PATH}/${s.id}.json`, s);
  }

  async listItems(_scopePath: string): Promise<AdoItem[]> {
    return [...this.byPath.keys()].map((path) => ({ path, isFolder: false }));
  }

  async getPathCommits(path: string, _branch: string): Promise<AdoCommit[]> {
    const spec = this.byPath.get(path)!;
    // ADO returns newest-first.
    return [...spec.commits].reverse().map((c) => ({
      commitId: c.commitId,
      author: { name: 'dev', date: c.date },
      comment: c.comment ?? '',
    }));
  }

  async getContent(path: string, version: VersionDescriptor): Promise<string> {
    const spec = this.byPath.get(path)!;
    const c = spec.commits.find((x) => x.commitId === version.version)!;
    return JSON.stringify({ Id: spec.id, Description: c.description ?? `${spec.id} desc`, Environments: c.envs });
  }
}

async function builtStore(specs: FlagSpec[]): Promise<WarmStore> {
  const store = new WarmStore();
  await store.build(new FakeAdoClient(specs));
  return store;
}

test('buildGridResponse: one row per flag with current states', async () => {
  const store = await builtStore([
    {
      id: 'FLTAlpha',
      commits: [
        { commitId: 'a1'.padEnd(40, '0'), date: '2026-03-01T00:00:00Z', envs: {} },
        { commitId: 'a2'.padEnd(40, '0'), date: '2026-03-05T00:00:00Z', comment: 'Merged PR 100', envs: { test: { Enabled: true } } },
      ],
    },
  ]);
  const res = buildGridResponse(store, { now: Date.parse('2026-03-10T00:00:00Z') });
  assert.equal(res.rows.length, 1);
  const row = res.rows[0]!;
  assert.equal(row.flagId, 'FLTAlpha');
  assert.equal(row.states.test, 'on');
  assert.equal(row.states.prod, 'off');
  assert.equal(row.lastChange?.prNumber, 100);
  assert.equal(row.daysSinceLastChange, 5);
  assert.equal(row.layer, 'ladder');
  assert.equal(Object.keys(row.states).length, 15);
});

test('buildGridResponse: rows sorted by flagId, meta reflects freshness', async () => {
  const now = Date.parse('2026-03-10T00:00:00Z');
  const store = await builtStore([
    { id: 'FLTZeta', commits: [{ commitId: 'z1'.padEnd(40, '0'), date: '2026-03-01T00:00:00Z', envs: { prod: { Enabled: true } } }] },
    { id: 'FLTAlpha', commits: [{ commitId: 'a1'.padEnd(40, '0'), date: '2026-03-01T00:00:00Z', envs: {} }] },
  ]);
  const res = buildGridResponse(store, { now });
  assert.deepEqual(res.rows.map((r) => r.flagId), ['FLTAlpha', 'FLTZeta']);
  assert.equal(res.meta.flagCount, 2);
  assert.equal(res.meta.status, 'ok');
  assert.equal(res.meta.isStale, false);
});

test('buildGridResponse: sovereign layer + stale-reason classification', async () => {
  const now = Date.parse('2026-09-01T00:00:00Z'); // ~half a year after the change
  const store = await builtStore([
    {
      id: 'FLTSov',
      commits: [
        { commitId: 's1'.padEnd(40, '0'), date: '2026-01-01T00:00:00Z', envs: {} },
        { commitId: 's2'.padEnd(40, '0'), date: '2026-02-01T00:00:00Z', envs: { mc: { Enabled: true } } },
      ],
    },
  ]);
  const res = buildGridResponse(store, { now });
  const row = res.rows[0]!;
  assert.equal(row.layer, 'sovereign');
  assert.equal(row.states.mc, 'on');
  // partial mainline? mc is sovereign, not mainline → mainlineOnCount 0 → not forgotten/launched.
  assert.equal(row.staleReason, null);
});

test('buildGridResponse: empty store → no rows, empty status', () => {
  const res = buildGridResponse(new WarmStore(), { now: Date.now() });
  assert.equal(res.rows.length, 0);
  assert.equal(res.meta.status, 'empty');
  assert.equal(res.meta.flagCount, 0);
});
