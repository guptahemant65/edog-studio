import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtStore, cid, type FlagSpec } from './_ado-fake.ts';
import { WarmStore } from '../src/engine/warm-store.ts';
import { buildDossierResponse } from '../src/api/dossier.ts';
import { buildPerFlagLadderResponse } from '../src/api/per-flag-ladder.ts';
import { buildTimelineDiff, buildActivityDiff } from '../src/api/diff.ts';
import { buildActivityStream, buildActivityTimeline, parseActivityFilter } from '../src/api/activity.ts';
import { buildTimeTravelBounds, buildTimeTravelResponse, InvalidAsOfError } from '../src/api/time-travel.ts';
import { buildInertResponse } from '../src/api/inert.ts';
import { buildUpdatesResponse, buildRefreshResponse, buildHealthResponse } from '../src/api/ops.ts';

const NOW = Date.parse('2026-06-01T00:00:00Z');

/** test→…→prod climb, enabling each rung on its own commit date. */
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

/** Full six-rung dwell ladder with the §5.2 contract spacing. */
function dwellLadder(): FlagSpec {
  const base = { test: { Enabled: true } };
  return {
    id: 'FLTDwell',
    commits: [
      { commitId: cid('dw0'), date: '2026-03-01T00:00:00Z', envs: { ...base } },
      { commitId: cid('dw1'), date: '2026-03-09T00:00:00Z', envs: { ...base, cst: { Enabled: true }, daily: { Enabled: true } } },
      { commitId: cid('dw2'), date: '2026-03-21T00:00:00Z', envs: { ...base, cst: { Enabled: true }, daily: { Enabled: true }, dxt: { Enabled: true } } },
      { commitId: cid('dw3'), date: '2026-03-28T00:00:00Z', envs: { ...base, cst: { Enabled: true }, daily: { Enabled: true }, dxt: { Enabled: true }, msit: { Enabled: true } } },
      { commitId: cid('dw4'), date: '2026-04-04T00:00:00Z', envs: { ...base, cst: { Enabled: true }, daily: { Enabled: true }, dxt: { Enabled: true }, msit: { Enabled: true }, prod: { Enabled: true } } },
    ],
  };
}

// ---- dossier ----

test('buildDossierResponse: current view exposes states, timeline, dwell, layer', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildDossierResponse(store, 'FLTAlpha', { now: NOW });
  assert.equal(res.found, true);
  assert.equal(res.existed, true);
  assert.equal(res.states.test, 'on');
  assert.equal(res.states.prod, 'on');
  assert.equal(res.timeToProdDays, 27); // 2026-01-05 → 2026-02-01
  assert.ok(res.timeline.length >= 2);
  // timeline is newest-first
  assert.ok(res.timeline[0]!.attribution.changedAt >= res.timeline.at(-1)!.attribution.changedAt);
  assert.equal(res.lastChange?.commitId, cid('FLTAlpha2'));
});

test('buildDossierResponse: asOf reconstructs the historical state', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  // 2026-01-10 is after test enabled (01-05) but before prod (02-01).
  const res = buildDossierResponse(store, 'FLTAlpha', { now: NOW, asOf: '2026-01-10T00:00:00Z' });
  assert.equal(res.found, true);
  assert.equal(res.existed, true);
  assert.equal(res.asOf, '2026-01-10T00:00:00Z');
  assert.equal(res.states.test, 'on');
  assert.equal(res.states.prod, 'off'); // not yet enabled at asOf
  assert.equal(res.timeToProdDays, null); // prod not reached within the asOf horizon
});

test('buildDossierResponse: unknown flag → found:false', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildDossierResponse(store, 'FLTMissing', { now: NOW });
  assert.equal(res.found, false);
  assert.equal(res.existed, false);
  assert.equal(res.timeline.length, 0);
});

test('buildDossierResponse: dwell rail matches the §5.2 contract spacing', async () => {
  const store = await builtStore([dwellLadder()]);
  const res = buildDossierResponse(store, 'FLTDwell', { now: NOW });
  const byRung = new Map(res.dwell.map((d) => [d.rung, d.dwellDays]));
  assert.equal(byRung.get('test'), 8); // 03-01 → 03-09
  assert.equal(byRung.get('cst'), 0); // 03-09 → 03-09
  assert.equal(byRung.get('daily'), 12); // 03-09 → 03-21
  assert.equal(byRung.get('dxt'), 7); // 03-21 → 03-28
  assert.equal(byRung.get('msit'), 7); // 03-28 → 04-04
  const prod = res.dwell.find((d) => d.rung === 'prod')!;
  assert.equal(prod.isCurrent, true);
  assert.equal(prod.nextRung, null);
  assert.equal(res.timeToProdDays, 34); // 03-01 → 04-04
});

// ---- per-flag ladder ----

test('buildPerFlagLadderResponse: rung states, furthest rung, firstEnabled', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildPerFlagLadderResponse(store, 'FLTAlpha', NOW);
  assert.equal(res.found, true);
  assert.equal(res.furthestRung, 'prod');
  const test = res.rungs.find((r) => r.rung === 'test')!;
  assert.equal(test.state, 'on');
  assert.equal(test.firstEnabled, '2026-01-05T00:00:00Z');
  const cst = res.rungs.find((r) => r.rung === 'cst')!;
  assert.equal(cst.state, 'off');
  assert.equal(cst.firstEnabled, null);
});

test('buildPerFlagLadderResponse: unknown flag → found:false', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildPerFlagLadderResponse(store, 'FLTNope', NOW);
  assert.equal(res.found, false);
  assert.equal(res.furthestRung, null);
});

// ---- timeline diff (commit-anchored) ----

test('buildTimelineDiff: env transitions carried by one commit', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildTimelineDiff(store, 'FLTAlpha', cid('FLTAlpha2'));
  assert.equal(res.found, true);
  assert.equal(res.isCreation, false);
  // commit 2 turns prod on (test was already on).
  const prod = res.changes.find((c) => c.env === 'prod')!;
  assert.equal(prod.prevState, 'off');
  assert.equal(prod.currState, 'on');
});

test('buildTimelineDiff: creation commit flagged as creation', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildTimelineDiff(store, 'FLTAlpha', cid('FLTAlpha0'));
  assert.equal(res.found, true);
  assert.equal(res.isCreation, true);
});

test('buildTimelineDiff: unknown commit → found:false', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildTimelineDiff(store, 'FLTAlpha', cid('nope'));
  assert.equal(res.found, false);
});

// ---- activity stream + diff round-trip ----

test('buildActivityStream: newest-first, filterable, paginated', async () => {
  const store = await builtStore([climb('FLTAlpha'), climb('FLTBeta')]);
  const all = buildActivityStream(store, {}, NOW);
  assert.ok(all.total >= 4);
  // newest-first
  assert.ok(all.items[0]!.attribution.changedAt >= all.items[1]!.attribution.changedAt);

  const onlyAlpha = buildActivityStream(store, { flags: new Set(['FLTAlpha']) }, NOW);
  assert.ok(onlyAlpha.items.every((i) => i.flagId === 'FLTAlpha'));

  const onlyProd = buildActivityStream(store, { envs: new Set(['prod']) }, NOW);
  assert.ok(onlyProd.items.every((i) => i.env === 'prod'));

  const paged = buildActivityStream(store, { limit: 1, offset: 0 }, NOW);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.limit, 1);
});

test('buildActivityDiff: eventId from the stream round-trips to its transition', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const stream = buildActivityStream(store, { flags: new Set(['FLTAlpha']), envs: new Set(['prod']) }, NOW);
  const row = stream.items[0]!;
  const diff = buildActivityDiff(store, row.eventId);
  assert.equal(diff.found, true);
  assert.equal(diff.flagId, 'FLTAlpha');
  assert.equal(diff.env, 'prod');
  assert.equal(diff.currState, 'on');
  assert.equal(diff.attribution?.commitId, row.attribution.commitId);
});

test('buildActivityDiff: malformed eventId → found:false', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const diff = buildActivityDiff(store, 'not-a-valid-id');
  assert.equal(diff.found, false);
});

test('buildActivityTimeline: buckets by UTC day with a busiest day', async () => {
  const store = await builtStore([climb('FLTAlpha'), climb('FLTBeta')]);
  const res = buildActivityTimeline(store, {}, NOW);
  assert.ok(res.totalEvents >= 4);
  // FLTAlpha + FLTBeta both create + enable test on 2026-01-01 / 2026-01-05.
  const sum = res.buckets.reduce((n, b) => n + b.count, 0);
  assert.equal(sum, res.totalEvents);
  assert.ok(res.busiestDay);
  assert.ok(res.range.from && res.range.to && res.range.from <= res.range.to);
});

test('parseActivityFilter: reads from/to/flags/envs/limit/offset', () => {
  const f = parseActivityFilter(new URLSearchParams('from=2026-01-01&to=2026-02-01&flags=A,B&envs=prod&limit=10&offset=5'));
  assert.equal(f.from, '2026-01-01');
  assert.equal(f.to, '2026-02-01');
  assert.deepEqual([...f.flags!], ['A', 'B']);
  assert.deepEqual([...f.envs!], ['prod']);
  assert.equal(f.limit, 10);
  assert.equal(f.offset, 5);
});

// ---- time travel ----

test('buildTimeTravelBounds: earliest/latest/totals over the event store', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const b = buildTimeTravelBounds(store);
  assert.equal(b.flagCount, 1);
  assert.equal(b.earliest, '2026-01-01T00:00:00Z');
  assert.equal(b.latest, '2026-02-01T00:00:00Z');
  assert.ok(b.totalEvents >= 2);
});

test('buildTimeTravelResponse: reconstructs per-flag state at an instant', async () => {
  const store = await builtStore([climb('FLTAlpha'), climb('FLTBeta')]);
  const res = buildTimeTravelResponse(store, { asOf: '2026-01-10T00:00:00Z', now: NOW });
  assert.equal(res.asOf, '2026-01-10T00:00:00Z');
  assert.equal(res.existingCount, 2);
  const alpha = res.rows.find((r) => r.flagId === 'FLTAlpha')!;
  assert.equal(alpha.states.test, 'on');
  assert.equal(alpha.states.prod, 'off'); // prod not enabled until 02-01
});

test('buildTimeTravelResponse: flag filter narrows the rows', async () => {
  const store = await builtStore([climb('FLTAlpha'), climb('FLTBeta')]);
  const res = buildTimeTravelResponse(store, { asOf: '2026-03-01T00:00:00Z', flags: new Set(['FLTAlpha']), now: NOW });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0]!.flagId, 'FLTAlpha');
});

test('buildTimeTravelResponse: before a flag existed → existed:false', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildTimeTravelResponse(store, { asOf: '2025-01-01T00:00:00Z', now: NOW });
  assert.equal(res.existingCount, 0);
  assert.equal(res.rows[0]!.existed, false);
});

test('buildTimeTravelResponse: invalid asOf → InvalidAsOfError', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  assert.throws(() => buildTimeTravelResponse(store, { asOf: 'not-a-date', now: NOW }), InvalidAsOfError);
});

// ---- inert intelligence ----

/** Two prerequisite flags (one on, one off in prod) + three dependents. */
function inertFixture(): FlagSpec[] {
  const on = { commitId: cid('on1'), date: '2026-02-01T00:00:00Z', envs: { test: { Enabled: true }, prod: { Enabled: true } } };
  const off = { commitId: cid('off1'), date: '2026-02-01T00:00:00Z', envs: { test: { Enabled: true } } };
  return [
    { id: 'FLTPrereqOn', commits: [on] },
    { id: 'FLTPrereqOff', commits: [off] },
    {
      id: 'FLTBlocked',
      commits: [{ commitId: cid('blk'), date: '2026-03-01T00:00:00Z', envs: { prod: { Enabled: true } }, description: 'FLTPrereqOff must be enabled before this works.' }],
    },
    {
      id: 'FLTSatisfied',
      commits: [{ commitId: cid('sat'), date: '2026-03-01T00:00:00Z', envs: { prod: { Enabled: true } }, description: 'Requires FLTPrereqOn to operate.' }],
    },
    {
      id: 'FLTExternalDep',
      commits: [{ commitId: cid('ext'), date: '2026-03-01T00:00:00Z', envs: { prod: { Enabled: true } }, description: 'Requires ExternalSystem to operate.' }],
    },
  ];
}

test('buildInertResponse: classifies INERT / OK / INFORMATIONAL correctly', async () => {
  const store = await builtStore(inertFixture());
  const res = buildInertResponse(store, NOW);
  const byFlag = new Map(res.findings.map((f) => [f.flagId, f.status]));
  assert.equal(byFlag.get('FLTBlocked'), 'INERT'); // prereq resolved + off in prod
  assert.equal(byFlag.get('FLTSatisfied'), 'OK'); // prereq resolved + on in prod
  assert.equal(byFlag.get('FLTExternalDep'), 'INFORMATIONAL'); // unresolved external prereq
  assert.equal(res.inertCount, 1);
  assert.equal(res.informationalCount, 1);
  // INERT ranks first.
  assert.equal(res.findings[0]!.flagId, 'FLTBlocked');
});

test('buildInertResponse: the INERT edge is marked as a blocker', async () => {
  const store = await builtStore(inertFixture());
  const res = buildInertResponse(store, NOW);
  const blocked = res.findings.find((f) => f.flagId === 'FLTBlocked')!;
  const edge = blocked.edges.find((e) => e.prerequisiteId === 'FLTPrereqOff')!;
  assert.equal(edge.isBlocker, true);
  assert.equal(edge.resolution, 'resolved-flt');
  assert.equal(edge.prereqProdState, 'off');
});

test('buildInertResponse: prereq flags with no dependency text are not surfaced', async () => {
  const store = await builtStore(inertFixture());
  const res = buildInertResponse(store, NOW);
  assert.equal(res.findings.some((f) => f.flagId === 'FLTPrereqOn'), false);
  assert.equal(res.parserMeta.flagsAnalyzed, 5);
});

// ---- ops (updates / refresh / health) ----

test('buildUpdatesResponse: remote head differing from store head → newer available', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const head = store.freshness(NOW).headCommitId!;
  assert.equal(buildUpdatesResponse(store, head, NOW).newerHeadAvailable, false);
  assert.equal(buildUpdatesResponse(store, cid('newer'), NOW).newerHeadAvailable, true);
  assert.equal(buildUpdatesResponse(store, null, NOW).newerHeadAvailable, false);
});

test('buildRefreshResponse: surfaces the atomic refresh result + meta', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildRefreshResponse({ ok: true, headCommitId: cid('h'), totalEvents: 3 }, store, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.headCommitId, cid('h'));
  assert.equal(res.totalEvents, 3);
  assert.equal(res.error, null);
  assert.ok(res.meta);
});

test('buildHealthResponse: liveness + cache stats without a build', () => {
  const empty = buildHealthResponse(new WarmStore(), NOW - 5000, NOW);
  assert.equal(empty.status, 'ok');
  assert.equal(empty.uptimeSeconds, 5);
  assert.equal(empty.cacheStats.isBuilt, false);
  assert.equal(empty.cacheStats.flagCount, 0);
});

test('buildHealthResponse: reports flag + cache counts once built', async () => {
  const store = await builtStore([climb('FLTAlpha')]);
  const res = buildHealthResponse(store, NOW - 1000, NOW);
  assert.equal(res.cacheStats.isBuilt, true);
  assert.equal(res.cacheStats.flagCount, 1);
  assert.ok(res.cacheStats.cacheSize >= 3);
});
