import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentStates, lastChange, daysSinceLastChange } from '../src/engine/current-state.ts';
import { tx } from './_fixtures.ts';

test('currentStates: all 15 envs present, default off', () => {
  const s = currentStates([]);
  assert.equal(Object.keys(s).length, 15);
  assert.equal(s.prod, 'off');
  assert.equal(s.test, 'off');
});

test('currentStates: latest transition per env wins', () => {
  const events = [
    tx('test', 'off', 'targeted', '2026-03-01T00:00:00Z'),
    tx('test', 'targeted', 'on', '2026-03-05T00:00:00Z'),
    tx('prod', 'off', 'targeted', '2026-03-10T00:00:00Z'),
  ];
  const s = currentStates(events);
  assert.equal(s.test, 'on');
  assert.equal(s.prod, 'targeted');
  assert.equal(s.cst, 'off');
});

test('currentStates: out-of-order events resolve by changedAt', () => {
  const events = [
    tx('msit', 'targeted', 'on', '2026-03-09T00:00:00Z'),
    tx('msit', 'off', 'targeted', '2026-03-01T00:00:00Z'),
  ];
  assert.equal(currentStates(events).msit, 'on');
});

test('lastChange: newest transition attribution', () => {
  const events = [
    tx('test', 'off', 'on', '2026-03-01T00:00:00Z', { author: 'alice' }),
    tx('prod', 'off', 'on', '2026-03-10T00:00:00Z', { author: 'bob' }),
  ];
  assert.equal(lastChange(events)?.author, 'bob');
  assert.equal(lastChange([]), null);
});

test('daysSinceLastChange: calendar days from last change', () => {
  const now = Date.parse('2026-03-20T00:00:00Z');
  const events = [tx('prod', 'off', 'on', '2026-03-10T00:00:00Z')];
  assert.equal(daysSinceLastChange(events, now), 10);
  assert.equal(daysSinceLastChange([], now), null);
});
