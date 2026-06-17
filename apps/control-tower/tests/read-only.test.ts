/**
 * P4 — Read-only enforcement gauntlet.
 *
 * The Control Tower is a strictly read-only intelligence surface (data-model §7.3):
 * it mines the FeatureManagement git history but never mutates ADO or any other
 * external system. These tests lock that contract from three angles:
 *
 *   1. HTTP surface — no mutating method handlers (PUT/DELETE/PATCH) exist, and
 *      POST is confined to the two sanctioned read-only-compute endpoints.
 *   2. ADO egress — the real HttpAdoClient only ever issues GET requests.
 *   3. Cost model — a cold load fetches each (flag, commit) exactly once, and a
 *      refresh reuses the immutable content cache instead of re-fetching history.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpAdoClient } from '../src/engine/ado-client.ts';
import type { AdoClient, AdoCommit, AdoItem, VersionDescriptor } from '../src/engine/ado-client.ts';
import { WarmStore } from '../src/engine/warm-store.ts';
import { FLAG_SCOPE_PATH } from '../src/engine/flag-discovery.ts';

// ── 1. HTTP method surface ────────────────────────────────────────────────────

const CT_ROUTES_DIR = fileURLToPath(new URL('../app/api/ct', import.meta.url));

/** Recursively collect every `route.ts` under the ct API tree (posix-normalised). */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts') out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

function exportedMethods(src: string): string[] {
  const methods: string[] = [];
  const re = /export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) methods.push(m[1]!);
  return methods;
}

// Only these two endpoints may answer POST — both are body-shaped reads that write nothing.
const POST_ALLOWLIST = ['api/ct/time-travel/reconstruct/route.ts', 'api/ct/refresh/route.ts'];

describe('read-only · HTTP method surface', () => {
  const files = routeFiles(CT_ROUTES_DIR);

  it('discovers the full ct route table', () => {
    assert.ok(files.length >= 16, `expected the ct route table, found ${files.length} files`);
  });

  it('exposes no mutating method handlers (PUT/DELETE/PATCH) anywhere', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const bad = exportedMethods(readFileSync(f, 'utf8')).filter((x) => ['PUT', 'DELETE', 'PATCH'].includes(x));
      if (bad.length) offenders.push(`${f}: ${bad.join(',')}`);
    }
    assert.deepEqual(offenders, [], `mutating handlers found: ${offenders.join(' | ')}`);
  });

  it('confines POST to the two sanctioned read-compute endpoints', () => {
    for (const f of files) {
      if (!exportedMethods(readFileSync(f, 'utf8')).includes('POST')) continue;
      const allowed = POST_ALLOWLIST.some((p) => f.endsWith(p));
      assert.ok(allowed, `unexpected POST handler in ${f}`);
    }
  });

  it('every ct route answers GET (the read path)', () => {
    for (const f of files) {
      const methods = exportedMethods(readFileSync(f, 'utf8'));
      const postOnly = POST_ALLOWLIST.some((p) => f.endsWith(p));
      if (postOnly) continue;
      assert.ok(methods.includes('GET'), `route exposes no GET handler: ${f}`);
    }
  });
});

// ── 2. ADO egress is GET-only ─────────────────────────────────────────────────

describe('read-only · ADO egress', () => {
  it('HttpAdoClient issues only GET requests', async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seen.push(init?.method);
      const body = JSON.stringify({ value: [] });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const client = new HttpAdoClient('test-token', { fetchImpl });
    await client.listItems(FLAG_SCOPE_PATH);
    await client.getContent('/x.json', { versionType: 'branch', version: 'master' });
    await client.getPathCommits('/x.json', 'master');
    await client.getLatestCommit!(FLAG_SCOPE_PATH, 'master');

    assert.ok(seen.length >= 4, 'expected one request per client method');
    for (const method of seen) {
      assert.ok(method === undefined || method.toUpperCase() === 'GET', `non-GET request to ADO: ${method}`);
    }
  });
});

// ── 3. Cost model — cold load fetches once, refresh reuses the cache ───────────

interface CommitFx {
  commit: AdoCommit;
  rawJson: string;
}

/** Read-only fake: one flag with an append-only commit log; counts content fetches. */
class CostModelClient implements AdoClient {
  getContentCalls = 0;
  private readonly path = `${FLAG_SCOPE_PATH}/FLTCost.json`;
  private readonly log: CommitFx[] = []; // newest-first

  addCommit(commitId: string, date: string, enabled: boolean): void {
    const raw = JSON.stringify({ Id: 'FLTCost', Description: 'cost', Environments: { test: { Enabled: enabled } } });
    this.log.unshift({ commit: { commitId: commitId.padEnd(40, '0'), author: { name: 'dev', date }, comment: '' }, rawJson: raw });
  }

  async listItems(): Promise<AdoItem[]> {
    return [{ path: this.path, isFolder: false }];
  }
  async getPathCommits(): Promise<AdoCommit[]> {
    return this.log.map((e) => e.commit);
  }
  async getContent(_path: string, version: VersionDescriptor): Promise<string> {
    this.getContentCalls++;
    const hit = this.log.find((e) => e.commit.commitId === version.version);
    if (!hit) throw new Error(`unknown commit ${version.version}`);
    return hit.rawJson;
  }
}

describe('read-only · cold-load cost model', () => {
  it('cold load fetches each commit exactly once; refresh reuses the cache', async () => {
    const client = new CostModelClient();
    client.addCommit('c1', '2026-01-01T00:00:00Z', false);
    client.addCommit('c2', '2026-02-01T00:00:00Z', true);

    const store = new WarmStore();
    await store.build(client);
    assert.equal(client.getContentCalls, 2, 'cold load should fetch each of the 2 commits once');

    const eventsAfterBuild = store.getEvents('FLTCost').length;
    assert.ok(eventsAfterBuild >= 1, 'expected mined attribution events after build');

    // Refresh with no new commits must not re-fetch cached content.
    const r1 = await store.refresh(client);
    assert.equal(r1.ok, true);
    assert.equal(client.getContentCalls, 2, 'refresh must reuse the immutable content cache, not re-fetch');

    // A new commit refetches only the new content; prior history is preserved.
    client.addCommit('c3', '2026-03-01T00:00:00Z', false);
    const r2 = await store.refresh(client);
    assert.equal(r2.ok, true);
    assert.equal(client.getContentCalls, 3, 'refresh should fetch only the one new commit');
    assert.ok(store.getEvents('FLTCost').length >= eventsAfterBuild, 'history must be preserved across refresh');
  });
});
