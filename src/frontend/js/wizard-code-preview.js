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
   * Regex-based single-line highlighter.
   * Order: comments -> strings -> functions -> types -> keywords.
   * @param {string} raw   Source line
   * @param {string} lang  'sql' | 'python'
   * @returns {string} HTML with <span> wrappers
   */
  _highlightLine(raw, lang) {
    // 1. Escape HTML entities
    var text = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // 2. Comments (greedy — captures rest of line)
    if (lang === 'python') {
      text = text.replace(/(#.*)$/, '<span class="iw-code-cm">$1</span>');
    }
    text = text.replace(/(--.*$)/, '<span class="iw-code-cm">$1</span>');

    // 3. Strings (single-quoted, not inside comments already)
    text = text.replace(
      /('(?:[^'\\]|\\.)*')/g,
      '<span class="iw-code-str">$1</span>'
    );

    // 4. Functions (word immediately followed by open-paren)
    text = text.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?=\()/g,
      function(match, fn) {
        // Skip if already wrapped inside a span (comment/string)
        return '<span class="iw-code-fn">' + fn + '</span>';
      }
    );

    // 5. Types
    text = text.replace(_CODE_TY_RE, function(m) {
      return '<span class="iw-code-ty">' + m + '</span>';
    });

    // 6. Keywords
    text = text.replace(_CODE_KW_RE, function(m) {
      return '<span class="iw-code-kw">' + m + '</span>';
    });

    return text;
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
