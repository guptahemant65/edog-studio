import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AdoClient, AdoCommit, AdoItem, VersionDescriptor } from '../src/engine/ado-client.ts';
import { isFlagPath, flagIdFromPath, discoverFlagPaths } from '../src/engine/flag-discovery.ts';
import { loadFlagHistory, mineRepository } from '../src/engine/repository.ts';
import type { AttributionEvent } from '../src/engine/miner.ts';

const BASE = '/Features/Configuration/Features';

/** In-memory AdoClient for tests. `commits` are newest-first, as ADO returns them. */
class FakeAdoClient implements AdoClient {
  private readonly items: AdoItem[];
  private readonly commits: Record<string, AdoCommit[]>;
  private readonly contents: Record<string, string>;
  constructor(
    items: AdoItem[],
    commits: Record<string, AdoCommit[]>,
    contents: Record<string, string>,
  ) {
    this.items = items;
    this.commits = commits;
    this.contents = contents;
  }
  async listItems(): Promise<AdoItem[]> {
    return this.items;
  }
  async getPathCommits(path: string): Promise<AdoCommit[]> {
    return this.commits[path] ?? [];
  }
  async getContent(path: string, version: VersionDescriptor): Promise<string> {
    const key = `${path}@${version.version}`;
    const found = this.contents[key];
    if (found === undefined) throw new Error(`no fixture content for ${key}`);
    return found;
  }
}

function flagJson(id: string, envs: Record<string, unknown>): string {
  return JSON.stringify({ Id: id, Environments: envs });
}

describe('flag-discovery (architecture §3.2)', () => {
  it('isFlagPath matches FLT*.json only', () => {
    assert.ok(isFlagPath(`${BASE}/FLTArtifactBasedThrottling.json`));
    assert.ok(!isFlagPath(`${BASE}/SomeOther.json`));
    assert.ok(!isFlagPath(`${BASE}/FLTNested/Inner.json`));
    assert.ok(!isFlagPath(`${BASE}/FLTReadme.md`));
  });

  it('flagIdFromPath strips dir and extension', () => {
    assert.equal(flagIdFromPath(`${BASE}/FLTFoo.json`), 'FLTFoo');
  });

  it('discoverFlagPaths filters folders + non-FLT and sorts', async () => {
    const client = new FakeAdoClient(
      [
        { path: `${BASE}/FLTBeta.json`, isFolder: false },
        { path: `${BASE}/FLTAlpha.json`, isFolder: false },
        { path: `${BASE}/NotAFlag.json`, isFolder: false },
        { path: `${BASE}/FLTFolder`, isFolder: true },
      ],
      {},
      {},
    );
    assert.deepEqual(await discoverFlagPaths(client), [
      `${BASE}/FLTAlpha.json`,
      `${BASE}/FLTBeta.json`,
    ]);
  });
});

function throttlingFixture() {
  const path = `${BASE}/FLTArtifactBasedThrottling.json`;
  const id = 'FLTArtifactBasedThrottling';
  // ADO returns commits NEWEST-first:
  const commits: AdoCommit[] = [
    { commitId: 'd'.repeat(40), author: { name: 'Dave', date: '2026-03-13T08:00:00Z' }, comment: 'Merged PR 4: prod on' },
    { commitId: 'c'.repeat(40), author: { name: 'Carol', date: '2026-03-10T12:00:00Z' }, comment: 'Merged PR 3: target prod' },
    { commitId: 'b'.repeat(40), author: { name: 'Bob', date: '2026-03-03T09:00:00Z' }, comment: 'Merged PR 2: msit' },
    { commitId: 'a'.repeat(40), author: { name: 'Alice', date: '2026-03-01T10:00:00Z' }, comment: 'Merged PR 1: create' },
  ];
  const contents: Record<string, string> = {
    [`${path}@${'a'.repeat(40)}`]: flagJson(id, { test: { Enabled: true } }),
    [`${path}@${'b'.repeat(40)}`]: flagJson(id, { test: { Enabled: true }, msit: { Enabled: true } }),
    [`${path}@${'c'.repeat(40)}`]: flagJson(id, { test: { Enabled: true }, msit: { Enabled: true }, prod: { Targets: { Tenants: ['t1'] } } }),
    [`${path}@${'d'.repeat(40)}`]: flagJson(id, { test: { Enabled: true }, msit: { Enabled: true }, prod: { Enabled: true } }),
  };
  return { path, id, client: new FakeAdoClient([{ path, isFolder: false }], { [path]: commits }, contents) };
}

describe('loadFlagHistory', () => {
  it('returns commits oldest-first with content attached', async () => {
    const { client, path } = throttlingFixture();
    const history = await loadFlagHistory(client, path);
    assert.equal(history.length, 4);
    assert.equal(history[0]?.author, 'Alice'); // creation first
    assert.equal(history[3]?.author, 'Dave');
    assert.ok(history[0]?.rawJson.includes('"test"'));
  });
});

describe('mineRepository (end-to-end, fake ADO)', () => {
  it('discovers, loads, and mines the worked-example flag', async () => {
    const { client } = throttlingFixture();
    const results = await mineRepository(client);
    assert.equal(results.length, 1);
    const r = results[0]!;
    assert.equal(r.flagId, 'FLTArtifactBasedThrottling');
    assert.equal(r.events[0]?.kind, 'creation');

    const prod = r.events.filter(
      (e): e is AttributionEvent => e.kind === 'transition' && e.env === 'prod',
    );
    assert.equal(prod.length, 2);
    assert.equal(prod[0]?.currState, 'targeted');
    assert.equal(prod[0]?.attribution.author, 'Carol');
    assert.equal(prod[0]?.attribution.prNumber, 3);
    assert.equal(prod[1]?.currState, 'on');
    assert.equal(prod[1]?.attribution.author, 'Dave');
  });
});
