/**
 * WizardEventBus — Per-instance pub/sub for wizard components.
 *
 * NOT a global singleton. One instance per InfraWizardDialog.
 * Created in InfraWizardDialog constructor, passed to all child components.
 * destroy() clears all listeners to prevent stale refs after wizard close.
 *
 * CSS prefix: .iw-
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   EVENT BUS
   ═══════════════════════════════════════════════════════════════════ */

class WizardEventBus {

  constructor() {
    /** @type {Object<string, Function[]>|null} */
    this._listeners = {};
  }

  /* ─── Subscribe ─── */

  /**
   * Register a handler for an event.
   * @param {string} event  Event name (use IW_EVENTS constants)
   * @param {Function} handler  Callback receiving (data)
   * @returns {Function} Unsubscribe function
   */
  on(event, handler) {
    if (!this._listeners) return function() {};
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(handler);

    var self = this;
    var removed = false;
    return function() {
      if (removed) return;
      removed = true;
      self.off(event, handler);
    };
  }

  /* ─── Unsubscribe ─── */

  /**
   * Remove a specific handler from an event.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    if (!this._listeners) return;
    var list = this._listeners[event];
    if (!list) return;
    var idx = list.indexOf(handler);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      delete this._listeners[event];
    }
  }

  /* ─── Emit ─── */

  /**
   * Dispatch an event to all registered handlers.
   * Swallows handler errors to prevent one bad listener from
   * breaking the entire event chain.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    if (!this._listeners) return;
    var list = this._listeners[event];
    if (!list) return;
    // Snapshot the array so mid-emit subscribe/unsubscribe is safe
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](data);
      } catch (err) {
        console.error('[WizardEventBus] Handler threw on "' + event + '":', err);
      }
    }
  }

  /* ─── Destroy ─── */

  /**
   * Clear ALL listeners and null out the map.
   * Call on wizard close to prevent memory leaks.
   */
  destroy() {
    this._listeners = null;
  }

  /* ─── Debug Helpers ─── */

  /**
   * Return the number of handlers registered for an event.
   * Returns 0 if the bus has been destroyed.
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    if (!this._listeners) return 0;
    var list = this._listeners[event];
    return list ? list.length : 0;
  }
}

window.WizardEventBus = WizardEventBus;
