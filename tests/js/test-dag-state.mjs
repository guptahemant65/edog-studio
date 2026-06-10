/**
 * Unit tests for the DAG Studio ExecutionStateManager (ESM) state matrix.
 * Guards the node state machine so the renderer/gantt glue can trust it:
 *   - _mapNodeStatus     — every FLT NodeExecutionStatus -> internal state
 *   - _isTerminal        — the terminal set (incl. the warning state)
 *   - _updateNodeState   — enforced transitions (running/pending -> warning)
 *   - _checkCompletion   — execution resolves when a node finishes 'warning'
 * Regression anchor: 'warning' used to fall through to 'pending' and was not
 * terminal, so a node that finished with warnings left the whole execution
 * stuck in 'running' forever. See _mapNodeStatus / _isTerminal in dag-studio.js.
 *
 * ExecutionStateManager is a top-level `class` (a lexical binding that vm does
 * not auto-expose), so we append a one-line export before evaluating.
 * @author Sentinel — EDOG Studio hivemind
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadESM() {
  var code = readFileSync(join(srcDir, 'dag-studio.js'), 'utf-8');
  code += '\nglobalThis.__ESM = ExecutionStateManager;';
  var ctx = vm.createContext({
    globalThis: {}, console: console,
    Object: Object, Array: Array, Math: Math, Date: Date, Map: Map, Set: Set,
    String: String, Number: Number, Boolean: Boolean, JSON: JSON,
  });
  // node:vm aliases the context object as its own globalThis.
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx);
  return ctx.__ESM;
}

function freshExecution() {
  const ESM = loadESM();
  const esm = new ESM();
  esm.setDag({ nodes: [{ nodeId: 'a', name: 'A' }, { nodeId: 'b', name: 'B' }], edges: [] });
  esm.startTracking('iter-1');
  return esm;
}

test('_mapNodeStatus: warning and its aliases map to the warning state', () => {
  const esm = new (loadESM())();
  for (const raw of ['warning', 'Warning', 'WARN', 'CompletedWithWarnings', 'SucceededWithWarnings']) {
    assert.equal(esm._mapNodeStatus(raw), 'warning', raw + ' should map to warning');
  }
});

test('_mapNodeStatus: known statuses unchanged', () => {
  const esm = new (loadESM())();
  assert.equal(esm._mapNodeStatus('Succeeded'), 'completed');
  assert.equal(esm._mapNodeStatus('Faulted'), 'failed');
  assert.equal(esm._mapNodeStatus('Skipped'), 'skipped');
  assert.equal(esm._mapNodeStatus('Cancelling'), 'cancelling');
  assert.equal(esm._mapNodeStatus('Running'), 'running');
  assert.equal(esm._mapNodeStatus(''), 'pending');
  assert.equal(esm._mapNodeStatus(null), 'pending');
});

test('_isTerminal: warning is terminal alongside the other end states', () => {
  const esm = new (loadESM())();
  for (const s of ['completed', 'failed', 'cancelled', 'skipped', 'warning']) {
    assert.equal(esm._isTerminal(s), true, s + ' should be terminal');
  }
  for (const s of ['pending', 'running', 'cancelling']) {
    assert.equal(esm._isTerminal(s), false, s + ' should NOT be terminal');
  }
});

test('_updateNodeState: pending -> warning is an allowed transition', () => {
  const esm = freshExecution();
  let observed = null;
  esm.onNodeStateChanged = (id, st) => { if (id === 'a') observed = st.status; };
  esm._updateNodeState('a', { status: 'warning', startedAt: 1, endedAt: 2, source: 'test' });
  assert.equal(esm.nodeStates.get('a').status, 'warning');
  assert.equal(observed, 'warning');
});

test('_updateNodeState: running -> warning is an allowed transition', () => {
  const esm = freshExecution();
  esm._updateNodeState('a', { status: 'running', startedAt: 1, source: 'test' });
  esm._updateNodeState('a', { status: 'warning', startedAt: 1, endedAt: 2, source: 'test' });
  assert.equal(esm.nodeStates.get('a').status, 'warning');
});

test('_checkCompletion: a warning node lets the execution resolve (regression)', () => {
  const esm = freshExecution();
  let done = null;
  esm.onExecutionComplete = (iterId, status) => { done = { iterId, status }; };
  esm._updateNodeState('a', { status: 'completed', startedAt: 1, endedAt: 2, source: 'test' });
  esm._updateNodeState('b', { status: 'warning', startedAt: 1, endedAt: 2, source: 'test' });
  // Before the fix, 'warning' was non-terminal -> _checkCompletion never fired
  // and status stayed 'running'. A warning-only run completes (warnings are a
  // per-node concern; execution still succeeded).
  assert.equal(esm.status, 'completed');
  assert.deepEqual(done, { iterId: 'iter-1', status: 'completed' });
});

test('_checkCompletion: a failed node still wins over warning', () => {
  const esm = freshExecution();
  esm._updateNodeState('a', { status: 'warning', startedAt: 1, endedAt: 2, source: 'test' });
  esm._updateNodeState('b', { status: 'failed', startedAt: 1, endedAt: 2, source: 'test' });
  assert.equal(esm.status, 'failed');
});
