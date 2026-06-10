/**
 * Unit tests for NotebookParser ipynb support.
 *
 * The Notebook IDE showed zero cells for wizard-created notebooks. Root cause:
 * the backend reader only picked up `notebook-content.sql`, while the wizard
 * stores ipynb JSON; and NotebookParser only understood Fabric's SQL-source
 * format. The holistic fix makes ipynb the canonical wire format: the reader
 * requests `?format=ipynb` (Fabric normalizes any stored notebook to canonical
 * ipynb), and NotebookParser learns to parse ipynb JSON and serialize back to it.
 *
 * Regression anchors:
 *   - parse() must turn ipynb cells into the SAME normalized shape the renderer
 *     consumes ({type, language, content, meta}) — the empty-IDE bug was a read
 *     that produced zero cells.
 *   - notebook-level metadata.dependencies.lakehouse is LOAD-BEARING: drop it on
 *     a save round-trip and every SQL/MLV cell fails with "lakehouse not found".
 *   - per-cell language lives at metadata['microsoft.fabric'].language (wizard)
 *     OR metadata.language (Fabric ipynb export) — both must resolve.
 *   - legacy SQL-source parse must still work (backward compat / safety net).
 *
 * NotebookParser is a top-level lexical binding vm does not auto-expose, so we
 * append a one-line export before evaluating (same trick as test-topbar-state).
 * @author Sentinel — EDOG Studio hivemind
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

function load() {
  var code = readFileSync(join(srcDir, 'notebook-parser.js'), 'utf-8');
  code += '\nglobalThis.__NotebookParser = NotebookParser;';
  var ctx = vm.createContext({ globalThis: {}, console: console, JSON: JSON });
  vm.runInContext(code, ctx);
  return ctx.globalThis.__NotebookParser;
}

var NotebookParser = load();

// A wizard-shaped ipynb: source as single-element array, language under the
// microsoft.fabric namespace, node identity in cell metadata, and a default
// lakehouse pinned at the notebook level.
function wizardIpynb() {
  return JSON.stringify({
    cells: [
      {
        cell_type: 'code',
        source: ['CREATE TABLE bronze AS SELECT * FROM raw'],
        metadata: {
          'microsoft.fabric': { language: 'sparksql' },
          node_id: 'n1',
          node_name: 'bronze',
        },
        outputs: [],
        execution_count: null,
      },
      {
        cell_type: 'code',
        source: ['df = spark.table("bronze")\n', 'df.show()'],
        metadata: {
          'microsoft.fabric': { language: 'pyspark' },
          node_id: 'n2',
          node_name: 'silver',
        },
        outputs: [],
        execution_count: null,
      },
    ],
    metadata: {
      kernel_info: { name: 'synapse_pyspark' },
      language_info: { name: 'python' },
      dependencies: {
        lakehouse: {
          default_lakehouse: 'lh-guid',
          default_lakehouse_name: 'MyLake',
          default_lakehouse_workspace_id: 'ws-guid',
          known_lakehouses: [{ id: 'lh-guid' }],
        },
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

test('parse: empty/invalid input yields no cells', () => {
  for (var raw of ['', null, undefined, 5]) {
    var r = NotebookParser.parse(raw);
    assert.equal(r.cells.length, 0);
    assert.equal(Object.keys(r.notebookMeta).length, 0);
  }
});

test('parse: ipynb code cells map to normalized {type,language,content}', () => {
  var r = NotebookParser.parse(wizardIpynb());
  assert.equal(r.cells.length, 2);
  assert.equal(r.cells[0].type, 'code');
  assert.equal(r.cells[0].language, 'sparksql');
  assert.equal(r.cells[0].content, 'CREATE TABLE bronze AS SELECT * FROM raw');
  assert.equal(r.cells[1].language, 'pyspark');
  // Multi-line source array (lines carrying their own \n) rejoins losslessly.
  assert.equal(r.cells[1].content, 'df = spark.table("bronze")\ndf.show()');
});

test('parse: ipynb markdown cell becomes a markdown cell', () => {
  var raw = JSON.stringify({
    cells: [{ cell_type: 'markdown', source: ['# Title\n', 'body'], metadata: {} }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  });
  var r = NotebookParser.parse(raw);
  assert.equal(r.cells[0].type, 'markdown');
  assert.equal(r.cells[0].language, 'markdown');
  assert.equal(r.cells[0].content, '# Title\nbody');
});

test('parse: notebook-level lakehouse dependency is preserved (load-bearing)', () => {
  var r = NotebookParser.parse(wizardIpynb());
  assert.equal(
    r.notebookMeta.dependencies.lakehouse.default_lakehouse, 'lh-guid');
});

test('parse: cell language falls back to metadata.language then language_info', () => {
  var raw = JSON.stringify({
    cells: [
      { cell_type: 'code', source: ['x'], metadata: { language: 'scala' } },
      { cell_type: 'code', source: ['y'], metadata: {} },
    ],
    metadata: { language_info: { name: 'sparksql' } },
    nbformat: 4, nbformat_minor: 5,
  });
  var r = NotebookParser.parse(raw);
  assert.equal(r.cells[0].language, 'scala');       // metadata.language
  assert.equal(r.cells[1].language, 'sparksql');    // language_info fallback
});

test('serialize: emits valid ipynb JSON with nbformat and cell array', () => {
  var nb = NotebookParser.parse(wizardIpynb());
  var out = NotebookParser.serialize(nb);
  var obj = JSON.parse(out);
  assert.equal(obj.nbformat, 4);
  assert.equal(obj.nbformat_minor, 5);
  assert.equal(obj.cells.length, 2);
  assert.equal(obj.cells[0].cell_type, 'code');
});

test('serialize: reflects edited cell.language into microsoft.fabric.language', () => {
  var nb = NotebookParser.parse(wizardIpynb());
  nb.cells[0].language = 'python';   // user changed the cell language
  var obj = JSON.parse(NotebookParser.serialize(nb));
  assert.equal(obj.cells[0].metadata['microsoft.fabric'].language, 'python');
});

test('serialize: preserves notebook-level lakehouse dependency', () => {
  var nb = NotebookParser.parse(wizardIpynb());
  var obj = JSON.parse(NotebookParser.serialize(nb));
  assert.equal(
    obj.metadata.dependencies.lakehouse.default_lakehouse, 'lh-guid');
});

test('round-trip: parse(serialize(parse(x))) is stable on cells', () => {
  var a = NotebookParser.parse(wizardIpynb());
  var b = NotebookParser.parse(NotebookParser.serialize(a));
  assert.deepEqual(b.cells, a.cells);
  assert.deepEqual(
    b.notebookMeta.dependencies, a.notebookMeta.dependencies);
});

test('backward-compat: legacy SQL-source still parses into cells', () => {
  var sql = [
    '-- Fabric notebook source',
    '',
    '-- CELL ********************',
    'SELECT 1',
    '',
    '-- MARKDOWN ********************',
    '-- # Heading',
  ].join('\n');
  var r = NotebookParser.parse(sql);
  assert.ok(r.cells.length >= 2);
  assert.equal(r.cells[0].type, 'code');
  assert.equal(r.cells[0].content, 'SELECT 1');
  assert.equal(r.cells[1].type, 'markdown');
});

test('parse: non-ipynb JSON-ish text does not throw and is treated as source', () => {
  // A string that starts with "{" but is not a notebook must not crash the IDE.
  var r = NotebookParser.parse('{ not valid json');
  assert.ok(Array.isArray(r.cells));
});
