/**
 * HttpRowMenu — F28 right-click context menu for HTTP rows.
 *
 * Glass-morphism panel with staggered fade-in. Items:
 *   Send to Playground │ Copy URL · Copy as cURL · Copy as fetch
 *                      │ Block this URL
 *                      │ Save as HAR · Delete
 *
 * Public API:
 *   const menu = new HttpRowMenu();
 *   menu.show(x, y, rowData, {
 *     onPlayground, onCopyUrl, onCopyCurl, onCopyFetch,
 *     onBlock, onHar, onDelete
 *   });
 *   menu.hide();
 *   menu.destroy();
 *
 * Dismiss vectors: click outside, Escape, item click, scroll, window blur.
 * Keyboard: ArrowUp/Down navigate, Home/End jump, Enter activates, Esc closes,
 *           single-char shortcuts (P for Playground, B for Block).
 */
class HttpRowMenu {
  constructor() {
    this._el = null;
    this._items = [];
    this._focusedIdx = 0;
    this._callbacks = null;
    this._rowData = null;

    this._onDocClick = this._onDocClick.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onBlur = this._onBlur.bind(this);

    this._buildDOM();
  }

  _buildDOM() {
    var el = document.createElement('div');
    el.className = 'http-row-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';

    // Item spec — order matters for staggered animation.
    var spec = [
      { id: 'playground', label: 'Send to Playground', shortcut: 'P', cb: 'onPlayground' },
      { sep: true },
      { id: 'copyUrl',   label: 'Copy URL',            shortcut: '',           cb: 'onCopyUrl' },
      { id: 'copyCurl',  label: 'Copy as cURL',        shortcut: 'Ctrl+Shift+C', cb: 'onCopyCurl' },
      { id: 'copyFetch', label: 'Copy as fetch',       shortcut: '',           cb: 'onCopyFetch' },
      { sep: true },
      { id: 'block',     label: 'Block this URL',      shortcut: 'B',  cb: 'onBlock' },
      { sep: true },
      { id: 'har',       label: 'Save as HAR',         shortcut: '',   cb: 'onHar' },
      { id: 'delete',    label: 'Delete',              shortcut: 'Del', cb: 'onDelete', danger: true }
    ];

    var staggerDelay = 0;
    for (var i = 0; i < spec.length; i++) {
      var s = spec[i];
      if (s.sep) {
        var sep = document.createElement('div');
        sep.className = 'http-row-menu-sep';
        sep.setAttribute('role', 'separator');
        el.appendChild(sep);
        continue;
      }
      var item = document.createElement('div');
      item.className = 'http-row-menu-item' + (s.danger ? ' danger' : '');
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.dataset.action = s.id;
      item.dataset.cb = s.cb;
      if (s.shortcut) item.dataset.key = s.shortcut.charAt(0).toLowerCase();
      item.style.animationDelay = staggerDelay + 'ms';
      staggerDelay += 28;

      var label = document.createElement('span');
      label.className = 'http-row-menu-label';
      label.textContent = s.label;
      item.appendChild(label);

      if (s.shortcut) {
        var kb = document.createElement('span');
        kb.className = 'http-row-menu-shortcut';
        kb.textContent = s.shortcut;
        item.appendChild(kb);
      }

      item.addEventListener('mouseenter', this._onItemHover.bind(this, item));
      item.addEventListener('click', this._onItemClick.bind(this, item));
      el.appendChild(item);
      this._items.push(item);
    }

    document.body.appendChild(el);
    this._el = el;
  }

  show(x, y, rowData, callbacks) {
    this._rowData = rowData || null;
    this._callbacks = callbacks || {};
    this._focusedIdx = 0;

    var el = this._el;
    el.style.display = '';
    el.setAttribute('aria-hidden', 'false');

    // Reset stagger animations by re-toggling display.
    for (var i = 0; i < this._items.length; i++) {
      var it = this._items[i];
      it.classList.remove('focused', 'activated');
      // Restart animation
      it.style.animation = 'none';
      // Force reflow
      void it.offsetWidth;
      it.style.animation = '';
    }

    // Position: prefer bottom-right of cursor; flip if off-screen.
    var rect = el.getBoundingClientRect();
    var menuW = rect.width || 224;
    var menuH = rect.height || 280;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var nx = (x + menuW + 8 > vw) ? Math.max(8, x - menuW) : x + 2;
    var ny = (y + menuH + 8 > vh) ? Math.max(8, y - menuH) : y + 2;
    el.style.left = nx + 'px';
    el.style.top = ny + 'px';

    if (this._items[0]) {
      this._setFocused(0);
    }

    // Register dismiss handlers.
    setTimeout(() => {
      document.addEventListener('mousedown', this._onDocClick, true);
      document.addEventListener('keydown', this._onKey, true);
      window.addEventListener('scroll', this._onScroll, true);
      window.addEventListener('blur', this._onBlur);
    }, 0);
  }

  hide() {
    if (!this._el || this._el.style.display === 'none') return;
    this._el.classList.add('closing');
    var self = this;
    setTimeout(function() {
      if (!self._el) return;
      self._el.style.display = 'none';
      self._el.classList.remove('closing');
      self._el.setAttribute('aria-hidden', 'true');
    }, 100);

    document.removeEventListener('mousedown', this._onDocClick, true);
    document.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('scroll', this._onScroll, true);
    window.removeEventListener('blur', this._onBlur);
    this._callbacks = null;
    this._rowData = null;
  }

  destroy() {
    this.hide();
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
    this._el = null;
    this._items = [];
  }

  _onItemHover(item) {
    var idx = this._items.indexOf(item);
    if (idx >= 0) this._setFocused(idx);
  }

  _onItemClick(item) {
    this._activate(item);
  }

  _activate(item) {
    if (!item) return;
    item.classList.add('activated');
    var cbName = item.dataset.cb;
    var cb = this._callbacks && this._callbacks[cbName];
    var self = this;
    setTimeout(function() {
      try { if (typeof cb === 'function') cb(self._rowData); } catch (e) { console.error('[row-menu]', e); }
      self.hide();
    }, 60);
  }

  _setFocused(idx) {
    this._focusedIdx = idx;
    for (var i = 0; i < this._items.length; i++) {
      this._items[i].classList.toggle('focused', i === idx);
    }
    var el = this._items[idx];
    if (el && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (_e) { el.focus(); }
    }
  }

  _onDocClick(e) {
    if (this._el && this._el.contains(e.target)) return;
    this.hide();
  }

  _onScroll() { this.hide(); }
  _onBlur() { this.hide(); }

  _onKey(e) {
    if (!this._el || this._el.style.display === 'none') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._setFocused((this._focusedIdx + 1) % this._items.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._setFocused((this._focusedIdx - 1 + this._items.length) % this._items.length);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      this._setFocused(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      this._setFocused(this._items.length - 1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this._activate(this._items[this._focusedIdx]);
      return;
    }
    // Single-char shortcut activation
    var ch = (e.key || '').toLowerCase();
    if (ch && ch.length === 1) {
      for (var i = 0; i < this._items.length; i++) {
        if (this._items[i].dataset.key === ch) {
          e.preventDefault();
          this._activate(this._items[i]);
          return;
        }
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.HttpRowMenu = HttpRowMenu;
}
