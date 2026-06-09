/**
 * Unit tests for the FLT Branch Switcher pure helpers.
 * Guards the switch decision logic so the popover (DOM glue) can stay thin:
 *   - filterBranches     — case-insensitive substring search
 *   - formatBranchSubtitle — ahead/behind + relative date + author line
 *   - canSwitch          — pre-deploy-only phase gate (the lock)
 *   - buildSwitchPlan    — dirty-prompt decision + don't-lose-work hazards
 * Loaded via node:vm so module-level functions are reachable without window.
 * @author Pixel — EDOG Studio hivemind
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

// Load branch-switcher.js into a fresh vm context and return the context so
// that module-level (non-window) helper functions are reachable for testing.
function loadContext() {
  var code = readFileSync(join(srcDir, 'branch-switcher.js'), 'utf-8');
  var win = {};
  var doc = {
    getElementById: function () { return null; },
    createElement: function () { return { style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {} }, setAttribute: function () {}, appendChild: function () {}, addEventListener: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, innerHTML: '' }; },
    querySelector: function () { return null; },
    body: { appendChild: function () {} }
  };
  var ctx = vm.createContext({
    window: win, document: doc, console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Object: Object, Array: Array, Math: Math, Date: Date, Error: Error, JSON: JSON,
    parseInt: parseInt, parseFloat: parseFloat, String: String, Number: Number, Boolean: Boolean,
    RegExp: RegExp, Map: Map, Set: Set, Promise: Promise
  });
  vm.runInContext(code, ctx);
  return ctx;
}

test('filterBranches: case-insensitive substring match', () => {
  const ctx = loadContext();
  const rows = [{ name: 'main' }, { name: 'feature/login' }, { name: 'hotfix' }];
  const out = ctx.filterBranches(rows, 'FEAT');
  assert.deepEqual(out.map((r) => r.name), ['feature/login']);
});

test('filterBranches: empty query returns all', () => {
  const ctx = loadContext();
  const rows = [{ name: 'a' }, { name: 'b' }];
  assert.equal(ctx.filterBranches(rows, '').length, 2);
});

test('formatBranchSubtitle: ahead/behind + meta', () => {
  const ctx = loadContext();
  const s = ctx.formatBranchSubtitle({
    ahead: 2, behind: 1, relativeDate: '3 hours ago', author: 'alice',
  });
  assert.match(s, /2/);
  assert.match(s, /1/);
  assert.match(s, /3 hours ago/);
  assert.match(s, /alice/);
});

test('formatBranchSubtitle: omits ahead/behind when zero', () => {
  const ctx = loadContext();
  const s = ctx.formatBranchSubtitle({ ahead: 0, behind: 0, relativeDate: 'yesterday', author: 'bob' });
  assert.equal(s.indexOf('\u2191'), -1);
  assert.equal(s.indexOf('\u2193'), -1);
  assert.match(s, /yesterday/);
});

test('canSwitch: only pre-deploy phases', () => {
  const ctx = loadContext();
  assert.equal(ctx.canSwitch('idle'), true);
  assert.equal(ctx.canSwitch('stopped'), true);
  assert.equal(ctx.canSwitch('crashed'), true);
  assert.equal(ctx.canSwitch('running'), false);
  assert.equal(ctx.canSwitch('deploying'), false);
  assert.equal(ctx.canSwitch(''), false);
});

test('buildSwitchPlan: prompts when user has dirty files', () => {
  const ctx = loadContext();
  const plan = ctx.buildSwitchPlan('main', 3, { name: 'feature', touchesEdogSurface: false });
  assert.equal(plan.needsPrompt, true);
  assert.match(plan.message, /3/);
});

test('buildSwitchPlan: no prompt when clean, surfaces edog hazard', () => {
  const ctx = loadContext();
  const plan = ctx.buildSwitchPlan('main', 0, {
    name: 'feature', touchesEdogSurface: true, edogSurfaceFiles: ['Program.cs'],
  });
  assert.equal(plan.needsPrompt, false);
  assert.ok(plan.hazards.some((h) => /Program\.cs/.test(h)));
});

test('buildSwitchPlan: safety surfaces unpushed, stashes, and edog-dirty hazards', () => {
  const ctx = loadContext();
  const plan = ctx.buildSwitchPlan('main', 0, { name: 'feature', touchesEdogSurface: false }, {
    unpushed: 2, stashes: 1, edogDirty: 3,
  });
  assert.equal(plan.needsPrompt, false);
  assert.ok(plan.hazards.some((h) => /unpushed/i.test(h) && /2/.test(h)), 'expected unpushed hazard');
  assert.ok(plan.hazards.some((h) => /stash/i.test(h)), 'expected stash hazard');
  assert.ok(plan.hazards.some((h) => /EDOG patch files dirty/i.test(h)), 'expected edog-dirty hazard');
});

test('buildSwitchPlan: no safety hazards when counts are zero/absent', () => {
  const ctx = loadContext();
  const plan = ctx.buildSwitchPlan('main', 0, { name: 'feature', touchesEdogSurface: false });
  assert.equal(plan.hazards.length, 0);
});
