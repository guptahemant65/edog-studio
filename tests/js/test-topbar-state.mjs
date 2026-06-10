/**
 * Unit tests for the top-bar connection indicator's effective-state mapper.
 *
 * topbarEffectiveState(studioPhase, socketStatus) is the pure core that decides
 * what the #service-status chip shows. The whole point of the "live top bar"
 * work is that the chip reflects the *real* SignalR socket, not just the 30s
 * studioPhase poll — so when the socket drops while the service is still
 * "running", the chip must degrade to "Reconnecting..." instead of lying
 * "Connected".
 *
 * Regression anchors:
 *   - running + a non-connected socket => 'reconnecting' (the headline bug:
 *     header claimed Connected while telemetry was dead).
 *   - crashed => its own 'crashed' class (NOT grey 'stopped'), so an error
 *     state never looks identical to idle "Browsing".
 *   - only the 'running'+connected state is `live` (caller appends uptime);
 *     nothing else gets a session timer.
 *
 * topbarEffectiveState is a top-level lexical binding vm does not auto-expose,
 * so we append a one-line export before evaluating (same trick as
 * test-dag-strip / test-dag-state).
 * @author Sentinel — EDOG Studio hivemind
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function load() {
  var code = readFileSync(join(srcDir, 'topbar.js'), 'utf-8');
  code += '\nglobalThis.__effState = topbarEffectiveState;\nglobalThis.__TopBar = TopBar;';
  // Minimal DOM + globals so the TopBar class can be constructed and its
  // _renderServiceStatus path exercised without a real browser. Only the
  // surface that path touches is stubbed.
  function makeEl() {
    return {
      className: '', textContent: '', title: '', offsetWidth: 0,
      style: {}, classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      setAttribute() {}, addEventListener() {},
    };
  }
  var doc = {
    getElementById() { return makeEl(); },
    addEventListener() {},
    hidden: false,
  };
  var ctx = vm.createContext({
    globalThis: {}, console: console,
    Object: Object, Array: Array, Math: Math, Date: Date, Map: Map, Set: Set,
    String: String, Number: Number, Boolean: Boolean, JSON: JSON,
    document: doc, window: { addEventListener() {} },
  });
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx);
  return { eff: ctx.__effState, TopBar: ctx.__TopBar };
}

const { eff, TopBar } = load();

test('running + connected socket => live Connected', () => {
  const s = eff('running', 'connected');
  assert.equal(s.cls, 'running');
  assert.equal(s.label, 'Connected');
  assert.equal(s.live, true, 'only this state appends uptime');
});

test('running + reconnecting socket => Reconnecting (not a lie)', () => {
  const s = eff('running', 'reconnecting');
  assert.equal(s.cls, 'reconnecting');
  assert.equal(s.label, 'Reconnecting\u2026');
  assert.equal(s.live, false, 'no uptime while the socket is down');
});

test('running + disconnected socket => Reconnecting', () => {
  const s = eff('running', 'disconnected');
  assert.equal(s.cls, 'reconnecting');
  assert.equal(s.live, false);
});

test('running + connecting socket => Reconnecting', () => {
  const s = eff('running', 'connecting');
  assert.equal(s.cls, 'reconnecting');
  assert.equal(s.live, false);
});

test('running + unknown/null socket => optimistic Connected', () => {
  // Before any status event has arrived we trust the running phase rather than
  // flashing a scary "Reconnecting" on a healthy cold start.
  const s = eff('running', null);
  assert.equal(s.cls, 'running');
  assert.equal(s.label, 'Connected');
  assert.equal(s.live, true);
});

test('deploying => Deploying (socket ignored)', () => {
  const s = eff('deploying', 'disconnected');
  assert.equal(s.cls, 'building');
  assert.equal(s.label, 'Deploying\u2026');
  assert.equal(s.live, false);
});

test('crashed => first-class crashed state, not grey stopped', () => {
  const s = eff('crashed', 'disconnected');
  assert.equal(s.cls, 'crashed', 'crashed must be visually distinct from stopped');
  assert.equal(s.label, 'Service Crashed');
  assert.equal(s.live, false);
});

test('stopped => Browsing', () => {
  const s = eff('stopped', 'connected');
  assert.equal(s.cls, 'stopped');
  assert.equal(s.label, 'Browsing');
  assert.equal(s.live, false);
});

test('idle / unknown phase => Browsing', () => {
  assert.equal(eff('idle', null).cls, 'stopped');
  assert.equal(eff(undefined, null).cls, 'stopped');
  assert.equal(eff('', null).label, 'Browsing');
});

// --- Render-path guardrail: the live tick/socket loop must NOT clobber the
// deploy flow's direct chip writes while a deploy is in-flight or errored.
// (Regression anchor for the Sentinel-caught _deployActive bug — the pure
//  mapper tests above cannot see this interaction.)

test('_renderServiceStatus is a no-op while _deployActive (deploy flow owns chip)', () => {
  const tb = new TopBar();
  // Simulate setDeployStatus('failed'): deploy flow wrote the chip directly.
  tb._deployActive = true;
  tb._statusEl.className = 'service-status stopped';
  tb._statusTextEl.textContent = 'Deploy Failed';
  // Stale phase + a socket event that would otherwise repaint the chip.
  tb._studioPhase = 'stopped';
  tb._socketStatus = 'connected';
  tb._renderServiceStatus();
  assert.equal(tb._statusTextEl.textContent, 'Deploy Failed', 'deploy text preserved');
  assert.equal(tb._statusEl.className, 'service-status stopped', 'deploy class preserved');
});

test('_renderServiceStatus repaints once _deployActive clears', () => {
  const tb = new TopBar();
  tb._deployActive = false;
  tb._studioPhase = 'running';
  tb._socketStatus = 'reconnecting';
  tb._renderServiceStatus();
  assert.equal(tb._statusEl.className, 'service-status reconnecting');
  assert.equal(tb._statusTextEl.textContent, 'Reconnecting\u2026');
});
