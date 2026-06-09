/**
 * Unit tests for Import-from-Lakehouse code capture + node-type detection.
 * Guards two regressions:
 *   1. getLatestDag node-type detection (tableType + kind), which previously
 *      mislabeled every MLV as a source table.
 *   2. SQL viewText ref-rewriting + source-ref normalization (code capture).
 * @author Donna — EDOG Studio hivemind
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

// Load a source file into a fresh vm context and return the context so that
// module-level (non-window) helper functions are reachable for unit testing.
function loadContext(filename) {
  var code = readFileSync(join(srcDir, filename), 'utf-8');
  var win = {};
  var doc = {
    createElement: function () { return { style: {}, classList: { add: function(){}, remove: function(){} }, setAttribute: function(){}, appendChild: function(){}, addEventListener: function(){}, innerHTML: '' }; },
    createElementNS: function () { return { style: {}, classList: { add: function(){}, remove: function(){} }, setAttribute: function(){}, setAttributeNS: function(){}, appendChild: function(){}, addEventListener: function(){} }; },
    querySelector: function () { return null; },
    body: { appendChild: function(){} }
  };
  var ctx = vm.createContext({
    window: win, document: doc, console: console,
    setTimeout: setTimeout, setInterval: setInterval, clearInterval: clearInterval, clearTimeout: clearTimeout,
    Object: Object, Array: Array, Math: Math, Date: Date, Error: Error, JSON: JSON,
    parseInt: parseInt, parseFloat: parseFloat, String: String, Number: Number, Boolean: Boolean,
    RegExp: RegExp, Map: Map, Set: Set, Symbol: Symbol, Promise: Promise,
    Reflect: Reflect, Proxy: typeof Proxy !== 'undefined' ? Proxy : undefined
  });
  vm.runInContext(code, ctx);
  return ctx;
}

var il = loadContext('wizard-import-lakehouse.js');

describe('_ilMapNodeType (getLatestDag type detection)', function () {
  test('materialized_lake_view + sql -> sql-mlv', function () {
    assert.equal(il._ilMapNodeType({ tableType: 'materialized_lake_view', kind: 'sql' }), 'sql-mlv');
  });
  test('materialized_lake_view + pyspark -> pyspark-mlv', function () {
    assert.equal(il._ilMapNodeType({ tableType: 'materialized_lake_view', kind: 'pyspark' }), 'pyspark-mlv');
  });
  test('managed -> sql-table', function () {
    assert.equal(il._ilMapNodeType({ tableType: 'managed', kind: '' }), 'sql-table');
  });
  test('empty node -> sql-table (no false MLV)', function () {
    assert.equal(il._ilMapNodeType({}), 'sql-table');
  });
  test('legacy single-string contract still honored', function () {
    assert.equal(il._ilMapNodeType({ type: 'SqlMaterializedView' }), 'sql-mlv');
    assert.equal(il._ilMapNodeType({ type: 'PySparkMaterializedView' }), 'pyspark-mlv');
  });
});

describe('_ilRewriteSourceRefs (SQL ref rewrite)', function () {
  var imported = [
    { schema: 'dbo', name: 'numtennew' },
    { schema: 'dbo', name: 'mv_numten2' }
  ];
  test('case-normalizes a qualified ref to the imported node', function () {
    assert.equal(
      il._ilRewriteSourceRefs('SELECT number FROM dbo.numTennew', imported),
      'SELECT number FROM dbo.numtennew');
  });
  test('does NOT rewrite a bare identifier (column safety)', function () {
    assert.equal(
      il._ilRewriteSourceRefs('SELECT numtennew FROM x.y', imported),
      'SELECT numtennew FROM x.y');
  });
  test('rewrites schema drift to the canonical schema', function () {
    assert.equal(
      il._ilRewriteSourceRefs('SELECT * FROM bronze.numtennew', imported),
      'SELECT * FROM dbo.numtennew');
  });
  test('leaves an unmatched ref verbatim', function () {
    assert.equal(
      il._ilRewriteSourceRefs('SELECT * FROM other.unknown_tbl', imported),
      'SELECT * FROM other.unknown_tbl');
  });
  test('handles bracketed identifiers', function () {
    assert.equal(
      il._ilRewriteSourceRefs('SELECT * FROM [dbo].[numTennew]', imported),
      'SELECT * FROM dbo.numtennew');
  });
  test('returns input unchanged with empty imported list', function () {
    assert.equal(il._ilRewriteSourceRefs('SELECT * FROM dbo.t', []), 'SELECT * FROM dbo.t');
  });
});

describe('_ilNormalizeSourceRefs', function () {
  test('normalizes FLT sourceEntities and flags cross-lakehouse', function () {
    var src = [{ namespace: { schemaName: 'dbo', artifactName: 'OtherLH' }, tableName: 'Orders' }];
    var out = il._ilNormalizeSourceRefs(src, 'RobinLH');
    assert.equal(out.length, 1);
    assert.equal(out[0].schema, 'dbo');
    assert.equal(out[0].table, 'orders');
    assert.equal(out[0].crossLakehouse, true);
  });
  test('same lakehouse is not flagged cross', function () {
    var src = [{ namespace: { schemaName: 'dbo', artifactName: 'RobinLH' }, tableName: 'numtennew' }];
    var out = il._ilNormalizeSourceRefs(src, 'RobinLH');
    assert.equal(out[0].crossLakehouse, false);
  });
});

describe('code-gen emits imported viewText verbatim', function () {
  var cg = loadContext('wizard-code-gen.js');
  var CodeGenerationEngine = cg.window.CodeGenerationEngine;

  test('sql-mlv with viewText reproduces the captured SELECT', function () {
    var eng = new CodeGenerationEngine();
    var nodes = [
      { id: 'a', type: 'sql-table', name: 'numtennew', schema: 'dbo', config: {} },
      { id: 'b', type: 'sql-mlv', name: 'mv_numten2', schema: 'dbo', config: {},
        viewText: 'SELECT number FROM dbo.numtennew' }
    ];
    var conns = [{ id: 1, sourceNodeId: 'a', targetNodeId: 'b' }];
    var cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    var mlvCell = cells.filter(function (c) { return c.nodeId === 'b'; })[0];
    assert.ok(mlvCell, 'expected a cell for the MLV node');
    assert.ok(mlvCell.content.indexOf('SELECT number FROM dbo.numtennew') !== -1,
      'imported SELECT must appear verbatim');
    assert.ok(mlvCell.content.indexOf('(imported)') !== -1,
      'imported cell should be marked imported');
  });

  test('sql-mlv without viewText falls back to template (regression)', function () {
    var eng = new CodeGenerationEngine();
    var nodes = [
      { id: 'a', type: 'sql-table', name: 'src', schema: 'bronze', config: {} },
      { id: 'b', type: 'sql-mlv', name: 'view_b', schema: 'silver', config: {} }
    ];
    var conns = [{ id: 1, sourceNodeId: 'a', targetNodeId: 'b' }];
    var cells = eng.generateCells(nodes, conns, 'ecommerce', {});
    var mlvCell = cells.filter(function (c) { return c.nodeId === 'b'; })[0];
    assert.ok(mlvCell.content.indexOf('CREATE MATERIALIZED LAKE VIEW') !== -1);
    assert.ok(mlvCell.content.indexOf('(imported)') === -1);
  });
});
