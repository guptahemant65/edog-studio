import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderDistribution } from '../src/engine/ladder-distribution.ts';
import { currentStates, type EnvStates } from '../src/engine/current-state.ts';
import { type CellState, type EnvKey } from '../src/types/model.ts';

function states(overrides: Partial<Record<EnvKey, CellState>>): EnvStates {
  return { ...currentStates([]), ...overrides };
}

test('ladderDistribution: per-rung state counts', () => {
  const flags = [
    states({ test: 'on', cst: 'on', daily: 'targeted' }),
    states({ test: 'on', cst: 'conditional' }),
    states({}),
  ];
  const d = ladderDistribution(flags);
  assert.equal(d.totalFlags, 3);
  const test = d.rungs.find((r) => r.rung === 'test')!;
  assert.equal(test.on, 2);
  assert.equal(test.off, 1);
  assert.equal(test.reached, 2);
  const cst = d.rungs.find((r) => r.rung === 'cst')!;
  assert.equal(cst.on, 1);
  assert.equal(cst.conditional, 1);
  assert.equal(cst.reached, 2);
});

test('ladderDistribution: furthest-rung histogram', () => {
  const flags = [
    states({ test: 'on', cst: 'on', daily: 'targeted' }), // furthest = daily
    states({ test: 'on' }), // furthest = test
    states({}), // none
    states({ test: 'on', cst: 'on', daily: 'on', dxt: 'on', msit: 'on', prod: 'on' }), // prod
  ];
  const d = ladderDistribution(flags);
  assert.equal(d.furthestRung.daily, 1);
  assert.equal(d.furthestRung.test, 1);
  assert.equal(d.furthestRung.none, 1);
  assert.equal(d.furthestRung.prod, 1);
});

test('ladderDistribution: 6 rungs in canonical order', () => {
  const d = ladderDistribution([]);
  assert.deepEqual(d.rungs.map((r) => r.rung), ['test', 'cst', 'daily', 'dxt', 'msit', 'prod']);
});
