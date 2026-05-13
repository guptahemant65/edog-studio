/**
 * QA Input Stage — PR URL entry, validation, and analysis trigger.
 *
 * Owns Stage 1 DOM. Validates PR URL format, calls QaStartCodeAnalysis
 * via SignalR, persists recent PRs to localStorage.
 */
class QaInput {
  constructor(panel) {
    this._panel = panel;    // QaPanel reference (for getConnection, goToStage, etc.)
    this._input = null;     // input element
    this._btn = null;       // analyze button
    this._errorEl = null;   // error display
    this._historyEl = null; // history list
    this._isAnalyzing = false;
  }

  // ── Lifecycle ──

  init() {
    this._input = document.getElementById('qaPrInput');
    this._btn = document.getElementById('qaAnalyzeBtn');
    this._errorEl = document.getElementById('qaInputError');
    this._historyEl = document.getElementById('qaHistoryList');

    if (this._input) {
      this._input.addEventListener('input', () => this._validate());
      this._input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !this._btn.disabled) this._startAnalysis();
      });
    }
    if (this._btn) {
      this._btn.addEventListener('click', () => this._startAnalysis());
    }

    this._renderHistory();
    this._panel.registerInput(this);
  }

  // ── Validation ──

  _validate() {
    var val = (this._input.value || '').trim();
    this._clearError();

    if (!val) {
      this._btn.disabled = true;
      return;
    }

    var parsed = this._parsePrInput(val);
    this._btn.disabled = !parsed;
  }

  /**
   * Parse PR input — accepts ADO PR URL, #NNN, or bare number.
   * @returns {{ prUrl: string|null, prId: number }|null}
   */
  _parsePrInput(val) {
    // Full ADO PR URL
    var urlMatch = val.match(/pullrequest\/(\d+)/i);
    if (urlMatch) return { prUrl: val, prId: parseInt(urlMatch[1], 10) };

    // PR #12345 or #12345
    var hashMatch = val.match(/^#?(\d+)$/);
    if (hashMatch) return { prId: parseInt(hashMatch[1], 10), prUrl: null };

    // Just a number
    var numMatch = val.match(/^\d+$/);
    if (numMatch) return { prId: parseInt(val, 10), prUrl: null };

    return null;
  }

  // ── Analysis ──

  _startAnalysis() {
    if (this._isAnalyzing) return;
    var val = (this._input.value || '').trim();
    var parsed = this._parsePrInput(val);
    if (!parsed) {
      this._showError('Enter a valid PR URL or PR number');
      return;
    }

    var conn = this._panel.getConnection();
    if (!conn) {
      this._showError('Not connected to FLT service');
      return;
    }

    this._isAnalyzing = true;
    this._btn.disabled = true;
    this._btn.textContent = 'Analyzing\u2026';
    this._clearError();

    var corrId = this._panel.getCorrelationId();
    var request = {
      correlationId: corrId,
      prUrl: parsed.prUrl || null,
      prId: parsed.prId || null,
      options: {
        maxScenarios: 30,
        categories: ['happy_path', 'error_path', 'edge_case', 'regression', 'performance'],
        priorityThreshold: 5,
        includeChaosSuggestions: true,
        timeoutMs: 120000
      }
    };

    var self = this;
    conn.invoke('QaStartCodeAnalysis', request).then(function (result) {
      self._isAnalyzing = false;
      self._btn.textContent = 'Analyze';

      if (result && result.success) {
        self._panel.setAnalysisId(result.analysisId);
        self._addToHistory(parsed.prId, val);
        self._panel.goToStage('analysis');
      } else {
        self._showError((result && result.message) || 'Analysis failed');
        self._btn.disabled = false;
      }
    }).catch(function (err) {
      self._isAnalyzing = false;
      self._btn.textContent = 'Analyze';
      self._btn.disabled = false;
      self._showError('Connection error: ' + (err.message || err));
    });
  }

  // ── Error Display ──

  _showError(msg) {
    if (this._errorEl) {
      this._errorEl.textContent = msg;
      this._errorEl.style.display = '';
    }
  }

  _clearError() {
    if (this._errorEl) {
      this._errorEl.textContent = '';
      this._errorEl.style.display = 'none';
    }
  }

  // ── History (localStorage) ──

  _getHistory() {
    try {
      return JSON.parse(localStorage.getItem('edog-qa-pr-history') || '[]');
    } catch (e) { return []; }
  }

  _addToHistory(prId, inputVal) {
    var history = this._getHistory();
    history = history.filter(function (h) { return h.prId !== prId; });
    history.unshift({ prId: prId, input: inputVal, timestamp: Date.now() });
    if (history.length > 10) history = history.slice(0, 10);
    try {
      localStorage.setItem('edog-qa-pr-history', JSON.stringify(history));
    } catch (e) { /* quota exceeded — safe to ignore */ }
    this._renderHistory();
  }

  _renderHistory() {
    if (!this._historyEl) return;
    var history = this._getHistory();
    var parentEl = document.getElementById('qaInputHistory');

    if (!history.length) {
      if (parentEl) parentEl.style.display = 'none';
      return;
    }
    if (parentEl) parentEl.style.display = '';

    this._historyEl.innerHTML = '';
    for (var i = 0; i < history.length; i++) {
      var item = history[i];
      var el = document.createElement('div');
      el.className = 'qa-history-item';
      el.textContent = 'PR #' + item.prId;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.dataset.pr = item.input;
      el.addEventListener('click', this._onHistoryClick.bind(this));
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') e.currentTarget.click();
      });
      this._historyEl.appendChild(el);
    }
  }

  _onHistoryClick(e) {
    var val = e.currentTarget.dataset.pr;
    this._input.value = val;
    this._validate();
  }

  // ── Public API ──

  /** Reset input for a new PR. */
  reset() {
    if (this._input) this._input.value = '';
    if (this._btn) {
      this._btn.disabled = true;
      this._btn.textContent = 'Analyze';
    }
    this._clearError();
    this._isAnalyzing = false;
  }
}
