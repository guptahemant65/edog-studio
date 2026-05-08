/**
 * Unit tests for CodeGenerationEngine (wizard-code-gen.js).
 * @author Sentinel — EDOG Studio hivemind
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ── Shared sandbox ──────────────────────────────────────────────────
var window = {};
var document = {
  createElement: function () { return { style: {}, classList: { add: function(){}, remove: function(){} }, setAttribute: function(){}, appendChild: function(){}, addEventListener: function(){}, innerHTML: '' }; },
  createElementNS: function () { return { style: {}, classList: { add: function(){}, remove: function(){} }, setAttribute: function(){}, setAttributeNS: function(){}, appendChild: function(){}, addEventListener: function(){} }; },
  querySelector: function () { return null; },
  body: { appendChild: function(){} }
};

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function loadSource(filename) {
  var code = readFileSync(join(srcDir, filename), 'utf-8');
  var ctx = vm.createContext({
    window: window, document: document, console: console,
    setTimeout: setTimeout, setInterval: setInterval, clearInterval: clearInterval, clearTimeout: clearTimeout,
    Object: Object, Array: Array, Math: Math, Date: Date, Error: Error, JSON: JSON,
    parseInt: parseInt, parseFloat: parseFloat, String: String, Number: Number,
    RegExp: RegExp, Map: Map, Set: Set, Symbol: Symbol,
    NULL: null,
    // class support requires these
    Reflect: Reflect, Proxy: typeof Proxy !== 'undefined' ? Proxy : undefined
  });
  vm.runInContext(code, ctx);
  Object.assign(window, ctx.window);
}

loadSource('wizard-code-gen.js');

var CodeGenerationEngine = window.CodeGenerationEngine;

// ── Helpers ─────────────────────────────────────────────────────────

function makeNode(id, type, name, schema) {
  return { id: id, type: type, name: name, schema: schema || 'dbo', config: {} };
}

function makeConn(id, src, tgt) {
  return { id: id, sourceNodeId: src, targetNodeId: tgt };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('CodeGenerationEngine', function () {
  var engine;

  test('constructor creates instance', function () {
    engine = new CodeGenerationEngine();
    assert.ok(engine);
  });

  // ── Topological sort ──────────────────────────────────────────────
  describe('topological sort', function () {
    test('linear chain: A->B->C produces correct order', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [
        makeNode('a', 'sql-table', 'TableA'),
        makeNode('b', 'sql-mlv',   'ViewB'),
        makeNode('c', 'sql-mlv',   'ViewC')
      ];
      var conns = [makeConn(1, 'a', 'b'), makeConn(2, 'b', 'c')];
      var cells = eng.generateCells(nodes, conns, 'ecommerce', {});
      var order = cells.map(function (c) { return c.nodeId; });
      assert.equal(order.length, 3);
      assert.equal(order[0], 'a');
      assert.equal(order[1], 'b');
      assert.equal(order[2], 'c');
    });

    test('diamond: A->B, A->C, B->D, C->D produces valid order', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [
        makeNode('a', 'sql-table', 'TblA'),
        makeNode('b', 'sql-mlv',   'ViewB'),
        makeNode('c', 'sql-mlv',   'ViewC'),
        makeNode('d', 'sql-mlv',   'ViewD')
      ];
      var conns = [
        makeConn(1, 'a', 'b'), makeConn(2, 'a', 'c'),
        makeConn(3, 'b', 'd'), makeConn(4, 'c', 'd')
      ];
      var cells = eng.generateCells(nodes, conns, 'ecommerce', {});
      var order = cells.map(function (c) { return c.nodeId; });
      // a must come before b and c; b and c before d
      assert.ok(order.indexOf('a') < order.indexOf('b'));
      assert.ok(order.indexOf('a') < order.indexOf('c'));
      assert.ok(order.indexOf('b') < order.indexOf('d'));
      assert.ok(order.indexOf('c') < order.indexOf('d'));
    });

    test('disconnected nodes: all included in output', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [
        makeNode('x', 'sql-table', 'TblX'),
        makeNode('y', 'sql-table', 'TblY'),
        makeNode('z', 'sql-table', 'TblZ')
      ];
      var cells = eng.generateCells(nodes, [], 'ecommerce', {});
      assert.equal(cells.length, 3);
    });

    test('single node: returns single cell', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode('solo', 'sql-table', 'Solo')];
      var cells = eng.generateCells(nodes, [], 'ecommerce', {});
      assert.equal(cells.length, 1);
      assert.equal(cells[0].nodeId, 'solo');
    });

    test('empty nodes array: returns empty cells', function () {
      var eng = new CodeGenerationEngine();
      var cells = eng.generateCells([], [], 'ecommerce', {});
      assert.equal(cells.length, 0);
    });

    test('detects circular dependency and returns empty array', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [
        makeNode('a', 'sql-mlv', 'ViewA'),
        makeNode('b', 'sql-mlv', 'ViewB')
      ];
      var conns = [makeConn(1, 'a', 'b'), makeConn(2, 'b', 'a')];
      var cells = eng.generateCells(nodes, conns, 'ecommerce', {});
      assert.equal(cells.length, 0);
    });
  });

  // ── Cell generation ───────────────────────────────────────────────
  describe('cell generation', function () {
    test('sql-table node generates CREATE TABLE SQL', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'Orders')];
      var cells = eng.generateCells(nodes, [], 'ecommerce', {});
      assert.equal(cells.length, 1);
      assert.ok(cells[0].content.includes('CREATE TABLE'));
      assert.equal(cells[0].type, 'sql-table');
      assert.equal(cells[0].language, 'sql');
    });

    test('sql-mlv node generates CREATE OR ALTER VIEW SQL', function () {
      var eng = new CodeGenerationEngine();
      var src = makeNode(1, 'sql-table', 'Orders');
      var mlv = makeNode(2, 'sql-mlv', 'OrderSummary');
      var conns = [makeConn(1, 1, 2)];
      var cells = eng.generateCells([src, mlv], conns, 'ecommerce', {});
      var mlvCell = cells.find(function (c) { return c.nodeId === 2; });
      assert.ok(mlvCell);
      assert.ok(mlvCell.content.includes('CREATE OR ALTER VIEW'));
      assert.equal(mlvCell.type, 'sql-mlv');
      assert.equal(mlvCell.language, 'sql');
    });

    test('pyspark-mlv node generates PySpark cell', function () {
      var eng = new CodeGenerationEngine();
      var src = makeNode(1, 'sql-table', 'Orders');
      var pys = makeNode(2, 'pyspark-mlv', 'OrderAnalytics', 'gold');
      var conns = [makeConn(1, 1, 2)];
      var cells = eng.generateCells([src, pys], conns, 'ecommerce', {});
      var pyCell = cells.find(function (c) { return c.nodeId === 2; });
      assert.ok(pyCell);
      assert.ok(pyCell.content.includes('SparkSession'));
      assert.equal(pyCell.type, 'pyspark-mlv');
      assert.equal(pyCell.language, 'python');
    });

    test('generated SQL uses correct theme columns', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'Sensors')];
      var cells = eng.generateCells(nodes, [], 'iot', {});
      // IoT theme has device_id, sensor_type, etc.
      assert.ok(cells[0].content.includes('device_id'));
      assert.ok(cells[0].content.includes('sensor_type'));
    });

    test('cells include schema prefix (e.g., dbo.Orders)', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'Orders', 'dbo')];
      var cells = eng.generateCells(nodes, [], 'ecommerce', {});
      assert.ok(cells[0].content.includes('[dbo].[Orders]'));
    });

    test('dependsOn: sql-mlv cell references parent in content', function () {
      var eng = new CodeGenerationEngine();
      var parent = makeNode(1, 'sql-table', 'Orders');
      var child = makeNode(2, 'sql-mlv', 'Summary');
      var conns = [makeConn(1, 1, 2)];
      var cells = eng.generateCells([parent, child], conns, 'ecommerce', {});
      var childCell = cells.find(function (c) { return c.nodeId === 2; });
      // The SQL MLV references its source table
      assert.ok(childCell.content.includes('Orders'));
    });
  });

  // ── generateNotebookPayload ───────────────────────────────────────
  describe('generateNotebookPayload', function () {
    test('returns valid notebook structure with cells', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'Orders')];
      var cells = eng.generateCells(nodes, [], 'ecommerce', {});
      var nb = eng.generateNotebookPayload(cells);
      assert.ok(nb.definition);
      assert.ok(nb.definition.format, 'ipynb');
      assert.ok(nb.definition.parts);
      assert.equal(nb.definition.parts.length, 1);
      var payload = JSON.parse(nb.definition.parts[0].payload);
      assert.equal(payload.cells.length, 1);
    });

    test('cells are ordered by topological sort', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [
        makeNode('a', 'sql-table', 'TblA'),
        makeNode('b', 'sql-mlv',   'ViewB'),
        makeNode('c', 'sql-mlv',   'ViewC')
      ];
      var conns = [makeConn(1, 'a', 'b'), makeConn(2, 'b', 'c')];
      var cells = eng.generateCells(nodes, conns, 'ecommerce', {});
      var nb = eng.generateNotebookPayload(cells);
      var payload = JSON.parse(nb.definition.parts[0].payload);
      var ids = payload.cells.map(function (c) { return c.metadata.node_id; });
      assert.deepEqual(ids, ['a', 'b', 'c']);
    });

    test('language field maps to cell metadata correctly', function () {
      var eng = new CodeGenerationEngine();
      var src = makeNode(1, 'sql-table', 'Orders');
      var pys = makeNode(2, 'pyspark-mlv', 'Analytics');
      var conns = [makeConn(1, 1, 2)];
      var cells = eng.generateCells([src, pys], conns, 'ecommerce', {});
      var nb = eng.generateNotebookPayload(cells);
      var payload = JSON.parse(nb.definition.parts[0].payload);
      var sqlCell = payload.cells.find(function (c) { return c.metadata.node_id === 1; });
      var pyCell = payload.cells.find(function (c) { return c.metadata.node_id === 2; });
      assert.equal(sqlCell.metadata['microsoft.fabric'].language, 'sql');
      assert.equal(pyCell.metadata['microsoft.fabric'].language, 'python');
    });

    test('empty cells array produces empty notebook', function () {
      var eng = new CodeGenerationEngine();
      var nb = eng.generateNotebookPayload([]);
      var payload = JSON.parse(nb.definition.parts[0].payload);
      assert.equal(payload.cells.length, 0);
      assert.equal(payload.nbformat, 4);
    });
  });

  // ── Themes ────────────────────────────────────────────────────────
  describe('themes', function () {
    test('ecommerce theme has expected columns', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'T')];
      var cells = eng.generateCells(nodes, [], 'ecommerce', {});
      assert.ok(cells[0].content.includes('order_id'));
      assert.ok(cells[0].content.includes('customer_name'));
      assert.ok(cells[0].content.includes('total_amount'));
    });

    test('sales theme has expected columns', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'T')];
      var cells = eng.generateCells(nodes, [], 'sales', {});
      assert.ok(cells[0].content.includes('deal_id'));
      assert.ok(cells[0].content.includes('account_name'));
      assert.ok(cells[0].content.includes('probability'));
    });

    test('healthcare theme has expected columns', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'T')];
      var cells = eng.generateCells(nodes, [], 'healthcare', {});
      assert.ok(cells[0].content.includes('patient_id'));
      assert.ok(cells[0].content.includes('diagnosis_code'));
      assert.ok(cells[0].content.includes('insurance_id'));
    });

    test('iot theme has expected columns', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'T')];
      var cells = eng.generateCells(nodes, [], 'iot', {});
      assert.ok(cells[0].content.includes('device_id'));
      assert.ok(cells[0].content.includes('reading_value'));
      assert.ok(cells[0].content.includes('alert_flag'));
    });

    test('unknown theme falls back to ecommerce', function () {
      var eng = new CodeGenerationEngine();
      var nodes = [makeNode(1, 'sql-table', 'T')];
      var cells = eng.generateCells(nodes, [], 'nonexistent_theme', {});
      // Should fall back to ecommerce columns
      assert.ok(cells[0].content.includes('order_id'));
    });
  });
});
