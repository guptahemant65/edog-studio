/**
 * QA Scenario Editor — Slide-from-right overlay for editing scenarios.
 *
 * Owns qaEditorOverlay. Opens via panel.openEditor(scenario),
 * closes via panel.closeEditor() or Escape key. Updates scenario
 * in QaCuration on save.
 */
class QaEditor {
  constructor(panel) {
    this._panel = panel;
    this._overlay = null;
    this._bodyEl = null;
    this._titleEl = null;
    this._scenario = null;     // the scenario being edited (deep copy)
    this._isOpen = false;
    this._boundKeydown = this._onKeydown.bind(this);
  }

  // ── Lifecycle ──

  init() {
    this._overlay = document.getElementById('qaEditorOverlay');
    this._bodyEl = document.getElementById('qaEditorBody');
    this._titleEl = document.getElementById('qaEditorTitle');

    var closeBtn = document.getElementById('qaEditorClose');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    var cancelBtn = document.getElementById('qaEditorCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());

    var saveBtn = document.getElementById('qaEditorSave');
    if (saveBtn) saveBtn.addEventListener('click', () => this._save());

    // Backdrop click closes
    if (this._overlay) {
      this._overlay.addEventListener('click', (e) => {
        if (e.target === this._overlay) this.close();
      });
    }

    this._panel.registerEditor(this);
  }

  // ── Public API ──

  open(scenario) {
    if (!scenario || !this._overlay) return;
    this._scenario = JSON.parse(JSON.stringify(scenario));
    this._isOpen = true;
    this._overlay.classList.add('open');
    if (this._titleEl) {
      this._titleEl.textContent = 'Edit: ' + (scenario.title || scenario.id);
    }
    this._renderForm();
    document.addEventListener('keydown', this._boundKeydown);
    // Focus first input after slide animation
    setTimeout(() => {
      var first = this._bodyEl && this._bodyEl.querySelector('input, textarea, select');
      if (first) first.focus();
    }, 100);
  }

  close() {
    this._isOpen = false;
    if (this._overlay) this._overlay.classList.remove('open');
    this._scenario = null;
    document.removeEventListener('keydown', this._boundKeydown);
  }

  get isOpen() { return this._isOpen; }

  // ── Keyboard ──

  _onKeydown(e) {
    if (!this._isOpen) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
      return;
    }
    // Focus trap: Tab cycles within the panel
    if (e.key === 'Tab') {
      var panel = document.getElementById('qaEditorPanel');
      if (!panel) return;
      var focusable = panel.querySelectorAll(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  // ── Form Rendering ──

  _renderForm() {
    if (!this._bodyEl || !this._scenario) return;
    this._bodyEl.innerHTML = '';
    var scn = this._scenario;

    // Title
    this._addField('Title', 'text', scn.title, 'qa-editor-title-input',
      function(val) { scn.title = val; });

    // Category
    this._addSelect('Category',
      ['happy_path', 'error_path', 'edge_case', 'regression', 'performance'],
      scn.category, function(val) { scn.category = val; });

    // Priority
    this._addField('Priority', 'number', scn.priority, 'qa-editor-priority',
      function(val) { scn.priority = parseInt(val, 10) || 1; },
      { min: 1, max: 10 });

    // Timeout
    this._addField('Timeout (ms)', 'number', scn.timeout, 'qa-editor-timeout',
      function(val) { scn.timeout = parseInt(val, 10) || 20000; },
      { min: 1000, max: 60000, step: 1000 });

    // Stimulus (JSON)
    var stimLabel = document.createElement('label');
    stimLabel.className = 'qa-editor-label';
    stimLabel.textContent = 'Stimulus (JSON)';
    this._bodyEl.appendChild(stimLabel);

    var stimArea = document.createElement('textarea');
    stimArea.className = 'qa-editor-textarea';
    stimArea.rows = 6;
    stimArea.value = JSON.stringify(scn.stimulus || {}, null, 2);
    stimArea.addEventListener('input', function() {
      try {
        scn.stimulus = JSON.parse(stimArea.value);
        stimArea.classList.remove('qa-editor-invalid');
      } catch (_) {
        stimArea.classList.add('qa-editor-invalid');
      }
    });
    this._bodyEl.appendChild(stimArea);

    // Expectations (JSON array)
    var expCount = scn.expectations ? scn.expectations.length : 0;
    var expLabel = document.createElement('label');
    expLabel.className = 'qa-editor-label';
    expLabel.textContent = 'Expectations (' + expCount + ')';
    this._bodyEl.appendChild(expLabel);

    var expArea = document.createElement('textarea');
    expArea.className = 'qa-editor-textarea';
    expArea.rows = 10;
    expArea.value = JSON.stringify(scn.expectations || [], null, 2);
    expArea.addEventListener('input', function() {
      try {
        var parsed = JSON.parse(expArea.value);
        if (Array.isArray(parsed)) {
          scn.expectations = parsed;
          expArea.classList.remove('qa-editor-invalid');
        }
      } catch (_) {
        expArea.classList.add('qa-editor-invalid');
      }
    });
    this._bodyEl.appendChild(expArea);

    // Description
    this._addField('Description', 'textarea', scn.description || '', 'qa-editor-desc',
      function(val) { scn.description = val; });
  }

  // ── Field Helpers ──

  _addField(label, type, value, id, onChange, attrs) {
    var labelEl = document.createElement('label');
    labelEl.className = 'qa-editor-label';
    labelEl.textContent = label;
    this._bodyEl.appendChild(labelEl);

    var input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'qa-editor-textarea';
      input.rows = 3;
      input.value = value || '';
    } else {
      input = document.createElement('input');
      input.className = 'qa-editor-input';
      input.type = type;
      input.value = value != null ? value : '';
    }
    if (id) input.id = id;
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          input[key] = attrs[key];
        }
      }
    }
    input.addEventListener('input', function() { onChange(input.value); });
    this._bodyEl.appendChild(input);
    return input;
  }

  _addSelect(label, options, current, onChange) {
    var labelEl = document.createElement('label');
    labelEl.className = 'qa-editor-label';
    labelEl.textContent = label;
    this._bodyEl.appendChild(labelEl);

    var select = document.createElement('select');
    select.className = 'qa-editor-select';
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement('option');
      opt.value = options[i];
      opt.textContent = options[i].replace(/_/g, ' ');
      if (options[i] === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', function() { onChange(select.value); });
    this._bodyEl.appendChild(select);
    return select;
  }

  // ── Save ──

  _save() {
    if (!this._scenario) return;
    if (this._panel._curation) {
      this._panel._curation.updateScenario(this._scenario);
    }
    window.edogToast && window.edogToast.show('Scenario updated', 'info');
    this.close();
  }
}
