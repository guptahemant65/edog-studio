/**
 * Gate 2 — Integration tests for ReviewSummaryPage cross-page validation.
 * Tests _runValidation() which reads state from all wizard pages.
 * @author Sentinel — EDOG Studio hivemind
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ── DOM mock ────────────────────────────────────────────────────

function createMockElement() {
  return {
    style: {},
    classList: { add: function(){}, remove: function(){}, contains: function(){ return false; }, toggle: function(){} },
    setAttribute: function(){}, getAttribute: function(){ return null; },
    appendChild: function(){}, removeChild: function(){},
    addEventListener: function(){}, removeEventListener: function(){},
    querySelector: function(){ return createMockElement(); },
    querySelectorAll: function(){ return []; },
    innerHTML: '', textContent: '', hidden: false,
    dataset: {}, children: [], childElementCount: 0,
    parentNode: { removeChild: function(){} },
    tagName: 'div', remove: function(){}
  };
}

var mockDocument = {
  createElement: function() { return createMockElement(); },
  createElementNS: function() { return createMockElement(); },
  querySelector: function() { return null; },
  body: { appendChild: function(){} }
};

// ── Load sources ────────────────────────────────────────────────

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadSources() {
  var shared = {
    window: {},
    document: mockDocument,
    console: console,
    setTimeout: setTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    clearTimeout: clearTimeout,
    Object: Object,
    Array: Array,
    Math: Math,
    Date: Date,
    Error: Error,
    JSON: JSON,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Infinity: Infinity,
    String: String
  };
  var ctx = vm.createContext(shared);
  vm.runInContext(readFileSync(join(srcDir, 'wizard-event-bus.js'), 'utf-8'), ctx);
  vm.runInContext(readFileSync(join(srcDir, 'wizard-review-summary.js'), 'utf-8'), ctx);
  return ctx.window;
}

const win = loadSources();
const ReviewSummaryPage = win.ReviewSummaryPage;
const WizardEventBus = win.WizardEventBus;

function normalize(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Helpers ─────────────────────────────────────────────────────

function makePage(overrides) {
  var bus = new WizardEventBus();
  return new ReviewSummaryPage(Object.assign({
    eventBus: bus,
    onNavigateToPage: function() {},
    onConfirm: function() {}
  }, overrides || {}));
}

function validState() {
  return {
    workspaceName: 'test-ws',
    capacityId: 'cap-123',
    capacityDisplayName: 'My Cap',
    capacitySku: 'F2',
    capacityRegion: 'westus2',
    lakehouseName: 'lh1',
    notebookName: 'nb1',
    theme: 'bronze-silver-gold',
    schemas: { dbo: true, bronze: true, silver: true },
    nodes: [
      { id: 'n1', name: 'Source', type: 'sql-table', schema: 'dbo', x: 0, y: 0 },
      { id: 'n2', name: 'Transform', type: 'mlv', schema: 'bronze', x: 200, y: 0 }
    ],
    connections: [
      { sourceNodeId: 'n1', targetNodeId: 'n2' }
    ]
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('ReviewSummaryPage — _runValidation() integration', () => {

  test('null state returns valid:false with "No wizard state" error', () => {
    const page = makePage();
    const result = normalize(page._runValidation(null));
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('No wizard state available'));
  });

  test('undefined state returns valid:false', () => {
    const page = makePage();
    const result = normalize(page._runValidation(undefined));
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('No wizard state'));
  });

  test('missing workspaceName returns error', () => {
    const page = makePage();
    const state = validState();
    delete state.workspaceName;
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Workspace name is required')));
  });

  test('empty workspaceName returns error', () => {
    const page = makePage();
    const state = validState();
    state.workspaceName = '';
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Workspace name is required')));
  });

  test('missing capacityId returns error', () => {
    const page = makePage();
    const state = validState();
    delete state.capacityId;
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('No capacity selected')));
  });

  test('empty nodes array returns error', () => {
    const page = makePage();
    const state = validState();
    state.nodes = [];
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('No nodes in DAG')));
  });

  test('no nodes property returns error', () => {
    const page = makePage();
    const state = validState();
    delete state.nodes;
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('No nodes in DAG')));
  });

  test('node with disabled schema returns specific error', () => {
    const page = makePage();
    const state = validState();
    state.schemas = { dbo: true, bronze: false, silver: true };
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) =>
      e.includes('Transform') && e.includes('bronze') && e.includes('not enabled')
    ));
  });

  test('multiple schema violations all reported', () => {
    const page = makePage();
    const state = validState();
    state.schemas = { dbo: false, bronze: false, silver: true };
    const result = normalize(page._runValidation(state));
    const schemaErrors = result.errors.filter((e) => e.includes('not enabled'));
    assert.equal(schemaErrors.length, 2);
  });

  test('node with schema=null skips schema check', () => {
    const page = makePage();
    const state = validState();
    state.nodes = [{ id: 'n1', name: 'No Schema', type: 'sql-table', schema: null, x: 0, y: 0 }];
    state.connections = [];
    state.schemas = { dbo: true };
    const result = normalize(page._runValidation(state));
    const schemaErrors = result.errors.filter((e) => e.includes('not enabled'));
    assert.equal(schemaErrors.length, 0);
  });

  test('>50 nodes generates warning', () => {
    const page = makePage();
    const state = validState();
    state.nodes = [];
    state.connections = [];
    for (let i = 0; i < 51; i++) {
      state.nodes.push({ id: 'n' + i, name: 'N' + i, type: 'mlv', schema: 'dbo', x: 0, y: i * 80 });
    }
    // Connect all so no orphan warning
    for (let i = 0; i < 50; i++) {
      state.connections.push({ sourceNodeId: 'n' + i, targetNodeId: 'n' + (i + 1) });
    }
    const result = normalize(page._runValidation(state));
    assert.ok(result.warnings.some((w) => w.includes('High node count') && w.includes('51')));
  });

  test('exactly 50 nodes = no high-count warning', () => {
    const page = makePage();
    const state = validState();
    state.nodes = [];
    state.connections = [];
    for (let i = 0; i < 50; i++) {
      state.nodes.push({ id: 'n' + i, name: 'N' + i, type: 'mlv', schema: 'dbo', x: 0, y: i * 80 });
    }
    for (let i = 0; i < 49; i++) {
      state.connections.push({ sourceNodeId: 'n' + i, targetNodeId: 'n' + (i + 1) });
    }
    const result = normalize(page._runValidation(state));
    assert.ok(!result.warnings.some((w) => w.includes('High node count')));
  });

  test('orphan nodes generate warning with count', () => {
    const page = makePage();
    const state = validState();
    state.nodes = [
      { id: 'n1', name: 'A', type: 'mlv', schema: 'dbo', x: 0, y: 0 },
      { id: 'n2', name: 'B', type: 'mlv', schema: 'dbo', x: 100, y: 0 },
      { id: 'n3', name: 'Orphan', type: 'mlv', schema: 'dbo', x: 200, y: 0 }
    ];
    state.connections = [{ sourceNodeId: 'n1', targetNodeId: 'n2' }];
    const result = normalize(page._runValidation(state));
    assert.ok(result.warnings.some((w) => w.includes('1 node(s) have no connections')));
  });

  test('all nodes connected = no orphan warning', () => {
    const page = makePage();
    const state = validState();
    const result = normalize(page._runValidation(state));
    assert.ok(!result.warnings.some((w) => w.includes('no connections')));
  });

  test('single node (no connections needed) = no orphan warning', () => {
    const page = makePage();
    const state = validState();
    state.nodes = [{ id: 'n1', name: 'Solo', type: 'mlv', schema: 'dbo', x: 0, y: 0 }];
    state.connections = [];
    const result = normalize(page._runValidation(state));
    assert.ok(!result.warnings.some((w) => w.includes('no connections')));
  });

  test('fully valid state returns valid:true, empty errors/warnings', () => {
    const page = makePage();
    const state = validState();
    const result = normalize(page._runValidation(state));
    assert.deepStrictEqual(result, { valid: true, errors: [], warnings: [] });
  });

  test('valid state with warnings still returns valid:true', () => {
    const page = makePage();
    const state = validState();
    // Add orphan to trigger a warning
    state.nodes.push({ id: 'n3', name: 'Orphan', type: 'mlv', schema: 'dbo', x: 300, y: 0 });
    const result = normalize(page._runValidation(state));
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.length > 0);
  });
});

describe('ReviewSummaryPage — page lifecycle', () => {

  test('validate() calls _runValidation with current state', () => {
    const page = makePage();
    const state = validState();
    page._state = state;
    const result = normalize(page.validate());
    assert.equal(result.valid, true);
  });

  test('validate() with no state returns error', () => {
    const page = makePage();
    const result = normalize(page.validate());
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('No wizard state'));
  });

  test('activate() stores state for later validate()', () => {
    const page = makePage();
    const state = validState();
    page.activate(state);
    assert.equal(page._state, state);
    const result = normalize(page.validate());
    assert.equal(result.valid, true);
  });

  test('collectState() is a no-op (read-only page)', () => {
    const page = makePage();
    const state = { foo: 'bar' };
    page.collectState(state);
    assert.deepStrictEqual(state, { foo: 'bar' });
  });

  test('getElement() returns root element', () => {
    const page = makePage();
    const el = page.getElement();
    assert.ok(el);
    assert.equal(el.className, 'iw-page iw-review-page');
  });

  test('destroy() cleans up state and validation', () => {
    const page = makePage();
    page.activate(validState());
    page.destroy();
    assert.equal(page._state, null);
    assert.equal(page._validationResult, null);
    assert.equal(page._destroyed, true);
  });

  test('activate() after destroy is a no-op', () => {
    const page = makePage();
    page.destroy();
    page.activate(validState());
    assert.equal(page._state, null);
  });
});
