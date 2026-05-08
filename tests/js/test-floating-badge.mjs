/**
 * Gate 2 — Integration tests for FloatingBadge state machine + DOM lifecycle.
 * @author Sentinel — EDOG Studio hivemind
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ── Enhanced DOM mock ───────────────────────────────────────────
// FloatingBadge._render() uses el.querySelector('.iw-badge-text') etc.
// We track children by className so querySelector can find them.

function createMockElement(tag) {
  var childMap = {};
  var childElements = [];
  var listeners = {};
  var el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    className: '',
    classList: {
      add: function(c) { el.className += ' ' + c; },
      remove: function(c) { el.className = el.className.replace(c, '').trim(); },
      contains: function(c) { return el.className.indexOf(c) !== -1; },
      toggle: function() {}
    },
    setAttribute: function(k, v) { el['_attr_' + k] = v; },
    getAttribute: function(k) { return el['_attr_' + k] || null; },
    appendChild: function(child) {
      childElements.push(child);
      if (child && child.className) {
        var classes = child.className.split(' ');
        for (var i = 0; i < classes.length; i++) {
          if (classes[i]) childMap[classes[i]] = child;
        }
      }
    },
    removeChild: function() {},
    addEventListener: function(evt, fn) {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },
    removeEventListener: function(evt, fn) {
      if (!listeners[evt]) return;
      var idx = listeners[evt].indexOf(fn);
      if (idx !== -1) listeners[evt].splice(idx, 1);
    },
    querySelector: function(sel) {
      // Recursive search for ".classname" selectors
      if (sel && sel.charAt(0) === '.') {
        var cls = sel.substring(1);
        if (childMap[cls]) return childMap[cls];
        // Search recursively through children
        for (var i = 0; i < childElements.length; i++) {
          if (childElements[i].querySelector) {
            var found = childElements[i].querySelector(sel);
            if (found) return found;
          }
        }
      }
      return null;
    },
    querySelectorAll: function() { return []; },
    innerHTML: '', textContent: '', hidden: false,
    dataset: {}, children: [], childElementCount: 0,
    parentNode: null,
    remove: function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    offsetWidth: 100,
    _floatingBadgeRef: null,
    _listeners: listeners,
    _childMap: childMap
  };
  return el;
}

function createBadgeContext() {
  var appendedChildren = [];
  var removedChildren = [];

  var mockBody = {
    appendChild: function(child) {
      appendedChildren.push(child);
      child.parentNode = mockBody;
    },
    removeChild: function(child) {
      removedChildren.push(child);
      child.parentNode = null;
    }
  };

  var existingBadge = null;

  var mockDocument = {
    createElement: function(tag) { return createMockElement(tag); },
    querySelector: function(sel) {
      if (sel === '.iw-badge') return existingBadge;
      return null;
    },
    body: mockBody
  };

  return {
    appendedChildren: appendedChildren,
    removedChildren: removedChildren,
    mockDocument: mockDocument,
    setExistingBadge: function(badge) { existingBadge = badge; }
  };
}

// ── Load source ─────────────────────────────────────────────────

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');
var badgeSrc = readFileSync(join(srcDir, 'wizard-floating-badge.js'), 'utf-8');

function loadBadge(docCtx) {
  var timers = [];
  var intervals = [];

  var ctx = vm.createContext({
    window: {},
    document: docCtx.mockDocument,
    console: console,
    setTimeout: function(fn, ms) {
      var id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    },
    setInterval: function(fn, ms) {
      var id = setInterval(fn, ms);
      intervals.push(id);
      return id;
    },
    clearTimeout: clearTimeout,
    clearInterval: clearInterval,
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
  });

  vm.runInContext(badgeSrc, ctx);
  return {
    FloatingBadge: ctx.window.FloatingBadge,
    timers: timers,
    intervals: intervals,
    cleanup: function() {
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
    }
  };
}

function normalize(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Tests: Constructor + Element creation ───────────────────────

describe('FloatingBadge — constructor + element creation', () => {

  test('constructor creates element with role=status', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    assert.equal(badge._el._attr_role, 'status');
    cleanup();
  });

  test('constructor sets aria-live=polite', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    assert.equal(badge._el['_attr_aria-live'], 'polite');
    cleanup();
  });

  test('constructor sets tabindex=0', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    assert.equal(badge._el._attr_tabindex, '0');
    cleanup();
  });

  test('initial state is hidden', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    assert.equal(badge._state, 'hidden');
    cleanup();
  });

  test('element has iw-badge class', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    assert.ok(badge._el.className.includes('iw-badge'));
    cleanup();
  });

  test('element stores _floatingBadgeRef back-reference', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    assert.equal(badge._el._floatingBadgeRef, badge);
    cleanup();
  });
});

// ── Tests: State transitions ────────────────────────────────────

describe('FloatingBadge — state transitions', () => {

  test('show() changes state to running', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Create workspace');
    assert.equal(badge._state, 'running');
    cleanup();
  });

  test('show() appends element to document.body', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Create workspace');
    assert.equal(docCtx.appendedChildren.length, 1);
    assert.equal(docCtx.appendedChildren[0], badge._el);
    cleanup();
  });

  test('show() renders correct text "Step N/6 — stepName"', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(2, 'Build tables');
    const textEl = badge._el.querySelector('.iw-badge-text');
    // stepIndex=2 → Step 3/6
    assert.ok(textEl);
    assert.equal(textEl.textContent, 'Step 3/6 \u2014 Build tables');
    cleanup();
  });

  test('updateStep() updates step display', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.updateStep(3, 'Deploy MLV');
    const textEl = badge._el.querySelector('.iw-badge-text');
    assert.equal(textEl.textContent, 'Step 4/6 \u2014 Deploy MLV');
    cleanup();
  });

  test('showCompleting() transitions to completing state', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showCompleting();
    assert.equal(badge._state, 'completing');
    const textEl = badge._el.querySelector('.iw-badge-text');
    assert.equal(textEl.textContent, 'Completing\u2026');
    cleanup();
  });

  test('showSuccess() transitions to success state', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showSuccess();
    assert.equal(badge._state, 'success');
    const textEl = badge._el.querySelector('.iw-badge-text');
    assert.ok(textEl.textContent.includes('Environment created'));
    cleanup();
  });

  test('showSuccess() starts auto-dismiss timer', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showSuccess();
    assert.notEqual(badge._dismissTimeout, null);
    cleanup();
  });

  test('showFailure() transitions to failure state', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(2, 'Deploy');
    badge.showFailure('Network timeout');
    assert.equal(badge._state, 'failure');
    const textEl = badge._el.querySelector('.iw-badge-text');
    assert.ok(textEl.textContent.includes('failed'));
    assert.ok(textEl.textContent.includes('Network timeout'));
    cleanup();
  });

  test('showFailure() does NOT start auto-dismiss', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showFailure('Error');
    assert.equal(badge._dismissTimeout, null);
    cleanup();
  });
});

// ── Tests: hide + destroy ───────────────────────────────────────

describe('FloatingBadge — hide + destroy', () => {

  test('hide() on non-attached element is a no-op', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    // Element not appended yet → parentNode is null
    badge.hide();
    assert.ok(badge._el); // Element still exists, not destroyed yet
    cleanup();
  });

  test('destroy() sets state to hidden', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.destroy();
    assert.equal(badge._state, 'hidden');
    cleanup();
  });

  test('destroy() nulls element reference', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.destroy();
    assert.equal(badge._el, null);
    cleanup();
  });

  test('destroy() removes element from DOM if attached', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    // After show(), element has parentNode set
    badge.destroy();
    assert.equal(badge._el, null);
    assert.equal(badge._state, 'hidden');
    cleanup();
  });

  test('destroy() is idempotent', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.destroy();
    badge.destroy(); // Should not throw
    assert.equal(badge._state, 'hidden');
    assert.equal(badge._el, null);
    cleanup();
  });

  test('destroy() clears auto-dismiss timer', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showSuccess();
    assert.notEqual(badge._dismissTimeout, null);
    badge.destroy();
    assert.equal(badge._dismissTimeout, null);
    cleanup();
  });
});

// ── Tests: Callbacks + keyboard ─────────────────────────────────

describe('FloatingBadge — callbacks + keyboard', () => {

  test('onRestore callback called on click', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    let restored = false;
    const badge = new FloatingBadge({ onRestore: function() { restored = true; } });
    // Simulate click via the bound handler
    badge._boundClick();
    assert.equal(restored, true);
    cleanup();
  });

  test('keyboard Enter triggers click handler', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    let restored = false;
    const badge = new FloatingBadge({ onRestore: function() { restored = true; } });
    badge._boundKeydown({ key: 'Enter', preventDefault: function() {} });
    assert.equal(restored, true);
    cleanup();
  });

  test('keyboard Space triggers click handler', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    let restored = false;
    const badge = new FloatingBadge({ onRestore: function() { restored = true; } });
    badge._boundKeydown({ key: ' ', preventDefault: function() {} });
    assert.equal(restored, true);
    cleanup();
  });

  test('other keys do not trigger click handler', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    let restored = false;
    const badge = new FloatingBadge({ onRestore: function() { restored = true; } });
    badge._boundKeydown({ key: 'Escape', preventDefault: function() {} });
    assert.equal(restored, false);
    cleanup();
  });
});

// ── Tests: Hover pauses auto-dismiss ────────────────────────────

describe('FloatingBadge — hover pauses auto-dismiss', () => {

  test('hover pauses auto-dismiss on success', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showSuccess();
    assert.notEqual(badge._dismissTimeout, null);
    // Simulate mouseenter
    badge._boundMouseEnter();
    assert.equal(badge._hovered, true);
    assert.equal(badge._dismissTimeout, null);
    cleanup();
  });

  test('mouse leave resumes auto-dismiss on success', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showSuccess();
    badge._boundMouseEnter();
    assert.equal(badge._dismissTimeout, null);
    badge._boundMouseLeave();
    assert.equal(badge._hovered, false);
    assert.notEqual(badge._dismissTimeout, null);
    cleanup();
  });

  test('hover during non-success state does not affect dismiss', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge._boundMouseEnter();
    assert.equal(badge._hovered, true);
    assert.equal(badge._dismissTimeout, null); // No dismiss timer in running state
    cleanup();
  });
});

// ── Tests: Singleton behavior ───────────────────────────────────

describe('FloatingBadge — singleton enforcement', () => {

  test('new badge destroys existing badge with _floatingBadgeRef', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge1 = new FloatingBadge({});

    // Simulate existing badge in DOM
    const existingEl = createMockElement();
    existingEl.className = 'iw-badge';
    existingEl._floatingBadgeRef = badge1;
    docCtx.setExistingBadge(existingEl);

    // Creating badge2 should destroy badge1 via its ref
    const badge2 = new FloatingBadge({});
    assert.equal(badge1._state, 'hidden');
    assert.equal(badge1._el, null);
    assert.ok(badge2._el); // badge2 is alive
    cleanup();
  });

  test('new badge removes orphan existing badge element', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);

    // Simulate orphan badge element (no ref)
    let removed = false;
    const orphanEl = createMockElement();
    orphanEl.className = 'iw-badge';
    orphanEl._floatingBadgeRef = null;
    orphanEl.remove = function() { removed = true; };
    docCtx.setExistingBadge(orphanEl);

    const badge = new FloatingBadge({});
    assert.equal(removed, true);
    assert.ok(badge._el);
    cleanup();
  });
});

// ── Tests: Progress rendering ───────────────────────────────────

describe('FloatingBadge — progress rendering', () => {

  test('running state shows progress bar', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(2, 'Create tables');
    const progressEl = badge._el.querySelector('.iw-badge-progress');
    // Progress should be visible (display not 'none')
    assert.notEqual(progressEl.style.display, 'none');
    cleanup();
  });

  test('success state hides progress bar', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showSuccess();
    const progressEl = badge._el.querySelector('.iw-badge-progress');
    assert.equal(progressEl.style.display, 'none');
    cleanup();
  });

  test('progress fill width reflects step progress', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(2, 'Create tables');
    const fillEl = badge._el.querySelector('.iw-badge-progress-fill');
    // Step 3/6 = 50%
    assert.equal(fillEl.style.width, '50%');
    cleanup();
  });

  test('completing state shows 100% progress', () => {
    const docCtx = createBadgeContext();
    const { FloatingBadge, cleanup } = loadBadge(docCtx);
    const badge = new FloatingBadge({});
    badge.show(0, 'Init');
    badge.showCompleting();
    const fillEl = badge._el.querySelector('.iw-badge-progress-fill');
    assert.equal(fillEl.style.width, '100%');
    cleanup();
  });
});
