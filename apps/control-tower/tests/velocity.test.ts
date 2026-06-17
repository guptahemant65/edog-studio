import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flagVelocity, cohortStats, percentile, median, perRungMedianDwell, quarterOf, quarterlyTrend,
} from '../src/engine/velocity.ts';
import { tx } from './_fixtures.ts';
import type { MineEvent } from '../src/engine/miner.ts';

function rolledOutFlag(testDate: string, prodOnDate: string): MineEvent[] {
  return [
    tx('test', 'off', 'on', testDate),
    tx('prod', 'off', 'targeted', prodOnDate),
    tx('prod', 'targeted', 'on', prodOnDate),
  ];
}

test('flagVelocity: TTP = prod-on minus test-start', () => {
  const v = flagVelocity('F', rolledOutFlag('2026-03-01T00:00:00Z', '2026-03-11T00:00:00Z'));
  assert.equal(v.ttpDays, 10);
  assert.equal(v.partialTtpDays, 10);
});

test('flagVelocity: partial TTP when prod targeted but not on', () => {
  const events = [
    tx('test', 'off', 'on', '2026-03-01T00:00:00Z'),
    tx('prod', 'off', 'targeted', '2026-03-08T00:00:00Z'),
  ];
  const v = flagVelocity('F', events);
  assert.equal(v.ttpDays, null);
  assert.equal(v.partialTtpDays, 7);
});

test('percentile + median', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(percentile([1, 2, 3, 4], 25), 1.75);
  assert.equal(median([]), null);
});

test('cohortStats: needs >=3 flags', () => {
  assert.equal(cohortStats([5, 10]).median, null);
  const s = cohortStats([5, 10, 15, 20]);
  assert.equal(s.count, 4);
  assert.equal(s.fastest, 5);
  assert.equal(s.slowest, 20);
  assert.equal(s.median, 12.5);
});

test('perRungMedianDwell: median across flags per rung', () => {
  const a = [tx('test', 'off', 'on', '2026-03-01T00:00:00Z'), tx('cst', 'off', 'on', '2026-03-05T00:00:00Z')];
  const b = [tx('test', 'off', 'on', '2026-03-01T00:00:00Z'), tx('cst', 'off', 'on', '2026-03-09T00:00:00Z')];
  const r = perRungMedianDwell([a, b]);
  assert.equal(r.test, 6); // dwell test→cst: 4 and 8, median 6
  assert.equal(r.cst, null); // no daily reached
});

test('quarterOf + quarterlyTrend', () => {
  assert.equal(quarterOf('2026-02-15T00:00:00Z'), '2026-Q1');
  assert.equal(quarterOf('2026-07-01T00:00:00Z'), '2026-Q3');
  const trend = quarterlyTrend([
    rolledOutFlag('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    rolledOutFlag('2026-01-01T00:00:00Z', '2026-02-15T00:00:00Z'),
    rolledOutFlag('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z'),
  ]);
  assert.equal(trend['2026-Q1'], 2);
  assert.equal(trend['2026-Q2'], 1);
});
