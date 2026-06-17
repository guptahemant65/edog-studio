import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtStore, cid, type FlagSpec } from './_ado-fake.ts';
import { WarmStore } from '../src/engine/warm-store.ts';
import { buildFreshnessResponse } from '../src/api/freshness.ts';
import { buildLadderDistributionResponse } from '../src/api/ladder.ts';
import { buildVelocityResponse } from '../src/api/velocity.ts';
import { buildSovereignLensResponse } from '../src/api/sovereign.ts';

const NOW = Date.parse('2026-06-01T00:00:00Z');

/** test→…→prod climb: enable each rung on its own commit date. */
function climb(id: string): FlagSpec {
  return {
    id,
    commits: [
      { commitId: cid(`${id}0`), date: '2026-01-01T00:00:00Z', envs: {} },
      { commitId: cid(`${id}1`), date: '2026-01-05T00:00:00Z', envs: { test: { Enabled: true } } },
      { commitId: cid(`${id}2`), date: '2026-02-01T00:00:00Z', envs: { test: { Enabled: true }, prod: { Enabled: true } } },
    ],
  };
}

// ---- freshness ----

test('buildFreshnessResponse: built store reports ok + flag/cache counts', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  // syncedAt is build wall-clock, so freshness is relative to real now, not fixtures.
  const fresh = buildFreshnessResponse(store, Date.now());
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.flagCount, 1);
  assert.ok(fresh.cacheSize >= 3); // three commits cached
  assert.equal(fresh.isStale, false);
  assert.ok(fresh.headCommitId);
  // 61 minutes past the sync → stale (STALE_AFTER_MINUTES = 60).
  const later = buildFreshnessResponse(store, Date.now() + 61 * 60_000);
  assert.equal(later.isStale, true);
});

test('buildFreshnessResponse: empty store → empty status, no ADO needed', () => {
  const res = buildFreshnessResponse(new WarmStore(), NOW);
  assert.equal(res.status, 'empty');
  assert.equal(res.flagCount, 0);
  assert.equal(res.syncedAt, null);
  assert.equal(res.isStale, true);
});

// ---- ladder distribution ----

test('buildLadderDistributionResponse: counts per-rung states + furthest rung', async () => {
  const store = await builtStore([
    climb('FLTAlpha'), // test on, prod on
    { id: 'FLTBeta', commits: [{ commitId: cid('b1'), date: '2026-03-01T00:00:00Z', envs: { test: { Enabled: true } } }] },
  ]);
  const res = buildLadderDistributionResponse(store, NOW);
  assert.equal(res.distribution.totalFlags, 2);
  const test = res.distribution.rungs.find((r) => r.rung === 'test')!;
  assert.equal(test.on, 2);
  assert.equal(test.reached, 2);
  const prod = res.distribution.rungs.find((r) => r.rung === 'prod')!;
  assert.equal(prod.on, 1);
  // Alpha's furthest non-off ladder rung is prod; Beta's is test.
  assert.equal(res.distribution.furthestRung.prod, 1);
  assert.equal(res.distribution.furthestRung.test, 1);
  assert.equal(res.meta.flagCount, 2);
});

// ---- velocity ----

test('buildVelocityResponse: per-flag TTP + cohort needs >=3 flags', async () => {
  const store = await builtStore([climb('FLTAlpha'), climb('FLTBeta')]);
  const res = buildVelocityResponse(store, NOW);
  assert.deepEqual(res.flags.map((f) => f.flagId), ['FLTAlpha', 'FLTBeta']);
  // test first enabled 2026-01-05, prod on 2026-02-01 → 27 days.
  assert.equal(res.flags[0]!.ttpDays, 27);
  assert.equal(res.cohort.count, 2); // <3 → no median
  assert.equal(res.cohort.median, null);
});

test('buildVelocityResponse: cohort stats once >=3 fully-rolled-out flags', async () => {
  const store = await builtStore([climb('FLTAlpha'), climb('FLTBeta'), climb('FLTGamma')]);
  const res = buildVelocityResponse(store, NOW);
  assert.equal(res.cohort.count, 3);
  assert.equal(res.cohort.median, 27);
  assert.equal(res.cohort.fastest, 27);
  // all three reach prod=on in 2026-Q1.
  assert.equal(res.quarterlyTrend['2026-Q1'], 3);
});

test('buildVelocityResponse: empty store → empty flags, zero cohort', () => {
  const res = buildVelocityResponse(new WarmStore(), NOW);
  assert.equal(res.flags.length, 0);
  assert.equal(res.cohort.count, 0);
  assert.deepEqual(res.quarterlyTrend, {});
});

// ---- sovereign lens ----

test('buildSovereignLensResponse: prod-on/cloud-off gap classified + aggregated', async () => {
  const store = await builtStore([
    {
      id: 'FLTSov',
      commits: [
        { commitId: cid('s1'), date: '2026-01-01T00:00:00Z', envs: {} },
        { commitId: cid('s2'), date: '2026-02-01T00:00:00Z', envs: { prod: { Enabled: true }, mc: { Enabled: true } } },
      ],
    },
  ]);
  const res = buildSovereignLensResponse(store, NOW);
  const flag = res.flags[0]!;
  assert.equal(flag.flagId, 'FLTSov');
  // prod on, mc on (aligned → no gap), other 6 clouds off vs prod on → 6 gaps.
  assert.equal(flag.gapCount, 6);
  assert.equal(res.byKind.prod_on_cloud_off, 6);
  assert.equal(res.totalGaps, 6);
});

test('buildSovereignLensResponse: flags sorted by gapCount desc', async () => {
  const store = await builtStore([
    { id: 'FLTLow', commits: [{ commitId: cid('l1'), date: '2026-02-01T00:00:00Z', envs: {} }] },
    { id: 'FLTHigh', commits: [{ commitId: cid('h1'), date: '2026-02-01T00:00:00Z', envs: { prod: { Enabled: true } } }] },
  ]);
  const res = buildSovereignLensResponse(store, NOW);
  // FLTHigh: prod on, all 7 clouds off → 7 gaps. FLTLow: prod off, all off → 0.
  assert.equal(res.flags[0]!.flagId, 'FLTHigh');
  assert.equal(res.flags[0]!.gapCount, 7);
  assert.equal(res.flags[1]!.gapCount, 0);
});
