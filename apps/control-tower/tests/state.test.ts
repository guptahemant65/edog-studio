import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyState, normaliseBlock, extractPR, buildPrUrl } from '../src/engine/state.ts';

describe('classifyState (data-model §1, architecture §3.3)', () => {
  it('absent or empty block is off', () => {
    assert.equal(classifyState(undefined), 'off');
    assert.equal(classifyState(null), 'off');
    assert.equal(classifyState({}), 'off');
  });

  it('Enabled:true is on', () => {
    assert.equal(classifyState({ Enabled: true }), 'on');
  });

  it('non-empty Requires is conditional', () => {
    assert.equal(classifyState({ Requires: ['Ring:Internal'] }), 'conditional');
  });

  it('empty Requires array is NOT conditional', () => {
    assert.equal(classifyState({ Requires: [] }), 'off');
  });

  it('Targets is targeted', () => {
    assert.equal(classifyState({ Targets: { Tenants: ['guid'] } }), 'targeted');
  });

  it('Enabled wins over Requires and Targets (precedence)', () => {
    assert.equal(classifyState({ Enabled: true, Requires: ['x'], Targets: {} }), 'on');
  });

  it('Requires wins over Targets', () => {
    assert.equal(classifyState({ Requires: ['x'], Targets: { a: 1 } }), 'conditional');
  });
});

describe('normaliseBlock (architecture §3.4.2 — reformat-proofing)', () => {
  it('key order does not matter', () => {
    assert.equal(normaliseBlock({ a: 1, b: 2 }), normaliseBlock({ b: 2, a: 1 }));
  });

  it('nested key order does not matter', () => {
    const x = { Targets: { Tenants: ['g1', 'g2'], Regions: ['r1'] } };
    const y = { Targets: { Regions: ['r1'], Tenants: ['g1', 'g2'] } };
    assert.equal(normaliseBlock(x), normaliseBlock(y));
  });

  it('absent and empty normalise identically', () => {
    assert.equal(normaliseBlock(undefined), normaliseBlock({}));
  });

  it('a real value change is detected', () => {
    assert.notEqual(normaliseBlock({ Enabled: true }), normaliseBlock({ Enabled: false }));
  });
});

describe('PR linkage (architecture §3.4.3)', () => {
  it('extracts merged PR number', () => {
    assert.equal(extractPR('Merged PR 1234567: enable prod'), 1234567);
  });

  it('is case-insensitive', () => {
    assert.equal(extractPR('merged pr 42'), 42);
  });

  it('returns null when no PR', () => {
    assert.equal(extractPR('hotfix typo'), null);
  });

  it('builds the ADO PR url', () => {
    assert.equal(
      buildPrUrl(42),
      'https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/42',
    );
  });
});
