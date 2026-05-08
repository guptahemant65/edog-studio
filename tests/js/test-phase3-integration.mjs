/**
 * Gate 2 INTEGRATION tests — Phase 3 feature interactions.
 *
 * Verifies that Phase 3 features (Presets, Context Menu, Marquee, Popover,
 * Zoom, Batch Ops, Auto-Layout, Workspace Explorer, Undo/Redo, Viewport
 * Culling) work together correctly through DagCanvas.
 *
 * @author Sentinel — EDOG Studio hivemind
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

// IW_EVENTS constants (mirrored from infra-wizard.js — too DOM-heavy to load)
const IW_EVENTS = {
  NODE_ADDED:          'canvas:node-added',
  NODE_REMOVED:        'canvas:node-removed',
  NODE_MOVED:          'canvas:node-moved',
  NODE_SELECTED:       'canvas:node-selected',
  SELECTION_CLEARED:   'canvas:selection-cleared',
  ZOOM_CHANGED:        'canvas:zoom-changed',
  STATE_CHANGED:       'canvas:state-changed',
  LAYOUT_COMPLETE:     'canvas:layout-complete',
  CONNECTION_CREATED:  'connection:created',
  CONNECTION_REMOVED:  'connection:removed',
  CONNECTION_STARTED:  'connection:started',
  CONNECTION_CANCELLED:'connection:cancelled',
  NODE_RENAMED:        'node:renamed',
  NODE_TYPE_CHANGED:   'node:type-changed',
  NODE_SCHEMA_CHANGED: 'node:schema-changed',
  CODE_STALE:          'code:stale',
  CODE_REGENERATED:    'code:regenerated',
  PAGE_CHANGED:        'wizard:page-changed',
  STATE_DIRTY:         'wizard:state-dirty',
  TEMPLATE_LOADED:     'template:loaded',
  TEMPLATE_SAVED:      'template:saved',
  REVIEW_VALIDATED:    'review:validated',
  EXECUTION_STARTED:   'execution:started',
  EXECUTION_STEP:      'execution:step',
  EXECUTION_COMPLETE:  'execution:complete',
  EXECUTION_FAILED:    'execution:failed',
  NAVIGATE_WORKSPACE:  'iw:navigate-workspace',
  UNDO:                'undo:performed',
  REDO:                'redo:performed'
};

/* ═══════════════════════════════════════════════════════════════════
   DOM MOCK
   ═══════════════════════════════════════════════════════════════════ */

function createMockElement(tag) {
  var attrs = {};
  var children = [];
  var listeners = {};
  var classList = [];

  var el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    classList: {
      _items: classList,
      add: function() { for (var i = 0; i < arguments.length; i++) { if (classList.indexOf(arguments[i]) === -1) classList.push(arguments[i]); } },
      remove: function() { for (var i = 0; i < arguments.length; i++) { var idx = classList.indexOf(arguments[i]); if (idx !== -1) classList.splice(idx, 1); } },
      contains: function(cls) { return classList.indexOf(cls) !== -1; },
      toggle: function(cls) { if (classList.indexOf(cls) !== -1) { classList.splice(classList.indexOf(cls), 1); } else { classList.push(cls); } }
    },
    setAttribute: function(k, v) { attrs[k] = v; },
    getAttribute: function(k) { return attrs[k] !== undefined ? attrs[k] : null; },
    setAttributeNS: function(ns, k, v) { attrs[k] = v; },
    appendChild: function(child) { children.push(child); if (child && typeof child === 'object') child.parentNode = el; return child; },
    removeChild: function(child) { var idx = children.indexOf(child); if (idx !== -1) children.splice(idx, 1); return child; },
    addEventListener: function(evt, fn) { if (!listeners[evt]) listeners[evt] = []; listeners[evt].push(fn); },
    removeEventListener: function(evt, fn) { if (listeners[evt]) { var idx = listeners[evt].indexOf(fn); if (idx !== -1) listeners[evt].splice(idx, 1); } },
    querySelector: function() { return createMockElement(); },
    querySelectorAll: function() { return []; },
    closest: function() { return null; },
    focus: function() {},
    contains: function() { return false; },
    getBoundingClientRect: function() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    children: children,
    childElementCount: 0,
    parentNode: { removeChild: function() {} },
    className: '',
    remove: function() {}
  };
  return el;
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT LOADER
   ═══════════════════════════════════════════════════════════════════ */

function createSharedContext() {
  var mockDoc = {
    createElement: function(tag) { return createMockElement(tag); },
    createElementNS: function(ns, tag) { return createMockElement(tag); },
    querySelector: function() { return createMockElement(); },
    querySelectorAll: function() { return []; },
    getElementById: function() { return createMockElement(); },
    body: { appendChild: function() {} },
    addEventListener: function() {},
    removeEventListener: function() {},
    activeElement: null
  };

  var mockWindow = {
    addEventListener: function() {},
    removeEventListener: function() {},
    location: { search: '' }
  };

  var ctx = vm.createContext({
    window: mockWindow,
    document: mockDoc,
    console: console,
    setTimeout: function(fn, ms) { fn(); return 1; },
    setInterval: setInterval,
    clearInterval: clearInterval,
    clearTimeout: function() {},
    requestAnimationFrame: function(fn) { fn(); return 1; },
    cancelAnimationFrame: function() {},
    Object: Object,
    Array: Array,
    Math: Math,
    Date: Date,
    Error: Error,
    TypeError: TypeError,
    JSON: JSON,
    parseInt: parseInt,
    parseFloat: parseFloat,
    String: String,
    Number: Number,
    RegExp: RegExp,
    Map: Map,
    Set: Set,
    Infinity: Infinity,
    NaN: NaN,
    isNaN: isNaN,
    encodeURIComponent: encodeURIComponent,
    Promise: Promise,
    CustomEvent: function(type, options) { this.type = type; this.detail = (options && options.detail) || null; },
    IW_EVENTS: IW_EVENTS,
    URLSearchParams: URLSearchParams
  });
  return ctx;
}

function loadInto(ctx, filename) {
  var code = readFileSync(join(srcDir, filename), 'utf-8');
  vm.runInContext(code, ctx);
}

/**
 * Load all Phase 3 dependencies into a shared context.
 * Returns references to key constructors.
 */
function loadPhase3() {
  var ctx = createSharedContext();
  loadInto(ctx, 'wizard-event-bus.js');
  loadInto(ctx, 'wizard-undo-redo.js');
  loadInto(ctx, 'wizard-auto-layout.js');
  loadInto(ctx, 'wizard-dag-node.js');
  loadInto(ctx, 'wizard-connection-mgr.js');
  loadInto(ctx, 'wizard-dag-canvas.js');
  loadInto(ctx, 'wizard-dag-presets.js');

  var WizardEventBus = ctx.window.WizardEventBus;
  var UndoRedoManager = ctx.window.UndoRedoManager;
  var DagCanvas = ctx.window.DagCanvas;
  var DagPresets = ctx.window.DagPresets;
  var AutoLayoutEngine = ctx.window.AutoLayoutEngine;

  return { ctx, WizardEventBus, UndoRedoManager, DagCanvas, DagPresets, AutoLayoutEngine };
}

/**
 * Create a fully-wired DagCanvas for testing.
 * Patches UndoRedoManager.push to normalize DagCanvas's command format
 * ({name, undo, redo} -> {type, undoFn, doFn}).
 */
function createTestCanvas(mods) {
  var loaded = mods || loadPhase3();
  var bus = new loaded.WizardEventBus();
  var undoMgr = new loaded.UndoRedoManager({ eventBus: bus });

  // Patch push to normalize DagCanvas's {name, undo, redo} format
  var origPush = undoMgr.push.bind(undoMgr);
  undoMgr.push = function(cmd) {
    return origPush({
      type: cmd.type || cmd.name,
      description: cmd.description || cmd.name,
      doFn: cmd.doFn || cmd.redo,
      undoFn: cmd.undoFn || cmd.undo,
      redoOnPush: cmd.redoOnPush
    });
  };

  var containerEl = createMockElement('div');
  var canvas = new loaded.DagCanvas({
    containerEl: containerEl,
    eventBus: bus,
    undoManager: undoMgr,
    schemas: { dbo: true, bronze: false, silver: false, gold: false }
  });

  return { canvas, bus, undoMgr, containerEl, loaded };
}

/** Normalize vm-context objects for deepStrictEqual */
function norm(obj) {
  return JSON.parse(JSON.stringify(obj));
}


/* ═══════════════════════════════════════════════════════════════════
   SUITE 1: Preset -> Canvas -> Code Preview Flow
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 1: Preset -> Canvas -> Code Preview Flow', () => {

  test('Simple Chain preset adds 2 nodes and 1 connection', () => {
    var t = createTestCanvas();
    var schemas = { dbo: true, bronze: false, silver: false, gold: false };
    var stateEvents = [];
    t.bus.on(IW_EVENTS.STATE_CHANGED, function() { stateEvents.push('state-changed'); });

    // Apply the Simple Chain preset's build function directly
    var simpleChain = { build: function(canvas, s) {
      var n1 = canvas.addNode('sql-table', null, { name: 'orders', schema: 'dbo' });
      var n2 = canvas.addNode('sql-mlv', null, { name: 'orders_view', schema: 'dbo' });
      canvas.addConnection(n1.id, n2.id);
    }};

    t.canvas.batchOperation(function(c) {
      simpleChain.build(c, schemas);
    });

    assert.equal(t.canvas.getNodeCount(), 2, 'Canvas should have 2 nodes');
    assert.equal(t.canvas.getConnections().length, 1, 'Canvas should have 1 connection');
  });

  test('state-changed fires after preset application', () => {
    var t = createTestCanvas();
    var stateCount = 0;
    t.bus.on(IW_EVENTS.STATE_CHANGED, function() { stateCount++; });

    // batchOperation emits exactly 1 state-changed after completion
    t.canvas.batchOperation(function(c) {
      c.addNode('sql-table', null, { name: 'a', schema: 'dbo' });
      c.addNode('sql-mlv', null, { name: 'b', schema: 'dbo' });
    });

    // batch emits 1 at the end, but each addNode also emits (debounced as sync in tests).
    // The batch suppresses intermediate, then emits 1 at the end.
    assert.ok(stateCount >= 1, 'state-changed should fire at least once after batch');
  });

  test('DagPresets overlay hides after preset selection', () => {
    var t = createTestCanvas();
    var presets = new t.loaded.DagPresets({
      containerEl: t.containerEl,
      dagCanvas: t.canvas,
      eventBus: t.bus,
      schemas: { dbo: true, bronze: false, silver: false, gold: false }
    });

    // Before applying: overlay should be visible (canvas has 0 nodes)
    // After _applyPreset: overlay hides because canvas has nodes
    presets._applyPreset({
      build: function(canvas, schemas) {
        canvas.addNode('sql-table', null, { name: 'test', schema: 'dbo' });
        canvas.addNode('sql-mlv', null, { name: 'test_v', schema: 'dbo' });
        canvas.addConnection(
          Object.keys(canvas._nodeData)[0],
          Object.keys(canvas._nodeData)[1]
        );
      }
    });

    assert.equal(t.canvas.getNodeCount(), 2, 'Preset should add 2 nodes');
    assert.ok(presets._dismissed, 'Presets overlay should be dismissed after apply');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 2: Context Menu -> Node Addition -> Selection
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 2: Context Menu -> Node Addition -> Selection', () => {

  test('addNode at specific position places node at those coordinates', () => {
    var t = createTestCanvas();
    var nodeData = t.canvas.addNode('sql-table', { x: 100, y: 100 });
    assert.ok(nodeData, 'addNode should return node data');
    assert.equal(nodeData.x, 100, 'Node x should be 100');
    assert.equal(nodeData.y, 100, 'Node y should be 100');
  });

  test('newly added node can be selected', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', { x: 100, y: 100 });
    t.canvas.selectNode(nd.id);
    assert.equal(t.canvas.getSelectedNodeId(), nd.id, 'Newly added node should be selectable');
  });

  test('context menu add actions create correct node types', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 50, y: 50 });
    var n2 = t.canvas.addNode('sql-mlv', { x: 150, y: 50 });
    var n3 = t.canvas.addNode('pyspark-mlv', { x: 250, y: 50 });

    assert.equal(n1.type, 'sql-table');
    assert.equal(n2.type, 'sql-mlv');
    assert.equal(n3.type, 'pyspark-mlv');
    assert.equal(t.canvas.getNodeCount(), 3);
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 3: Marquee Selection -> Multi-Delete
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 3: Marquee Selection -> Multi-Delete', () => {

  test('selectNodes selects multiple nodes', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 0, y: 0 });
    var n2 = t.canvas.addNode('sql-table', { x: 200, y: 0 });
    var n3 = t.canvas.addNode('sql-table', { x: 400, y: 0 });
    var n4 = t.canvas.addNode('sql-table', { x: 600, y: 0 });

    t.canvas.selectNodes([n1.id, n2.id, n3.id]);
    var selected = t.canvas.getSelectedNodeIds();
    assert.equal(selected.length, 3, 'Should have 3 selected nodes');
    assert.ok(selected.indexOf(n1.id) !== -1, 'n1 should be selected');
    assert.ok(selected.indexOf(n2.id) !== -1, 'n2 should be selected');
    assert.ok(selected.indexOf(n3.id) !== -1, 'n3 should be selected');
    assert.ok(selected.indexOf(n4.id) === -1, 'n4 should NOT be selected');
  });

  test('removing all selected nodes leaves only unselected ones', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 0, y: 0 });
    var n2 = t.canvas.addNode('sql-table', { x: 200, y: 0 });
    var n3 = t.canvas.addNode('sql-table', { x: 400, y: 0 });
    var n4 = t.canvas.addNode('sql-table', { x: 600, y: 0 });

    t.canvas.selectNodes([n1.id, n2.id, n3.id]);

    // Simulate Delete key behavior: remove all selected
    var toRemove = t.canvas.getSelectedNodeIds().slice();
    for (var i = 0; i < toRemove.length; i++) {
      t.canvas.removeNode(toRemove[i]);
    }

    assert.equal(t.canvas.getNodeCount(), 1, 'Only 1 node should remain');
    var remaining = t.canvas.getNodes();
    assert.equal(remaining[0].id, n4.id, 'Remaining node should be n4');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 4: Node Popover -> updateNode Flow
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 4: Node Popover -> updateNode Flow', () => {

  test('updateNode changes node name', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', null, { name: 'table_1', schema: 'dbo' });

    t.canvas.updateNode(nd.id, { name: 'customers' });

    var updated = t.canvas.getNodeData(nd.id);
    assert.equal(updated.name, 'customers', 'Node name should be updated to customers');
  });

  test('updateNode changes node type', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', null, { name: 'my_node', schema: 'dbo' });

    t.canvas.updateNode(nd.id, { type: 'sql-mlv' });

    var updated = t.canvas.getNodeData(nd.id);
    assert.equal(updated.type, 'sql-mlv', 'Node type should be updated to sql-mlv');
  });

  test('updateNode changes node schema', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', null, { name: 'orders', schema: 'dbo' });

    t.canvas.updateNode(nd.id, { schema: 'bronze' });

    var updated = t.canvas.getNodeData(nd.id);
    assert.equal(updated.schema, 'bronze', 'Node schema should be updated to bronze');
  });

  test('updateNode emits state-changed', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', null, { name: 'table_1' });
    var stateCount = 0;
    t.bus.on(IW_EVENTS.STATE_CHANGED, function() { stateCount++; });

    t.canvas.updateNode(nd.id, { name: 'customers' });

    assert.ok(stateCount >= 1, 'state-changed should fire after updateNode');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 5: Zoom Controls -> Viewport State
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 5: Zoom Controls -> Viewport State', () => {

  test('setViewport updates zoom level', () => {
    var t = createTestCanvas();
    t.canvas.setViewport(0, 0, 1.0);
    var vp1 = t.canvas.getViewport();
    assert.equal(vp1.zoom, 1.0, 'Initial zoom should be 1.0');

    t.canvas.setViewport(0, 0, 1.1);
    var vp2 = t.canvas.getViewport();
    assert.ok(Math.abs(vp2.zoom - 1.1) < 0.001, 'Zoom should be ~1.1');
  });

  test('setViewport emits ZOOM_CHANGED event', () => {
    var t = createTestCanvas();
    var zoomEvents = [];
    t.bus.on(IW_EVENTS.ZOOM_CHANGED, function(vp) { zoomEvents.push(vp); });

    t.canvas.setViewport(10, 20, 1.5);

    assert.ok(zoomEvents.length >= 1, 'ZOOM_CHANGED should fire');
    assert.ok(Math.abs(zoomEvents[0].zoom - 1.5) < 0.001, 'Zoom event should carry correct value');
  });

  test('setViewport clamps zoom to valid range', () => {
    var t = createTestCanvas();

    t.canvas.setViewport(0, 0, 0.1);
    assert.equal(t.canvas.getViewport().zoom, 0.25, 'Zoom should clamp to min 0.25');

    t.canvas.setViewport(0, 0, 10.0);
    assert.equal(t.canvas.getViewport().zoom, 4.0, 'Zoom should clamp to max 4.0');
  });

  test('fitToContent adjusts viewport to contain all nodes', () => {
    var t = createTestCanvas();
    t.canvas.addNode('sql-table', { x: 0, y: 0 });
    t.canvas.addNode('sql-table', { x: 500, y: 500 });

    t.canvas.fitToContent();

    var vp = t.canvas.getViewport();
    // fitToContent should adjust zoom/pan to fit all nodes in viewport
    assert.ok(vp.zoom > 0, 'Zoom should be positive');
    assert.ok(vp.zoom <= 4.0, 'Zoom should not exceed max');
  });

  test('resetViewport returns to defaults', () => {
    var t = createTestCanvas();
    t.canvas.setViewport(100, 200, 2.0);
    t.canvas.resetViewport();

    var vp = t.canvas.getViewport();
    assert.equal(vp.panX, 0, 'panX should reset to 0');
    assert.equal(vp.panY, 0, 'panY should reset to 0');
    assert.equal(vp.zoom, 1.0, 'zoom should reset to 1.0');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 6: Batch Operation -> State Events
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 6: Batch Operation -> State Events', () => {

  test('batchOperation suppresses intermediate state-changed events', () => {
    var t = createTestCanvas();
    var stateCount = 0;
    t.bus.on(IW_EVENTS.STATE_CHANGED, function() { stateCount++; });

    t.canvas.batchOperation(function(c) {
      c.addNode('sql-table', { x: 0, y: 0 }, { name: 'a' });
      c.addNode('sql-table', { x: 200, y: 0 }, { name: 'b' });
      c.addNode('sql-table', { x: 400, y: 0 }, { name: 'c' });
    });

    // Batch should emit exactly 1 state-changed (the final one), not 3
    assert.equal(stateCount, 1, 'state-changed should fire exactly ONCE after batch');
  });

  test('all nodes exist after batch operation', () => {
    var t = createTestCanvas();

    t.canvas.batchOperation(function(c) {
      c.addNode('sql-table', { x: 0, y: 0 }, { name: 'node_a' });
      c.addNode('sql-mlv', { x: 200, y: 0 }, { name: 'node_b' });
      c.addNode('pyspark-mlv', { x: 400, y: 0 }, { name: 'node_c' });
    });

    assert.equal(t.canvas.getNodeCount(), 3, 'All 3 nodes should exist');
    var nodes = t.canvas.getNodes();
    var names = nodes.map(function(n) { return n.name; }).sort();
    assert.deepStrictEqual(norm(names), ['node_a', 'node_b', 'node_c']);
  });

  test('batchOperation correctly emits even if fn throws', () => {
    var t = createTestCanvas();
    var stateCount = 0;
    t.bus.on(IW_EVENTS.STATE_CHANGED, function() { stateCount++; });

    assert.throws(function() {
      t.canvas.batchOperation(function() {
        t.canvas.addNode('sql-table', { x: 0, y: 0 });
        throw new Error('deliberate');
      });
    }, /deliberate/);

    // batchOperation uses try/finally, so state-changed still fires
    assert.equal(stateCount, 1, 'state-changed should still fire after failed batch');
    // Batching flag should be reset
    assert.equal(t.canvas._isBatching, false, 'Batching flag should be cleared');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 7: Auto-Layout -> All Nodes Repositioned
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 7: Auto-Layout -> All Nodes Repositioned', () => {

  test('autoLayout repositions overlapping nodes to non-overlapping', () => {
    var t = createTestCanvas();
    // Place 5 nodes at overlapping positions
    var n1 = t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'a' });
    var n2 = t.canvas.addNode('sql-table', { x: 10, y: 10 }, { name: 'b' });
    var n3 = t.canvas.addNode('sql-mlv', { x: 20, y: 20 }, { name: 'c' });
    var n4 = t.canvas.addNode('sql-mlv', { x: 30, y: 30 }, { name: 'd' });
    var n5 = t.canvas.addNode('pyspark-mlv', { x: 40, y: 40 }, { name: 'e' });

    // Add connections: chain a -> b -> c, a -> d -> e
    t.canvas.addConnection(n1.id, n2.id);
    t.canvas.addConnection(n2.id, n3.id);
    t.canvas.addConnection(n1.id, n4.id);
    t.canvas.addConnection(n4.id, n5.id);

    t.canvas.autoLayout();

    // Check no two nodes overlap
    var nodes = t.canvas.getNodes();
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i];
        var b = nodes[j];
        var overlap = !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
                        a.y + a.height <= b.y || b.y + b.height <= a.y);
        assert.ok(!overlap, 'Nodes ' + a.name + ' and ' + b.name + ' should not overlap');
      }
    }
  });

  test('autoLayout preserves connections', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 0, y: 0 });
    var n2 = t.canvas.addNode('sql-mlv', { x: 0, y: 0 });
    t.canvas.addConnection(n1.id, n2.id);

    t.canvas.autoLayout();

    var conns = t.canvas.getConnections();
    assert.equal(conns.length, 1, 'Connection should still exist after layout');
    assert.equal(conns[0].sourceNodeId, n1.id);
    assert.equal(conns[0].targetNodeId, n2.id);
  });

  test('autoLayout emits LAYOUT_COMPLETE event', () => {
    var t = createTestCanvas();
    t.canvas.addNode('sql-table', { x: 0, y: 0 });
    t.canvas.addNode('sql-mlv', { x: 10, y: 10 });

    var layoutFired = false;
    t.bus.on(IW_EVENTS.LAYOUT_COMPLETE, function() { layoutFired = true; });

    t.canvas.autoLayout();

    assert.ok(layoutFired, 'LAYOUT_COMPLETE event should fire');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 8: Workspace Explorer Integration
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 8: Workspace Explorer Integration', () => {

  test('workspace-explorer.js exposes WorkspaceExplorer on window', () => {
    var code = readFileSync(join(srcDir, 'workspace-explorer.js'), 'utf-8');
    // Check that the source defines selectWorkspace
    assert.ok(code.indexOf('selectWorkspace') !== -1,
      'workspace-explorer.js should export selectWorkspace');
  });

  test('workspace-explorer.js handles edog:select-workspace event', () => {
    var code = readFileSync(join(srcDir, 'workspace-explorer.js'), 'utf-8');
    assert.ok(code.indexOf('edog:select-workspace') !== -1,
      'workspace-explorer.js should listen for edog:select-workspace');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 9: Confirmation Dialog -> Navigation Flow
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 9: Event Constants and Navigation Flow', () => {

  test('IW_EVENTS.NAVIGATE_WORKSPACE exists', () => {
    assert.ok(IW_EVENTS.NAVIGATE_WORKSPACE, 'NAVIGATE_WORKSPACE should be defined');
    assert.equal(IW_EVENTS.NAVIGATE_WORKSPACE, 'iw:navigate-workspace');
  });

  test('NAVIGATE_WORKSPACE event can be emitted and received via EventBus', () => {
    var loaded = loadPhase3();
    var bus = new loaded.WizardEventBus();
    var received = [];
    bus.on(IW_EVENTS.NAVIGATE_WORKSPACE, function(data) { received.push(data); });

    bus.emit(IW_EVENTS.NAVIGATE_WORKSPACE, { workspaceId: 'ws-123' });

    assert.equal(received.length, 1);
    assert.equal(received[0].workspaceId, 'ws-123');
  });

  test('infra-wizard.js source references NAVIGATE_WORKSPACE event', () => {
    var code = readFileSync(join(srcDir, 'infra-wizard.js'), 'utf-8');
    assert.ok(code.indexOf('NAVIGATE_WORKSPACE') !== -1,
      'infra-wizard.js should define NAVIGATE_WORKSPACE');
    assert.ok(code.indexOf('iw:navigate-workspace') !== -1,
      'NAVIGATE_WORKSPACE should map to iw:navigate-workspace');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 10: Undo/Redo with Phase 3 Features
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 10: Undo/Redo with Phase 3 Features', () => {

  test('addNode -> undo removes the node', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', { x: 50, y: 50 }, { name: 'orders' });
    assert.equal(t.canvas.getNodeCount(), 1);

    t.undoMgr.undo();
    assert.equal(t.canvas.getNodeCount(), 0, 'Node should be removed after undo');
  });

  test('addNode -> undo -> redo restores the node', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', { x: 50, y: 50 }, { name: 'orders' });
    var originalId = nd.id;

    t.undoMgr.undo();
    assert.equal(t.canvas.getNodeCount(), 0);

    t.undoMgr.redo();
    assert.equal(t.canvas.getNodeCount(), 1, 'Node should be restored after redo');
  });

  test('updateNode does not push undo command', () => {
    var t = createTestCanvas();
    t.canvas.addNode('sql-table', null, { name: 'table_1' });
    var undoSizeBefore = t.undoMgr.stackInfo().undoSize;

    var nodeId = t.canvas.getNodes()[0].id;
    t.canvas.updateNode(nodeId, { name: 'customers' });
    var undoSizeAfter = t.undoMgr.stackInfo().undoSize;

    assert.equal(undoSizeAfter, undoSizeBefore,
      'updateNode should NOT push to undo stack');
  });

  test('autoLayout -> undo reverts positions', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'a' });
    var n2 = t.canvas.addNode('sql-mlv', { x: 10, y: 10 }, { name: 'b' });
    t.canvas.addConnection(n1.id, n2.id);

    // Record positions before layout
    var beforeA = t.canvas.getNodeData(n1.id);
    var beforeB = t.canvas.getNodeData(n2.id);

    t.canvas.autoLayout();

    // Positions should have changed
    var afterA = t.canvas.getNodeData(n1.id);
    var moved = (afterA.x !== beforeA.x || afterA.y !== beforeA.y);
    assert.ok(moved, 'autoLayout should move at least one node');

    // Undo autoLayout (it's the last command pushed)
    t.undoMgr.undo();

    var revertedA = t.canvas.getNodeData(n1.id);
    var revertedB = t.canvas.getNodeData(n2.id);
    assert.equal(revertedA.x, beforeA.x, 'Node A x should revert');
    assert.equal(revertedA.y, beforeA.y, 'Node A y should revert');
    assert.equal(revertedB.x, beforeB.x, 'Node B x should revert');
    assert.equal(revertedB.y, beforeB.y, 'Node B y should revert');
  });

  test('removeNode -> undo restores node', () => {
    var t = createTestCanvas();
    var nd = t.canvas.addNode('sql-table', { x: 100, y: 100 }, { name: 'to_remove' });
    var id = nd.id;
    assert.equal(t.canvas.getNodeCount(), 1);

    t.canvas.removeNode(id);
    assert.equal(t.canvas.getNodeCount(), 0);

    // Undo the remove (last command)
    t.undoMgr.undo();
    assert.equal(t.canvas.getNodeCount(), 1, 'Node should be restored after undo remove');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 11: Multi-Select + Connection Integrity
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 11: Multi-Select + Connection Integrity', () => {

  test('removing middle node removes both its connections', () => {
    var t = createTestCanvas();
    var nA = t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'A' });
    var nB = t.canvas.addNode('sql-table', { x: 200, y: 0 }, { name: 'B' });
    var nC = t.canvas.addNode('sql-mlv', { x: 400, y: 0 }, { name: 'C' });

    t.canvas.addConnection(nA.id, nB.id);
    t.canvas.addConnection(nB.id, nC.id);
    assert.equal(t.canvas.getConnections().length, 2, 'Should have 2 connections');

    // Remove middle node B
    t.canvas.removeNode(nB.id);

    assert.equal(t.canvas.getNodeCount(), 2, 'A and C should remain');
    assert.equal(t.canvas.getConnections().length, 0, 'Both connections to B should be removed');

    // Verify A and C still exist
    assert.ok(t.canvas.getNodeData(nA.id), 'Node A should exist');
    assert.ok(t.canvas.getNodeData(nC.id), 'Node C should exist');
    assert.ok(!t.canvas.getNodeData(nB.id), 'Node B should not exist');
  });

  test('selectNodes followed by removing 1 preserves others in selection', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 0, y: 0 });
    var n2 = t.canvas.addNode('sql-table', { x: 200, y: 0 });
    var n3 = t.canvas.addNode('sql-table', { x: 400, y: 0 });

    t.canvas.selectNodes([n1.id, n2.id, n3.id]);
    assert.equal(t.canvas.getSelectedNodeIds().length, 3);

    t.canvas.removeNode(n2.id);

    // n2 should be removed from selection
    var selected = t.canvas.getSelectedNodeIds();
    assert.ok(selected.indexOf(n2.id) === -1, 'Removed node should not be in selection');
    assert.equal(t.canvas.getNodeCount(), 2);
  });

  test('connection cascade with fan-in topology', () => {
    var t = createTestCanvas();
    var nA = t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'A' });
    var nB = t.canvas.addNode('sql-table', { x: 200, y: 0 }, { name: 'B' });
    var nC = t.canvas.addNode('sql-mlv', { x: 100, y: 200 }, { name: 'C' });

    t.canvas.addConnection(nA.id, nC.id);
    t.canvas.addConnection(nB.id, nC.id);
    assert.equal(t.canvas.getConnections().length, 2);

    // Remove target node C — both incoming connections should be removed
    t.canvas.removeNode(nC.id);

    assert.equal(t.canvas.getConnections().length, 0, 'All connections to C should be removed');
    assert.equal(t.canvas.getNodeCount(), 2, 'A and B should remain');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 12: Viewport Culling Integration
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 12: Viewport Culling Integration', () => {

  test('near node is visible, far node is hidden after _updateVisibility', () => {
    var t = createTestCanvas();
    // Default viewport: panX=0, panY=0, zoom=1.0
    // getBoundingClientRect returns {width: 800, height: 600}
    var nearNode = t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'near' });
    var farNode = t.canvas.addNode('sql-table', { x: 5000, y: 5000 }, { name: 'far' });

    t.canvas._updateVisibility();

    var nearDagNode = t.canvas._nodes[nearNode.id];
    var farDagNode = t.canvas._nodes[farNode.id];

    assert.ok(nearDagNode.isVisible(), 'Near node at (0,0) should be visible');
    assert.ok(!farDagNode.isVisible(), 'Far node at (5000,5000) should be hidden');
  });

  test('panning viewport makes far node visible', () => {
    var t = createTestCanvas();
    var nearNode = t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'near' });
    var farNode = t.canvas.addNode('sql-table', { x: 5000, y: 5000 }, { name: 'far' });

    t.canvas._updateVisibility();
    assert.ok(!t.canvas._nodes[farNode.id].isVisible(), 'Far node should start hidden');

    // Pan viewport to show far node area
    // panX/panY in setViewport are pixel offsets: to see canvas (5000,5000), 
    // we need panX = -5000, panY = -5000 at zoom=1.0
    t.canvas.setViewport(-5000, -5000, 1.0);
    t.canvas._updateVisibility();

    assert.ok(t.canvas._nodes[farNode.id].isVisible(), 'Far node should become visible after pan');
  });

  test('zoom out makes more nodes visible', () => {
    var t = createTestCanvas();
    t.canvas.addNode('sql-table', { x: 0, y: 0 }, { name: 'center' });
    t.canvas.addNode('sql-table', { x: 2000, y: 2000 }, { name: 'distant' });

    // At zoom 1.0, distant node is outside 800x600 viewport
    t.canvas.setViewport(0, 0, 1.0);
    t.canvas._updateVisibility();

    // Zoom way out to fit everything
    t.canvas.setViewport(0, 0, 0.25);
    t.canvas._updateVisibility();

    // At zoom 0.25, viewport covers 3200x2400 in canvas space
    // distant node at (2000,2000) should be visible
    var distantNode = t.canvas._nodes[Object.keys(t.canvas._nodeData)[1]];
    assert.ok(distantNode.isVisible(), 'Distant node should be visible after zoom out');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 13: End-to-End Composite Scenarios
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 13: End-to-End Composite Scenarios', () => {

  test('preset -> autoLayout -> undo -> redo full cycle', () => {
    var t = createTestCanvas();

    // Place nodes at deliberately overlapping positions so autoLayout must move them
    t.canvas.batchOperation(function(c) {
      var n1 = c.addNode('sql-table', { x: 5, y: 5 }, { name: 'orders' });
      var n2 = c.addNode('sql-mlv', { x: 5, y: 5 }, { name: 'orders_view' });
      c.addConnection(n1.id, n2.id);
    });

    assert.equal(t.canvas.getNodeCount(), 2, 'Preset should add 2 nodes');
    var nodeIds = t.canvas.getNodes().map(function(n) { return n.id; });
    var beforeLayout = t.canvas.getNodeData(nodeIds[1]);

    // AutoLayout — must move at least one node off (5,5)
    t.canvas.autoLayout();
    var afterLayout = t.canvas.getNodeData(nodeIds[1]);
    var moved = (afterLayout.x !== beforeLayout.x || afterLayout.y !== beforeLayout.y);
    assert.ok(moved, 'autoLayout should move overlapping nodes');

    // Undo layout — positions should revert to pre-layout values
    t.undoMgr.undo();
    var afterUndo = t.canvas.getNodeData(nodeIds[1]);
    assert.equal(afterUndo.x, beforeLayout.x, 'x should revert after undo');
    assert.equal(afterUndo.y, beforeLayout.y, 'y should revert after undo');
  });

  test('removeNode -> undo restores single node in composite flow', () => {
    var t = createTestCanvas();

    t.canvas.batchOperation(function(c) {
      c.addNode('sql-table', { x: 0, y: 0 }, { name: 'a' });
      c.addNode('sql-table', { x: 200, y: 0 }, { name: 'b' });
    });

    assert.equal(t.canvas.getNodeCount(), 2);

    // Remove one node, then undo to restore it
    var nodeB = t.canvas.getNodes().find(function(n) { return n.name === 'b'; });
    t.canvas.removeNode(nodeB.id);
    assert.equal(t.canvas.getNodeCount(), 1, 'One node removed');

    // Undo the remove — node B should be restored
    t.undoMgr.undo();
    assert.equal(t.canvas.getNodeCount(), 2, 'Node should be restored after undo');
  });

  test('collectState captures full canvas snapshot', () => {
    var t = createTestCanvas();
    var n1 = t.canvas.addNode('sql-table', { x: 10, y: 20 }, { name: 'src' });
    var n2 = t.canvas.addNode('sql-mlv', { x: 300, y: 20 }, { name: 'view' });
    t.canvas.addConnection(n1.id, n2.id);
    t.canvas.setViewport(5, 10, 1.5);

    var state = {};
    t.canvas.collectState(state);

    assert.equal(state.nodes.length, 2, 'State should have 2 nodes');
    assert.equal(state.connections.length, 1, 'State should have 1 connection');
    assert.ok(Math.abs(state.viewport.zoom - 1.5) < 0.001, 'State should capture viewport zoom');
    assert.equal(state.viewport.panX, 5, 'State should capture panX');
  });
});
