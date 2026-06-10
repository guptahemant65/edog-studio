/**
 * Unit tests for the DAG Studio camera-tween pure helpers.
 * Guards the easing + interpolation math behind the smooth pan/zoom controls so
 * the renderer glue (rAF loop, event wiring) can stay thin:
 *   - dagEaseOutCubic — clamped [0,1], monotonic, decelerating (ease-out)
 *   - dagLerpCamera   — endpoint-exact, linear between two camera poses
 * Both are module-level function declarations in dag-graph.js, so a node:vm
 * context exposes them directly without constructing the (DOM-bound) renderer.
 * @author Pixel — EDOG Studio hivemind
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadContext() {
  var code = readFileSync(join(srcDir, 'dag-graph.js'), 'utf-8');
  var ctx = vm.createContext({
    window: { devicePixelRatio: 1 }, document: {}, console: console,
    Object: Object, Array: Array, Math: Math, Date: Date, Map: Map, Set: Set,
    requestAnimationFrame: function () {}, cancelAnimationFrame: function () {},
    performance: { now: function () { return 0; } },
  });
  vm.runInContext(code, ctx);
  return ctx;
}

test('dagEaseOutCubic: pinned at the endpoints', () => {
  const ctx = loadContext();
  assert.equal(ctx.dagEaseOutCubic(0), 0);
  assert.equal(ctx.dagEaseOutCubic(1), 1);
});

test('dagEaseOutCubic: clamps out-of-range input', () => {
  const ctx = loadContext();
  assert.equal(ctx.dagEaseOutCubic(-0.5), 0);
  assert.equal(ctx.dagEaseOutCubic(2), 1);
});

test('dagEaseOutCubic: monotonically increasing', () => {
  const ctx = loadContext();
  var prev = -1;
  for (var t = 0; t <= 1.0001; t += 0.1) {
    var v = ctx.dagEaseOutCubic(t);
    assert.ok(v >= prev, 'ease should not decrease at t=' + t);
    prev = v;
  }
});

test('dagEaseOutCubic: decelerates (ease-OUT — past halfway by the midpoint)', () => {
  const ctx = loadContext();
  // Ease-out means most progress happens early: value at t=0.5 exceeds 0.5.
  assert.ok(ctx.dagEaseOutCubic(0.5) > 0.5);
});

test('dagLerpCamera: e=0 returns the start pose', () => {
  const ctx = loadContext();
  const from = { x: 10, y: 20, scale: 0.5 };
  const to = { x: 110, y: 220, scale: 1.5 };
  const r = ctx.dagLerpCamera(from, to, 0);
  assert.equal(r.x, 10);
  assert.equal(r.y, 20);
  assert.equal(r.scale, 0.5);
});

test('dagLerpCamera: e=1 returns the target pose', () => {
  const ctx = loadContext();
  const from = { x: 10, y: 20, scale: 0.5 };
  const to = { x: 110, y: 220, scale: 1.5 };
  const r = ctx.dagLerpCamera(from, to, 1);
  assert.equal(r.x, 110);
  assert.equal(r.y, 220);
  assert.equal(r.scale, 1.5);
});

test('dagLerpCamera: e=0.5 is the midpoint of every axis', () => {
  const ctx = loadContext();
  const from = { x: 0, y: 0, scale: 1 };
  const to = { x: 100, y: 200, scale: 3 };
  const r = ctx.dagLerpCamera(from, to, 0.5);
  assert.equal(r.x, 50);
  assert.equal(r.y, 100);
  assert.equal(r.scale, 2);
});
