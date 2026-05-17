/**
 * CodePreviewPanel — Right collapsible panel showing generated notebook code.
 *
 * Consumes CodeGenerationEngine to produce SQL/PySpark cells from DAG state,
 * renders them with regex-based syntax highlighting, and provides
 * copy-to-clipboard for individual cells and the entire notebook.
 *
 * CSS prefix: .iw-code-
 * Component: C08
 * @author Pixel — EDOG Studio hivemind
 */

/* global CodeGenerationEngine, WizardEventBus, IW_EVENTS */

/* ═══════════════════════════════════════════════════════════════════
   SYNTAX HIGHLIGHTING PATTERNS
   ═══════════════════════════════════════════════════════════════════ */

var _CODE_KW = [
  'SELECT', 'FROM', 'WHERE', 'CREATE', 'TABLE', 'AS', 'INSERT', 'INTO',
  'VALUES', 'SET', 'JOIN', 'ON', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
  'UNION', 'ALL', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'DISTINCT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN',
  'IS', 'NULL', 'BETWEEN', 'LIKE', 'EXISTS', 'MATERIALIZED', 'VIEW',
  'def', 'import', 'from', 'return', 'if', 'else', 'for', 'in',
  'class', 'spark', 'display'
];

var _CODE_TY = [
  'INT', 'BIGINT', 'VARCHAR', 'NVARCHAR', 'DATE', 'DATETIME',
  'FLOAT', 'DECIMAL', 'BIT', 'STRING', 'TIMESTAMP'
];

var _CODE_KW_RE = new RegExp(
  '\\b(' + _CODE_KW.join('|') + ')\\b', 'gi'
);

var _CODE_TY_RE = new RegExp(
  '\\b(' + _CODE_TY.join('|') + ')\\b', 'gi'
);

// O(1) lookup sets for the tokenizing highlighter — populated with both the
// original spelling and its UPPER/lower variants so the tokenizer can do
// case-insensitive membership checks without rebuilding regexes per line.
var _CODE_KW_SET = (function() {
  var s = Object.create(null);
  for (var i = 0; i < _CODE_KW.length; i++) {
    var w = _CODE_KW[i];
    s[w] = true;
    s[w.toUpperCase()] = true;
    s[w.toLowerCase()] = true;
  }
  return s;
})();

var _CODE_TY_SET = (function() {
  var s = Object.create(null);
  for (var i = 0; i < _CODE_TY.length; i++) {
    s[_CODE_TY[i].toUpperCase()] = true;
  }
  return s;
})();

function _ihIsIdStart(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
}

function _ihIsIdPart(c) {
  return _ihIsIdStart(c) || (c >= '0' && c <= '9');
}

function _ihEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════════════════════════════
   CodePreviewPanel CLASS
   ═══════════════════════════════════════════════════════════════════ */

class CodePreviewPanel {

  /**
   * @param {Object} options
   * @param {HTMLElement} options.containerEl  Parent element to render into
   * @param {WizardEventBus} options.eventBus  Per-wizard event bus
   * @param {CodeGenerationEngine} options.codeGen  Code generation engine instance
   */
  constructor(options) {
    /** @type {HTMLElement} */
    this._container = options.containerEl;
    /** @type {WizardEventBus} */
    this._bus = options.eventBus;
    /** @type {CodeGenerationEngine} */
    this._codeGen = options.codeGen;

    /** @type {boolean} */
    this._expanded = false;
    /** @type {boolean} */
    this._isStale = false;
    /** @type {Array|null} */
    this._cells = null;

    /** @type {HTMLElement|null} */
    this._root = null;
    /** @type {HTMLElement|null} */
    this._toggleBtn = null;
    /** @type {HTMLElement|null} */
    this._body = null;
    /** @type {HTMLElement|null} */
    this._refreshBtn = null;
    /** @type {HTMLElement|null} */
    this._copyAllBtn = null;

    /** @type {Function[]} */
    this._unsubs = [];

    this._build();
    this._bindEvents();
  }

  /* ─── Public API ─── */

  expand() {
    this._expanded = true;
    this._root.classList.remove('iw-code-collapsed');
    this._root.style.width = '280px';
    this._root.style.opacity = '1';
    this._root.style.borderLeft = '';
    this._toggleBtn.textContent = '\u25C2'; // ◂
  }

  collapse() {
    this._expanded = false;
    this._root.classList.add('iw-code-collapsed');
    this._root.style.width = '0';
    this._root.style.opacity = '0';
    this._root.style.borderLeft = 'none';
    this._toggleBtn.textContent = '\u25B8'; // ▸
  }

  toggle() {
    if (this._expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  /** @returns {boolean} */
  isExpanded() {
    return this._expanded;
  }

  /**
   * Regenerate code from current DAG state.
   * @param {Array} nodes
   * @param {Array} connections
   * @param {string} theme
   * @param {Object} schemas
   */
  refresh(nodes, connections, theme, schemas) {
    var cells = this._codeGen.generateCells(nodes, connections, theme, schemas);
    this._cells = cells;
    this._renderCells(cells);
    this._isStale = false;
    this._root.classList.remove('iw-code-stale');
    if (this._refreshBtn) {
      this._refreshBtn.classList.remove('iw-code-btn-accent');
    }
  }

  markStale() {
    if (this._isStale) return;
    this._isStale = true;
    this._root.classList.add('iw-code-stale');
    if (this._refreshBtn) {
      this._refreshBtn.classList.add('iw-code-btn-accent');
    }
    if (this._bus) {
      this._bus.emit(IW_EVENTS.CODE_STALE);
    }
  }

  /** @returns {Array|null} Last generated cells */
  getGeneratedCells() {
    return this._cells;
  }

  /** @returns {HTMLElement} */
  getElement() {
    return this._root;
  }

  destroy() {
    for (var i = 0; i < this._unsubs.length; i++) {
      this._unsubs[i]();
    }
    this._unsubs = [];

    if (this._toggleBtn && this._toggleBtn.parentNode) {
      this._toggleBtn.parentNode.removeChild(this._toggleBtn);
    }
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }

    this._root = null;
    this._toggleBtn = null;
    this._body = null;
    this._refreshBtn = null;
    this._copyAllBtn = null;
    this._cells = null;
    this._bus = null;
    this._codeGen = null;
    this._container = null;
  }

  /* ─── DOM Construction ─── */

  _build() {
    // Panel root
    var panel = document.createElement('div');
    panel.className = 'iw-code-panel iw-code-collapsed';
    panel.style.width = '0';
    panel.style.opacity = '0';
    panel.style.overflow = 'hidden';
    panel.style.borderLeft = 'none';
    panel.style.transition = 'width 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease';

    // Header
    var header = document.createElement('div');
    header.className = 'iw-code-header';

    var title = document.createElement('span');
    title.className = 'iw-code-title';
    title.textContent = 'CODE PREVIEW';

    var actions = document.createElement('div');
    actions.className = 'iw-code-actions';

    var copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'iw-code-btn iw-code-copy-all';
    copyAllBtn.textContent = 'Copy All';
    copyAllBtn.type = 'button';

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'iw-code-btn iw-code-refresh';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.type = 'button';

    actions.appendChild(copyAllBtn);
    actions.appendChild(refreshBtn);
    header.appendChild(title);
    header.appendChild(actions);

    // Body (scrollable cell list)
    var body = document.createElement('div');
    body.className = 'iw-code-body';
    this._renderEmpty(body);

    panel.appendChild(header);
    panel.appendChild(body);
    this._container.appendChild(panel);

    // Toggle button (outside panel, positioned absolutely)
    var toggle = document.createElement('div');
    toggle.className = 'iw-code-toggle';
    toggle.textContent = '\u25B8'; // ▸
    this._container.appendChild(toggle);

    // Store refs
    this._root = panel;
    this._body = body;
    this._refreshBtn = refreshBtn;
    this._copyAllBtn = copyAllBtn;
    this._toggleBtn = toggle;

    // Wire header actions
    var self = this;
    toggle.addEventListener('click', function() { self.toggle(); });
    copyAllBtn.addEventListener('click', function() { self._onCopyAll(); });
    refreshBtn.addEventListener('click', function() { self._onRefreshClick(); });
  }

  /* ─── EventBus Subscriptions ─── */

  _bindEvents() {
    if (!this._bus) return;
    var self = this;

    var events = [
      IW_EVENTS.NODE_ADDED,
      IW_EVENTS.NODE_REMOVED,
      IW_EVENTS.CONNECTION_CREATED,
      IW_EVENTS.CONNECTION_REMOVED,
      IW_EVENTS.STATE_CHANGED
    ];

    for (var i = 0; i < events.length; i++) {
      var unsub = this._bus.on(events[i], function() { self.markStale(); });
      this._unsubs.push(unsub);
    }
  }

  /* ─── Rendering ─── */

  _renderCells(cells) {
    this._body.innerHTML = '';

    if (!cells || cells.length === 0) {
      this._renderEmpty(this._body);
      return;
    }

    for (var i = 0; i < cells.length; i++) {
      var cellEl = this._buildCellElement(cells[i]);
      this._body.appendChild(cellEl);
    }
  }

  _renderEmpty(container) {
    container.innerHTML = '';
    var msg = document.createElement('div');
    msg.className = 'iw-code-empty';
    msg.textContent = 'Add nodes to see code preview';
    container.appendChild(msg);
  }

  /**
   * Build DOM for a single code cell.
   * @param {Object} cell  { type, language, nodeId, nodeName, content }
   * @returns {HTMLElement}
   */
  _buildCellElement(cell) {
    var wrapper = document.createElement('div');
    wrapper.className = 'iw-code-cell';
    wrapper.setAttribute('data-node-id', cell.nodeId);

    // Cell header
    var hdr = document.createElement('div');
    hdr.className = 'iw-code-cell-header';

    var label = document.createElement('span');
    label.className = 'iw-code-cell-label';
    var langTag = (cell.language || 'sql').toUpperCase();
    label.textContent = langTag + ' \u2014 ' + (cell.nodeName || 'untitled');

    var copyBtn = document.createElement('button');
    copyBtn.className = 'iw-code-cell-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.type = 'button';

    var self = this;
    copyBtn.addEventListener('click', function() {
      self._copyToClipboard(cell.content);
      self._flashCopied(copyBtn);
    });

    hdr.appendChild(label);
    hdr.appendChild(copyBtn);
    wrapper.appendChild(hdr);

    // Lines
    var lines = (cell.content || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var lineEl = document.createElement('div');
      lineEl.className = 'iw-code-line';

      var gutter = document.createElement('span');
      gutter.className = 'iw-code-gutter';
      gutter.textContent = String(i + 1);

      var text = document.createElement('span');
      text.className = 'iw-code-text';
      text.innerHTML = this._highlightLine(lines[i], cell.language);

      lineEl.appendChild(gutter);
      lineEl.appendChild(text);
      wrapper.appendChild(lineEl);
    }

    return wrapper;
  }

  /* ─── Syntax Highlighting ─── */

  /**
   * Single-pass tokenizing highlighter.
   *
   * The previous regex-pipeline approach ran multiple .replace() passes over
   * a string that already contained injected <span class="..."> markup. The
   * later passes then matched against that markup (e.g. the keyword `class`
   * in `<span class="...">`) and wrapped attribute names in nested spans,
   * producing malformed HTML that the browser rendered as literal text like
   * `class="iw-code-cm">— Create table:`. This tokenizer walks the source
   * once, classifies every char, then emits properly-escaped HTML — so the
   * highlighting markup can never feed back into the highlighter.
   *
   * @param {string} raw   Source line
   * @param {string} lang  'sql' | 'python'
   * @returns {string}     HTML with <span> wrappers
   */
  _highlightLine(raw, lang) {
    var isPython = lang === 'python';
    var i = 0;
    var n = raw.length;
    var out = '';

    while (i < n) {
      var c = raw.charAt(i);

      // ── Comment to end of line ──────────────────────────────────
      if ((isPython && c === '#') || (c === '-' && raw.charAt(i + 1) === '-')) {
        out += '<span class="iw-code-cm">' + _ihEscape(raw.substring(i)) + '</span>';
        break;
      }

      // ── Single-quoted string (with backslash escapes) ───────────
      if (c === "'") {
        var sEnd = i + 1;
        while (sEnd < n) {
          var sc = raw.charAt(sEnd);
          if (sc === '\\' && sEnd + 1 < n) { sEnd += 2; continue; }
          if (sc === "'") { sEnd++; break; }
          sEnd++;
        }
        out += '<span class="iw-code-str">' + _ihEscape(raw.substring(i, sEnd)) + '</span>';
        i = sEnd;
        continue;
      }

      // ── Identifier / keyword / type / function ──────────────────
      if (_ihIsIdStart(c)) {
        var wEnd = i + 1;
        while (wEnd < n && _ihIsIdPart(raw.charAt(wEnd))) wEnd++;
        var word = raw.substring(i, wEnd);

        // Look ahead past spaces for '('
        var look = wEnd;
        while (look < n && raw.charAt(look) === ' ') look++;
        var isCall = raw.charAt(look) === '(';

        var upper = word.toUpperCase();
        var cls = null;
        if (isCall) {
          cls = 'iw-code-fn';
        } else if (_CODE_TY_SET[upper]) {
          cls = 'iw-code-ty';
        } else if (_CODE_KW_SET[word] || _CODE_KW_SET[upper]) {
          cls = 'iw-code-kw';
        }

        if (cls) {
          out += '<span class="' + cls + '">' + _ihEscape(word) + '</span>';
        } else {
          out += _ihEscape(word);
        }
        i = wEnd;
        continue;
      }

      // ── Plain run: numbers, punctuation, whitespace ─────────────
      var pStart = i;
      i++; // guarantee progress
      while (i < n) {
        var pc = raw.charAt(i);
        if (_ihIsIdStart(pc)) break;
        if (pc === "'") break;
        if (isPython && pc === '#') break;
        if (pc === '-' && raw.charAt(i + 1) === '-') break;
        i++;
      }
      out += _ihEscape(raw.substring(pStart, i));
    }

    return out;
  }

  /* ─── Clipboard ─── */

  /**
   * Copy text to clipboard with modern API + fallback.
   * @param {string} text
   */
  _copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  /**
   * Flash copied state on a button.
   * @param {HTMLElement} btn
   */
  _flashCopied(btn) {
    var original = btn.textContent;
    btn.textContent = '\u2714 ok';
    btn.classList.add('iw-code-copied');
    setTimeout(function() {
      btn.textContent = original;
      btn.classList.remove('iw-code-copied');
    }, 1500);
  }

  /* ─── Action Handlers ─── */

  _onCopyAll() {
    if (!this._cells || this._cells.length === 0) return;
    var parts = [];
    for (var i = 0; i < this._cells.length; i++) {
      parts.push(this._cells[i].content);
    }
    this._copyToClipboard(parts.join('\n\n'));
    this._flashCopied(this._copyAllBtn);
  }

  _onRefreshClick() {
    if (this._bus) {
      this._bus.emit(IW_EVENTS.CODE_REGENERATED);
    }
  }
}

window.CodePreviewPanel = CodePreviewPanel;
