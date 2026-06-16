import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mineFlag, type FlagCommit } from '../src/engine/miner.ts';
import { firstEnabledDate, calendarDaysBetween, ladderDwell } from '../src/engine/derivation.ts';

function flagJson(envs: Record<string, unknown>): string {
  return JSON.stringify({ Id: 'FLTArtifactBasedThrottling', Environments: envs });
}

function history(): FlagCommit[] {
  return [
    { commitId: 'a'.repeat(40), author: 'A', date: '2026-03-01T10:00:00Z', comment: 'create', rawJson: flagJson({ test: { Enabled: true } }) },
    { commitId: 'b'.repeat(40), author: 'B', date: '2026-03-03T09:00:00Z', comment: 'msit', rawJson: flagJson({ test: { Enabled: true }, msit: { Enabled: true } }) },
    { commitId: 'c'.repeat(40), author: 'C', date: '2026-03-10T12:00:00Z', comment: 'prod target', rawJson: flagJson({ test: { Enabled: true }, msit: { Enabled: true }, prod: { Targets: { Tenants: ['t1'] } } }) },
    { commitId: 'd'.repeat(40), author: 'D', date: '2026-03-13T08:00:00Z', comment: 'prod on', rawJson: flagJson({ test: { Enabled: true }, msit: { Enabled: true }, prod: { Enabled: true } }) },
  ];
}

describe('calendarDaysBetween', () => {
  it('counts whole calendar days regardless of time-of-day', () => {
    assert.equal(calendarDaysBetween('2026-03-03T09:00:00Z', '2026-03-10T12:00:00Z'), 7);
  });
  it('is zero on the same day', () => {
    assert.equal(calendarDaysBetween('2026-03-03T01:00:00Z', '2026-03-03T23:00:00Z'), 0);
  });
});

describe('firstEnabledDate (dwell rule, data-model §7 — first non-off)', () => {
  it('uses the first non-off transition (targeted counts)', () => {
    const events = mineFlag('FLTArtifactBasedThrottling', history());
    assert.equal(firstEnabledDate(events, 'prod'), '2026-03-10T12:00:00Z'); // targeted, not the later 'on'
    assert.equal(firstEnabledDate(events, 'msit'), '2026-03-03T09:00:00Z');
  });
  it('is null for a never-reached rung', () => {
    const events = mineFlag('FLTArtifactBasedThrottling', history());
    assert.equal(firstEnabledDate(events, 'dxt'), null);
  });
});

describe('ladderDwell — worked example FLTArtifactBasedThrottling', () => {
  it('msit → prod dwell is 7 calendar days', () => {
    const dwell = ladderDwell(mineFlag('FLTArtifactBasedThrottling', history()));
    const msitToProd = dwell.find((d) => d.from === 'msit' && d.to === 'prod');
    assert.equal(msitToProd?.dwellDays, 7);
  });
  it('null dwell where a rung was never reached', () => {
    const dwell = ladderDwell(mineFlag('FLTArtifactBasedThrottling', history()));
    assert.equal(dwell.find((d) => d.from === 'cst' && d.to === 'daily')?.dwellDays, null);
  });
});
