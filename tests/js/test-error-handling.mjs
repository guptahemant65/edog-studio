/**
 * Gate 4 — ERROR HANDLING tests for ExecutionPipeline.
 *
 * "If it can fail, it will fail. The question is whether the user gets
 *  a helpful message or a blank screen."
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
    parentNode: { removeChild: function () {} },
    tagName: 'div',
    remove: function () {}
  };
}

/**
 * Build a fresh VM context with configurable fetch behaviour.
 * @param {Function} [fetchImpl] — custom fetch; defaults to 200 OK + JSON {id:'mock-id'}
 * @returns {{window: Object, fetchCalls: Array}}
 */
function createContext(fetchImpl) {
  var fetchCalls = [];

  var defaultFetch = function (url, opts) {
    fetchCalls.push({ url: url, opts: opts });
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ id: 'mock-id' }); },
      text: function () { return Promise.resolve('{"id":"mock-id"}'); },
      headers: { get: function (h) { return h === 'Content-Type' ? 'application/json' : null; } }
    });
  };

  var activeFetch = fetchImpl
    ? function (url, opts) { fetchCalls.push({ url: url, opts: opts }); return fetchImpl(url, opts); }
    : defaultFetch;

  var mockDocument = {
    createElement: function (tag) { var el = createMockElement(); el.tagName = tag; return el; },
    createElementNS: function (_ns, tag) { var el = createMockElement(); el.tagName = tag; return el; },
    querySelector: function () { return null; },
    body: { appendChild: function () {}, removeChild: function () {} }
  };

  var ctx = vm.createContext({
    window: {},
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
    fetch: activeFetch,
    AbortController: AbortController,
    Map: Map,
    Set: Set,
    encodeURIComponent: encodeURIComponent,
    SyntaxError: SyntaxError,
    TypeError: TypeError
  });

  var ebCode = readFileSync(join(srcDir, 'wizard-event-bus.js'), 'utf-8');
  vm.runInContext(ebCode, ctx);

  var code = readFileSync(join(srcDir, 'wizard-execution.js'), 'utf-8');
  vm.runInContext(code, ctx);

  return { window: ctx.window, fetchCalls: fetchCalls };
}

/** Minimal wizard state sufficient for activate(). */
var STUB_WIZARD_STATE = {
  naming: { workspaceName: 'ws', lakehouseName: 'lh', notebookName: 'nb' },
  capacity: { capacityId: 'cap-1' },
  codeGeneration: { notebookPayload: { cells: [] } }
};

/**
 * Create a pipeline with _sleep, _render, _startTimer, _stopTimer stubbed.
 * fetch is driven by `fetchImpl`.
 */
function makePipeline(fetchImpl, callbacks) {
  var env = createContext(fetchImpl);
  var bus = new env.window.WizardEventBus();
  var opts = { eventBus: bus };
  if (callbacks) {
    if (callbacks.onFailed)   opts.onFailed   = callbacks.onFailed;
    if (callbacks.onComplete) opts.onComplete = callbacks.onComplete;
  }
  var pipeline = new env.window.ExecutionPipeline(opts);
  pipeline._sleep = function () { return Promise.resolve(); };
  pipeline._render = function () {};
  pipeline._renderTimers = function () {};
  pipeline._renderStepLogs = function () {};
  pipeline._startTimer = function () {};
  pipeline._stopTimer = function () {};
  return { pipeline: pipeline, bus: bus, fetchCalls: env.fetchCalls };
}

/** Build a mock Response object. */
function mockResponse(status, body, headers) {
  var hdrs = headers || {};
  var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  var isOk = status >= 200 && status < 300;
  return {
    ok: isOk,
    status: status,
    json: function () {
      if (body === undefined || body === null) return Promise.reject(new SyntaxError('Unexpected end of JSON'));
      if (typeof body === 'string') {
        try { return Promise.resolve(JSON.parse(body)); }
        catch (e) { return Promise.reject(e); }
      }
      return Promise.resolve(body);
    },
    text: function () { return Promise.resolve(bodyStr); },
    headers: {
      get: function (h) {
        var key = h.toLowerCase();
        for (var k in hdrs) {
          if (k.toLowerCase() === key) return hdrs[k];
        }
        return null;
      }
    }
  };
}


/* ═══════════════════════════════════════════════════════════════════
   SUITE 1 — HTTP ERROR CODES
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 1: HTTP Error Codes', function () {

  test('400 Bad Request fails step with "HTTP 400: {body}"', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(400, 'bad request body'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('HTTP 400') === 0);
    assert.ok(pipeline._state.steps[0].error.indexOf('bad request body') !== -1);
  });

  test('401 Unauthorized — immediate fail, no retry, httpStatus=401', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.resolve(mockResponse(401, 'not authorized'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(pipeline._state.status, 'failed');
    assert.equal(pipeline._state.steps[0].httpStatus, 401);
    assert.equal(calls, 1, '401 must not be retried');
  });

  test('403 Forbidden — fails with "HTTP 403: {body}"', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(403, 'forbidden'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('HTTP 403') === 0);
  });

  test('404 Not Found — fails with "HTTP 404: {body}"', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(404, 'not found'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('HTTP 404') === 0);
  });

  test('409 Conflict — fails with "HTTP 409: {body}"', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(409, 'conflict'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('HTTP 409') === 0);
  });

  test('500 Server Error — retries, then fails after max attempts', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.resolve(mockResponse(500, 'internal error'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    // autoRetries = 2, so 1 initial + 2 retries = 3 total
    assert.equal(calls, 3, 'Should attempt 1 + 2 retries = 3');
  });

  test('503 Service Unavailable — retries with backoff', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.resolve(mockResponse(503, 'unavailable'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(calls >= 3, 'Should have retried');
    // Verify retry log messages exist
    var logs = pipeline._state.steps[0].logs;
    var retryLogs = logs.filter(function (l) { return l.message.indexOf('retrying in') !== -1; });
    assert.ok(retryLogs.length > 0, 'Should log retry messages');
  });

  test('Error body longer than 200 chars is truncated', async function () {
    var longBody = 'X'.repeat(500);
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(400, longBody));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    // The error should contain 200 X's, not 500
    var errMsg = pipeline._state.steps[0].error;
    assert.ok(errMsg.indexOf('HTTP 400: ') === 0);
    // After "HTTP 400: " prefix, body portion is at most 200 chars
    var bodyPortion = errMsg.substring('HTTP 400: '.length);
    assert.ok(bodyPortion.length <= 200, 'Body truncated to 200 chars');
  });

});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 2 — NETWORK FAILURES
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 2: Network Failures', function () {

  test('fetch throws TypeError (network error) — retry then fail', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    assert.equal(calls, 3, 'Should retry network errors');
  });

  test('fetch rejects with generic Error — retry then fail', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('ECONNREFUSED') !== -1);
  });

  test('_fetchWithTimeout exceeds timeoutMs — AbortError', async function () {
    var { pipeline } = makePipeline(function (_url, opts) {
      // Simulate a fetch that hangs; the abort signal from _fetchWithTimeout fires
      return new Promise(function (_resolve, reject) {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', function () {
            var err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });
    // Patch _fetchWithTimeout to use a very short timeout
    var origFetch = pipeline._fetchWithTimeout.bind(pipeline);
    pipeline._fetchWithTimeout = function (url, options, _timeoutMs) {
      return origFetch(url, options, 1); // 1ms timeout
    };
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(pipeline._state.status, 'failed');
    var logs = pipeline._state.steps[0].logs;
    var abortLog = logs.find(function (l) { return l.message === 'Aborted'; });
    assert.ok(abortLog, 'Should log "Aborted"');
  });

  test('Connection refused — error propagated with message', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('ECONNREFUSED') !== -1);
  });

  test('DNS resolution failure — error propagated', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.reject(new Error('getaddrinfo ENOTFOUND api.fabric.microsoft.com'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[0].error.indexOf('ENOTFOUND') !== -1);
  });

  test('Multiple network errors across retries all logged', async function () {
    var callCount = 0;
    var { pipeline } = makePipeline(function () {
      callCount++;
      return Promise.reject(new Error('net error #' + callCount));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    var logs = pipeline._state.steps[0].logs;
    // Should have retry warning logs + final failure log
    var failLogs = logs.filter(function (l) { return l.level === 'warn' || l.level === 'error'; });
    assert.ok(failLogs.length >= 3, 'All failures logged (retries + final)');
  });

});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 3 — 401 SPECIAL HANDLING
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 3: 401 Special Handling', function () {

  test('401 at step 0 — immediate fail, zero retries', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.resolve(mockResponse(401, 'Unauthorized'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(calls, 1);
    assert.equal(pipeline._state.steps[0].status, 'failed');
    assert.equal(pipeline._state.steps[0].httpStatus, 401);
  });

  test('401 at step 3 — steps 0-2 succeeded, step 3 fails immediately', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      // Steps 0-2 succeed (calls 1-3), step 3 (call 4) gets 401
      if (calls <= 3) {
        return Promise.resolve(mockResponse(200, { id: 'id-' + calls }, { 'Content-Type': 'application/json' }));
      }
      return Promise.resolve(mockResponse(401, 'token expired'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.steps[0].status, 'succeeded');
    assert.equal(pipeline._state.steps[1].status, 'succeeded');
    assert.equal(pipeline._state.steps[2].status, 'succeeded');
    assert.equal(pipeline._state.steps[3].status, 'failed');
    assert.equal(pipeline._state.steps[3].httpStatus, 401);
    // Step 3 got only 1 call (no retry)
    assert.equal(calls, 4);
  });

  test('401 error message preserved: "HTTP 401: {server message}"', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(401, 'Bearer token expired'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    var err = pipeline._state.steps[0].error;
    assert.ok(err.indexOf('HTTP 401') === 0, 'Starts with HTTP 401');
    assert.ok(err.indexOf('Bearer token expired') !== -1, 'Contains server message');
  });

  test('onFailed callback receives state with error', async function () {
    var receivedState = null;
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(401, 'nope'));
    }, {
      onFailed: function (state) { receivedState = state; }
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.ok(receivedState, 'onFailed was called');
    assert.equal(receivedState.status, 'failed');
    assert.ok(receivedState.error, 'State has error string');
  });

  test('EventBus emits execution:failed with error info', async function () {
    var emittedData = null;
    var env = createContext(function () {
      return Promise.resolve(mockResponse(401, 'auth fail'));
    });
    var bus = new env.window.WizardEventBus();
    bus.on('execution:failed', function (data) { emittedData = data; });
    var pipeline = new env.window.ExecutionPipeline({ eventBus: bus });
    pipeline._sleep = function () { return Promise.resolve(); };
    pipeline._render = function () {};
    pipeline._renderTimers = function () {};
    pipeline._renderStepLogs = function () {};
    pipeline._startTimer = function () {};
    pipeline._stopTimer = function () {};
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.ok(emittedData, 'execution:failed emitted');
    assert.ok(emittedData.error, 'Event data has error');
    assert.ok(emittedData.error.indexOf('401') !== -1);
  });

});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 4 — MALFORMED RESPONSES
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 4: Malformed Responses', function () {

  test('response.json() throws SyntaxError — caught, triggers retry', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.reject(new SyntaxError('Unexpected token')); },
        text: function () { return Promise.resolve('not json'); },
        headers: { get: function (h) { return h === 'Content-Type' ? 'application/json' : null; } }
      });
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    // json() throws, caught by outer try/catch, retries happen
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(calls >= 2, 'Should have retried after SyntaxError');
  });

  test('response.text() throws — errBody is null, error is "HTTP {status}"', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve({
        ok: false, status: 502,
        json: function () { return Promise.reject(new Error('no json')); },
        text: function () { return Promise.reject(new Error('stream error')); },
        headers: { get: function () { return null; } }
      });
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    // errBody is null because text() threw, so message is "HTTP 502"
    var err = pipeline._state.steps[0].error;
    assert.ok(err.indexOf('HTTP 502') !== -1);
  });

  test('Response with no Content-Type header — step succeeds with null data', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({}); },
        text: function () { return Promise.resolve(''); },
        headers: { get: function () { return null; } }
      });
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    // Step 0 succeeds because response.ok and no Content-Type means data = null path
    assert.equal(pipeline._state.steps[0].status, 'succeeded');
  });

  test('Response body is empty string — handled gracefully', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(null); },
        text: function () { return Promise.resolve(''); },
        headers: { get: function () { return null; } }
      });
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(pipeline._state.steps[0].status, 'succeeded');
  });

  test('LRO response body missing id AND no Location header — extraction error', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      if (calls === 1) {
        // Steps 0–4 succeed
        return Promise.resolve(mockResponse(200, { id: 'id-' + calls }, { 'Content-Type': 'application/json' }));
      }
      if (calls <= 5) {
        return Promise.resolve(mockResponse(200, { id: 'id-' + calls }, { 'Content-Type': 'application/json' }));
      }
      // Step 5 (LRO) returns 202 with no id and no Location header
      return Promise.resolve({
        ok: false, status: 202,
        json: function () { return Promise.resolve({}); },
        text: function () { return Promise.resolve('{}'); },
        headers: { get: function () { return null; } }
      });
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    // The LRO step should have failed
    assert.equal(pipeline._state.steps[5].status, 'failed');
    assert.ok(
      pipeline._state.steps[5].error.indexOf('Could not extract job instance ID') !== -1 ||
      pipeline._state.steps[5].error.indexOf('LRO failed') !== -1,
      'Error mentions job instance ID extraction failure'
    );
  });

});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 5 — LRO FAILURE MODES
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 5: LRO Failure Modes', function () {

  /** Helper: URL-based routing. Steps 0-4 succeed, step 5 POST returns 202, polls use pollResponses. */
  function makeLROPipeline(pollResponses) {
    var pollIndex = 0;
    return makePipeline(function (url, opts) {
      var method = (opts && opts.method) || 'GET';
      // LRO poll: GET to /jobs/instances/{id} (no jobType param)
      if (method === 'GET' && url.indexOf('/jobs/instances/') !== -1) {
        var resp = pollResponses[pollIndex] || pollResponses[pollResponses.length - 1];
        pollIndex++;
        return Promise.resolve(resp);
      }
      // Step 5 initial POST: contains jobType=RunNotebook
      if (url.indexOf('jobType=RunNotebook') !== -1) {
        return Promise.resolve({
          ok: false, status: 202,
          json: function () { return Promise.resolve({ id: 'job-1' }); },
          text: function () { return Promise.resolve('{"id":"job-1"}'); },
          headers: { get: function (h) { return h === 'Location' ? '/jobs/job-1' : null; } }
        });
      }
      // Steps 0-4: standard JSON success
      return Promise.resolve(mockResponse(200, { id: 'mock-id' }, { 'Content-Type': 'application/json' }));
    });
  }

  test('LRO poll returns status "failed" — pipeline fails with failureReason', async function () {
    var { pipeline } = makeLROPipeline([
      mockResponse(200, { status: 'Failed', failureReason: 'OOM in Spark executor' }, { 'Content-Type': 'application/json' })
    ]);
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 150); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[5].error.indexOf('OOM in Spark executor') !== -1);
  });

  test('LRO poll returns status "cancelled" — pipeline fails', async function () {
    var { pipeline } = makeLROPipeline([
      mockResponse(200, { status: 'Cancelled' }, { 'Content-Type': 'application/json' })
    ]);
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 150); });
    assert.equal(pipeline._state.status, 'failed');
    assert.ok(pipeline._state.steps[5].error.indexOf('cancelled') !== -1);
  });

  test('LRO poll timeout — timeout error message', async function () {
    var { pipeline } = makeLROPipeline([
      mockResponse(200, { status: 'Running' }, { 'Content-Type': 'application/json' })
    ]);
    // Monkey-patch _pollLRO to use tiny maxPollDurationMs
    var origPollLRO = pipeline._pollLRO.bind(pipeline);
    pipeline._pollLRO = function (pollUrl, stepDef) {
      var tweakedDef = Object.assign({}, stepDef, {
        lroConfig: { pollIntervalMs: 1, maxPollDurationMs: 1 }
      });
      return origPollLRO(pollUrl, tweakedDef);
    };
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(pipeline._state.status, 'failed');
    var err = pipeline._state.steps[5].error;
    assert.ok(err.indexOf('timed out') !== -1, 'Error mentions timeout');
  });

  test('LRO poll gets non-ok response — warns and continues polling', async function () {
    var { pipeline } = makeLROPipeline([
      mockResponse(500, 'server err'),
      mockResponse(500, 'server err'),
      mockResponse(200, { status: 'Completed' }, { 'Content-Type': 'application/json' })
    ]);
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(pipeline._state.status, 'succeeded');
    var logs = pipeline._state.steps[5].logs;
    var warnLogs = logs.filter(function (l) { return l.message.indexOf('Poll returned HTTP 500') !== -1; });
    assert.ok(warnLogs.length >= 2, 'Warns about non-ok poll responses');
  });

  test('LRO poll fetch throws — warns and continues polling', async function () {
    var pollCount = 0;
    var { pipeline } = makePipeline(function (url, opts) {
      var method = (opts && opts.method) || 'GET';
      // LRO poll
      if (method === 'GET' && url.indexOf('/jobs/instances/') !== -1) {
        pollCount++;
        if (pollCount <= 2) {
          return Promise.reject(new Error('network blip'));
        }
        return Promise.resolve(mockResponse(200, { status: 'Completed' }, { 'Content-Type': 'application/json' }));
      }
      // Step 5 POST
      if (url.indexOf('jobType=RunNotebook') !== -1) {
        return Promise.resolve({
          ok: false, status: 202,
          json: function () { return Promise.resolve({ id: 'job-1' }); },
          text: function () { return Promise.resolve('{"id":"job-1"}'); },
          headers: { get: function (h) { return h === 'Location' ? '/jobs/job-1' : null; } }
        });
      }
      return Promise.resolve(mockResponse(200, { id: 'mock-id' }, { 'Content-Type': 'application/json' }));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 300); });
    assert.equal(pipeline._state.status, 'succeeded');
  });

  test('LRO abort during polling — returns AbortError', async function () {
    var { pipeline } = makePipeline(function (url, opts) {
      var method = (opts && opts.method) || 'GET';
      // LRO poll — hang until aborted
      if (method === 'GET' && url.indexOf('/jobs/instances/') !== -1) {
        return new Promise(function (_resolve, reject) {
          if (opts && opts.signal) {
            if (opts.signal.aborted) {
              var e = new Error('Aborted');
              e.name = 'AbortError';
              reject(e);
              return;
            }
            opts.signal.addEventListener('abort', function () {
              var e = new Error('Aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }
        });
      }
      // Step 5 POST
      if (url.indexOf('jobType=RunNotebook') !== -1) {
        return Promise.resolve({
          ok: false, status: 202,
          json: function () { return Promise.resolve({ id: 'job-1' }); },
          text: function () { return Promise.resolve('{"id":"job-1"}'); },
          headers: { get: function (h) { return h === 'Location' ? '/jobs/job-1' : null; } }
        });
      }
      return Promise.resolve(mockResponse(200, { id: 'mock-id' }, { 'Content-Type': 'application/json' }));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    if (pipeline._abortController) {
      pipeline._abortController.abort();
    }
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
  });

});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 6 — EXPONENTIAL BACKOFF
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 6: Exponential Backoff', function () {

  test('First retry delay: retryDelayMs * 2^0 = retryDelayMs', async function () {
    var sleepDelays = [];
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      return Promise.resolve(mockResponse(500, 'err'));
    });
    pipeline._sleep = function (ms) { sleepDelays.push(ms); return Promise.resolve(); };
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    // Step 0 has retryDelayMs = 1000, first retry delay = 1000 * 2^0 = 1000
    assert.ok(sleepDelays.length >= 1, 'At least one sleep call');
    assert.equal(sleepDelays[0], 1000, 'First retry delay = 1000 * 2^0');
  });

  test('Second retry delay: retryDelayMs * 2^1 = retryDelayMs * 2', async function () {
    var sleepDelays = [];
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(500, 'err'));
    });
    pipeline._sleep = function (ms) { sleepDelays.push(ms); return Promise.resolve(); };
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    // Step 0: retryDelayMs=1000. Attempt 0 fails → delay 1000*2^0=1000,
    //  attempt 1 fails → delay 1000*2^1=2000
    assert.ok(sleepDelays.length >= 2, 'At least two sleep calls');
    assert.equal(sleepDelays[0], 1000);
    assert.equal(sleepDelays[1], 2000);
  });

  test('401 bypasses retry entirely (no delay)', async function () {
    var sleepDelays = [];
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(401, 'auth'));
    });
    pipeline._sleep = function (ms) { sleepDelays.push(ms); return Promise.resolve(); };
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(sleepDelays.length, 0, 'No sleep for 401');
    assert.equal(pipeline._state.status, 'failed');
  });

  test('AbortError bypasses retry entirely', async function () {
    var sleepDelays = [];
    var { pipeline } = makePipeline(function () {
      var err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    pipeline._sleep = function (ms) { sleepDelays.push(ms); return Promise.resolve(); };
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(sleepDelays.length, 0, 'No sleep for AbortError');
    assert.equal(pipeline._state.status, 'failed');
  });

  test('maxRetriesPerStep caps retries', async function () {
    var calls = 0;
    var env = createContext(function () {
      calls++;
      return Promise.resolve(mockResponse(500, 'err'));
    });
    var bus = new env.window.WizardEventBus();
    var pipeline = new env.window.ExecutionPipeline({ eventBus: bus });
    pipeline._sleep = function () { return Promise.resolve(); };
    pipeline._render = function () {};
    pipeline._renderTimers = function () {};
    pipeline._renderStepLogs = function () {};
    pipeline._startTimer = function () {};
    pipeline._stopTimer = function () {};
    // Set maxRetriesPerStep to 1 (lower than autoRetries=2)
    pipeline._state.maxRetriesPerStep = 1;
    pipeline._executionContext = pipeline._getExecutionContext(STUB_WIZARD_STATE);
    pipeline._abortController = new AbortController();
    var success = await pipeline._executeStep(0, pipeline._executionContext);
    assert.equal(success, false);
    // autoRetries=2 but maxRetriesPerStep=1, so min(2,1)=1 → 1 initial + 1 retry = 2
    assert.equal(calls, 2, 'Capped at maxRetriesPerStep=1 → 2 total calls');
  });

});


/* ═══════════════════════════════════════════════════════════════════
   SUITE 7 — ERROR STATE SHAPE
   ═══════════════════════════════════════════════════════════════════ */

describe('Suite 7: Error State Shape', function () {

  test('Failed state has: status=failed, error string, step[i].error, step[i].status=failed', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(400, 'bad'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(pipeline._state.status, 'failed');
    assert.equal(typeof pipeline._state.error, 'string');
    assert.ok(pipeline._state.error.length > 0);
    assert.equal(pipeline._state.steps[0].status, 'failed');
    assert.equal(typeof pipeline._state.steps[0].error, 'string');
  });

  test('Error message format: Step "{stepName}" failed: {error}', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(400, 'kaboom'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    var expected = 'Step "Create Workspace" failed: HTTP 400: kaboom';
    assert.equal(pipeline._state.error, expected);
  });

  test('Timing recorded even on failure (startedAt, completedAt, elapsedMs)', async function () {
    var { pipeline } = makePipeline(function () {
      return Promise.resolve(mockResponse(400, 'err'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 100); });
    // Pipeline timing
    assert.ok(pipeline._state.timing.startedAt > 0, 'Pipeline startedAt set');
    assert.ok(pipeline._state.timing.completedAt > 0, 'Pipeline completedAt set');
    assert.ok(pipeline._state.timing.elapsedMs >= 0, 'Pipeline elapsedMs >= 0');
    // Step timing
    var step = pipeline._state.steps[0];
    assert.ok(step.timing.startedAt > 0, 'Step startedAt set');
    assert.ok(step.timing.completedAt > 0, 'Step completedAt set');
    assert.ok(step.timing.elapsedMs >= 0, 'Step elapsedMs >= 0');
  });

  test('Artifacts from previous successful steps are preserved after failure', async function () {
    var calls = 0;
    var { pipeline } = makePipeline(function () {
      calls++;
      // Step 0 succeeds, step 1 fails
      if (calls === 1) {
        return Promise.resolve(mockResponse(200, { id: 'ws-123' }, { 'Content-Type': 'application/json' }));
      }
      return Promise.resolve(mockResponse(500, 'boom'));
    });
    pipeline.activate(STUB_WIZARD_STATE);
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(pipeline._state.status, 'failed');
    // Step 0 artifact (workspaceId) should be preserved
    assert.equal(pipeline._state.artifacts.workspaceId, 'ws-123', 'Artifact from step 0 preserved');
    // Step 0 status should be succeeded
    assert.equal(pipeline._state.steps[0].status, 'succeeded');
  });

});
