/**
 * Regression: the Spark session detail panel must not lose scroll position on
 * the per-second render tick.
 *
 * The detail pane re-renders every 1s (live elapsed timer, tab counts, live
 * polls). The old code rebuilt the ENTIRE pane each tick — including the
 * `.sp-detail-body` scroll container — so setting innerHTML reset scrollTop to
 * 0 and the panel snapped back to the top while the user scrolled, on all 10
 * sub-tabs. The fix keeps the body element alive across ticks and:
 *   - skips the rewrite entirely when the rendered HTML is unchanged (so a
 *     scrolled, static/terminal tab is never touched), and
 *   - restores scrollTop after a rewrite WITHIN the same view (live append),
 *     while resetting to top when the tab/transform changes.
 *
 * These tests exercise _renderDetailBody directly with a fake body element
 * whose `innerHTML` setter resets scrollTop to 0 — exactly like a real DOM
 * element — so a regression to the old "always rewrite" path goes red.
 *
 * SparkSessionsTab is a top-level class declaration vm does not auto-expose, so
 * we append an export line before evaluating (same trick as test-topbar-state).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadClass() {
  let code = readFileSync(join(srcDir, 'tab-spark.js'), 'utf-8');
  code += '\nglobalThis.__SparkTab = SparkSessionsTab;';
  const ctx = vm.createContext({ globalThis: {}, console });
  vm.runInContext(code, ctx);
  return ctx.globalThis.__SparkTab;
}

// A fake scroll container that mimics the browser: replacing innerHTML resets
// scrollTop to 0 (this is the exact behavior that caused the bug).
function makeBody() {
  let scroll = 0;
  let html = '';
  return {
    get scrollTop() { return scroll; },
    set scrollTop(v) { scroll = v; },
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; scroll = 0; },
  };
}

// Build a detail instance without running the constructor (which wires SignalR
// and timers). We only need the fields _renderDetailBody touches.
function makeInstance(SparkTab, bodyHtml) {
  const inst = Object.create(SparkTab.prototype);
  inst._elDetailBody = makeBody();
  inst._selectedId = 's1';
  inst._selectedTxfId = 't1';
  inst._detailTab = 'raw';
  inst._bodyKey = null;
  inst._bodyHtml = null;
  // Control the rendered HTML deterministically.
  inst._currentHtml = bodyHtml;
  inst._detailBodyHtml = function () { return this._currentHtml; };
  return inst;
}

test('first render lands at top and records the view key', () => {
  const SparkTab = loadClass();
  const inst = makeInstance(SparkTab, '<div>A</div>');
  inst._renderDetailBody(null, null);
  assert.equal(inst._elDetailBody.innerHTML, '<div>A</div>');
  assert.equal(inst._elDetailBody.scrollTop, 0);
  assert.equal(inst._bodyKey, 's1|t1|raw');
});

test('unchanged content on a tick does NOT rewrite — scroll is preserved', () => {
  const SparkTab = loadClass();
  const inst = makeInstance(SparkTab, '<div>A</div>');
  inst._renderDetailBody(null, null);   // initial
  inst._elDetailBody.scrollTop = 137;   // user scrolls down
  inst._renderDetailBody(null, null);   // tick, identical html
  assert.equal(inst._elDetailBody.scrollTop, 137, 'scroll was reset on an unchanged tick');
});

test('live content change in the same view preserves scroll position', () => {
  const SparkTab = loadClass();
  const inst = makeInstance(SparkTab, '<div>A</div>');
  inst._renderDetailBody(null, null);
  inst._elDetailBody.scrollTop = 200;
  inst._currentHtml = '<div>A</div><div>B</div>'; // a new poll row appended
  inst._renderDetailBody(null, null);
  assert.equal(inst._elDetailBody.innerHTML, '<div>A</div><div>B</div>');
  assert.equal(inst._elDetailBody.scrollTop, 200, 'scroll not preserved across a live append');
});

test('switching tab resets scroll to the top of the new content', () => {
  const SparkTab = loadClass();
  const inst = makeInstance(SparkTab, '<div>A</div>');
  inst._renderDetailBody(null, null);
  inst._elDetailBody.scrollTop = 200;
  inst._detailTab = 'polls';            // different view key
  inst._currentHtml = '<div>C</div>';
  inst._renderDetailBody(null, null);
  assert.equal(inst._elDetailBody.scrollTop, 0, 'new tab should start at the top');
  assert.equal(inst._bodyKey, 's1|t1|polls');
});

test('switching transform within a session resets scroll to top', () => {
  const SparkTab = loadClass();
  const inst = makeInstance(SparkTab, '<div>A</div>');
  inst._renderDetailBody(null, null);
  inst._elDetailBody.scrollTop = 90;
  inst._selectedTxfId = 't2';           // different transform => different view key
  inst._currentHtml = '<div>A</div>';   // same html, different view
  inst._renderDetailBody(null, null);
  assert.equal(inst._elDetailBody.scrollTop, 0);
  assert.equal(inst._bodyKey, 's1|t2|raw');
});
