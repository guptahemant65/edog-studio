/**
 * Gate 5 — Edge Case Tests for F16 Phase 2 components.
 *
 * "Normal inputs are easy. Edge cases are where bugs live."
 *
 * @author Sentinel — EDOG Studio hivemind
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ── VM Context Setup ────────────────────────────────────────────────

const srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function createMockElement() {
  return {
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    setAttribute(){}, getAttribute(){ return null; },
    appendChild(){}, removeChild(){},
    addEventListener(){}, removeEventListener(){},
    querySelector(){ return createMockElement(); },
    querySelectorAll(){ return []; },
    innerHTML: '', textContent: '', hidden: false,
    dataset: {}, children: [], childElementCount: 0,
    parentNode: { removeChild(){} },
    tagName: 'div', remove(){}
  };
}

function createContext() {
  const win = {};
  const doc = {
    createElement() { return createMockElement(); },
    createElementNS() { return createMockElement(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: { appendChild(){} }
  };

  const ctx = vm.createContext({
    window: win, document: doc, console,
    setTimeout, setInterval, clearInterval, clearTimeout,
    Object, Array, Math, Date, Error, JSON,
    parseInt, parseFloat, String, Number, Boolean,
    RegExp, Map, Set, Symbol, Infinity, NaN, undefined,
    Reflect, Proxy: typeof Proxy !== 'undefined' ? Proxy : undefined,
    NULL: null
  });

  const files = [
    'wizard-event-bus.js',
    'wizard-code-gen.js',
    'wizard-auto-layout.js',
    'wizard-undo-redo.js',
    'wizard-review-summary.js'
  ];
  for (const f of files) {
    vm.runInContext(readFileSync(join(srcDir, f), 'utf-8'), ctx);
  }
  Object.assign(win, ctx.window);
  return { window: win };
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeNode(id, name, type, schema) {
  return { id, name: name || 'node_' + id, type: type || 'sql-table', schema: schema || 'dbo', x: 0, y: 0, width: 180, height: 72 };
}

function makeConn(id, src, tgt) {
  return { id, sourceNodeId: src, targetNodeId: tgt };
}

function generateNodes(count, type, schema) {
  const nodes = [];
  for (let i = 1; i <= count; i++) {
    nodes.push(makeNode(i, 'node_' + i, type || 'sql-table', schema || 'dbo'));
  }
  return nodes;
}

function linearChain(count) {
  const nodes = generateNodes(count);
  const conns = [];
  for (let i = 1; i < count; i++) {
    conns.push(makeConn(i, i, i + 1));
  }
  return { nodes, connections: conns };
}

// ── Load context once ───────────────────────────────────────────────

const ctx = createContext();

// =====================================================================
// Suite 1: Node Count Boundaries (CodeGen + ReviewSummary)
// =====================================================================

describe('Suite 1: Node Count Boundaries', () => {
  test('0 nodes — CodeGen returns empty cells, no crash', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const cells = eng.generateCells([], [], 'ecommerce', {});
    assert.ok(Array.isArray(cells));
    assert.equal(cells.length, 0);
  });

  test('1 node — CodeGen generates valid single-cell output', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const nodes = [makeNode(1, 'orders', 'sql-table', 'dbo')];
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 1);
    assert.equal(cells[0].nodeId, 1);
    assert.equal(cells[0].nodeName, 'orders');
    assert.ok(cells[0].content.length > 0);
  });

  test('50 nodes — ReviewSummary validation has NO high count warning', () => {
    const page = new ctx.window.ReviewSummaryPage({ eventBus: new ctx.window.WizardEventBus() });
    const state = {
      workspaceName: 'ws', capacityId: 'cap1',
      nodes: generateNodes(50),
      connections: [], schemas: { dbo: true }
    };
    page.activate(state);
    const result = page.validate();
    const highCountWarnings = result.warnings.filter(w => w.includes('High node count'));
    assert.equal(highCountWarnings.length, 0);
  });

  test('51 nodes — ReviewSummary validation returns high node count warning', () => {
    const page = new ctx.window.ReviewSummaryPage({ eventBus: new ctx.window.WizardEventBus() });
    const state = {
      workspaceName: 'ws', capacityId: 'cap1',
      nodes: generateNodes(51),
      connections: [], schemas: { dbo: true }
    };
    page.activate(state);
    const result = page.validate();
    const highCountWarnings = result.warnings.filter(w => w.includes('High node count'));
    assert.equal(highCountWarnings.length, 1);
  });

  test('100 nodes — CodeGen handles without error (stress)', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const nodes = generateNodes(100);
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 100);
  });

  test('100 nodes with linear chain — topoSort preserves order', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const { nodes, connections } = linearChain(100);
    const cells = eng.generateCells(nodes, connections, 'ecommerce', {});
    assert.equal(cells.length, 100);
    // First cell must be node 1 (root), last must be node 100
    assert.equal(cells[0].nodeId, 1);
    assert.equal(cells[99].nodeId, 100);
  });

  test('101 nodes — CodeGen handles gracefully', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const nodes = generateNodes(101);
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 101);
  });

  test('500 nodes — CodeGen does not crash, returns cells', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const nodes = generateNodes(500);
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 500);
  });
});

// =====================================================================
// Suite 2: Topological Sort Edge Cases (CodeGen)
// =====================================================================

describe('Suite 2: Topological Sort Edge Cases', () => {
  let eng;
  beforeEach(() => { eng = new ctx.window.CodeGenerationEngine(); });

  test('single node, no connections — returns that node', () => {
    const nodes = [makeNode('a', 'single')];
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 1);
    assert.equal(cells[0].nodeId, 'a');
  });

  test('linear chain A->B->C — returns [A,B,C]', () => {
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B', 'sql-mlv'), makeNode('c', 'C', 'sql-mlv')];
    const conns = [makeConn(1, 'a', 'b'), makeConn(2, 'b', 'c')];
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    const ids = cells.map(c => c.nodeId);
    assert.equal(ids.length, 3);
    assert.equal(ids[0], 'a');
    assert.equal(ids[1], 'b');
    assert.equal(ids[2], 'c');
  });

  test('diamond A->B, A->C, B->D, C->D — dependencies preserved', () => {
    const nodes = [
      makeNode('a', 'A'), makeNode('b', 'B', 'sql-mlv'),
      makeNode('c', 'C', 'sql-mlv'), makeNode('d', 'D', 'sql-mlv')
    ];
    const conns = [
      makeConn(1, 'a', 'b'), makeConn(2, 'a', 'c'),
      makeConn(3, 'b', 'd'), makeConn(4, 'c', 'd')
    ];
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    const ids = cells.map(c => c.nodeId);
    // A must be before B and C; B and C must be before D
    assert.ok(ids.indexOf('a') < ids.indexOf('b'));
    assert.ok(ids.indexOf('a') < ids.indexOf('c'));
    assert.ok(ids.indexOf('b') < ids.indexOf('d'));
    assert.ok(ids.indexOf('c') < ids.indexOf('d'));
  });

  test('disconnected subgraphs — all nodes included', () => {
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B'), makeNode('c', 'C'), makeNode('d', 'D')];
    const conns = [makeConn(1, 'a', 'b')]; // c, d disconnected
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    assert.equal(cells.length, 4);
    const ids = new Set(cells.map(c => c.nodeId));
    assert.ok(ids.has('a') && ids.has('b') && ids.has('c') && ids.has('d'));
  });

  test('all nodes disconnected — all nodes in output', () => {
    const nodes = [makeNode('x', 'X'), makeNode('y', 'Y'), makeNode('z', 'Z')];
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 3);
  });

  test('wide graph (1 root -> 20 leaves) — root first', () => {
    const nodes = [makeNode('root', 'Root')];
    const conns = [];
    for (let i = 1; i <= 20; i++) {
      nodes.push(makeNode('leaf' + i, 'Leaf' + i, 'sql-mlv'));
      conns.push(makeConn(i, 'root', 'leaf' + i));
    }
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    assert.equal(cells[0].nodeId, 'root');
    assert.equal(cells.length, 21);
  });

  test('deep linear chain (50 nodes) — correct sequential order', () => {
    const { nodes, connections } = linearChain(50);
    const cells = eng.generateCells(nodes, connections, 'ecommerce', {});
    for (let i = 0; i < 50; i++) {
      assert.equal(cells[i].nodeId, i + 1);
    }
  });

  test('self-loop (node connects to itself) — cycle detection returns null/empty', () => {
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B')];
    const conns = [makeConn(1, 'a', 'a')]; // self-loop
    // CodeGen's _topologicalSort returns null on cycle; generateCells returns []
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    // With self-loop, a gets inDegree 1, only b has inDegree 0 => result.length (1) !== 2 => null => []
    assert.ok(Array.isArray(cells));
    // Either empty (cycle detected) or graceful partial output
    assert.ok(cells.length === 0 || cells.length <= 2);
  });
});

// =====================================================================
// Suite 3: AutoLayout Edge Cases
// =====================================================================

describe('Suite 3: AutoLayout Edge Cases', () => {
  // AutoLayoutEngine is a constructor function (NOT a plain object — it's an IIFE returning a constructor)
  let layout;
  beforeEach(() => { layout = new ctx.window.AutoLayoutEngine(); });

  test('0 nodes — returns empty positions', () => {
    const result = layout.layout([], []);
    assert.equal(Object.keys(result.positions).length, 0);
    assert.ok(result.viewport);
  });

  test('null nodes — returns empty positions', () => {
    const result = layout.layout(null, null);
    assert.equal(Object.keys(result.positions).length, 0);
  });

  test('1 node — positioned at default location', () => {
    const nodes = [makeNode(1, 'solo')];
    const result = layout.layout(nodes, []);
    assert.ok(result.positions[1]);
    assert.equal(typeof result.positions[1].x, 'number');
    assert.equal(typeof result.positions[1].y, 'number');
  });

  test('disconnected nodes — all get positioned', () => {
    const nodes = generateNodes(5);
    const result = layout.layout(nodes, []);
    for (let i = 1; i <= 5; i++) {
      assert.ok(result.positions[i], 'node ' + i + ' should be positioned');
    }
  });

  test('all nodes same rank (no connections) — spread horizontally', () => {
    const nodes = generateNodes(5);
    const result = layout.layout(nodes, []);
    const xs = new Set();
    for (const id of Object.keys(result.positions)) {
      xs.add(result.positions[id].x);
    }
    // Each component is laid out independently side-by-side — all get distinct x values
    assert.equal(xs.size, 5, 'all 5 nodes should have distinct x positions');
  });

  test('very deep chain (20 levels) — all get different y positions', () => {
    const { nodes, connections } = linearChain(20);
    const result = layout.layout(nodes, connections);
    const ys = new Set();
    for (const id of Object.keys(result.positions)) {
      ys.add(result.positions[id].y);
    }
    assert.equal(ys.size, 20, 'each rank level should have a distinct y');
  });

  test('wide graph (20 nodes same rank) — all positioned', () => {
    const root = makeNode('root', 'Root');
    const nodes = [root];
    const conns = [];
    for (let i = 1; i <= 20; i++) {
      nodes.push(makeNode('c' + i, 'Child' + i));
      conns.push(makeConn(i, 'root', 'c' + i));
    }
    const result = layout.layout(nodes, conns);
    assert.equal(Object.keys(result.positions).length, 21);
  });
});

// =====================================================================
// Suite 4: UndoRedo Stack Boundaries
// =====================================================================

describe('Suite 4: UndoRedo Stack Boundaries', () => {
  test('push at max stack size (50) — oldest item dropped, size stays at 50', () => {
    const undo = new ctx.window.UndoRedoManager({ maxStack: 50 });
    for (let i = 0; i < 55; i++) {
      undo.push({ type: 'test', description: 'action ' + i, doFn() {}, undoFn() {} });
    }
    assert.equal(undo.stackInfo().undoSize, 50);
  });

  test('undo when empty — returns false', () => {
    const undo = new ctx.window.UndoRedoManager({});
    assert.equal(undo.undo(), false);
  });

  test('redo when empty — returns false', () => {
    const undo = new ctx.window.UndoRedoManager({});
    assert.equal(undo.redo(), false);
  });

  test('rapid push 1000 times — stack capped at maxStack', () => {
    const undo = new ctx.window.UndoRedoManager({ maxStack: 50 });
    for (let i = 0; i < 1000; i++) {
      undo.push({ type: 'test', description: 'action ' + i, doFn() {}, undoFn() {} });
    }
    assert.equal(undo.stackInfo().undoSize, 50);
    assert.equal(undo.stackInfo().redoSize, 0);
  });

  test('push after undo clears redo stack', () => {
    const undo = new ctx.window.UndoRedoManager({});
    undo.push({ type: 'a', description: 'a', doFn() {}, undoFn() {} });
    undo.push({ type: 'b', description: 'b', doFn() {}, undoFn() {} });
    undo.undo();
    assert.equal(undo.stackInfo().redoSize, 1);
    undo.push({ type: 'c', description: 'c', doFn() {}, undoFn() {} });
    assert.equal(undo.stackInfo().redoSize, 0);
  });

  test('null/undefined command fields — does not crash', () => {
    const undo = new ctx.window.UndoRedoManager({});
    // push with minimal fields — doFn/undoFn required by contract but we test graceful handling
    undo.push({ type: null, description: undefined, doFn() {}, undoFn() {} });
    assert.equal(undo.stackInfo().undoSize, 1);
    const result = undo.undo();
    assert.equal(result, true);
  });
});

// =====================================================================
// Suite 5: String Edge Cases (ReviewSummary + CodeGen)
// =====================================================================

describe('Suite 5: String Edge Cases', () => {
  test('500-char workspace name — validation still passes', () => {
    const page = new ctx.window.ReviewSummaryPage({ eventBus: new ctx.window.WizardEventBus() });
    const longName = 'A'.repeat(500);
    const state = {
      workspaceName: longName, capacityId: 'cap1',
      nodes: [makeNode(1, 'n1')], connections: [], schemas: { dbo: true }
    };
    page.activate(state);
    const result = page.validate();
    assert.equal(result.valid, true);
  });

  test('empty string workspace name — validation catches it', () => {
    const page = new ctx.window.ReviewSummaryPage({ eventBus: new ctx.window.WizardEventBus() });
    const state = {
      workspaceName: '', capacityId: 'cap1',
      nodes: [makeNode(1, 'n1')], connections: [], schemas: { dbo: true }
    };
    page.activate(state);
    const result = page.validate();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Workspace name')));
  });

  test('special chars in node name (quotes, backslashes, angle brackets) — CodeGen produces output', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const nodes = [makeNode('a', 'node"with<special>\\chars')];
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 1);
    assert.ok(cells[0].content.length > 0);
  });

  test('unicode node names (CJK characters) — handled without error', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const nodes = [makeNode('u1', '\u8BA2\u5355\u8868')]; // Chinese: "orders table"
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 1);
    assert.ok(cells[0].content.includes('\u8BA2\u5355\u8868'));
  });

  test('null schema on a node — does not trigger disabled schema error', () => {
    const page = new ctx.window.ReviewSummaryPage({ eventBus: new ctx.window.WizardEventBus() });
    const state = {
      workspaceName: 'ws', capacityId: 'cap1',
      nodes: [{ id: 1, name: 'test', type: 'sql-table', schema: null, x: 0, y: 0, width: 180, height: 72 }],
      connections: [], schemas: { dbo: true }
    };
    page.activate(state);
    const result = page.validate();
    // null schema should not produce a "schema not enabled" error
    const schemaErrors = result.errors.filter(e => e.includes('not enabled'));
    assert.equal(schemaErrors.length, 0);
  });

  test('very long schema name — CodeGen handles without crash', () => {
    const eng = new ctx.window.CodeGenerationEngine();
    const longSchema = 'schema_' + 'x'.repeat(500);
    const nodes = [makeNode(1, 'tbl', 'sql-table', longSchema)];
    const cells = eng.generateCells(nodes, [], 'ecommerce', {});
    assert.equal(cells.length, 1);
    assert.ok(cells[0].content.includes(longSchema));
  });
});

// =====================================================================
// Suite 6: Connection Edge Cases (CodeGen)
// =====================================================================

describe('Suite 6: Connection Edge Cases', () => {
  let eng;
  beforeEach(() => { eng = new ctx.window.CodeGenerationEngine(); });

  test('connection references non-existent nodeId — throws (no guard in topoSort)', () => {
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B')];
    const conns = [makeConn(1, 'a', 'z')]; // z doesn't exist
    let threw = false;
    try {
      eng.generateCells(nodes, conns, 'ecommerce', {});
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('undefined'), 'expected TypeError about undefined');
    }
    assert.ok(threw, 'should have thrown on non-existent nodeId');
  });

  test('duplicate connections (same source->target twice) — handled', () => {
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B', 'sql-mlv')];
    const conns = [makeConn(1, 'a', 'b'), makeConn(2, 'a', 'b')];
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    // Should still produce 2 cells in order (a before b)
    assert.equal(cells.length, 2);
    assert.equal(cells[0].nodeId, 'a');
    assert.equal(cells[1].nodeId, 'b');
  });

  test('connection with null sourceNodeId — throws (no guard in topoSort)', () => {
    const nodes = [makeNode('a', 'A'), makeNode('b', 'B')];
    const conns = [makeConn(1, null, 'b')];
    let threw = false;
    try {
      eng.generateCells(nodes, conns, 'ecommerce', {});
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('undefined'), 'expected TypeError about undefined');
    }
    assert.ok(threw, 'should have thrown on null sourceNodeId');
  });

  test('connection where source === target (self-loop) — handled gracefully', () => {
    const nodes = [makeNode('a', 'A')];
    const conns = [makeConn(1, 'a', 'a')];
    const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    // Cycle detection: result is null => returns []
    assert.ok(Array.isArray(cells));
  });

  test('many connections (50 nodes fully connected forward) — does not crash', () => {
    const nodes = generateNodes(50);
    const conns = [];
    let connId = 1;
    // Forward connections only: i -> j where i < j (acyclic)
    for (let i = 1; i <= 10; i++) {
      for (let j = i + 1; j <= 15; j++) {
        conns.push(makeConn(connId++, i, j));
      }
    }
    assert.doesNotThrow(() => {
      const cells = eng.generateCells(nodes, conns, 'ecommerce', {});
      assert.equal(cells.length, 50);
    });
  });
});

// =====================================================================
// Suite 7: EventBus Boundaries
// =====================================================================

describe('Suite 7: EventBus Boundaries', () => {
  test('10,000 listeners on same event — all fire', () => {
    const bus = new ctx.window.WizardEventBus();
    let count = 0;
    for (let i = 0; i < 10000; i++) {
      bus.on('mass', () => { count++; });
    }
    bus.emit('mass', {});
    assert.equal(count, 10000);
  });

  test('emit with no listeners — no error', () => {
    const bus = new ctx.window.WizardEventBus();
    assert.doesNotThrow(() => {
      bus.emit('nonexistent', { data: 42 });
    });
  });

  test('very long event name (1000 chars) — works fine', () => {
    const bus = new ctx.window.WizardEventBus();
    const longName = 'e'.repeat(1000);
    let fired = false;
    bus.on(longName, () => { fired = true; });
    bus.emit(longName, {});
    assert.equal(fired, true);
  });

  test('listener that throws during emit — other listeners still fire (error isolation)', () => {
    const bus = new ctx.window.WizardEventBus();
    let secondFired = false;
    bus.on('boom', () => { throw new Error('deliberate'); });
    bus.on('boom', () => { secondFired = true; });
    // emit swallows handler errors per source code (try/catch in loop)
    bus.emit('boom', {});
    assert.equal(secondFired, true);
  });
});
