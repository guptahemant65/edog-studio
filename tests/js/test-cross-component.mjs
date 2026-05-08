/**
 * Gate 2 INTEGRATION tests — Cross-component communication via EventBus
 * and state shape compatibility between F16 Phase 2 modules.
 *
 * @author Sentinel — EDOG Studio hivemind
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

// IW_EVENTS constants (defined in infra-wizard.js — too DOM-heavy to load)
const IW_EVENTS = {
  UNDO: 'wizard:undo',
  REDO: 'wizard:redo',
  STATE_CHANGED: 'wizard:state-changed',
  NODE_ADDED: 'wizard:node-added',
  NODE_REMOVED: 'wizard:node-removed',
  CONNECTION_CREATED: 'wizard:connection-created',
  CONNECTION_REMOVED: 'wizard:connection-removed',
  ZOOM_CHANGED: 'wizard:zoom-changed',
  LAYOUT_COMPLETE: 'wizard:layout-complete',
  EXECUTION_STARTED: 'wizard:execution-started',
  EXECUTION_STEP: 'wizard:execution-step',
  EXECUTION_COMPLETE: 'wizard:execution-complete',
  EXECUTION_FAILED: 'wizard:execution-failed'
};

/* ═══════════════════════════════════════════════════════════════════
   DOM MOCK
   ═══════════════════════════════════════════════════════════════════ */

function createMockElement() {
  return {
    style: {},
    classList: {
      add: function() {},
      remove: function() {},
      contains: function() { return false; },
      toggle: function() {}
    },
    setAttribute: function() {},
    getAttribute: function() { return null; },
    appendChild: function() {},
    removeChild: function() {},
    addEventListener: function() {},
    removeEventListener: function() {},
    querySelector: function() { return createMockElement(); },
    querySelectorAll: function() { return []; },
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    children: [],
    childElementCount: 0,
    parentNode: { removeChild: function() {} },
    tagName: 'div',
    remove: function() {}
  };
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT LOADER — loads multiple source files into one vm context
   ═══════════════════════════════════════════════════════════════════ */

function createSharedContext() {
  const mockDoc = {
    createElement: function() { return createMockElement(); },
    createElementNS: function() { return createMockElement(); },
    querySelector: function() { return createMockElement(); },
    querySelectorAll: function() { return []; },
    body: { appendChild: function() {} }
  };
  const ctx = vm.createContext({
    window: {},
    document: mockDoc,
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
    NaN: NaN,
    isNaN: isNaN,
    NULL: null,
    encodeURIComponent: encodeURIComponent,
    AbortController: AbortController,
    Promise: Promise,
    fetch: function() { return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve({}); }, headers: { get: function() { return ''; } } }); }
  });
  return ctx;
}

function loadInto(ctx, filename) {
  const code = readFileSync(join(srcDir, filename), 'utf-8');
  vm.runInContext(code, ctx);
}

/** Normalize vm-context objects for deepStrictEqual */
function norm(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ═══════════════════════════════════════════════════════════════════
   CANONICAL TEST DATA (DagCanvas-compatible shapes)
   ═══════════════════════════════════════════════════════════════════ */

function makeNodes() {
  return [
    { id: 1, name: 'customers', type: 'sql-table', schema: 'dbo', x: 0, y: 0, width: 180, height: 72 },
    { id: 2, name: 'customer_mlv', type: 'sql-mlv', schema: 'dbo', x: 200, y: 0, width: 180, height: 72, parentTable: 'customers' }
  ];
}

function makeConnections() {
  return [{ id: 1, sourceNodeId: 1, targetNodeId: 2 }];
}


/* ═══════════════════════════════════════════════════════════════════
   SUITE 1: EventBus Cross-Module Communication
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 1: EventBus Cross-Module Communication', () => {

  test('EventBus created once, shared across UndoRedo and other consumers', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const WEB = ctx.window.WizardEventBus;
    const URM = ctx.window.UndoRedoManager;
    const bus = new WEB();
    const mgr = new URM({ eventBus: bus });
    // Both reference the same bus
    assert.equal(mgr._eventBus, bus);
    assert.ok(bus instanceof WEB);
  });

  test('UndoRedoManager emits UNDO event that other listeners receive', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    const received = [];
    bus.on('undo:performed', (data) => { received.push(data); });
    mgr.push({ type: 'add-node', description: 'Add customers', doFn() {}, undoFn() {} });
    mgr.undo();
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'add-node');
    assert.equal(received[0].description, 'Add customers');
  });

  test('UndoRedoManager emits REDO event that other listeners receive', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    const received = [];
    bus.on('redo:performed', (data) => { received.push(data); });
    mgr.push({ type: 'move-node', description: 'Move node', doFn() {}, undoFn() {} });
    mgr.undo();
    mgr.redo();
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'move-node');
  });

  test('push() followed by undo() emits correct event sequence', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    const events = [];
    bus.on('undo:performed', () => events.push('undo'));
    bus.on('redo:performed', () => events.push('redo'));
    mgr.push({ type: 't', description: 'd', doFn() {}, undoFn() {} });
    mgr.push({ type: 't2', description: 'd2', doFn() {}, undoFn() {} });
    mgr.undo();
    mgr.undo();
    mgr.redo();
    assert.deepStrictEqual(events, ['undo', 'undo', 'redo']);
  });

  test('Multiple subscribers on the same bus receive the same event', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    const bus = new ctx.window.WizardEventBus();
    const results = { a: null, b: null, c: null };
    bus.on(IW_EVENTS.STATE_CHANGED, (d) => { results.a = d; });
    bus.on(IW_EVENTS.STATE_CHANGED, (d) => { results.b = d; });
    bus.on(IW_EVENTS.STATE_CHANGED, (d) => { results.c = d; });
    bus.emit(IW_EVENTS.STATE_CHANGED, { foo: 1 });
    assert.deepStrictEqual(norm(results), { a: { foo: 1 }, b: { foo: 1 }, c: { foo: 1 } });
  });

  test('Unsubscribing one consumer does not affect others', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    const bus = new ctx.window.WizardEventBus();
    const calls = [];
    const unsub = bus.on('evt', () => calls.push('A'));
    bus.on('evt', () => calls.push('B'));
    unsub();
    bus.emit('evt');
    assert.deepStrictEqual(calls, ['B']);
  });

  test('destroy() on EventBus stops all communication', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    const bus = new ctx.window.WizardEventBus();
    let called = false;
    bus.on('evt', () => { called = true; });
    bus.destroy();
    bus.emit('evt');
    assert.equal(called, false);
    // on() after destroy returns a no-op unsub
    const unsub = bus.on('evt2', () => {});
    assert.equal(typeof unsub, 'function');
    assert.equal(bus.listenerCount('evt2'), 0);
  });

  test('EventBus created per-wizard: separate instances are isolated', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    const busA = new ctx.window.WizardEventBus();
    const busB = new ctx.window.WizardEventBus();
    let gotA = false, gotB = false;
    busA.on('test', () => { gotA = true; });
    busB.on('test', () => { gotB = true; });
    busA.emit('test');
    assert.equal(gotA, true);
    assert.equal(gotB, false);
  });

  test('UndoRedo + EventBus: undo triggers event, listener updates external state', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    const externalState = { nodeCount: 1 };
    bus.on('undo:performed', (data) => {
      if (data.type === 'add-node') externalState.nodeCount--;
    });
    mgr.push({ type: 'add-node', description: 'Add node', doFn() {}, undoFn() {} });
    mgr.undo();
    assert.equal(externalState.nodeCount, 0);
  });

  test('Custom event names via UndoRedo constructor propagate through EventBus', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({
      eventBus: bus,
      undoEvent: IW_EVENTS.UNDO,
      redoEvent: IW_EVENTS.REDO
    });
    const events = [];
    bus.on(IW_EVENTS.UNDO, () => events.push('undo'));
    bus.on(IW_EVENTS.REDO, () => events.push('redo'));
    mgr.push({ type: 't', description: 'd', doFn() {}, undoFn() {} });
    mgr.undo();
    mgr.redo();
    assert.deepStrictEqual(events, ['undo', 'redo']);
  });

  test('CodeGen loaded into same context as EventBus does not conflict', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-code-gen.js');
    assert.ok(ctx.window.WizardEventBus);
    assert.ok(ctx.window.CodeGenerationEngine);
    // Both coexist
    const bus = new ctx.window.WizardEventBus();
    const gen = new ctx.window.CodeGenerationEngine();
    assert.equal(bus.listenerCount('test'), 0);
    assert.equal(typeof gen.generateCells, 'function');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 2: State Shape Compatibility
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 2: State Shape Compatibility', () => {

  test('CodeGenerationEngine.generateCells() accepts DagCanvas node/connection format', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const cells = gen.generateCells(makeNodes(), makeConnections(), 'ecommerce', {});
    assert.ok(Array.isArray(cells));
    assert.equal(cells.length, 2);
    // First cell is the sql-table, second is the sql-mlv
    assert.equal(cells[0].type, 'sql-table');
    assert.equal(cells[1].type, 'sql-mlv');
  });

  test('AutoLayoutEngine.layout() accepts the same node/connection format', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-auto-layout.js');
    const ALE = ctx.window.AutoLayoutEngine;
    const engine = new ALE();
    const result = engine.layout(makeNodes(), makeConnections());
    assert.ok(result.positions);
    assert.ok(result.viewport);
    // Both nodes get positions
    assert.ok(result.positions[1]);
    assert.ok(result.positions[2]);
    assert.equal(typeof result.positions[1].x, 'number');
    assert.equal(typeof result.positions[1].y, 'number');
  });

  test('CodeGen output (cells array) has correct structure for notebook payload', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const cells = gen.generateCells(makeNodes(), makeConnections(), 'ecommerce', {});
    for (const cell of cells) {
      assert.ok(cell.type, 'cell must have type');
      assert.ok(cell.language, 'cell must have language');
      assert.ok(cell.nodeId !== undefined, 'cell must have nodeId');
      assert.ok(cell.nodeName, 'cell must have nodeName');
      assert.ok(typeof cell.content === 'string', 'cell must have string content');
    }
  });

  test('generateNotebookPayload() produces valid payload with cells from generateCells()', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const cells = gen.generateCells(makeNodes(), makeConnections(), 'ecommerce', {});
    const payload = gen.generateNotebookPayload(cells);
    assert.ok(payload.definition);
    assert.equal(payload.definition.format, 'ipynb');
    assert.ok(Array.isArray(payload.definition.parts));
    assert.equal(payload.definition.parts.length, 1);
    const part = payload.definition.parts[0];
    assert.equal(part.path, 'notebook-content.py');
    assert.equal(part.payloadType, 'InlineBase64');
    // payload is valid JSON string
    const inner = JSON.parse(part.payload);
    assert.equal(inner.nbformat, 4);
    assert.equal(inner.cells.length, 2);
    assert.equal(inner.cells[0].cell_type, 'code');
  });

  test('State round-trip: create state -> pass through CodeGen -> verify output', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const nodes = [
      { id: 10, name: 'orders', type: 'sql-table', schema: 'dbo', x: 0, y: 0, width: 180, height: 72 },
      { id: 20, name: 'order_summary', type: 'sql-mlv', schema: 'dbo', x: 200, y: 0, width: 180, height: 72, parentTable: 'orders' },
      { id: 30, name: 'order_pyspark', type: 'pyspark-mlv', schema: 'dbo', x: 400, y: 0, width: 180, height: 72, parentTable: 'orders' }
    ];
    const conns = [
      { id: 1, sourceNodeId: 10, targetNodeId: 20 },
      { id: 2, sourceNodeId: 10, targetNodeId: 30 }
    ];
    const cells = gen.generateCells(nodes, conns, 'sales', {});
    assert.equal(cells.length, 3);
    // Topological order: orders first (no deps), then the MLVs
    assert.equal(cells[0].nodeId, 10);
    const payload = gen.generateNotebookPayload(cells);
    const inner = JSON.parse(payload.definition.parts[0].payload);
    assert.equal(inner.cells.length, 3);
  });

  test('Empty nodes/connections do not crash CodeGen or AutoLayout', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    loadInto(ctx, 'wizard-auto-layout.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const ALE = ctx.window.AutoLayoutEngine;
    const engine = new ALE();
    // CodeGen with empty arrays
    const cells = gen.generateCells([], [], 'ecommerce', {});
    assert.ok(Array.isArray(cells));
    assert.equal(cells.length, 0);
    // AutoLayout with empty arrays
    const result = engine.layout([], []);
    assert.deepStrictEqual(norm(result.positions), {});
  });

  test('Theme from state.theme correctly maps to THEME_COLUMNS in CodeGen', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const singleNode = [{ id: 1, name: 'test_table', type: 'sql-table', schema: 'dbo', x: 0, y: 0, width: 180, height: 72 }];
    const themes = ['ecommerce', 'sales', 'iot', 'hr', 'finance', 'healthcare'];
    for (const theme of themes) {
      const cells = gen.generateCells(singleNode, [], theme, {});
      assert.equal(cells.length, 1, 'Should produce 1 cell for theme: ' + theme);
      assert.ok(cells[0].content.length > 0, 'Cell content should not be empty for theme: ' + theme);
      assert.ok(cells[0].content.includes('CREATE TABLE'), 'Cell should contain CREATE TABLE for theme: ' + theme);
    }
  });

  test('AutoLayout positions and CodeGen cells agree on node ordering', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-code-gen.js');
    loadInto(ctx, 'wizard-auto-layout.js');
    const gen = new ctx.window.CodeGenerationEngine();
    const engine = new ctx.window.AutoLayoutEngine();
    const nodes = makeNodes();
    const conns = makeConnections();
    const cells = gen.generateCells(nodes, conns, 'ecommerce', {});
    const layout = engine.layout(nodes, conns);
    // Source node (id=1) gets positioned higher (lower y) than target (id=2)
    assert.ok(layout.positions[1].y <= layout.positions[2].y);
    // CodeGen produces source cell first
    assert.equal(cells[0].nodeId, 1);
    assert.equal(cells[1].nodeId, 2);
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 3: UndoRedo + EventBus Integration
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 3: UndoRedo + EventBus Integration', () => {

  test('UndoRedoManager uses EventBus for undo/redo notifications', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    const log = [];
    bus.on('undo:performed', () => log.push('undo'));
    bus.on('redo:performed', () => log.push('redo'));
    mgr.push({ type: 'a', description: 'A', doFn() {}, undoFn() {} });
    mgr.undo();
    mgr.redo();
    assert.deepStrictEqual(log, ['undo', 'redo']);
  });

  test('External listener receives notification when undo happens', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    let undoData = null;
    bus.on('undo:performed', (d) => { undoData = d; });
    mgr.push({ type: 'remove-node', description: 'Remove orders', doFn() {}, undoFn() {} });
    mgr.undo();
    assert.ok(undoData);
    assert.equal(undoData.type, 'remove-node');
    assert.equal(undoData.description, 'Remove orders');
  });

  test('External listener receives notification when redo happens', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    let redoData = null;
    bus.on('redo:performed', (d) => { redoData = d; });
    mgr.push({ type: 'move-node', description: 'Move orders', doFn() {}, undoFn() {} });
    mgr.undo();
    mgr.redo();
    assert.ok(redoData);
    assert.equal(redoData.type, 'move-node');
  });

  test('Stack state is consistent after undo+redo sequence with event listeners', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const bus = new ctx.window.WizardEventBus();
    const mgr = new ctx.window.UndoRedoManager({ eventBus: bus });
    const eventCount = { undo: 0, redo: 0 };
    bus.on('undo:performed', () => eventCount.undo++);
    bus.on('redo:performed', () => eventCount.redo++);
    mgr.push({ type: 'a', description: 'A', doFn() {}, undoFn() {} });
    mgr.push({ type: 'b', description: 'B', doFn() {}, undoFn() {} });
    mgr.push({ type: 'c', description: 'C', doFn() {}, undoFn() {} });
    mgr.undo(); // undo C
    mgr.undo(); // undo B
    mgr.redo(); // redo B
    assert.deepStrictEqual(norm(mgr.stackInfo()), { undoSize: 2, redoSize: 1 });
    assert.equal(eventCount.undo, 2);
    assert.equal(eventCount.redo, 1);
    assert.equal(mgr.undoDescription(), 'B');
    assert.equal(mgr.redoDescription(), 'C');
  });

  test('Multiple UndoRedoManagers on separate EventBus instances are isolated', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const busA = new ctx.window.WizardEventBus();
    const busB = new ctx.window.WizardEventBus();
    const mgrA = new ctx.window.UndoRedoManager({ eventBus: busA });
    const mgrB = new ctx.window.UndoRedoManager({ eventBus: busB });
    let gotA = false, gotB = false;
    busA.on('undo:performed', () => { gotA = true; });
    busB.on('undo:performed', () => { gotB = true; });
    mgrA.push({ type: 'x', description: 'X', doFn() {}, undoFn() {} });
    mgrA.undo();
    assert.equal(gotA, true);
    assert.equal(gotB, false);
  });

  test('Destroying one UndoRedoManager does not affect another on a different bus', () => {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-undo-redo.js');
    const busA = new ctx.window.WizardEventBus();
    const busB = new ctx.window.WizardEventBus();
    const mgrA = new ctx.window.UndoRedoManager({ eventBus: busA });
    const mgrB = new ctx.window.UndoRedoManager({ eventBus: busB });
    mgrB.push({ type: 'y', description: 'Y', doFn() {}, undoFn() {} });
    mgrA.destroy();
    // mgrA is dead
    assert.equal(mgrA.canUndo(), false);
    // mgrB still works
    assert.equal(mgrB.canUndo(), true);
    let received = null;
    busB.on('undo:performed', (d) => { received = d; });
    mgrB.undo();
    assert.ok(received);
    assert.equal(received.type, 'y');
  });
});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 4: Execution Pipeline + EventBus
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 4: Execution Pipeline + EventBus', () => {

  function loadExecutionContext() {
    const ctx = createSharedContext();
    loadInto(ctx, 'wizard-event-bus.js');
    loadInto(ctx, 'wizard-execution.js');
    return ctx;
  }

  test('ExecutionPipeline constructor accepts EventBus', () => {
    const ctx = loadExecutionContext();
    const bus = new ctx.window.WizardEventBus();
    const pipeline = new ctx.window.ExecutionPipeline({ eventBus: bus });
    assert.ok(pipeline);
    assert.equal(pipeline._eventBus, bus);
    pipeline.destroy();
  });

  test('activate() with valid state stores it for execution', () => {
    const ctx = loadExecutionContext();
    const bus = new ctx.window.WizardEventBus();
    // Capture the execution:started event to prove activate runs
    let startedFired = false;
    bus.on('execution:started', () => { startedFired = true; });
    const pipeline = new ctx.window.ExecutionPipeline({ eventBus: bus });
    const wizardState = {
      naming: { workspaceName: 'test-ws', lakehouseName: 'test-lh', notebookName: 'test-nb' },
      capacity: { capacityId: 'cap-123' },
      codeGeneration: { notebookPayload: { dummy: true }, cells: [] }
    };
    pipeline.activate(wizardState);
    // The execution context is derived from the wizardState
    assert.ok(pipeline._executionContext);
    assert.equal(pipeline._executionContext.workspaceName, 'test-ws');
    assert.equal(pipeline._executionContext.capacityId, 'cap-123');
    assert.equal(pipeline._executionContext.lakehouseName, 'test-lh');
    assert.equal(pipeline._executionContext.notebookName, 'test-nb');
    assert.equal(startedFired, true);
    pipeline.destroy();
  });

  test('validate() returns correct structure', () => {
    const ctx = loadExecutionContext();
    const bus = new ctx.window.WizardEventBus();
    const pipeline = new ctx.window.ExecutionPipeline({ eventBus: bus });
    const result = pipeline.validate();
    assert.deepStrictEqual(norm(result), { valid: true });
    pipeline.destroy();
  });

  test('ExecutionPipeline.destroy() cleans up EventBus references', () => {
    const ctx = loadExecutionContext();
    const bus = new ctx.window.WizardEventBus();
    const pipeline = new ctx.window.ExecutionPipeline({ eventBus: bus });
    pipeline.destroy();
    assert.equal(pipeline._eventBus, null);
    assert.equal(pipeline._destroyed, true);
    assert.equal(pipeline._el, null);
  });

  test('State shape from pages 0-2 is compatible with execution pipeline expectations', () => {
    const ctx = loadExecutionContext();
    const bus = new ctx.window.WizardEventBus();
    const pipeline = new ctx.window.ExecutionPipeline({ eventBus: bus });
    // Simulate the state shape that pages 0 (naming), 1 (capacity), 2 (DAG/codeGen) produce
    const wizardState = {
      naming: {
        workspaceName: 'my-workspace',
        lakehouseName: 'my-lakehouse',
        notebookName: 'my-notebook'
      },
      capacity: {
        capacityId: 'F2-capacity-guid'
      },
      codeGeneration: {
        cells: [{ type: 'sql-table', language: 'sql', nodeId: 1, nodeName: 'orders', content: 'CREATE TABLE ...' }],
        notebookPayload: { definition: { format: 'ipynb', parts: [] } }
      }
    };
    // _getExecutionContext is how activate() transforms wizard state
    const execCtx = pipeline._getExecutionContext(wizardState);
    assert.equal(execCtx.workspaceName, 'my-workspace');
    assert.equal(execCtx.lakehouseName, 'my-lakehouse');
    assert.equal(execCtx.notebookName, 'my-notebook');
    assert.equal(execCtx.capacityId, 'F2-capacity-guid');
    assert.ok(execCtx.notebookPayload);
    assert.ok(execCtx.cells);
    pipeline.destroy();
  });

  test('collectState() persists execution state correctly', () => {
    const ctx = loadExecutionContext();
    const bus = new ctx.window.WizardEventBus();
    const pipeline = new ctx.window.ExecutionPipeline({ eventBus: bus });
    const state = {};
    pipeline.collectState(state);
    assert.ok(state.execution);
    assert.equal(state.execution.status, 'idle');
    assert.ok(state.execution.artifacts);
    assert.ok(state.execution.timing);
    assert.equal(state.execution.artifacts.workspaceId, null);
    assert.equal(state.execution.error, null);
    pipeline.destroy();
  });
});
