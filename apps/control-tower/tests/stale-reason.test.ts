import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStaleReason } from '../src/engine/stale-reason.ts';
import { currentStates, type EnvStates } from '../src/engine/current-state.ts';
import { CANONICAL_15_ENVS, MAINLINE_ENVS, type CellState, type EnvKey } from '../src/types/model.ts';

function states(overrides: Partial<Record<EnvKey, CellState>>): EnvStates {
  const base = currentStates([]); // all off
  return { ...base, ...overrides };
}

test('ACTIVE_ROLLOUT: recent change + partial mainline', () => {
  const s = states({ test: 'on', cst: 'on' });
  assert.equal(deriveStaleReason(s, 5), 'ACTIVE_ROLLOUT');
});

test('PROBABLY_DEAD: all 15 off and old', () => {
  const s = states({});
  assert.equal(deriveStaleReason(s, 120), 'PROBABLY_DEAD');
});

test('PROBABLY_LAUNCHED: full mainline + old', () => {
  const o: Partial<Record<EnvKey, CellState>> = {};
  for (const e of MAINLINE_ENVS) o[e] = 'on';
  assert.equal(deriveStaleReason(states(o), 120), 'PROBABLY_LAUNCHED');
});

test('PROBABLY_FORGOTTEN: partial mainline, very old', () => {
  const s = states({ test: 'on', cst: 'on', daily: 'on' });
  assert.equal(deriveStaleReason(s, 200), 'PROBABLY_FORGOTTEN');
});

test('STABLE (null): partial mainline, moderate age', () => {
  const s = states({ test: 'on' });
  assert.equal(deriveStaleReason(s, 60), null);
});

test('priority: active-rollout beats forgotten when recent', () => {
  const s = states({ test: 'on' });
  assert.equal(deriveStaleReason(s, 10), 'ACTIVE_ROLLOUT');
});

test('null daysSinceLastChange → null (cannot classify by age)', () => {
  assert.equal(deriveStaleReason(states({ test: 'on' }), null), null);
});

test('thresholds are configurable', () => {
  const s = states({ test: 'on' });
  // With a tiny forgotten threshold, an old partial-mainline flag is forgotten.
  assert.equal(deriveStaleReason(s, 40, {
    activeRolloutDays: 30, probablyDeadDays: 90, probablyLaunchedDays: 90, probablyForgottenDays: 35,
  }), 'PROBABLY_FORGOTTEN');
});

test('sanity: env constants', () => {
  assert.equal(CANONICAL_15_ENVS.length, 15);
  assert.equal(MAINLINE_ENVS.length, 7);
});
