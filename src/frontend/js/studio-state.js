/**
 * studioState — Tiny observable store for cross-module UI state.
 *
 * PR-A: activeTab.
 * PR-B: filters.{logs,telemetry} with URL hash sync and per-tab localStorage
 *       fallback (key 'edog-filters-<tabId>').
 *
 * Three properties matter, in order:
 *   1. queueMicrotask batching — multiple set() in one tick = one notify.
 *   2. shallowEqual short-circuit — no-op set() does not notify.
 *   3. AbortSignal unsubscribe — lifecycle hygiene without bookkeeping.
 *
 * shallowEqual is TOP-LEVEL ONLY. Nested mutations (e.g. filters.logs.q) MUST
 * produce a new top-level `filters` object too, or shallowEqual short-circuits
 * the notification and subscribers never run. Use setFilter(tab, partial) which
 * does the deep immutable update correctly.
 *
 * URL is the source of truth on load, with localStorage as a soft fallback per
 * domain. Hash shape:
 *   #tab=logs&q=error&levels=warning,error&preset=flt&since=15&corr=abc
 *      &excl=Foo,Bar&ep=x&comp=y&raid=z
 *      &tq=spark&tstatus=failed&dmin=2&dmax=60
 *
 * Logs filter keys are unprefixed (logs is the dominant view). Telemetry keys
 * are prefixed with `t`/`d` to avoid collisions. Default values are OMITTED
 * from the URL so a clean state writes just `#tab=logs`.
 *
 * Sets cannot survive shallowEqual cleanly, so activeLevels and excludedComponents
 * are stored as plain arrays. Consumer-side getters (LogViewerState) rebuild a
 * Set-like view object on demand.
 *
 * Exposed on window.studioState (and window.createStore, window.studioSetFilter)
 * because EDOG runs without a module system — every script is concatenated by
 * build-html.py.
 *
 * @author Pixel (with Kai's principles) — EDOG Studio hivemind
 */
'use strict';

(function () {

  /* ─── createStore ─── */

  function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    var ak = Object.keys(a);
    var bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var i = 0; i < ak.length; i++) {
      var k = ak[i];
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  function createStore(initial) {
    var state = initial;
    var subscribers = new Set();
    var notifyScheduled = false;

    function scheduleNotify() {
      if (notifyScheduled) return;
      notifyScheduled = true;
      queueMicrotask(function () {
        notifyScheduled = false;
        // Snapshot BOTH the state and the subscriber set so re-entrant
        // set()/subscribe()/unsubscribe() inside a handler can't shift
        // what other subscribers in this batch observe.
        var snapState = state;
        var snapshot = Array.from(subscribers);
        for (var i = 0; i < snapshot.length; i++) {
          try {
            snapshot[i](snapState);
          } catch (err) {
            console.error('[studioState] subscriber threw:', err);
          }
        }
      });
    }

    return {
      get: function () { return state; },

      set: function (partial) {
        var next = typeof partial === 'function'
          ? partial(state)
          : Object.assign({}, state, partial);
        if (shallowEqual(next, state)) return;
        state = next;
        scheduleNotify();
      },

      subscribe: function (fn, options) {
        subscribers.add(fn);
        var removed = false;
        var unsub = function () {
          if (removed) return;
          removed = true;
          subscribers.delete(fn);
        };
        var signal = options && options.signal;
        if (signal) {
          if (signal.aborted) { unsub(); return unsub; }
          signal.addEventListener('abort', unsub, { once: true });
        }
        return unsub;
      },
    };
  }

  /* ─── Filter schema ───
   *
   * DEFAULTS_<tab>: starting values. Values matching the default are OMITTED
   * from the URL hash (so the clean state is a short URL).
   *
   * URL key tables:
   *   logs:      q, levels, preset, excl, since, corr, ep, comp, raid
   *   telemetry: tq, tstatus, dmin, dmax
   *
   * Type tag table drives parse/serialize:
   *   'str'   — string, decodeURIComponent
   *   'num'   — Number(), NaN → default
   *   'arr'   — comma-split, per-element decodeURIComponent, drop empty
   *   'nullable_str' — string or null
   */

  var DEFAULTS_LOGS = {
    q: '',
    levels: ['Verbose', 'Message', 'Warning', 'Error'],
    preset: 'flt',
    excl: [],
    since: 0,
    corr: null,
    ep: '',
    comp: '',
    raid: '',
  };

  var DEFAULTS_TELEMETRY = {
    q: '',
    status: 'all',
    dmin: 0,
    dmax: 120,
  };

  // (URL key) -> (tab, internal key, type)
  // Logs unprefixed; telemetry prefixed to avoid collisions.
  var URL_KEY_MAP = {
    q:       { tab: 'logs',      key: 'q',      type: 'str' },
    levels:  { tab: 'logs',      key: 'levels', type: 'arr' },
    preset:  { tab: 'logs',      key: 'preset', type: 'str' },
    excl:    { tab: 'logs',      key: 'excl',   type: 'arr' },
    since:   { tab: 'logs',      key: 'since',  type: 'num' },
    corr:    { tab: 'logs',      key: 'corr',   type: 'nullable_str' },
    ep:      { tab: 'logs',      key: 'ep',     type: 'str' },
    comp:    { tab: 'logs',      key: 'comp',   type: 'str' },
    raid:    { tab: 'logs',      key: 'raid',   type: 'str' },
    tq:      { tab: 'telemetry', key: 'q',      type: 'str' },
    tstatus: { tab: 'telemetry', key: 'status', type: 'str' },
    dmin:    { tab: 'telemetry', key: 'dmin',   type: 'num' },
    dmax:    { tab: 'telemetry', key: 'dmax',   type: 'num' },
  };

  // Inverse: (tab, internalKey) -> urlKey
  var INVERSE_URL_KEY = {};
  for (var _uk in URL_KEY_MAP) {
    if (!Object.prototype.hasOwnProperty.call(URL_KEY_MAP, _uk)) continue;
    var _m = URL_KEY_MAP[_uk];
    INVERSE_URL_KEY[_m.tab + '.' + _m.key] = _uk;
  }

  function defaultsFor(tab) {
    if (tab === 'logs') return DEFAULTS_LOGS;
    if (tab === 'telemetry') return DEFAULTS_TELEMETRY;
    return {};
  }

  function defaultFilters() {
    return {
      logs: Object.assign({}, DEFAULTS_LOGS, { levels: DEFAULTS_LOGS.levels.slice(), excl: [] }),
      telemetry: Object.assign({}, DEFAULTS_TELEMETRY),
    };
  }

  /* Parse a single URL value into the typed internal value. Returns
   * { ok: true, value } or { ok: false } if malformed. Each decode is
   * guarded individually — one bad field cannot brick the whole hash. */
  function parseValue(rawValue, type) {
    try {
      if (type === 'arr') {
        if (!rawValue) return { ok: true, value: [] };
        var parts = rawValue.split(',');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i]) continue;
          // decodeURIComponent throws on malformed %xx — skip those entries.
          try {
            out.push(decodeURIComponent(parts[i]));
          } catch (_e) { /* drop bad element */ }
        }
        return { ok: true, value: out };
      }
      if (type === 'num') {
        var dec = decodeURIComponent(rawValue);
        var n = Number(dec);
        if (!isFinite(n)) return { ok: false };
        return { ok: true, value: n };
      }
      var s = decodeURIComponent(rawValue);
      if (type === 'nullable_str') {
        return { ok: true, value: s === '' ? null : s };
      }
      return { ok: true, value: s };
    } catch (_e) {
      return { ok: false };
    }
  }

  /* Serialize an internal value to a URL-safe string. Returns null if the
   * value equals the default (caller omits it from the hash). */
  function serializeValue(value, defaultValue, type) {
    if (type === 'arr') {
      var arr = Array.isArray(value) ? value : [];
      var defArr = Array.isArray(defaultValue) ? defaultValue : [];
      if (arraysEqualUnordered(arr, defArr)) return null;
      return arr.map(function (v) { return encodeURIComponent(v); }).join(',');
    }
    if (type === 'num') {
      if (value === defaultValue) return null;
      if (!isFinite(value)) return null;
      return encodeURIComponent(String(value));
    }
    if (type === 'nullable_str') {
      if (value === defaultValue || value == null || value === '') return null;
      return encodeURIComponent(String(value));
    }
    if (value === defaultValue || value === '' || value == null) return null;
    return encodeURIComponent(String(value));
  }

  function arraysEqualUnordered(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    var sa = a.slice().sort();
    var sb = b.slice().sort();
    for (var i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  }

  /* ─── URL <-> state adapter ─── */

  var LS_KEY_TAB = 'edog-active-tab';
  var LS_KEY_FILTERS_LOGS = 'edog-filters-logs';
  var LS_KEY_FILTERS_TELEMETRY = 'edog-filters-telemetry';
  var HASH_KEY_TAB = 'tab';

  /* Returns { tab: string|null, filters: { logs:{...}, telemetry:{...} } }.
   * Top-level try/catch is the white-screen backstop (B1 lesson): even though
   * parseValue is individually guarded, an exotic input could still throw
   * somewhere outside it (e.g. split semantics). One broken URL must NOT take
   * down the whole concatenated bundle. */
  function parseHash() {
    var result = { tab: null, filters: { logs: {}, telemetry: {} } };
    try {
      var raw = (window.location.hash || '').replace(/^#/, '');
      if (!raw) return result;
      var pairs = raw.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var eq = pairs[i].indexOf('=');
        if (eq === -1) continue;
        var rawK = pairs[i].slice(0, eq);
        var rawV = pairs[i].slice(eq + 1);
        var k;
        try { k = decodeURIComponent(rawK); } catch (_e) { continue; }
        if (k === HASH_KEY_TAB) {
          try { result.tab = decodeURIComponent(rawV) || null; } catch (_e) { /* drop */ }
          continue;
        }
        var meta = URL_KEY_MAP[k];
        if (!meta) continue;
        var parsed = parseValue(rawV, meta.type);
        if (parsed.ok) result.filters[meta.tab][meta.key] = parsed.value;
      }
      return result;
    } catch (_e) {
      return { tab: null, filters: { logs: {}, telemetry: {} } };
    }
  }

  /* Serialize the full studioState into a hash string. Defaults are omitted. */
  function buildHash(state) {
    var parts = [];
    if (state.activeTab) {
      parts.push(HASH_KEY_TAB + '=' + encodeURIComponent(state.activeTab));
    }
    var filters = state.filters || {};
    var tabs = ['logs', 'telemetry'];
    for (var t = 0; t < tabs.length; t++) {
      var tab = tabs[t];
      var defaults = defaultsFor(tab);
      var current = filters[tab] || {};
      for (var key in defaults) {
        if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
        var meta = URL_KEY_MAP[INVERSE_URL_KEY[tab + '.' + key]];
        if (!meta) continue;
        var value = Object.prototype.hasOwnProperty.call(current, key)
          ? current[key]
          : defaults[key];
        var serialized = serializeValue(value, defaults[key], meta.type);
        if (serialized === null) continue;
        parts.push(INVERSE_URL_KEY[tab + '.' + key] + '=' + serialized);
      }
    }
    return parts.length === 0 ? '' : '#' + parts.join('&');
  }

  function writeHash(state) {
    var target = buildHash(state);
    var current = window.location.hash || '';
    if (current === target) return;
    if (target === '' && current === '') return;
    // replaceState avoids polluting back-button history with every keystroke.
    try {
      window.history.replaceState(null, '', target || window.location.pathname + window.location.search);
    } catch (_e) {
      window.location.hash = target;
    }
  }

  /* ─── localStorage helpers (private mode safe) ─── */

  function lsGet(key) {
    try { return window.localStorage.getItem(key); }
    catch (_e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); }
    catch (_e) { /* private mode, quota, etc. */ }
  }

  function readFiltersFromLS(tab) {
    var key = tab === 'logs' ? LS_KEY_FILTERS_LOGS : LS_KEY_FILTERS_TELEMETRY;
    var raw = lsGet(key);
    if (!raw) return {};
    try {
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return {};
      return obj;
    } catch (_e) {
      return {};
    }
  }

  /* Merge precedence: URL > localStorage > defaults. */
  function readInitialState() {
    var parsed = parseHash();
    var tab = parsed.tab || lsGet(LS_KEY_TAB) || 'logs';
    var defaults = defaultFilters();
    var lsLogs = readFiltersFromLS('logs');
    var lsTele = readFiltersFromLS('telemetry');
    var filters = {
      logs: Object.assign({}, defaults.logs, lsLogs, parsed.filters.logs),
      telemetry: Object.assign({}, defaults.telemetry, lsTele, parsed.filters.telemetry),
    };
    return { activeTab: tab, filters: filters };
  }

  /* ─── Singleton ─── */

  var studioState = createStore(readInitialState());

  /* setFilter(tab, partial) — deep immutable update that produces a NEW
   * top-level `filters` reference so shallowEqual fires. Always use this
   * instead of mutating studioState.get().filters.logs in place. */
  function setFilter(tab, partial) {
    var s = studioState.get();
    var existing = (s.filters && s.filters[tab]) || {};
    var nextTab = Object.assign({}, existing, partial);
    var nextFilters = Object.assign({}, s.filters);
    nextFilters[tab] = nextTab;
    studioState.set({ filters: nextFilters });
  }

  // Persist + URL-sync on every change. One subscriber, never torn down.
  studioState.subscribe(function (next) {
    writeHash(next);
    lsSet(LS_KEY_TAB, next.activeTab);
    if (next.filters) {
      if (next.filters.logs) lsSet(LS_KEY_FILTERS_LOGS, safeStringify(next.filters.logs));
      if (next.filters.telemetry) lsSet(LS_KEY_FILTERS_TELEMETRY, safeStringify(next.filters.telemetry));
    }
  });

  function safeStringify(obj) {
    try { return JSON.stringify(obj); } catch (_e) { return '{}'; }
  }

  // Listen for hash changes (back/forward, manual edit, deep link).
  window.addEventListener('hashchange', function () {
    var parsed = parseHash();
    var s = studioState.get();
    var defaults = defaultFilters();
    var nextLogs = Object.assign({}, defaults.logs, parsed.filters.logs);
    var nextTele = Object.assign({}, defaults.telemetry, parsed.filters.telemetry);
    studioState.set({
      activeTab: parsed.tab || s.activeTab,
      filters: { logs: nextLogs, telemetry: nextTele },
    });
  });

  /* ─── Export (no module system; window is the bus) ─── */

  window.createStore = createStore;
  window.studioState = studioState;
  window.studioSetFilter = setFilter;
  window.studioStateDefaults = defaultFilters; // used by back-compat shims

})();
