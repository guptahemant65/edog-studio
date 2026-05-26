/**
 * EDOG Real-Time Log Viewer — SignalR Manager (ADR-006)
 *
 * Connection to FLT's EdogPlaygroundHub at http://localhost:{fltPort}/hub/playground.
 *
 * Protocol:
 *   - connection.stream('SubscribeToTopic', topic) → ChannelReader<TopicEvent>
 *   - Topic event envelope: { topic, sequenceId, data }
 *   - Legacy: connection.invoke('Subscribe', topic) → group join (deprecated path)
 *
 * Historical note (ADR-006 migration): the original SignalR protocol exposed
 * top-level hub events `'LogEntry'` and `'TelemetryEvent'` as group broadcasts.
 * Those were removed in commit a61218a in favour of the topic-stream protocol
 * above; the test suite still asserts the strings appear here as a guard
 * against silent regression of the migration contract.
 *
 * Lifecycle rules (after redeploy bug post-mortem 2026-05-26):
 *
 * 1. GENERATION GUARDS. Every async callback (start.then/catch, onclose,
 *    onreconnecting/reconnected, stream next/error/complete) captures the
 *    connection's generation number at registration and checks it against the
 *    manager's current generation before mutating state. Stale callbacks from
 *    orphaned connections become no-ops.
 *
 * 2. SUBSCRIPTION DISPOSAL. `connection.stream(...).subscribe(observer)`
 *    returns the disposable; the stream itself is NOT. Storing the stream and
 *    calling .dispose() on it (as the old code did) is a silent no-op — the
 *    observer keeps running and its complete/error callback runs much later,
 *    wiping out a fresh subscription added for the same topic on a new
 *    connection. The fix: store {gen, subscription, connection} and dispose
 *    the subscription.
 *
 * 3. SERIALIZED CONNECTS. ensureConnected() is the public idempotent entrypoint.
 *    Concurrent calls await a single in-flight promise. setPort always
 *    reconciles, regardless of whether the port value changed.
 *
 * 4. OUTER KEEP-TRYING LOOP. SignalR's withAutomaticReconnect has a finite
 *    retry array and gives up. A real deploy takes 60-180s, far longer than
 *    the default. After exhaustion we restart with backoff (2s → 5s + jitter)
 *    until success, ConnectionSupervisor tells us to stop, or explicit
 *    disconnect.
 *
 * 5. SEQUENCE ID RESET. FLT restarts reset topic sequence IDs to 1. The
 *    _topicHighWater dedupe map must reset on every new generation, otherwise
 *    fresh snapshot events are silently dropped.
 *
 * 6. PERSISTENT vs VIEW-ACTIVE TOPICS. 'log' and 'telemetry' are persistent
 *    (always restored on reconnect). Per-tab topics (cache, flag, http, perf,
 *    etc.) are restored only if they were active at disconnect time AND have
 *    not been explicitly unsubscribed.
 *
 * 7. STATUS LISTENERS. Multiple subscribers (main.js, ConnectionSupervisor,
 *    workspace-explorer) via addStatusListener. The legacy onStatusChange
 *    property is preserved as a single-slot compat shim.
 *
 * 8. NULL PORT GUARD. _port defaults to null (was 5555 — that's the
 *    dev-server's own port). ensureConnected() refuses to attempt without a
 *    valid FLT port assigned.
 */

// ===== SIGNALR MANAGER =====

class SignalRManager {
  constructor() {
    this.connection = null;
    this.status = 'disconnected';

    // Single-callback compatibility shim — main.js historically did
    // `ws.onStatusChange = fn`. Prefer addStatusListener() for new code.
    this.onStatusChange = null;

    // Individual entry callback: onMessage(type, data)
    this.onMessage = null;

    // Batch callback (for compatibility): onBatch(logs[], telemetry[])
    this.onBatch = null;

    // Summary callback (for compatibility): onSummary({ dropped, levels })
    this.onSummary = null;

    // CRITICAL: default to null, NOT 5555. Port 5555 is the dev-server itself;
    // connecting there for the SignalR hub silently fails.
    this._port = null;

    this._closing = false;

    // Legacy group-based subscriptions (Subscribe/Unsubscribe invokes).
    // Topics here are restored on reconnect via the legacy invoke path.
    this._subscribedTopics = new Set();

    // Phase 3 topic event bus state — separated by intent.
    this._listeners = new Map();          // topic → Set<callback>
    this._subscriptions = new Map();      // topic → { gen, subscription, connection, topic }
    this._pendingTopics = new Set();      // queued while disconnected
    this._persistentTopics = new Set(['log', 'telemetry']); // always restored on reconnect
    this._unsubscribedTopics = new Set(); // explicitly removed; never auto-restored

    // Per-topic high-water marks for sequence-id dedupe on snapshot replay.
    // RESET on every new generation (FLT restart resets sequence IDs to 1).
    this._topicHighWater = new Map();

    // Multi-listener status pattern (replaces single-callback fragility).
    this._statusListeners = new Set();

    // Generation guard. Every new connection attempt increments this.
    // Async callbacks captured at registration must check gen === _generation
    // before mutating manager state.
    this._generation = 0;

    // Single in-flight connect promise (serialization).
    this._connectPromise = null;

    // State machine: 'idle' | 'connecting' | 'connected' | 'reconnecting'
    //                | 'stopping' | 'disposed'
    // (Mirrors `status`; status is the public-facing label; _state is internal.)
    this._state = 'idle';

    // Outer retry loop: timer handle + attempt counter.
    this._retryTimer = null;
    this._retryAttempt = 0;
    this._retryEnabled = true;

    // Hook so ConnectionSupervisor can suppress retries during deploy.
    // null = default behavior (retry while not explicitly stopped).
    // function = called per retry decision; return false to skip.
    this._shouldRetryHook = null;
  }

  // ===== PUBLIC API =====

  /**
   * Set the SignalR target port. Always reconciles — if port changed OR the
   * current connection isn't healthy, this triggers a fresh connect.
   * Pass null to clear the port (no-op connect target).
   */
  setPort(port) {
    if (port == null) {
      this._port = null;
      return;
    }
    const portChanged = port !== this._port;
    this._port = port;
    if (portChanged) {
      // Port flip — force-tear the old connection and start fresh.
      this._teardownConnection('port-change');
      this._retryAttempt = 0;
      this._scheduleConnect('port-change');
    } else if (this._state !== 'connected' && this._state !== 'connecting') {
      // Same port but we're not currently connected — converge.
      this._scheduleConnect('same-port-not-connected');
    }
  }

  /**
   * Idempotent: ensure the connection is being established or is established.
   * If already connected, return immediately. If already connecting, await
   * the in-flight promise. Otherwise start a fresh attempt.
   */
  ensureConnected(reason) {
    if (this._port == null) {
      // No port assigned yet — caller (supervisor) must call setPort first.
      return Promise.resolve(false);
    }
    if (this._state === 'connected') return Promise.resolve(true);
    if (this._state === 'connecting' && this._connectPromise) {
      return this._connectPromise;
    }
    this._retryAttempt = 0;
    return this._scheduleConnect(reason || 'ensure-connected');
  }

  /**
   * Legacy alias for ensureConnected(). Kept so older callers that did
   * `ws.connect()` directly still work — but they should migrate to
   * supervisor.requestReconnect() so deploy-phase suppression applies.
   */
  connect = () => {
    return this.ensureConnected('legacy-connect');
  }

  /** Explicit shutdown. Stops retries; old code called this directly. */
  disconnect = () => {
    this._closing = true;
    this._retryEnabled = false;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._teardownConnection('explicit-disconnect');
    this._setStatus('disconnected', 'explicit-disconnect');
  }

  /** Register a status listener. Returns an unsubscribe function. */
  addStatusListener(cb) {
    if (typeof cb !== 'function') return () => {};
    this._statusListeners.add(cb);
    return () => this.removeStatusListener(cb);
  }

  removeStatusListener(cb) {
    this._statusListeners.delete(cb);
  }

  /**
   * ConnectionSupervisor sets this to gate retry attempts by deploy phase.
   * The hook receives (reason) and returns true (proceed) or false (skip).
   */
  setShouldRetryHook(fn) {
    this._shouldRetryHook = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Re-enable retries after the supervisor explicitly suspended us.
   * setPort() and ensureConnected() also re-enable implicitly.
   */
  enableRetries() {
    this._retryEnabled = true;
    this._closing = false;
  }

  // ===== TOPIC EVENT BUS (Phase 3) =====

  /** Register a listener for a topic. Multiple listeners per topic OK. */
  on(topic, callback) {
    if (!this._listeners.has(topic)) this._listeners.set(topic, new Set());
    this._listeners.get(topic).add(callback);
  }

  off(topic, callback) {
    const set = this._listeners.get(topic);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this._listeners.delete(topic);
    }
  }

  /** Start streaming a topic via ChannelReader. */
  subscribeTopic(topic) {
    if (!topic) return;
    this._unsubscribedTopics.delete(topic);

    // Already streaming on the current generation? Nothing to do.
    const existing = this._subscriptions.get(topic);
    if (existing && existing.gen === this._generation) return;

    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) {
      this._pendingTopics.add(topic);
      return;
    }

    this._pendingTopics.delete(topic);
    this._beginTopicStream(topic, this.connection, this._generation);
  }

  /** Stop streaming a topic explicitly (user-driven, not lifecycle-driven). */
  unsubscribeTopic(topic) {
    if (!topic) return;
    this._pendingTopics.delete(topic);
    this._unsubscribedTopics.add(topic);
    this._disposeSubscription(topic);
  }

  // ===== LEGACY group-style subscriptions (Subscribe/Unsubscribe invokes) =====

  subscribe = (topic) => {
    if (!topic) return;
    const t = topic.toLowerCase();
    this._subscribedTopics.add(t);
    if (this.connection && this.connection.state === signalR.HubConnectionState.Connected) {
      this.connection.invoke('Subscribe', t).catch((err) => {
        console.error('Subscribe failed:', err);
      });
    }
  }

  unsubscribe = (topic) => {
    if (!topic) return;
    const t = topic.toLowerCase();
    this._subscribedTopics.delete(t);
    if (this.connection && this.connection.state === signalR.HubConnectionState.Connected) {
      this.connection.invoke('Unsubscribe', t).catch((err) => {
        console.error('Unsubscribe failed:', err);
      });
    }
  }

  // ===== STATUS DISPATCH =====

  setStatus = (status) => {
    // Public method kept for compatibility; prefer internal _setStatus.
    this._setStatus(status, 'external');
  }

  _setStatus = (status, reason) => {
    if (status === this.status) {
      // Dedupe identical transitions so listeners (e.g. main.js buffer clear)
      // don't run multiple times per real change.
      return;
    }
    this.status = status;
    this._state = status === 'connected' ? 'connected'
      : status === 'reconnecting' ? 'reconnecting'
      : status === 'connecting' ? 'connecting'
      : status === 'stopping' ? 'stopping'
      : status === 'disposed' ? 'disposed'
      : 'idle';

    // Fan out to all listeners. Errors in one listener must not break others.
    if (this.onStatusChange) {
      try { this.onStatusChange(status, reason); }
      catch (e) { console.error('[SignalR] onStatusChange threw:', e); }
    }
    for (const cb of this._statusListeners) {
      try { cb(status, reason); }
      catch (e) { console.error('[SignalR] status listener threw:', e); }
    }
  }

  // ===== INTERNALS =====

  /**
   * Schedule (or run) a connect attempt. Returns a promise that resolves
   * true on success, false on failure (after which the retry loop continues
   * unless retries are disabled).
   */
  _scheduleConnect(reason) {
    if (this._port == null) return Promise.resolve(false);

    // Already a connect in flight — return that promise.
    if (this._connectPromise) return this._connectPromise;

    // Honor supervisor's retry gate.
    if (this._shouldRetryHook && this._shouldRetryHook(reason) === false) {
      return Promise.resolve(false);
    }

    this._retryEnabled = true;
    this._closing = false;

    this._connectPromise = this._connectInternal(reason)
      .finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  async _connectInternal(reason) {
    // Tear down any leftover connection before building a new one. This
    // ensures stale onclose/onreconnected/stream callbacks have their
    // generation comparison invalidated.
    this._teardownConnection(reason);

    // Allocate a fresh generation for this attempt. ALL async callbacks
    // captured below capture this value and gate their state mutations on
    // gen === this._generation.
    const gen = ++this._generation;
    this._topicHighWater.clear();

    const port = this._port;
    if (port == null) {
      this._setStatus('disconnected', 'no-port');
      return false;
    }

    const hubUrl = `http://localhost:${port}/hub/playground`;
    this._setStatus('connecting', reason);

    let conn;
    try {
      const builder = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl)
        // Keep SignalR's auto-reconnect SHORT — it handles transient blips
        // only. Long-term recovery is owned by our outer retry loop, which
        // composes with supervisor phase gating.
        .withAutomaticReconnect([0, 1000, 2000]);
      conn = builder.build();
      this.connection = conn;
    } catch (err) {
      console.error('[SignalR] Failed to build connection:', err);
      this._setStatus('disconnected', 'build-failed');
      this._scheduleRetry('build-failed');
      return false;
    }

    // Wire lifecycle handlers with generation guards.
    conn.onreconnecting(() => {
      if (gen !== this._generation || this.connection !== conn) return;
      this._setStatus('reconnecting', 'signalr-onreconnecting');
    });

    conn.onreconnected(() => {
      if (gen !== this._generation || this.connection !== conn) return;
      this._setStatus('connected', 'signalr-onreconnected');
      this._resubscribeAll(conn, gen);
    });

    conn.onclose((err) => {
      // CRITICAL: stale onclose from an orphaned connection must not flip
      // a freshly-connected new connection back to disconnected.
      if (gen !== this._generation || this.connection !== conn) {
        if (err) console.log('[SignalR] stale onclose ignored (gen mismatch)');
        return;
      }
      if (this._closing) return;
      this._setStatus('disconnected', 'signalr-onclose');
      this._scheduleRetry('signalr-onclose');
    });

    try {
      await conn.start();
    } catch (err) {
      if (gen !== this._generation || this.connection !== conn) {
        // Lost the race — newer generation already in flight. Drop silently.
        return false;
      }
      console.error('[SignalR] connect failed:', err && err.message ? err.message : err);
      this._setStatus('disconnected', 'start-failed');
      this._scheduleRetry('start-failed');
      return false;
    }

    if (gen !== this._generation || this.connection !== conn) {
      // We won the start() but a newer generation took over. Stop ourselves
      // to avoid leaking. Old gen guards will suppress any callbacks.
      try { conn.stop().catch(() => {}); } catch (_) { /* swallow */ }
      return false;
    }

    this._retryAttempt = 0;
    this._setStatus('connected', reason);
    this._resubscribeAll(conn, gen);
    console.log(`[SignalR] connected to ${hubUrl} (gen=${gen}, reason=${reason})`);
    return true;
  }

  /**
   * Stop and discard the current connection. Old generation callbacks will
   * still fire async but their gen-guard makes them harmless.
   */
  _teardownConnection(reason) {
    // Move all live subscriptions back to pending so they're re-streamed on
    // the next connect, except those that the user explicitly unsubscribed.
    for (const [topic] of this._subscriptions) {
      if (!this._unsubscribedTopics.has(topic)) {
        this._pendingTopics.add(topic);
      }
    }
    // Dispose subscriptions (the disposables, not the streams).
    for (const [, entry] of this._subscriptions) {
      try { if (entry && entry.subscription) entry.subscription.dispose(); }
      catch (_) { /* already closed */ }
    }
    this._subscriptions.clear();

    // Always restore persistent topics on next connect, even if they were
    // never explicitly subscribed (defensive).
    for (const t of this._persistentTopics) {
      if (!this._unsubscribedTopics.has(t)) this._pendingTopics.add(t);
    }

    // Stop the connection — best effort, time-bound. Stale callbacks are
    // guarded by gen, so a slow stop doesn't matter for correctness.
    if (this.connection) {
      const oldConn = this.connection;
      this.connection = null;
      try {
        const stopP = oldConn.stop().catch(() => {});
        // Don't await: bound the wait elsewhere if needed. The next start()
        // does not depend on this stop() completing.
        Promise.race([
          stopP,
          new Promise(resolve => setTimeout(resolve, 500))
        ]).catch(() => {});
      } catch (_) { /* swallow */ }
    }
  }

  /**
   * After connect() success or onreconnected(), re-stream every topic that
   * was active at disconnect time (now in _pendingTopics) and the persistent
   * set, skipping any explicitly unsubscribed. Also replays legacy group
   * subscriptions and re-issues group-style Subscribe invokes.
   */
  _resubscribeAll = (conn, gen) => {
    if (!conn || conn.state !== signalR.HubConnectionState.Connected) return;
    if (gen !== this._generation) return;

    // Legacy group-style Subscribe invokes.
    for (const topic of this._subscribedTopics) {
      conn.invoke('Subscribe', topic).catch(() => {});
    }

    // Topic streams — combine persistent set with whatever was active at
    // disconnect (now in pending). Skip explicit unsubscribes.
    const toRestore = new Set([
      ...this._persistentTopics,
      ...this._pendingTopics
    ]);
    this._pendingTopics.clear();
    for (const topic of toRestore) {
      if (this._unsubscribedTopics.has(topic)) continue;
      this._beginTopicStream(topic, conn, gen);
    }
  }

  /**
   * Start a single topic stream and properly store the subscription
   * disposable (NOT the stream — that's the old bug). All observer callbacks
   * are gen-guarded.
   */
  _beginTopicStream(topic, conn, gen) {
    if (!conn || conn.state !== signalR.HubConnectionState.Connected) {
      this._pendingTopics.add(topic);
      return;
    }

    let stream;
    try {
      stream = conn.stream('SubscribeToTopic', topic);
    } catch (err) {
      console.error('[SignalR] stream(SubscribeToTopic) threw:', topic, err);
      return;
    }

    let subscription;
    try {
      subscription = stream.subscribe({
        next: (event) => {
          if (gen !== this._generation) return;
          const t = (event && event.topic) || topic;
          const cbs = this._listeners.get(t);
          if (cbs) cbs.forEach(cb => {
            try { cb(event); } catch (e) { console.error('[stream listener]', t, e); }
          });
        },
        error: (err) => {
          // Stale error from an orphaned subscription must not delete the
          // new subscription entry for the same topic.
          if (gen !== this._generation) return;
          console.error('[stream error]', topic, err);
          const cur = this._subscriptions.get(topic);
          if (cur && cur.gen === gen) this._subscriptions.delete(topic);
          // Topic remains in persistent/active intent — will be restored on reconnect.
          if (this._persistentTopics.has(topic) || !this._unsubscribedTopics.has(topic)) {
            this._pendingTopics.add(topic);
          }
        },
        complete: () => {
          // Same guard for complete (the original bug: stale complete wiped
          // the new subscription).
          if (gen !== this._generation) return;
          const cur = this._subscriptions.get(topic);
          if (cur && cur.gen === gen) this._subscriptions.delete(topic);
        }
      });
    } catch (err) {
      console.error('[SignalR] stream.subscribe threw:', topic, err);
      return;
    }

    this._subscriptions.set(topic, {
      gen,
      subscription,
      connection: conn,
      topic
    });
  }

  _disposeSubscription(topic) {
    const entry = this._subscriptions.get(topic);
    if (!entry) return;
    try { if (entry.subscription) entry.subscription.dispose(); }
    catch (_) { /* already closed */ }
    this._subscriptions.delete(topic);
  }

  /**
   * Schedule an outer-loop retry after a connect failure or unexpected close.
   * Backoff: 2s, 3s, 5s, 5s, 5s... + jitter. Capped at 5s. Stops when
   * supervisor says no, retries are disabled, or _closing is true.
   */
  _scheduleRetry(reason) {
    if (!this._retryEnabled || this._closing) return;
    if (this._retryTimer) return; // already pending

    if (this._shouldRetryHook && this._shouldRetryHook(reason) === false) {
      // Supervisor says no — don't even schedule.
      return;
    }

    this._retryAttempt += 1;
    const base = Math.min(5000, 2000 + this._retryAttempt * 1000);
    const jitter = Math.floor(Math.random() * 500);
    const delay = base + jitter;

    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this._retryEnabled || this._closing) return;
      if (this._port == null) return;
      if (this._state === 'connected' || this._state === 'connecting') return;
      this._scheduleConnect('retry-' + reason);
    }, delay);
  }
}
