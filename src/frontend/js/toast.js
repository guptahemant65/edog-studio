/**
 * ToastManager — unified notification system.
 *
 * Replaces all fragmented _showToast implementations.
 * API: window.edogToast(message, variant, options)
 *
 * @author Pixel — EDOG Studio hivemind
 */
class ToastManager {
  constructor() {
    this._container = null;
    this._toasts = new Map();
    this._queue = [];
    this._maxVisible = 3;
    this._init();
  }

  _init() {
    this._container = document.createElement('div');
    this._container.className = 'toast-container';
    document.body.appendChild(this._container);
  }

  /**
   * Show a toast notification.
   * @param {string} message — text content
   * @param {string} [variant='info'] — 'info' | 'success' | 'warning' | 'error'
   * @param {object} [opts] — { duration, action, id }
   * @returns {string} toast ID
   */
  show(message, variant, opts) {
    variant = variant || 'info';
    opts = opts || {};
    var duration = opts.duration !== undefined ? opts.duration : 4000;
    var id = opts.id || ('t-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));

    // Dedup: if same ID exists, update message and reset timer
    if (this._toasts.has(id)) {
      var existing = this._toasts.get(id);
      var msgEl = existing.el.querySelector('.toast-msg');
      if (msgEl) msgEl.textContent = message;
      if (existing.timer) clearTimeout(existing.timer);
      if (duration > 0) {
        existing.timer = setTimeout(this.dismiss.bind(this, id), duration);
      }
      return id;
    }

    // Queue if at max
    var visible = this._container.children.length;
    if (visible >= this._maxVisible) {
      this._queue.push({ message: message, variant: variant, opts: opts });
      return id;
    }

    this._render(id, message, variant, duration, opts.action || null);
    return id;
  }

  _render(id, message, variant, duration, action) {
    var self = this;
    var el = document.createElement('div');
    el.className = 'toast-item variant-' + variant;
    el.dataset.toastId = id;

    var msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    el.appendChild(msgSpan);

    if (action) {
      var btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', function() {
        if (action.onClick) action.onClick();
        self.dismiss(id);
      });
      el.appendChild(btn);
    }

    var dismiss = document.createElement('button');
    dismiss.className = 'toast-dismiss';
    dismiss.textContent = '\u2715';
    dismiss.addEventListener('click', function() { self.dismiss(id); });
    el.appendChild(dismiss);

    this._container.appendChild(el);

    var timer = null;
    if (duration > 0) {
      timer = setTimeout(function() { self.dismiss(id); }, duration);
    }

    this._toasts.set(id, { el: el, timer: timer });
  }

  /**
   * Dismiss a toast by ID.
   * @param {string} id
   */
  dismiss(id) {
    var entry = this._toasts.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.classList.add('exiting');
    var self = this;
    entry.el.addEventListener('animationend', function() {
      if (entry.el.parentNode) entry.el.remove();
      self._toasts.delete(id);
      self._drainQueue();
    }, { once: true });
    // Fallback if animationend doesn't fire
    setTimeout(function() {
      if (entry.el.parentNode) entry.el.remove();
      self._toasts.delete(id);
      self._drainQueue();
    }, 300);
  }

  /** Dismiss all toasts. */
  clear() {
    var self = this;
    this._toasts.forEach(function(_, id) { self.dismiss(id); });
    this._queue = [];
  }

  _drainQueue() {
    if (this._queue.length === 0) return;
    if (this._container.children.length >= this._maxVisible) return;
    var next = this._queue.shift();
    this.show(next.message, next.variant, next.opts);
  }
}

// Global singleton
window.edogToastManager = new ToastManager();

/**
 * Global toast function.
 * @param {string} message
 * @param {string} [variant='info']
 * @param {object} [opts]
 */
window.edogToast = function(message, variant, opts) {
  return window.edogToastManager.show(message, variant, opts);
};
