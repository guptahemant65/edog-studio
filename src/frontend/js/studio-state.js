/**
 * studioState — Tiny observable store for cross-module UI state.
 *
 * PR-A scope: only `activeTab` ships here. Future PRs add filters,
 * connection, selection. Keep the shape flat; only one level of keys
 * so shallowEqual stays cheap.
 *
 * Three properties matter, in order:
 *   1. queueMicrotask batching — multiple set() in one tick = one notify.
 *   2. shallowEqual short-circuit — no-op set() does not notify.
 *   3. AbortSignal unsubscribe — lifecycle hygiene without bookkeeping.
 *
 * URL is the source of truth on load. Hash form: #tab=logs (room to grow
 * to #tab=logs&filter=...). localStorage is a soft fallback for users who
 * land without a hash (back-compat with the old 'edog-active-tab' key).
 *
 * Exposed on window.studioState (and window.createStore) because EDOG runs
 * without a module system — every script is concatenated by build-html.py.
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

  /* ─── URL <-> state adapter ─── */

  var LS_KEY = 'edog-active-tab';
  var HASH_KEY = 'tab';

  function parseHash() {
    // Defensive: malformed percent-encoding (e.g. '#tab=%E0%A4%A') makes
    // decodeURIComponent throw 'URI malformed'. Because every JS module is
    // concatenated into one <script>, an uncaught throw here would abort
    // the entire app at boot — white screen, no tabs. Catch and degrade.
    try {
      var raw = (window.location.hash || '').replace(/^#/, '');
      if (!raw) return null;
      var pairs = raw.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var eq = pairs[i].indexOf('=');
        if (eq === -1) continue;
        var k = decodeURIComponent(pairs[i].slice(0, eq));
        if (k === HASH_KEY) {
          var v = decodeURIComponent(pairs[i].slice(eq + 1));
          return v || null;
        }
      }
      return null;
    } catch (_e) {
      return null;
    }
  }

  function writeHash(tab) {
    var target = '#' + HASH_KEY + '=' + encodeURIComponent(tab);
    if (window.location.hash === target) return;
    // replaceState avoids polluting back-button history with every tab click.
    try {
      window.history.replaceState(null, '', target);
    } catch (_e) {
      window.location.hash = target;
    }
  }

  /* ─── Initial value: hash → localStorage → default ─── */

  function readInitialTab() {
    var fromHash = parseHash();
    if (fromHash) return fromHash;
    try {
      var fromLS = window.localStorage.getItem(LS_KEY);
      if (fromLS) return fromLS;
    } catch (_e) { /* private mode, etc. */ }
    return 'logs';
  }

  /* ─── Singleton ─── */

  var studioState = createStore({
    activeTab: readInitialTab(),
  });

  // Persist + URL-sync on every change. One subscriber, never torn down.
  studioState.subscribe(function (next) {
    writeHash(next.activeTab);
    try {
      window.localStorage.setItem(LS_KEY, next.activeTab);
    } catch (_e) { /* ignore */ }
  });

  // Listen for hash changes (back/forward, manual edit, deep link from another tab).
  window.addEventListener('hashchange', function () {
    var tab = parseHash();
    if (tab) studioState.set({ activeTab: tab });
  });

  /* ─── Export (no module system; window is the bus) ─── */

  window.createStore = createStore;
  window.studioState = studioState;

})();
