import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGap, sovereignGaps } from '../src/engine/sovereign.ts';
import { currentStates, type EnvStates } from '../src/engine/current-state.ts';
import { type CellState, type EnvKey } from '../src/types/model.ts';

function states(overrides: Partial<Record<EnvKey, CellState>>): EnvStates {
  return { ...currentStates([]), ...overrides };
}

test('classifyGap: aligned states → null', () => {
  assert.equal(classifyGap('on', 'on'), null);
  assert.equal(classifyGap('off', 'off'), null);
});

test('classifyGap: prod ahead of cloud', () => {
  assert.equal(classifyGap('on', 'off'), 'prod_on_cloud_off');
  assert.equal(classifyGap('on', 'conditional'), 'prod_on_cloud_cond');
  assert.equal(classifyGap('on', 'targeted'), 'prod_on_cloud_target');
  assert.equal(classifyGap('conditional', 'off'), 'prod_cond_cloud_off');
  assert.equal(classifyGap('targeted', 'off'), 'prod_target_cloud_off');
});

test('classifyGap: cloud ahead of prod', () => {
  assert.equal(classifyGap('off', 'on'), 'cloud_on_prod_off');
  assert.equal(classifyGap('conditional', 'on'), 'cloud_on_prod_cond');
  assert.equal(classifyGap('off', 'conditional'), 'cloud_cond_prod_off');
});

test('classifyGap: unmapped combo → null', () => {
  assert.equal(classifyGap('targeted', 'conditional'), null);
});

test('sovereignGaps: 7 sovereign cells, each compared to prod', () => {
  const s = states({ prod: 'on', mc: 'off', gcc: 'on' });
  const gaps = sovereignGaps(s);
  assert.equal(gaps.length, 7);
  const mc = gaps.find((g) => g.env === 'mc')!;
  assert.equal(mc.gap, 'prod_on_cloud_off');
  assert.equal(mc.prodState, 'on');
  const gcc = gaps.find((g) => g.env === 'gcc')!;
  assert.equal(gcc.gap, null);
});
