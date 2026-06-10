/**
 * Regression: clicking "New Infrastructure" while a wizard is already in
 * progress must return the user to the existing wizard — NOT destroy their
 * in-progress work and spawn a fresh blank one.
 *
 * The bug: WorkspaceExplorer._ctxNewInfra() called
 * InfraWizardDialog.getActive().destroy() before constructing a new wizard, so
 * a half-finished environment setup was silently thrown away and replaced by a
 * blank instance (the user perceived this as "another instance opening").
 *
 * The InfraWizardDialog is a documented singleton (static _activeInstance,
 * open() restores an existing instance). The fix makes _ctxNewInfra honor that:
 * when active, restore() and return; otherwise build + open a new one.
 *
 * WorkspaceExplorer is a top-level class declaration vm does not auto-expose,
 * so we append an export line, and inject a fake InfraWizardDialog into the
 * context to observe the calls _ctxNewInfra makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadWithFakeWizard(fake) {
  let code = readFileSync(join(srcDir, 'workspace-explorer.js'), 'utf-8');
  code += '\nglobalThis.__WX = WorkspaceExplorer;';
  const noop = () => {};
  const docStub = {
    createElement: () => ({ set textContent(v) {}, innerHTML: '' }),
    addEventListener: noop,
    querySelector: () => null,
  };
  const ctx = {
    console,
    document: docStub,
    window: {},
    InfraWizardDialog: fake,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.__WX;
}

function makeFakeWizard() {
  const calls = { constructed: 0, opened: 0, restored: 0, destroyed: 0 };
  let active = null;
  function Fake(api, opts) {
    calls.constructed++;
    this._opts = opts;
    this.onClose = null;
    this.onComplete = null;
    this.open = () => { calls.opened++; };
  }
  Fake.isActive = () => active !== null;
  Fake.getActive = () => active;
  Fake.__setActive = (inst) => { active = inst; };
  Fake.__makeActiveSpy = () => {
    const inst = {
      restore: () => { calls.restored++; },
      destroy: () => { calls.destroyed++; },
    };
    active = inst;
    return inst;
  };
  return { Fake, calls };
}

function makeExplorer(WX) {
  const wx = Object.create(WX.prototype);
  wx._api = { hasBearerToken: () => true };
  wx._workspaces = [];
  wx.loadWorkspaces = () => {};
  return wx;
}

test('New Infra with an active wizard restores it and does NOT destroy or recreate', () => {
  const { Fake, calls } = makeFakeWizard();
  Fake.__makeActiveSpy();
  const WX = loadWithFakeWizard(Fake);
  const wx = makeExplorer(WX);

  wx._ctxNewInfra();

  assert.equal(calls.restored, 1, 'should restore the in-progress wizard');
  assert.equal(calls.destroyed, 0, 'must NOT destroy in-progress work');
  assert.equal(calls.constructed, 0, 'must NOT construct a second wizard');
  assert.equal(calls.opened, 0, 'must NOT open a second wizard');
});

test('New Infra with no active wizard constructs and opens a fresh one', () => {
  const { Fake, calls } = makeFakeWizard();
  // no active instance
  const WX = loadWithFakeWizard(Fake);
  const wx = makeExplorer(WX);

  wx._ctxNewInfra();

  assert.equal(calls.constructed, 1, 'should construct a new wizard');
  assert.equal(calls.opened, 1, 'should open the new wizard');
  assert.equal(calls.destroyed, 0);
  assert.equal(calls.restored, 0);
});
