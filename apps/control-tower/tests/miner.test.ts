import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mineFlag, type AttributionEvent, type FlagCommit, type MineEvent } from '../src/engine/miner.ts';

/** Build a flag-file JSON string with the given Environments map. */
function flagJson(id: string, envs: Record<string, unknown>): string {
  return JSON.stringify({ Id: id, Description: `${id} desc`, Environments: envs });
}

/** The data-model §7 worked example: FLTArtifactBasedThrottling. */
function throttlingHistory(): FlagCommit[] {
  return [
    {
      commitId: 'a'.repeat(40),
      author: 'Alice',
      date: '2026-03-01T10:00:00Z',
      comment: 'Merged PR 1000001: create flag, enable test',
      rawJson: flagJson('FLTArtifactBasedThrottling', { test: { Enabled: true } }),
    },
    {
      commitId: 'b'.repeat(40),
      author: 'Bob',
      date: '2026-03-03T09:00:00Z',
      comment: 'Merged PR 1000002: enable msit',
      rawJson: flagJson('FLTArtifactBasedThrottling', {
        test: { Enabled: true },
        msit: { Enabled: true },
      }),
    },
    {
      commitId: 'c'.repeat(40),
      author: 'Carol',
      date: '2026-03-10T12:00:00Z',
      comment: 'Merged PR 1000003: target prod',
      rawJson: flagJson('FLTArtifactBasedThrottling', {
        test: { Enabled: true },
        msit: { Enabled: true },
        prod: { Targets: { Tenants: ['t1'] } },
      }),
    },
    {
      commitId: 'd'.repeat(40),
      author: 'Dave',
      date: '2026-03-13T08:00:00Z',
      comment: 'Merged PR 1000004: fully enable prod',
      rawJson: flagJson('FLTArtifactBasedThrottling', {
        test: { Enabled: true },
        msit: { Enabled: true },
        prod: { Enabled: true },
      }),
    },
  ];
}

function transitionsFor(events: MineEvent[], env: string): AttributionEvent[] {
  return events.filter((e): e is AttributionEvent => e.kind === 'transition' && e.env === env);
}

describe('mineFlag (architecture §3.4.1)', () => {
  it('emits a creation event for the first commit', () => {
    const events = mineFlag('FLTArtifactBasedThrottling', throttlingHistory());
    assert.equal(events[0]?.kind, 'creation');
    assert.equal(events[0]?.flagId, 'FLTArtifactBasedThrottling');
    assert.equal(events[0]?.attribution.author, 'Alice');
    assert.equal(events[0]?.attribution.prNumber, 1000001);
  });

  it('captures test enabled at creation (off → on)', () => {
    const test = transitionsFor(mineFlag('FLTArtifactBasedThrottling', throttlingHistory()), 'test');
    assert.equal(test.length, 1);
    assert.equal(test[0]?.prevState, 'off');
    assert.equal(test[0]?.currState, 'on');
    assert.equal(test[0]?.attribution.changedAt, '2026-03-01T10:00:00Z');
  });

  it('attributes each env change to the right author + PR', () => {
    const msit = transitionsFor(mineFlag('FLTArtifactBasedThrottling', throttlingHistory()), 'msit')[0];
    assert.equal(msit?.attribution.author, 'Bob');
    assert.equal(msit?.attribution.prNumber, 1000002);
    assert.equal(msit?.currState, 'on');
  });

  it('surfaces prod first-non-off (off → targeted) and the later graduation (targeted → on) as TWO events', () => {
    const prod = transitionsFor(mineFlag('FLTArtifactBasedThrottling', throttlingHistory()), 'prod');
    assert.equal(prod.length, 2);
    assert.equal(prod[0]?.prevState, 'off');
    assert.equal(prod[0]?.currState, 'targeted');
    assert.equal(prod[0]?.attribution.changedAt, '2026-03-10T12:00:00Z');
    assert.equal(prod[1]?.prevState, 'targeted');
    assert.equal(prod[1]?.currState, 'on');
    assert.equal(prod[1]?.attribution.changedAt, '2026-03-13T08:00:00Z');
  });

  it('does NOT emit phantom events for unchanged envs', () => {
    const test = transitionsFor(mineFlag('FLTArtifactBasedThrottling', throttlingHistory()), 'test');
    assert.equal(test.length, 1); // test changes only at creation
  });
});

describe('mineFlag — reformat-proofing (architecture §3.4.2, P0 risk R3)', () => {
  it('emits no transition when only formatting/key-order changes', () => {
    const commits: FlagCommit[] = [
      {
        commitId: '1'.repeat(40),
        author: 'A',
        date: '2026-01-01T00:00:00Z',
        comment: 'create',
        rawJson: flagJson('FLTX', { prod: { Targets: { Tenants: ['t1'], Regions: ['r1'] } } }),
      },
      {
        commitId: '2'.repeat(40),
        author: 'B',
        date: '2026-01-02T00:00:00Z',
        comment: 'reformat (key reorder only)',
        rawJson: flagJson('FLTX', { prod: { Targets: { Regions: ['r1'], Tenants: ['t1'] } } }),
      },
    ];
    const events = mineFlag('FLTX', commits);
    assert.equal(transitionsFor(events, 'prod').length, 1); // only the creation transition
    assert.equal(events.filter((e) => e.kind === 'transition').length, 1);
  });

  it('still emits when targeted content genuinely changes (targeted → targeted, modified)', () => {
    const commits: FlagCommit[] = [
      {
        commitId: '1'.repeat(40),
        author: 'A',
        date: '2026-01-01T00:00:00Z',
        comment: 'create',
        rawJson: flagJson('FLTX', { prod: { Targets: { Tenants: ['t1'] } } }),
      },
      {
        commitId: '2'.repeat(40),
        author: 'B',
        date: '2026-01-05T00:00:00Z',
        comment: 'expand targets',
        rawJson: flagJson('FLTX', { prod: { Targets: { Tenants: ['t1', 't2'] } } }),
      },
    ];
    const prod = transitionsFor(mineFlag('FLTX', commits), 'prod');
    assert.equal(prod.length, 2);
    assert.equal(prod[1]?.prevState, 'targeted');
    assert.equal(prod[1]?.currState, 'targeted');
    assert.equal(prod[1]?.attribution.author, 'B');
  });
});
