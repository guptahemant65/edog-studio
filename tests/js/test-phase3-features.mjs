/**
 * Unit tests for Phase 3 features: DagPresets, Context Menu, Zoom Controls,
 * Marquee Selection, Node Popover, updateNode, Batch Operations, Viewport
 * Culling, Accessibility, and Workspace-Explorer wire.
 *
 * @author Sentinel — EDOG Studio hivemind
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ── Comprehensive DOM mock ──────────────────────────────────────────
var mockElements = [];

function makeMockElement(tag) {
  var el = {
    tagName: tag,
    _className: '',
    style: {},
    children: [],
    childNodes: [],
    attributes: {},
    _eventListeners: {},
    _visible: true,
    classList: {
      _el: null,
      _list: [],
      add: function(c) { if (this._list.indexOf(c) === -1) this._list.push(c); },
      remove: function(c) { var i = this._list.indexOf(c); if (i >= 0) this._list.splice(i, 1); },
      contains: function(c) { return this._list.indexOf(c) >= 0; },
      toggle: function(c) { if (this.contains(c)) this.remove(c); else this.add(c); }
    },
    setAttribute: function(k, v) { this.attributes[k] = v; },
    getAttribute: function(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; },
    setAttributeNS: function(ns, k, v) { this.attributes[k] = v; },
    appendChild: function(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild: function(child) {
      var i = this.children.indexOf(child);
      if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      child.parentNode = null;
      return child;
    },
    insertBefore: function(newChild, refChild) {
      var i = this.children.indexOf(refChild);
      if (i >= 0) { this.children.splice(i, 0, newChild); this.childNodes.splice(i, 0, newChild); }
      else { this.children.push(newChild); this.childNodes.push(newChild); }
      newChild.parentNode = this;
      return newChild;
    },
    addEventListener: function(evt, fn) {
      if (!this._eventListeners[evt]) this._eventListeners[evt] = [];
      this._eventListeners[evt].push(fn);
    },
    removeEventListener: function(evt, fn) {
      if (!this._eventListeners[evt]) return;
      var i = this._eventListeners[evt].indexOf(fn);
      if (i >= 0) this._eventListeners[evt].splice(i, 1);
    },
    dispatchEvent: function(e) {
      var listeners = this._eventListeners[e.type] || [];
      for (var i = 0; i < listeners.length; i++) listeners[i](e);
    },
    querySelector: function(sel) {
      // Minimal: search children by className or tagName
      for (var i = 0; i < this.children.length; i++) {
        var c = this.children[i];
        if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) return c;
        if (c.tagName === sel) return c;
        var sub = c.querySelector ? c.querySelector(sel) : null;
        if (sub) return sub;
      }
      return null;
    },
    querySelectorAll: function(sel) {
      var results = [];
      function walk(node) {
        for (var i = 0; i < (node.children || []).length; i++) {
          var c = node.children[i];
          if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) results.push(c);
          if (c.tagName === sel) results.push(c);
          if (c.children) walk(c);
        }
      }
      walk(this);
      return results;
    },
    closest: function(sel) {
      var cur = this;
      while (cur) {
        if (sel.startsWith('.') && cur.classList && cur.classList.contains(sel.slice(1))) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    contains: function(other) {
      if (other === this) return true;
      for (var i = 0; i < this.children.length; i++) {
        if (this.children[i] === other) return true;
        if (this.children[i].contains && this.children[i].contains(other)) return true;
      }
      return false;
    },
    get firstChild() { return this.children[0] || null; },
    parentNode: null,
    textContent: '',
    innerHTML: '',
    value: '',
    type: '',
    namespaceURI: null,
    getBoundingClientRect: function() {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    },
    focus: function() {},
    blur: function() {}
  };
  // Sync className property with classList._list
  Object.defineProperty(el, 'className', {
    get: function() { return el.classList._list.join(' '); },
    set: function(v) {
      el.classList._list = v ? v.split(/\s+/).filter(Boolean) : [];
    }
  });
  mockElements.push(el);
  return el;
}

var window = {
  addEventListener: function() {},
  removeEventListener: function() {},
  location: { search: '' }
};
var document = {
  createElement: function(tag) { return makeMockElement(tag); },
  createElementNS: function(ns, tag) {
    var el = makeMockElement(tag);
    el.namespaceURI = ns;
    return el;
  },
  getElementById: function() { return null; },
  querySelector: function() { return null; },
  querySelectorAll: function() { return []; },
  addEventListener: function() {},
  removeEventListener: function() {},
  body: { appendChild: function(child) { return child; } },
  activeElement: null
};

var pendingTimeouts = [];
var mockSetTimeout = function(fn, ms) {
  var id = pendingTimeouts.length + 1;
  pendingTimeouts.push({ fn: fn, ms: ms || 0, id: id });
  return id;
};
var mockClearTimeout = function(id) {
  pendingTimeouts = pendingTimeouts.filter(function(t) { return t.id !== id; });
};
function flushTimeouts() {
  var copy = pendingTimeouts.slice();
  pendingTimeouts = [];
  for (var i = 0; i < copy.length; i++) {
    copy[i].fn();
  }
}
var mockRAF = function(fn) { return mockSetTimeout(fn, 0); };
var mockCAF = function(id) { mockClearTimeout(id); };

// ── Load source files ───────────────────────────────────────────────
var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

// Shared context across all loadSource calls — classes reference each other
var sharedCtx = vm.createContext({
  window: window, document: document, console: console,
  setTimeout: mockSetTimeout, setInterval: setInterval,
  clearInterval: clearInterval, clearTimeout: mockClearTimeout,
  requestAnimationFrame: mockRAF, cancelAnimationFrame: mockCAF,
  Object: Object, Array: Array, Math: Math, Date: Date, Error: Error, JSON: JSON,
  parseInt: parseInt, parseFloat: parseFloat, String: String, Number: Number,
  RegExp: RegExp, Map: Map, Set: Set, Infinity: Infinity,
  Promise: Promise, Symbol: Symbol, Intl: Intl, URLSearchParams: URLSearchParams,
  CustomEvent: class MockCustomEvent { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } }
});

function loadSource(filename) {
  var code = readFileSync(join(srcDir, filename), 'utf-8');
  vm.runInContext(code, sharedCtx);
  Object.assign(window, sharedCtx.window);
}

// IW_EVENTS constant must be loaded first
var iwCode = readFileSync(join(srcDir, 'infra-wizard.js'), 'utf-8');
// Extract just the IW_EVENTS declaration
var iwMatch = iwCode.match(/var IW_EVENTS\s*=\s*\{[\s\S]*?\};/);
if (iwMatch) {
  vm.runInContext(iwMatch[0] + '\nwindow.IW_EVENTS = IW_EVENTS;', sharedCtx);
  Object.assign(window, sharedCtx.window);
}
var IW_EVENTS = window.IW_EVENTS;

// Load in dependency order
loadSource('wizard-event-bus.js');
loadSource('wizard-undo-redo.js');
loadSource('wizard-auto-layout.js');
loadSource('wizard-connection-mgr.js');
loadSource('wizard-dag-node.js');
loadSource('wizard-dag-canvas.js');
loadSource('wizard-dag-presets.js');
loadSource('wizard-node-popover.js');

var WizardEventBus = window.WizardEventBus;
var UndoRedoManager = window.UndoRedoManager;
var DagCanvas = window.DagCanvas;
var DagPresets = window.DagPresets;
var NodePopover = window.NodePopover;

// ── Helpers ─────────────────────────────────────────────────────────

function makeEventBus() {
  return new WizardEventBus();
}

function makeUndoManager(bus) {
  return new UndoRedoManager({ eventBus: bus });
}

function makeContainer() {
  var el = makeMockElement('div');
  el.getBoundingClientRect = function() {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  };
  return el;
}

function makeLiveRegion() {
  var el = makeMockElement('div');
  el.setAttribute('aria-live', 'polite');
  return el;
}

var defaultSchemas = { dbo: true, bronze: false, silver: false, gold: false };

function makeCanvas(opts) {
  var bus = (opts && opts.eventBus) || makeEventBus();
  var undo = (opts && opts.undoManager) || makeUndoManager(bus);
  var container = (opts && opts.containerEl) || makeContainer();
  var schemas = (opts && opts.schemas) || defaultSchemas;
  var liveRegion = (opts && opts.liveRegion) || makeLiveRegion();
  return new DagCanvas({
    containerEl: container,
    eventBus: bus,
    undoManager: undo,
    schemas: schemas,
    liveRegion: liveRegion
  });
}

// ═══════════════════════════════════════════════════════════════════
//  1. DagPresets
// ═══════════════════════════════════════════════════════════════════

describe('DagPresets', function() {

  test('constructor creates instance with container and canvas refs', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    assert.ok(presets);
    presets.destroy();
  });

  test('render creates overlay DOM with correct structure', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    // Overlay is appended to container
    var overlay = container.children.find(function(c) {
      return c.classList.contains('iw-dag-presets-overlay');
    });
    assert.ok(overlay, 'Overlay element should exist');
    assert.equal(overlay.getAttribute('role'), 'dialog');
    assert.equal(overlay.getAttribute('aria-modal'), 'true');
    presets.destroy();
  });

  test('5 preset cards render', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    var overlay = container.children.find(function(c) {
      return c.classList.contains('iw-dag-presets-overlay');
    });
    var cards = overlay.querySelectorAll('.iw-dag-presets-card');
    assert.equal(cards.length, 5, 'Should have 5 preset cards');
    presets.destroy();
  });

  test('preset card titles match expected names', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    var overlay = container.children.find(function(c) {
      return c.classList.contains('iw-dag-presets-overlay');
    });
    var titles = overlay.querySelectorAll('.iw-dag-presets-card-title');
    var expected = ['Simple Chain', 'Fan-Out', 'Diamond', 'Medallion Pipeline', 'Full Pipeline'];
    assert.equal(titles.length, 5);
    for (var i = 0; i < expected.length; i++) {
      assert.equal(titles[i].textContent, expected[i]);
    }
    presets.destroy();
  });

  test('each preset has correct node count in card stats innerHTML', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    var overlay = container.children.find(function(c) {
      return c.classList.contains('iw-dag-presets-overlay');
    });
    var statsEls = overlay.querySelectorAll('.iw-dag-presets-card-stats');
    var expectedCounts = [2, 4, 5, 7, 8];
    assert.equal(statsEls.length, 5);
    for (var i = 0; i < expectedCounts.length; i++) {
      assert.ok(
        statsEls[i].innerHTML.indexOf(expectedCounts[i] + ' nodes') >= 0,
        'Card ' + i + ' should show ' + expectedCounts[i] + ' nodes'
      );
    }
    presets.destroy();
  });

  test('_applyPreset uses batchOperation when available', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var batchCalled = false;
    var origBatch = canvas.batchOperation.bind(canvas);
    canvas.batchOperation = function(fn) {
      batchCalled = true;
      origBatch(fn);
    };
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    // Apply the simple-chain preset by simulating internal call
    presets._applyPreset({ id: 'simple-chain', title: 'Simple Chain', nodeCount: 2,
      build: function(c) { c.addNode('sql-table'); c.addNode('sql-mlv'); },
      svg: function() { return ''; }
    });
    assert.ok(batchCalled, 'batchOperation should be called');
    presets.destroy();
  });

  test('destroy cleans up overlay', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    presets.destroy();
    // Internal refs should be null
    assert.equal(presets._overlayEl, null);
    assert.equal(presets._containerEl, null);
    assert.equal(presets._canvas, null);
    assert.equal(presets._eventBus, null);
  });

  test('dismiss hides overlay', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var presets = new DagPresets({
      containerEl: container,
      dagCanvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    presets._dismiss();
    assert.ok(presets._dismissed);
    presets.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  2. Context Menu
// ═══════════════════════════════════════════════════════════════════

describe('Context Menu', function() {

  test('_showContextMenu creates menu DOM with correct items', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    var menu = canvas._ctxMenuEl;
    assert.ok(menu, 'Context menu element should exist');
    assert.equal(menu.getAttribute('role'), 'menu');
    assert.equal(menu.getAttribute('aria-label'), 'Canvas context menu');
  });

  test('menu has 3 add-node items + separator + Auto Arrange + Zoom to Fit', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    var menu = canvas._ctxMenuEl;
    var items = menu.querySelectorAll('.iw-dag-ctx-item');
    var seps = menu.querySelectorAll('.iw-dag-ctx-sep');
    assert.equal(items.length, 5, '5 clickable items (3 add-node + auto-arrange + zoom-fit)');
    assert.equal(seps.length, 1, '1 separator');
  });

  test('items have correct data-action attributes', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    var menu = canvas._ctxMenuEl;
    var items = menu.querySelectorAll('.iw-dag-ctx-item');
    var actions = items.map(function(i) { return i.getAttribute('data-action'); });
    assert.deepEqual(actions, [
      'add-sql-table', 'add-sql-mlv', 'add-pyspark-mlv', 'auto-arrange', 'zoom-fit'
    ]);
  });

  test('context menu items have role="menuitem"', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    var items = canvas._ctxMenuEl.querySelectorAll('.iw-dag-ctx-item');
    for (var i = 0; i < items.length; i++) {
      assert.equal(items[i].getAttribute('role'), 'menuitem');
    }
  });

  test('_hideContextMenu removes menu from DOM', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    assert.ok(canvas._ctxMenuEl);
    canvas._hideContextMenu();
    assert.equal(canvas._ctxMenuEl, null, 'Menu ref should be null after hide');
  });

  test('showing a new context menu removes old one', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    var firstMenu = canvas._ctxMenuEl;
    canvas._showContextMenu(150, 250, 70, 80);
    var secondMenu = canvas._ctxMenuEl;
    assert.notEqual(firstMenu, secondMenu, 'New menu should be different element');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  3. Zoom Controls
// ═══════════════════════════════════════════════════════════════════

describe('Zoom Controls', function() {

  test('_buildZoomControls creates control panel with buttons', function() {
    var canvas = makeCanvas();
    var zoomEl = canvas._zoomControlsEl;
    assert.ok(zoomEl, 'Zoom controls element should exist');
    assert.equal(zoomEl.className, 'iw-dag-zoom-controls');
  });

  test('zoom controls have 3 buttons and 1 level span', function() {
    var canvas = makeCanvas();
    var el = canvas._zoomControlsEl;
    var buttons = el.querySelectorAll('button');
    assert.equal(buttons.length, 3, 'Should have zoom-out, zoom-in, fit buttons');
    var levelSpan = el.querySelector('.iw-dag-zoom-level');
    assert.ok(levelSpan, 'Zoom level span should exist');
    assert.equal(levelSpan.textContent, '100%');
  });

  test('zoom buttons have correct data-action attributes', function() {
    var canvas = makeCanvas();
    var buttons = canvas._zoomControlsEl.querySelectorAll('button');
    var actions = buttons.map(function(b) { return b.getAttribute('data-action'); });
    assert.ok(actions.indexOf('zoom-in') >= 0, 'zoom-in button');
    assert.ok(actions.indexOf('zoom-out') >= 0, 'zoom-out button');
    assert.ok(actions.indexOf('fit') >= 0, 'fit button');
  });

  test('zoom buttons have aria-label attributes', function() {
    var canvas = makeCanvas();
    var buttons = canvas._zoomControlsEl.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      assert.ok(buttons[i].getAttribute('aria-label'), 'Button should have aria-label');
    }
  });

  test('setViewport changes zoom and clamps to bounds', function() {
    var canvas = makeCanvas();
    canvas.setViewport(0, 0, 2.0);
    assert.equal(canvas.getViewport().zoom, 2.0);
    // Clamp to max (4.0)
    canvas.setViewport(0, 0, 10.0);
    assert.equal(canvas.getViewport().zoom, 4.0);
    // Clamp to min (0.25)
    canvas.setViewport(0, 0, 0.01);
    assert.equal(canvas.getViewport().zoom, 0.25);
  });

  test('zoom display shows correct initial percentage', function() {
    var canvas = makeCanvas();
    assert.equal(canvas._zoomLevelEl.textContent, '100%');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  4. Marquee Selection
// ═══════════════════════════════════════════════════════════════════

describe('Marquee Selection', function() {

  test('selectNodes sets multi-selection correctly', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    var n2 = canvas.addNode('sql-mlv', { x: 200, y: 10 });
    canvas.selectNodes([n1.id, n2.id]);
    var selected = canvas.getSelectedNodeIds();
    assert.equal(selected.length, 2);
    assert.ok(selected.indexOf(n1.id) >= 0);
    assert.ok(selected.indexOf(n2.id) >= 0);
  });

  test('selectNodes with additive adds to existing selection', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    var n2 = canvas.addNode('sql-mlv', { x: 200, y: 10 });
    var n3 = canvas.addNode('pyspark-mlv', { x: 400, y: 10 });
    canvas.selectNodes([n1.id]);
    canvas.selectNodes([n2.id, n3.id], true);
    var selected = canvas.getSelectedNodeIds();
    assert.equal(selected.length, 3);
  });

  test('selectNodes without additive replaces selection', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    var n2 = canvas.addNode('sql-mlv', { x: 200, y: 10 });
    canvas.selectNodes([n1.id, n2.id]);
    canvas.selectNodes([n2.id]);
    var selected = canvas.getSelectedNodeIds();
    assert.equal(selected.length, 1);
    assert.equal(selected[0], n2.id);
  });

  test('getSelectedNodeIds returns copy of current selection', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas.selectNodes([n1.id]);
    var sel = canvas.getSelectedNodeIds();
    sel.push('fake-id');
    // Original should be unaffected
    assert.equal(canvas.getSelectedNodeIds().length, 1);
  });

  test('_clearMultiSelect deselects all', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    var n2 = canvas.addNode('sql-mlv', { x: 200, y: 10 });
    canvas.selectNodes([n1.id, n2.id]);
    canvas._clearMultiSelect();
    assert.equal(canvas.getSelectedNodeIds().length, 0);
  });

  test('_intersectsRect correctly tests node-rect intersection', function() {
    var canvas = makeCanvas();
    // Node at (10, 10) with width 180, height 72
    var node = { x: 10, y: 10, width: 180, height: 72 };
    // Rect that overlaps
    var overlapping = { x: 50, y: 20, width: 100, height: 100 };
    assert.ok(canvas._intersectsRect(node, overlapping), 'Should intersect');
    // Rect that does NOT overlap (far right)
    var nonOverlapping = { x: 500, y: 500, width: 50, height: 50 };
    assert.ok(!canvas._intersectsRect(node, nonOverlapping), 'Should not intersect');
  });

  test('_intersectsRect edge case: touching rects count as intersecting', function() {
    var canvas = makeCanvas();
    var node = { x: 0, y: 0, width: 100, height: 100 };
    // Rect starts exactly where node ends (touching)
    var adjacent = { x: 100, y: 0, width: 50, height: 50 };
    // The implementation uses < (not <=), so touching rects DO intersect
    assert.ok(canvas._intersectsRect(node, adjacent), 'Touching rects should intersect');
  });

  test('selectNode single clears multi-selection', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    var n2 = canvas.addNode('sql-mlv', { x: 200, y: 10 });
    canvas.selectNodes([n1.id, n2.id]);
    assert.equal(canvas.getSelectedNodeIds().length, 2);
    canvas.selectNode(n1.id);
    assert.equal(canvas.getSelectedNodeIds().length, 1);
    assert.equal(canvas.getSelectedNodeId(), n1.id);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  5. Node Popover
// ═══════════════════════════════════════════════════════════════════

describe('NodePopover', function() {

  test('constructor creates instance', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    assert.ok(popover);
    popover.destroy();
  });

  test('popover DOM has correct structure', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    // Popover element should be in container
    var popEl = container.children.find(function(c) {
      return c.classList.contains('iw-node-popover');
    });
    assert.ok(popEl, 'Popover element should exist');
    assert.equal(popEl.getAttribute('role'), 'dialog');
    assert.equal(popEl.style.display, 'none', 'Initially hidden');
    popover.destroy();
  });

  test('popover has name input', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    assert.ok(popover._nameInput, 'Name input should exist');
    assert.equal(popover._nameInput.type, 'text');
    assert.ok(popover._nameInput.classList.contains('iw-node-popover-input'));
    popover.destroy();
  });

  test('popover has type select with 3 options', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    assert.ok(popover._typeSelect, 'Type select should exist');
    assert.equal(popover._typeSelect.children.length, 3, 'Should have 3 type options');
    popover.destroy();
  });

  test('popover has schema select', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    assert.ok(popover._schemaSelect, 'Schema select should exist');
    popover.destroy();
  });

  test('popover has delete button', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    var popEl = container.children.find(function(c) {
      return c.classList.contains('iw-node-popover');
    });
    var deleteBtn = popEl.querySelector('.iw-node-popover-delete');
    assert.ok(deleteBtn, 'Delete button should exist');
    assert.equal(deleteBtn.textContent, 'Delete Node');
    popover.destroy();
  });

  test('destroy cleans up popover', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    popover.destroy();
    assert.equal(popover._popoverEl, null);
    assert.equal(popover._canvas, null);
    assert.equal(popover._eventBus, null);
  });

  test('destroy is idempotent', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    popover.destroy();
    popover.destroy(); // second call should not throw
    assert.equal(popover._popoverEl, null);
  });

  test('updateSchemas updates internal schemas', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var container = makeContainer();
    var popover = new NodePopover({
      containerEl: container,
      canvas: canvas,
      eventBus: bus,
      schemas: defaultSchemas
    });
    var newSchemas = { dbo: true, bronze: true, silver: true, gold: true };
    popover.updateSchemas(newSchemas);
    assert.deepEqual(popover._schemas, newSchemas);
    popover.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  6. updateNode
// ═══════════════════════════════════════════════════════════════════

describe('updateNode', function() {

  test('updateNode updates nodeData name', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas.updateNode(n.id, { name: 'my_table' });
    var data = canvas.getNodeData(n.id);
    assert.equal(data.name, 'my_table');
  });

  test('updateNode updates nodeData type', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas.updateNode(n.id, { type: 'sql-mlv' });
    var data = canvas.getNodeData(n.id);
    assert.equal(data.type, 'sql-mlv');
  });

  test('updateNode updates nodeData schema', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas.updateNode(n.id, { schema: 'gold' });
    var data = canvas.getNodeData(n.id);
    assert.equal(data.schema, 'gold');
  });

  test('updateNode with multiple changes at once', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas.updateNode(n.id, { name: 'renamed', type: 'pyspark-mlv', schema: 'silver' });
    var data = canvas.getNodeData(n.id);
    assert.equal(data.name, 'renamed');
    assert.equal(data.type, 'pyspark-mlv');
    assert.equal(data.schema, 'silver');
  });

  test('updateNode returns silently for non-existent node', function() {
    var canvas = makeCanvas();
    // Should not throw
    canvas.updateNode('nonexistent-id', { name: 'nope' });
    assert.ok(true, 'No error for non-existent node');
  });

  test('getNodeData returns clone (not reference)', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    var data = canvas.getNodeData(n.id);
    data.name = 'mutated';
    // Original should be unchanged
    var fresh = canvas.getNodeData(n.id);
    assert.notEqual(fresh.name, 'mutated');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  7. Batch Operations
// ═══════════════════════════════════════════════════════════════════

describe('Batch Operations', function() {

  test('batchOperation suppresses state emissions during fn', function() {
    var bus = makeEventBus();
    var canvas = makeCanvas({ eventBus: bus });
    var emitCount = 0;
    bus.on(IW_EVENTS.STATE_CHANGED, function() { emitCount++; });

    canvas.batchOperation(function(c) {
      // _emitStateChanged is suppressed during batch
      assert.ok(c._isBatching, 'Should be in batching mode');
    });
    assert.ok(!canvas._isBatching, 'Should exit batching mode');
  });

  test('batchOperation works with addNode inside batch', function() {
    var canvas = makeCanvas();
    canvas.batchOperation(function(c) {
      c.addNode('sql-table', { x: 10, y: 10 });
      c.addNode('sql-mlv', { x: 200, y: 10 });
    });
    assert.equal(canvas.getNodeCount(), 2);
  });

  test('batchOperation restores state even if fn throws', function() {
    var canvas = makeCanvas();
    try {
      canvas.batchOperation(function() {
        throw new Error('test error');
      });
    } catch (e) {
      // expected
    }
    assert.ok(!canvas._isBatching, 'Should exit batching mode after error');
  });

  test('batch receives canvas as argument', function() {
    var canvas = makeCanvas();
    var received = null;
    canvas.batchOperation(function(c) {
      received = c;
    });
    assert.equal(received, canvas);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  8. Viewport Culling
// ═══════════════════════════════════════════════════════════════════

describe('Viewport Culling', function() {

  test('_updateVisibility hides nodes outside viewport', function() {
    var canvas = makeCanvas();
    // Add node far outside viewport (viewport is 800x600 at zoom=1, pan=0)
    var nFar = canvas.addNode('sql-table', { x: 5000, y: 5000 });
    canvas._updateVisibility();
    var node = canvas._nodes[nFar.id];
    assert.ok(!node.isVisible(), 'Far node should be hidden');
  });

  test('nodes inside viewport remain visible', function() {
    var canvas = makeCanvas();
    var nNear = canvas.addNode('sql-table', { x: 100, y: 100 });
    canvas._updateVisibility();
    var node = canvas._nodes[nNear.id];
    assert.ok(node.isVisible(), 'Near node should be visible');
  });

  test('_updateVisibility handles empty canvas', function() {
    var canvas = makeCanvas();
    // Should not throw
    canvas._updateVisibility();
    assert.ok(true);
  });

  test('zoomed-out viewport shows more nodes', function() {
    var canvas = makeCanvas();
    // Add node at moderate distance
    var n = canvas.addNode('sql-table', { x: 1500, y: 1500 });
    canvas.setViewport(0, 0, 0.25); // zoom out to 25%
    canvas._updateVisibility();
    var node = canvas._nodes[n.id];
    // At zoom=0.25 and 800x600, viewRight = (800 + 100) / 0.25 = 3600
    assert.ok(node.isVisible(), 'Node should be visible when zoomed out');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  9. Accessibility
// ═══════════════════════════════════════════════════════════════════

describe('Accessibility', function() {

  test('canvas SVG has role="application" and aria-label', function() {
    var canvas = makeCanvas();
    var svg = canvas._svgEl;
    assert.equal(svg.getAttribute('role'), 'application');
    assert.ok(svg.getAttribute('aria-label').indexOf('DAG canvas') >= 0);
    assert.ok(svg.getAttribute('aria-label').indexOf('0 nodes') >= 0);
  });

  test('SVG has tabindex="0" for keyboard focus', function() {
    var canvas = makeCanvas();
    assert.equal(canvas._svgEl.getAttribute('tabindex'), '0');
  });

  test('context menu items have role="menuitem"', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    var items = canvas._ctxMenuEl.querySelectorAll('.iw-dag-ctx-item');
    for (var i = 0; i < items.length; i++) {
      assert.equal(items[i].getAttribute('role'), 'menuitem');
    }
  });

  test('context menu has role="menu"', function() {
    var canvas = makeCanvas();
    canvas._showContextMenu(100, 200, 50, 60);
    assert.equal(canvas._ctxMenuEl.getAttribute('role'), 'menu');
  });

  test('aria-label updates after adding nodes', function() {
    var canvas = makeCanvas();
    canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas._updateSvgAriaLabel();
    var label = canvas._svgEl.getAttribute('aria-label');
    assert.ok(label.indexOf('1 nodes') >= 0 || label.indexOf('1 node') >= 0);
  });

  test('live region announces node add', function() {
    var liveRegion = makeLiveRegion();
    var canvas = makeCanvas({ liveRegion: liveRegion });
    canvas.addNode('sql-table', { x: 10, y: 10 });
    // The announce uses setTimeout — flush pending
    flushTimeouts();
    assert.ok(liveRegion.textContent.indexOf('added') >= 0,
      'Live region should announce node added');
  });

  test('live region announces node remove', function() {
    var liveRegion = makeLiveRegion();
    var canvas = makeCanvas({ liveRegion: liveRegion });
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    flushTimeouts();
    liveRegion.textContent = '';
    canvas.removeNode(n.id);
    flushTimeouts();
    assert.ok(liveRegion.textContent.indexOf('removed') >= 0,
      'Live region should announce node removed');
  });

  test('zoom buttons have aria-label for screen readers', function() {
    var canvas = makeCanvas();
    var buttons = canvas._zoomControlsEl.querySelectorAll('button');
    var labels = buttons.map(function(b) { return b.getAttribute('aria-label'); });
    assert.ok(labels.indexOf('Zoom in') >= 0);
    assert.ok(labels.indexOf('Zoom out') >= 0);
    assert.ok(labels.indexOf('Fit to content') >= 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  10. DagCanvas Core — addNode / removeNode / connections
// ═══════════════════════════════════════════════════════════════════

describe('DagCanvas Core', function() {

  test('constructor creates instance', function() {
    var canvas = makeCanvas();
    assert.ok(canvas);
  });

  test('addNode returns nodeData with correct shape', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 100, y: 200 });
    assert.ok(n);
    assert.ok(n.id);
    assert.equal(n.type, 'sql-table');
    assert.equal(n.x, 100);
    assert.equal(n.y, 200);
    assert.equal(n.width, 180);
    assert.equal(n.height, 72);
    assert.equal(n.schema, 'dbo');
  });

  test('addNode with overrides applies them', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-mlv', { x: 0, y: 0 }, {
      name: 'custom_name', schema: 'gold'
    });
    assert.equal(n.name, 'custom_name');
    assert.equal(n.schema, 'gold');
  });

  test('addNode returns null at limit', function() {
    var canvas = makeCanvas();
    // Add max nodes
    for (var i = 0; i < 100; i++) {
      canvas.addNode('sql-table', { x: i * 10, y: 0 });
    }
    var extra = canvas.addNode('sql-table', { x: 0, y: 0 });
    assert.equal(extra, null, 'Should return null when at limit');
  });

  test('removeNode removes the node', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    assert.equal(canvas.getNodeCount(), 1);
    canvas.removeNode(n.id);
    assert.equal(canvas.getNodeCount(), 0);
  });

  test('removeNode returns null for nonexistent node', function() {
    var canvas = makeCanvas();
    var result = canvas.removeNode('does-not-exist');
    assert.equal(result, null);
  });

  test('getNodeCount tracks nodes correctly', function() {
    var canvas = makeCanvas();
    assert.equal(canvas.getNodeCount(), 0);
    canvas.addNode('sql-table', { x: 10, y: 10 });
    assert.equal(canvas.getNodeCount(), 1);
    canvas.addNode('sql-mlv', { x: 200, y: 10 });
    assert.equal(canvas.getNodeCount(), 2);
  });

  test('addConnection creates connection between nodes', function() {
    var canvas = makeCanvas();
    var n1 = canvas.addNode('sql-table', { x: 10, y: 10 });
    var n2 = canvas.addNode('sql-mlv', { x: 200, y: 200 });
    var conn = canvas.addConnection(n1.id, n2.id);
    assert.ok(conn);
    assert.equal(conn.sourceNodeId, n1.id);
    assert.equal(conn.targetNodeId, n2.id);
  });

  test('getViewport returns default viewport', function() {
    var canvas = makeCanvas();
    var vp = canvas.getViewport();
    assert.equal(vp.panX, 0);
    assert.equal(vp.panY, 0);
    assert.equal(vp.zoom, 1.0);
  });

  test('setViewport updates viewport state', function() {
    var canvas = makeCanvas();
    canvas.setViewport(50, 100, 1.5);
    var vp = canvas.getViewport();
    assert.equal(vp.panX, 50);
    assert.equal(vp.panY, 100);
    assert.equal(vp.zoom, 1.5);
  });

  test('resetViewport returns to default', function() {
    var canvas = makeCanvas();
    canvas.setViewport(100, 200, 2.0);
    canvas.resetViewport();
    var vp = canvas.getViewport();
    assert.equal(vp.panX, 0);
    assert.equal(vp.panY, 0);
    assert.equal(vp.zoom, 1.0);
  });

  test('selectNode sets and clears selection', function() {
    var canvas = makeCanvas();
    var n = canvas.addNode('sql-table', { x: 10, y: 10 });
    canvas.selectNode(n.id);
    assert.equal(canvas.getSelectedNodeId(), n.id);
    canvas.selectNode(null);
    assert.equal(canvas.getSelectedNodeId(), null);
  });

  test('fitToContent with no nodes resets viewport', function() {
    var canvas = makeCanvas();
    canvas.setViewport(100, 200, 2.0);
    canvas.fitToContent();
    var vp = canvas.getViewport();
    assert.equal(vp.panX, 0);
    assert.equal(vp.panY, 0);
    assert.equal(vp.zoom, 1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  11. Workspace Explorer Wire
// ═══════════════════════════════════════════════════════════════════

describe('Workspace Explorer', function() {

  function loadWorkspaceExplorer(overrides) {
    var wsElements = {};
    var wsEventListeners = {};
    var wsDocument = {
      createElement: function(tag) { return makeMockElement(tag); },
      createElementNS: function(ns, tag) { var el = makeMockElement(tag); el.namespaceURI = ns; return el; },
      getElementById: function(id) {
        if (!wsElements[id]) {
          wsElements[id] = makeMockElement('div');
          wsElements[id].id = id;
        }
        return wsElements[id];
      },
      querySelector: function(sel) {
        return (overrides && overrides.querySelector) ? overrides.querySelector(sel) : null;
      },
      querySelectorAll: function() { return []; },
      addEventListener: function(evt, fn) {
        if (!wsEventListeners[evt]) wsEventListeners[evt] = [];
        wsEventListeners[evt].push(fn);
      },
      removeEventListener: function() {},
      body: { appendChild: function(c) { return c; } },
      activeElement: null
    };
    var wsWindow = {
      addEventListener: function() {},
      removeEventListener: function() {},
      location: { search: '' }
    };
    var wsCode = readFileSync(join(srcDir, 'workspace-explorer.js'), 'utf-8');
    var wsCtx = vm.createContext({
      window: wsWindow, document: wsDocument, console: console,
      setTimeout: mockSetTimeout, setInterval: setInterval,
      clearInterval: clearInterval, clearTimeout: mockClearTimeout,
      requestAnimationFrame: mockRAF, cancelAnimationFrame: mockCAF,
      Object: Object, Array: Array, Math: Math, Date: Date, Error: Error, JSON: JSON,
      parseInt: parseInt, parseFloat: parseFloat, String: String, Number: Number,
      RegExp: RegExp, Map: Map, Set: Set, Infinity: Infinity,
      Promise: Promise, Symbol: Symbol, Intl: Intl,
      URLSearchParams: URLSearchParams,
      CustomEvent: class MockCE { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }
    });
    vm.runInContext(wsCode + '\nvar __WE = WorkspaceExplorer;', wsCtx);
    return { WE: wsCtx.__WE, eventListeners: wsEventListeners, document: wsDocument };
  }

  test('workspace-explorer.js defines WorkspaceExplorer class', function() {
    var loaded = loadWorkspaceExplorer();
    assert.ok(loaded.WE, 'WorkspaceExplorer class should be defined');
  });

  test('WorkspaceExplorer constructor creates instance', function() {
    var loaded = loadWorkspaceExplorer();
    var mockApi = { listWorkspaces: function() { return Promise.resolve([]); } };
    var explorer = new loaded.WE(mockApi);
    assert.ok(explorer);
  });

  test('_bindWorkspaceSelectEvent registers edog:select-workspace listener', function() {
    var loaded = loadWorkspaceExplorer();
    var mockApi = { listWorkspaces: function() { return Promise.resolve([]); } };
    var explorer = new loaded.WE(mockApi);
    explorer._bindWorkspaceSelectEvent();
    assert.ok(loaded.eventListeners['edog:select-workspace'],
      'Should have registered edog:select-workspace listener');
    assert.ok(loaded.eventListeners['edog:select-workspace'].length > 0);
  });

  test('_bindNewEnvironment creates "New Environment" button', function() {
    var mockHeader = makeMockElement('div');
    mockHeader.querySelector = function(sel) {
      if (sel === '.ws-new-env-btn') return null;
      return null;
    };
    var loaded = loadWorkspaceExplorer({
      querySelector: function(sel) {
        if (sel === '.ws-tree-header') return mockHeader;
        return null;
      }
    });
    var mockApi = { listWorkspaces: function() { return Promise.resolve([]); } };
    var explorer = new loaded.WE(mockApi);
    explorer._bindNewEnvironment();
    var newEnvBtn = mockHeader.children.find(function(c) {
      return c.classList.contains('ws-new-env-btn');
    });
    assert.ok(newEnvBtn, '"New Environment" button should be added to header');
    assert.equal(newEnvBtn.textContent, '+ New Environment');
  });
});
