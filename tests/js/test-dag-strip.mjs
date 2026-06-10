/**
 * Unit tests for the DAG Studio execution-strip wiring improvements:
 *   - ExecutionStateManager.markTerminal — the single, idempotent terminal
 *     transition (status + endedAt + emit + onExecutionComplete, fired ONCE).
 *     Regression anchor (#3): the REST poller used to poke _executionStatus /
 *     _endedAt directly and hand-roll the callbacks, which could double-fire or
 *     silently skip onExecutionComplete. markTerminal funnels every path.
 *   - dagFormatDuration — the single pure formatter shared by the rAF summary
 *     refresh and the 100ms elapsed tick, so the strip duration can never
 *     disagree with the toolbar timer (#1) and stays monotonic / non-negative
 *     under client/server clock skew (#5).
 *
 * Both symbols are top-level lexical bindings vm does not auto-expose, so we
 * append a one-line export before evaluating (same trick as test-dag-state).
 * @author Sentinel — EDOG Studio hivemind
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function load() {
  var code = readFileSync(join(srcDir, 'dag-studio.js'), 'utf-8');
  code += '\nglobalThis.__ESM = ExecutionStateManager;\nglobalThis.__fmt = dagFormatDuration;';
  var ctx = vm.createContext({
    globalThis: {}, console: console,
    Object: Object, Array: Array, Math: Math, Date: Date, Map: Map, Set: Set,
    String: String, Number: Number, Boolean: Boolean, JSON: JSON,
  });
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx);
  return { ESM: ctx.__ESM, fmt: ctx.__fmt };
}

function freshRunning() {
  const { ESM } = load();
  const esm = new ESM();
  esm.setDag({ nodes: [{ nodeId: 'a', name: 'A' }, { nodeId: 'b', name: 'B' }], edges: [] });
  esm.startTracking('iter-1');
  return esm;
}

test('markTerminal: fires onExecutionComplete exactly once (idempotent)', () => {
  const esm = freshRunning();
  const calls = [];
  esm.onExecutionComplete = (id, s) => calls.push({ id, s });
  const a = esm.markTerminal('completed');
  const b = esm.markTerminal('completed'); // duplicate, e.g. poll after telemetry
  const c = esm.markTerminal('failed');    // late conflicting signal
  assert.equal(a, true, 'first transition returns true');
  assert.equal(b, false, 'duplicate is a no-op');
  assert.equal(c, false, 'cannot re-resolve a terminal run');
  assert.equal(esm.status, 'completed', 'status frozen at first terminal value');
  assert.equal(calls.length, 1, 'onExecutionComplete fired exactly once');
  assert.deepEqual(calls[0], { id: 'iter-1', s: 'completed' });
});

test('markTerminal: sets endedAt and emits state-change once', () => {
  const esm = freshRunning();
  let emits = 0;
  esm.onExecutionStateChanged = () => { emits += 1; };
  assert.equal(esm.endedAt, null);
  esm.markTerminal('failed');
  assert.equal(esm.status, 'failed');
  assert.equal(typeof esm.endedAt, 'number');
  assert.ok(esm.endedAt >= esm.startedAt, 'endedAt is not before startedAt (#5)');
  assert.equal(emits, 1);
});

test('markTerminal: no-op when idle (never started)', () => {
  const { ESM } = load();
  const esm = new ESM();
  let fired = false;
  esm.onExecutionComplete = () => { fired = true; };
  assert.equal(esm.markTerminal('completed'), false);
  assert.equal(esm.status, 'idle');
  assert.equal(fired, false);
});

test('markTerminal: cancelling -> cancelled is a valid terminal transition', () => {
  const esm = freshRunning();
  esm._executionStatus = 'cancelling';
  let calls = 0;
  esm.onExecutionComplete = () => { calls += 1; };
  assert.equal(esm.markTerminal('cancelled'), true);
  assert.equal(esm.status, 'cancelled');
  assert.equal(calls, 1);
});

test('dagFormatDuration: terminal shows the frozen final delta', () => {
  const { fmt } = load();
  assert.equal(fmt(1000, 4500, 'completed', 9999), '3.5s');
});

test('dagFormatDuration: running counts against now (live)', () => {
  const { fmt } = load();
  assert.equal(fmt(1000, null, 'running', 3000), '2.0s');
});

test('dagFormatDuration: cancelling is still treated as live (#2)', () => {
  const { fmt } = load();
  assert.equal(fmt(1000, null, 'cancelling', 2500), '1.5s');
});

test('dagFormatDuration: never negative under clock skew (#5)', () => {
  const { fmt } = load();
  assert.equal(fmt(5000, 4000, 'completed', 0), '0.0s'); // end before start -> clamp
  assert.equal(fmt(5000, null, 'running', 4000), '0.0s'); // now before start -> clamp
});

test('dagFormatDuration: idle/pending shows the placeholder', () => {
  const { fmt } = load();
  assert.equal(fmt(null, null, 'idle', 1000), '--');
  assert.equal(fmt(null, null, 'pending', 1000), '--');
});
