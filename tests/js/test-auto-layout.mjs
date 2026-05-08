/**
 * Unit tests for AutoLayoutEngine (wizard-auto-layout.js).
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
    RegExp: RegExp, Map: Map, Set: Set, Infinity: Infinity
  });
  vm.runInContext(code, ctx);
  Object.assign(window, ctx.window);
}

loadSource('wizard-auto-layout.js');

var AutoLayoutEngine = window.AutoLayoutEngine;

// ── Layout constants (mirror source for assertions) ─────────────────
var NODE_WIDTH = 180;
var NODE_HEIGHT = 72;
var H_GAP = 60;
var V_GAP = 80;
var PADDING = 40;

// ── Helpers ─────────────────────────────────────────────────────────

function makeNode(id) {
  return { id: id };
}

function makeConn(id, src, tgt) {
  return { id: id, sourceNodeId: src, targetNodeId: tgt };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('AutoLayoutEngine', function () {

  test('constructor creates instance', function () {
    var eng = new AutoLayoutEngine();
    assert.ok(eng);
  });

  // ── layout() ──────────────────────────────────────────────────────
  describe('layout()', function () {
    test('returns positions for all nodes', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3)];
      var conns = [makeConn(1, 1, 2), makeConn(2, 2, 3)];
      var result = eng.layout(nodes, conns);
      assert.ok(result.positions);
      assert.equal(Object.keys(result.positions).length, 3);
    });

    test('linear chain: nodes arranged top-to-bottom by rank', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3)];
      var conns = [makeConn(1, 1, 2), makeConn(2, 2, 3)];
      var result = eng.layout(nodes, conns);
      var p = result.positions;
      // rank 0 < rank 1 < rank 2 → y values increase
      assert.ok(p[1].y < p[2].y);
      assert.ok(p[2].y < p[3].y);
    });

    test('diamond graph: correct rank assignment', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3), makeNode(4)];
      var conns = [
        makeConn(1, 1, 2), makeConn(2, 1, 3),
        makeConn(3, 2, 4), makeConn(4, 3, 4)
      ];
      var result = eng.layout(nodes, conns);
      var p = result.positions;
      // node 1 top, 2 & 3 same rank, 4 bottom
      assert.ok(p[1].y < p[2].y);
      assert.ok(p[1].y < p[3].y);
      assert.equal(p[2].y, p[3].y);
      assert.ok(p[4].y > p[2].y);
    });

    test('single node: positioned at padding origin', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1)];
      var result = eng.layout(nodes, []);
      assert.equal(result.positions[1].x, PADDING);
      assert.equal(result.positions[1].y, PADDING);
    });

    test('empty nodes: returns empty positions', function () {
      var eng = new AutoLayoutEngine();
      var result = eng.layout([], []);
      assert.equal(Object.keys(result.positions).length, 0);
      assert.equal(result.viewport.panX, 0);
      assert.equal(result.viewport.panY, 0);
      assert.equal(result.viewport.zoom, 1.0);
    });

    test('null/undefined nodes: returns empty positions', function () {
      var eng = new AutoLayoutEngine();
      var result = eng.layout(null, null);
      assert.equal(Object.keys(result.positions).length, 0);
    });

    test('disconnected subgraphs: all positioned without overlap', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3), makeNode(4)];
      // Two separate chains: 1->2, 3->4
      var conns = [makeConn(1, 1, 2), makeConn(2, 3, 4)];
      var result = eng.layout(nodes, conns);
      assert.equal(Object.keys(result.positions).length, 4);

      // No two nodes should have the same (x, y)
      var seen = {};
      var ids = Object.keys(result.positions);
      for (var i = 0; i < ids.length; i++) {
        var pos = result.positions[ids[i]];
        var key = pos.x + ',' + pos.y;
        assert.ok(!seen[key], 'Positions should not overlap: ' + key);
        seen[key] = true;
      }
    });

    test('wide graph: parallel nodes at same rank have different x', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3)];
      // 1->2 and 1->3 (2 and 3 at same rank)
      var conns = [makeConn(1, 1, 2), makeConn(2, 1, 3)];
      var result = eng.layout(nodes, conns);
      assert.notEqual(result.positions[2].x, result.positions[3].x);
    });
  });

  // ── Rank assignment ───────────────────────────────────────────────
  describe('rank assignment', function () {
    test('source nodes (no incoming edges) get rank 0 position', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2)];
      var conns = [makeConn(1, 1, 2)];
      var result = eng.layout(nodes, conns);
      // Rank 0 y = PADDING
      assert.equal(result.positions[1].y, PADDING);
    });

    test('node rank = max(parent ranks) + 1 — reflected in y position', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3)];
      var conns = [makeConn(1, 1, 2), makeConn(2, 2, 3)];
      var result = eng.layout(nodes, conns);
      // rank 0 → y = PADDING
      // rank 1 → y = PADDING + 1 * (NODE_HEIGHT + V_GAP)
      // rank 2 → y = PADDING + 2 * (NODE_HEIGHT + V_GAP)
      var expectedY0 = PADDING;
      var expectedY1 = PADDING + (NODE_HEIGHT + V_GAP);
      var expectedY2 = PADDING + 2 * (NODE_HEIGHT + V_GAP);
      assert.equal(result.positions[1].y, expectedY0);
      assert.equal(result.positions[2].y, expectedY1);
      assert.equal(result.positions[3].y, expectedY2);
    });

    test('linear chain ranks: 0, 1, 2 via y positions', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      var conns = [makeConn(1, 'a', 'b'), makeConn(2, 'b', 'c')];
      var result = eng.layout(nodes, conns);
      var p = result.positions;
      // Each rank separated by (NODE_HEIGHT + V_GAP) = 152
      var step = NODE_HEIGHT + V_GAP;
      assert.equal(p['b'].y - p['a'].y, step);
      assert.equal(p['c'].y - p['b'].y, step);
    });
  });

  // ── Positioning ───────────────────────────────────────────────────
  describe('positioning', function () {
    test('nodes at same rank are spaced horizontally', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2), makeNode(3)];
      var conns = [makeConn(1, 1, 2), makeConn(2, 1, 3)];
      var result = eng.layout(nodes, conns);
      // Nodes 2 and 3 are at the same rank
      assert.equal(result.positions[2].y, result.positions[3].y);
      var xDiff = Math.abs(result.positions[2].x - result.positions[3].x);
      assert.equal(xDiff, NODE_WIDTH + H_GAP);
    });

    test('nodes at different ranks are spaced vertically', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2)];
      var conns = [makeConn(1, 1, 2)];
      var result = eng.layout(nodes, conns);
      var yDiff = result.positions[2].y - result.positions[1].y;
      assert.equal(yDiff, NODE_HEIGHT + V_GAP);
    });

    test('no node positions overlap', function () {
      var eng = new AutoLayoutEngine();
      // Build a larger graph: 1->3, 1->4, 2->4, 2->5
      var nodes = [makeNode(1), makeNode(2), makeNode(3), makeNode(4), makeNode(5)];
      var conns = [
        makeConn(1, 1, 3), makeConn(2, 1, 4),
        makeConn(3, 2, 4), makeConn(4, 2, 5)
      ];
      var result = eng.layout(nodes, conns);
      var ids = Object.keys(result.positions);
      // Check bounding-box non-overlap for all pairs
      for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
          var a = result.positions[ids[i]];
          var b = result.positions[ids[j]];
          var xOverlap = a.x < b.x + NODE_WIDTH && a.x + NODE_WIDTH > b.x;
          var yOverlap = a.y < b.y + NODE_HEIGHT && a.y + NODE_HEIGHT > b.y;
          assert.ok(!(xOverlap && yOverlap),
            'Nodes ' + ids[i] + ' and ' + ids[j] + ' overlap');
        }
      }
    });
  });

  // ── Options / viewport ────────────────────────────────────────────
  describe('viewport and fitToViewport', function () {
    test('layout returns viewport object', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2)];
      var conns = [makeConn(1, 1, 2)];
      var result = eng.layout(nodes, conns);
      assert.ok(result.viewport);
      assert.equal(typeof result.viewport.panX, 'number');
      assert.equal(typeof result.viewport.panY, 'number');
      assert.equal(typeof result.viewport.zoom, 'number');
    });

    test('fitToViewport returns valid viewport for given positions', function () {
      var eng = new AutoLayoutEngine();
      var nodes = [makeNode(1), makeNode(2)];
      var conns = [makeConn(1, 1, 2)];
      var result = eng.layout(nodes, conns);
      var vp = eng.fitToViewport(result.positions, 800, 600);
      assert.equal(typeof vp.panX, 'number');
      assert.equal(typeof vp.panY, 'number');
      assert.ok(vp.zoom > 0);
    });

    test('fitToViewport with empty positions returns defaults', function () {
      var eng = new AutoLayoutEngine();
      var vp = eng.fitToViewport({}, 800, 600);
      assert.equal(vp.panX, 0);
      assert.equal(vp.panY, 0);
      assert.equal(vp.zoom, 1.0);
    });
  });
});
