/**
 * Unit tests for ExecutionPipeline — pure logic only.
 * State machine, URL building, elapsed formatting, request bodies.
 *
 * @agent Sentinel — EDOG Studio hivemind
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

var srcDir = join(import.meta.dirname, '..', '..', 'src', 'frontend', 'js');

/* ═══════════════════════════════════════════════════════════════════
   TEST HARNESS
   ═══════════════════════════════════════════════════════════════════ */

function createMockElement() {
  return {
    style: {},
    classList: {
      add: function () {},
      remove: function () {},
      contains: function () { return false; },
      toggle: function () {}
    },
    setAttribute: function () {},
    getAttribute: function () { return null; },
    appendChild: function () {},
    removeChild: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function () { return createMockElement(); },
    querySelectorAll: function () { return []; },
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    children: [],
    childElementCount: 0,
    parentNode: { removeChild: function () {} }
  };
}

function createContext() {
  var mockWindow = {};
  var mockFetch = function () {
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({}); },
      text: function () { return Promise.resolve(''); },
      headers: { get: function () { return null; } }
    });
  };

  var mockDocument = {
    createElement: function (tag) {
      var el = createMockElement();
      el.tagName = tag;
      return el;
    },
    createElementNS: function (_ns, tag) {
      var el = createMockElement();
      el.tagName = tag;
      return el;
    },
    querySelector: function () { return null; },
    body: { appendChild: function () {}, removeChild: function () {} }
  };

  var ctx = vm.createContext({
    window: mockWindow,
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
    String: String,
    Number: Number,
    Promise: Promise,
    fetch: mockFetch,
    AbortController: AbortController,
    Map: Map,
    Set: Set,
    encodeURIComponent: encodeURIComponent
  });

  // Load EventBus first (dependency)
  var ebCode = readFileSync(join(srcDir, 'wizard-event-bus.js'), 'utf-8');
  vm.runInContext(ebCode, ctx);

  // Load ExecutionPipeline
  var code = readFileSync(join(srcDir, 'wizard-execution.js'), 'utf-8');
  vm.runInContext(code, ctx);

  return ctx.window;
}

function makePipeline(globals) {
  var bus = new globals.WizardEventBus();
  return new globals.ExecutionPipeline({ eventBus: bus });
}

// vm-created objects have different prototypes; normalize for deepEqual
function normalize(obj) {
  return JSON.parse(JSON.stringify(obj));
}


/* ═══════════════════════════════════════════════════════════════════
   TESTS
   ═══════════════════════════════════════════════════════════════════ */

describe('ExecutionPipeline', function () {
  var globals;
  var pipeline;

  beforeEach(function () {
    globals = createContext();
    pipeline = makePipeline(globals);
  });


  /* ─── Initialization ─────────────────────────────────────────── */

  describe('initialization', function () {

    test('constructor creates element', function () {
      assert.ok(pipeline.getElement() != null, 'getElement() should return a truthy element');
    });

    test('_createInitialState() returns correct shape', function () {
      var s = pipeline._createInitialState();
      assert.equal(typeof s.status, 'string');
      assert.ok(Array.isArray(s.steps));
      assert.equal(typeof s.artifacts, 'object');
      assert.equal(typeof s.timing, 'object');
      assert.equal(typeof s.rollbackManifest, 'object');
      assert.equal(s.activeStepIndex, null);
    });

    test('initial status is idle', function () {
      var s = pipeline._createInitialState();
      assert.equal(s.status, 'idle');
    });

    test('initial steps has 6 entries', function () {
      var s = pipeline._createInitialState();
      assert.equal(s.steps.length, 6);
    });

    test('all steps start as pending', function () {
      var s = pipeline._createInitialState();
      for (var i = 0; i < s.steps.length; i++) {
        assert.equal(s.steps[i].status, 'pending', 'step ' + i + ' should be pending');
      }
    });

    test('artifacts start as all null', function () {
      var s = pipeline._createInitialState();
      var a = s.artifacts;
      assert.equal(a.workspaceId, null);
      assert.equal(a.capacityId, null);
      assert.equal(a.lakehouseId, null);
      assert.equal(a.notebookId, null);
      assert.equal(a.jobInstanceId, null);
      assert.equal(a.notebookRunStatus, null);
      assert.equal(a.workspaceUrl, null);
    });
  });


  /* ─── PIPELINE_STEPS constants ───────────────────────────────── */

  describe('PIPELINE_STEPS constants', function () {

    test('has exactly 6 steps', function () {
      var s = pipeline._createInitialState();
      assert.equal(s.steps.length, 6);
    });

    test('step IDs match expected sequence', function () {
      var expected = [
        'create-workspace', 'assign-capacity', 'create-lakehouse',
        'create-notebook', 'write-cells', 'execute-notebook'
      ];
      var s = pipeline._createInitialState();
      for (var i = 0; i < expected.length; i++) {
        assert.equal(s.steps[i].id, expected[i], 'step ' + i + ' id mismatch');
      }
    });

    test('step names match expected sequence', function () {
      var expected = [
        'Create Workspace', 'Assign Capacity', 'Create Lakehouse',
        'Create Notebook', 'Write Notebook Cells', 'Run Notebook'
      ];
      var s = pipeline._createInitialState();
      for (var i = 0; i < expected.length; i++) {
        assert.equal(s.steps[i].name, expected[i], 'step ' + i + ' name mismatch');
      }
    });

    test('each step has correct timing shape', function () {
      var s = pipeline._createInitialState();
      for (var i = 0; i < s.steps.length; i++) {
        var t = s.steps[i].timing;
        assert.equal(t.startedAt, null);
        assert.equal(t.completedAt, null);
        assert.equal(t.elapsedMs, 0);
      }
    });
  });


  /* ─── _formatElapsed ─────────────────────────────────────────── */

  describe('_formatElapsed', function () {

    test('0ms returns "0.0s"', function () {
      assert.equal(pipeline._formatElapsed(0), '0.0s');
    });

    test('500ms returns "0.5s"', function () {
      assert.equal(pipeline._formatElapsed(500), '0.5s');
    });

    test('3200ms returns "3.2s"', function () {
      assert.equal(pipeline._formatElapsed(3200), '3.2s');
    });

    test('59900ms returns "59.9s"', function () {
      assert.equal(pipeline._formatElapsed(59900), '59.9s');
    });

    test('60000ms returns "1m 00s"', function () {
      assert.equal(pipeline._formatElapsed(60000), '1m 00s');
    });

    test('64000ms returns "1m 04s"', function () {
      assert.equal(pipeline._formatElapsed(64000), '1m 04s');
    });

    test('125000ms returns "2m 05s"', function () {
      assert.equal(pipeline._formatElapsed(125000), '2m 05s');
    });

    test('null returns "0.0s"', function () {
      assert.equal(pipeline._formatElapsed(null), '0.0s');
    });

    test('negative returns "0.0s"', function () {
      assert.equal(pipeline._formatElapsed(-100), '0.0s');
    });
  });


  /* ─── _buildRequestUrl ───────────────────────────────────────── */

  describe('_buildRequestUrl', function () {

    // Helper: get step definitions via vm context
    function getStepDefs() {
      return vm.runInContext('PIPELINE_STEPS', globals.__ctx || createStepCtx());
    }

    // We re-read the steps from a fresh context to get the raw PIPELINE_STEPS array
    var stepDefs;
    beforeEach(function () {
      var freshCtx = vm.createContext({
        window: {}, document: createMockDoc(), console: console,
        setTimeout: setTimeout, setInterval: setInterval,
        clearInterval: clearInterval, clearTimeout: clearTimeout,
        Object: Object, Array: Array, Math: Math, Date: Date,
        Error: Error, JSON: JSON, parseInt: parseInt, parseFloat: parseFloat,
        String: String, Number: Number, Promise: Promise,
        fetch: function () { return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(''); }, headers: { get: function () { return null; } } }); },
        AbortController: AbortController, Map: Map, Set: Set,
        encodeURIComponent: encodeURIComponent
      });
      var ebCode = readFileSync(join(srcDir, 'wizard-event-bus.js'), 'utf-8');
      vm.runInContext(ebCode, freshCtx);
      var code = readFileSync(join(srcDir, 'wizard-execution.js'), 'utf-8');
      vm.runInContext(code, freshCtx);
      stepDefs = vm.runInContext('PIPELINE_STEPS', freshCtx);
    });

    function createMockDoc() {
      return {
        createElement: function () { return createMockElement(); },
        createElementNS: function () { return createMockElement(); },
        querySelector: function () { return null; },
        body: { appendChild: function () {}, removeChild: function () {} }
      };
    }

    test('step 0 URL has no interpolation needed', function () {
      var artifacts = { workspaceId: null, notebookId: null, jobInstanceId: null };
      var url = pipeline._buildRequestUrl(stepDefs[0], artifacts);
      assert.equal(url, '/api/fabric/v1/workspaces');
    });

    test('step 1 URL interpolates workspaceId', function () {
      var artifacts = { workspaceId: 'ws-123', notebookId: null, jobInstanceId: null };
      var url = pipeline._buildRequestUrl(stepDefs[1], artifacts);
      assert.equal(url, '/api/fabric/v1/workspaces/ws-123/assignToCapacity');
    });

    test('step 4 URL interpolates workspaceId and notebookId', function () {
      var artifacts = { workspaceId: 'ws-123', notebookId: 'nb-456', jobInstanceId: null };
      var url = pipeline._buildRequestUrl(stepDefs[4], artifacts);
      assert.equal(url, '/api/fabric/v1/workspaces/ws-123/notebooks/nb-456/content');
    });

    test('step 5 URL interpolates workspaceId and notebookId', function () {
      var artifacts = { workspaceId: 'ws-123', notebookId: 'nb-456', jobInstanceId: null };
      var url = pipeline._buildRequestUrl(stepDefs[5], artifacts);
      assert.equal(url, '/api/fabric/v1/workspaces/ws-123/notebooks/nb-456/jobs/instances?jobType=RunNotebook');
    });

    test('missing artifact leaves placeholder in URL', function () {
      var artifacts = { workspaceId: null, notebookId: null, jobInstanceId: null };
      var url = pipeline._buildRequestUrl(stepDefs[4], artifacts);
      assert.ok(url.indexOf('{workspaceId}') !== -1, 'should contain unreplaced {workspaceId}');
      assert.ok(url.indexOf('{notebookId}') !== -1, 'should contain unreplaced {notebookId}');
    });

    test('special characters in artifact are URI-encoded', function () {
      var artifacts = { workspaceId: 'ws/special&id', notebookId: null, jobInstanceId: null };
      var url = pipeline._buildRequestUrl(stepDefs[1], artifacts);
      assert.ok(url.indexOf('ws/special&id') === -1, 'should not contain raw special chars');
      assert.ok(url.indexOf(encodeURIComponent('ws/special&id')) !== -1, 'should contain encoded value');
    });
  });


  /* ─── _buildRequestBody ──────────────────────────────────────── */

  describe('_buildRequestBody', function () {

    var stepDefs;
    beforeEach(function () {
      var freshCtx = vm.createContext({
        window: {}, document: {
          createElement: function () { return createMockElement(); },
          createElementNS: function () { return createMockElement(); },
          querySelector: function () { return null; },
          body: { appendChild: function () {}, removeChild: function () {} }
        }, console: console,
        setTimeout: setTimeout, setInterval: setInterval,
        clearInterval: clearInterval, clearTimeout: clearTimeout,
        Object: Object, Array: Array, Math: Math, Date: Date,
        Error: Error, JSON: JSON, parseInt: parseInt, parseFloat: parseFloat,
        String: String, Number: Number, Promise: Promise,
        fetch: function () { return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(''); }, headers: { get: function () { return null; } } }); },
        AbortController: AbortController, Map: Map, Set: Set,
        encodeURIComponent: encodeURIComponent
      });
      var ebCode = readFileSync(join(srcDir, 'wizard-event-bus.js'), 'utf-8');
      vm.runInContext(ebCode, freshCtx);
      var code = readFileSync(join(srcDir, 'wizard-execution.js'), 'utf-8');
      vm.runInContext(code, freshCtx);
      stepDefs = vm.runInContext('PIPELINE_STEPS', freshCtx);
    });

    test('step 0 body has displayName from context (workspace)', function () {
      var ctx = { workspaceName: 'my-ws' };
      var body = pipeline._buildRequestBody(stepDefs[0], ctx, {});
      assert.deepEqual(normalize(body), { displayName: 'my-ws' });
    });

    test('step 1 body has capacityId from context', function () {
      var ctx = { capacityId: 'cap-abc' };
      var body = pipeline._buildRequestBody(stepDefs[1], ctx, {});
      assert.deepEqual(normalize(body), { capacityId: 'cap-abc' });
    });

    test('step 2 body has displayName and enableSchemas for lakehouse', function () {
      var ctx = { lakehouseName: 'my-lh' };
      var body = pipeline._buildRequestBody(stepDefs[2], ctx, {});
      assert.deepEqual(normalize(body), { displayName: 'my-lh', enableSchemas: true });
    });

    test('step 3 body has displayName for notebook', function () {
      var ctx = { notebookName: 'my-nb' };
      var body = pipeline._buildRequestBody(stepDefs[3], ctx, {});
      assert.deepEqual(normalize(body), { displayName: 'my-nb' });
    });

    test('step 4 body uses notebookPayload if provided', function () {
      var payload = { cells: [{ code: 'print(1)' }] };
      var ctx = { notebookPayload: payload };
      var body = pipeline._buildRequestBody(stepDefs[4], ctx, {});
      assert.deepEqual(body, payload);
    });

    test('step 4 body falls back to empty object when no payload', function () {
      var ctx = {};
      var body = pipeline._buildRequestBody(stepDefs[4], ctx, {});
      assert.deepEqual(normalize(body), {});
    });

    test('step 5 body is empty object', function () {
      var ctx = {};
      var body = pipeline._buildRequestBody(stepDefs[5], ctx, {});
      assert.deepEqual(normalize(body), {});
    });
  });


  /* ─── State machine ──────────────────────────────────────────── */

  describe('state machine', function () {

    test('initial state status is idle', function () {
      var s = pipeline._createInitialState();
      assert.equal(s.status, 'idle');
    });

    test('activate() resets state and starts pipeline', function () {
      // activate() calls _startPipeline which sets status to executing
      var wizardState = {
        naming: { workspaceName: 'ws', lakehouseName: 'lh', notebookName: 'nb' },
        capacity: { capacityId: 'cap-1' }
      };
      pipeline.activate(wizardState);
      // After activate, status should be 'executing' (set synchronously before async work)
      assert.equal(pipeline._state.status, 'executing');
    });

    test('validate() returns { valid: true }', function () {
      assert.deepEqual(normalize(pipeline.validate()), { valid: true });
    });

    test('collectState() writes execution state', function () {
      var state = {};
      pipeline.collectState(state);
      assert.ok(state.execution != null, 'should have execution key');
      assert.equal(state.execution.status, 'idle');
      assert.ok(state.execution.artifacts != null);
      assert.ok(state.execution.timing != null);
    });

    test('getElement() returns the root element', function () {
      var el = pipeline.getElement();
      assert.ok(el != null);
    });

    test('destroy() nulls out element and eventBus', function () {
      pipeline.destroy();
      assert.equal(pipeline._el, null);
      assert.equal(pipeline._eventBus, null);
      assert.equal(pipeline._destroyed, true);
    });

    test('activate() after destroy is a no-op', function () {
      pipeline.destroy();
      pipeline.activate({});
      // Should not throw; status stays from destroyed state
      assert.equal(pipeline._destroyed, true);
    });

    test('rollbackManifest starts empty', function () {
      var s = pipeline._createInitialState();
      assert.deepEqual(normalize(s.rollbackManifest.resources), []);
      assert.equal(s.rollbackManifest.rollbackAttempted, false);
    });
  });
});
