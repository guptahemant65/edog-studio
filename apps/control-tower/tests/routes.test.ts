import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGrid, errorResponse } from '../src/server/routes.ts';
import { ensureBuilt, resetStore, getStore } from '../src/server/store.ts';
import { WarmStore } from '../src/engine/warm-store.ts';
import { FLAG_SCOPE_PATH } from '../src/engine/flag-discovery.ts';
import type { AdoClient, AdoCommit, AdoItem, VersionDescriptor } from '../src/engine/ado-client.ts';

class OneFlagClient implements AdoClient {
  buildCount = 0;
  private readonly path = `${FLAG_SCOPE_PATH}/FLTOne.json`;
  async listItems(): Promise<AdoItem[]> {
    this.buildCount += 1;
    return [{ path: this.path, isFolder: false }];
  }
  async getPathCommits(): Promise<AdoCommit[]> {
    return [{ commitId: 'c1'.padEnd(40, '0'), author: { name: 'dev', date: '2026-03-01T00:00:00Z' }, comment: '' }];
  }
  async getContent(_p: string, _v: VersionDescriptor): Promise<string> {
    return JSON.stringify({ Id: 'FLTOne', Description: 'one', Environments: { test: { Enabled: true } } });
  }
}

test('handleGrid: returns 200 JSON with no-store and grid body', async () => {
  const store = new WarmStore();
  await store.build(new OneFlagClient());
  const res = handleGrid(store, { now: Date.parse('2026-03-02T00:00:00Z') });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = (await res.json()) as { rows: Array<{ flagId: string; states: Record<string, string> }> };
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0]!.flagId, 'FLTOne');
  assert.equal(body.rows[0]!.states.test, 'on');
});

test('errorResponse: status + envelope', async () => {
  const res = errorResponse(401, 'nope');
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'nope' });
});

test('ensureBuilt: builds once and is shared across concurrent callers', async () => {
  resetStore();
  const client = new OneFlagClient();
  const [a, b] = await Promise.all([
    ensureBuilt(async () => client),
    ensureBuilt(async () => client),
  ]);
  assert.equal(a, b);
  assert.equal(a, getStore());
  assert.equal(a.isBuilt, true);
  assert.equal(client.buildCount, 1); // single cold-load despite two callers
  resetStore();
});
