/**
 * WorkspaceExplorer — Three-panel workspace browser with context menu,
 * rename/delete, deploy flow, favorites, toast notifications, and mock mode.
 *
 * Panels: Tree (left) · Content (center) · Inspector (right)
 *
 * @author Zara Okonkwo — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════
   Create-dialog shared validation
   ═══════════════════════════════════════════════════════════════ */
var WsCreateValidation = {
  NAME_MIN: 3,
  NAME_MAX: 256,
  NAME_RE: /^[A-Za-z0-9][A-Za-z0-9 _-]*$/,

  /** Validate a workspace/lakehouse name. Returns {valid, error}. */
  validateName: function(name, existingNames) {
    var trimmed = (name || '').trim();
    if (!trimmed) return { valid: false, error: '' };
    if (trimmed.length < this.NAME_MIN) {
      return { valid: false, error: 'Name must be at least ' + this.NAME_MIN + ' characters' };
    }
    if (trimmed.length > this.NAME_MAX) {
      return { valid: false, error: 'Name must be at most ' + this.NAME_MAX + ' characters' };
    }
    if (!this.NAME_RE.test(trimmed)) {
      return { valid: false, error: 'Only letters, numbers, hyphens, underscores, spaces' };
    }
    var lower = trimmed.toLowerCase();
    for (var i = 0; i < existingNames.length; i++) {
      if ((existingNames[i] || '').toLowerCase() === lower) {
        return { valid: false, error: 'A workspace with this name already exists' };
      }
    }
    return { valid: true, error: '' };
  },

  /** Validate lakehouse name against workspace items. Returns {valid, error}. */
  validateLakehouseName: function(name, existingItemNames) {
    var result = this.validateName(name, []);
    if (!result.valid) return result;
    var trimmed = (name || '').trim().toLowerCase();
    for (var i = 0; i < existingItemNames.length; i++) {
      if ((existingItemNames[i] || '').toLowerCase() === trimmed) {
        return { valid: false, error: 'An item with this name already exists in this workspace' };
      }
    }
    return { valid: true, error: '' };
  }
};

/* ═══════════════════════════════════════════════════════════════
   WorkspaceCreateDialog — modal for creating a Fabric workspace
   States: empty → valid/invalid → capacity-loading → ready → creating → success/failure
   ═══════════════════════════════════════════════════════════════ */
class WorkspaceCreateDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._existingNames = (opts.existingWorkspaces || []).map(function(w) { return w.displayName; });
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._counterEl = null;
    this._nameValidEl = null;
    this._capListEl = null;
    this._createBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._selectedCapacity = null;
    this._capacitiesLoaded = false;
    this._state = 'idle'; // idle | creating | success | failed
    this.onComplete = null;
    this.onClose = null;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    this._nameInput.focus();
    this._loadCapacities();
    this._boundKeydown = this._onKeydown.bind(this);
    document.addEventListener('keydown', this._boundKeydown);
  }

  close() {
    if (!this._overlayEl) return;
    if (this._state === 'idle' && this._nameInput && this._nameInput.value.trim()) {
      if (!confirm('Discard workspace creation?')) return;
    }
    document.removeEventListener('keydown', this._boundKeydown);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') this.close();
    if (e.key === 'Enter' && !this._createBtn.disabled) this._submit();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Create workspace');
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    header.innerHTML =
      '<div class="ws-cd-header-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
      '</div>' +
      '<div class="ws-cd-title">Create Workspace</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner (hidden initially)
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'ws-cd-field';
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-cd-label';
    nameLabel.textContent = 'WORKSPACE NAME';
    nameField.appendChild(nameLabel);

    var nameWrap = document.createElement('div');
    nameWrap.className = 'ws-cd-input-wrap';
    this._nameInput = document.createElement('input');
    this._nameInput.className = 'ws-cd-input';
    this._nameInput.type = 'text';
    this._nameInput.placeholder = 'Enter workspace name';
    this._nameInput.maxLength = WsCreateValidation.NAME_MAX;
    this._nameInput.setAttribute('aria-label', 'Workspace name');
    this._nameInput.addEventListener('input', function() { self._validateName(); });
    nameWrap.appendChild(this._nameInput);

    this._counterEl = document.createElement('span');
    this._counterEl.className = 'ws-cd-counter';
    this._counterEl.textContent = '0 / ' + WsCreateValidation.NAME_MAX;
    nameWrap.appendChild(this._counterEl);

    nameField.appendChild(nameWrap);
    this._nameValidEl = document.createElement('div');
    this._nameValidEl.className = 'ws-cd-error';
    this._nameValidEl.style.display = 'none';
    nameField.appendChild(this._nameValidEl);
    body.appendChild(nameField);

    // Capacity field
    var capField = document.createElement('div');
    capField.className = 'ws-cd-field';
    var capLabel = document.createElement('div');
    capLabel.className = 'ws-cd-label';
    capLabel.innerHTML = 'CAPACITY <span class="ws-cd-label-opt">(optional)</span>';
    capField.appendChild(capLabel);
    this._capListEl = document.createElement('div');
    this._capListEl.className = 'ws-cd-cap-list';
    // Shimmer placeholders
    this._capListEl.innerHTML =
      '<div class="ws-cd-shimmer"></div>' +
      '<div class="ws-cd-shimmer" style="animation-delay:0.15s"></div>';
    capField.appendChild(this._capListEl);
    body.appendChild(capField);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._createBtn = document.createElement('button');
    this._createBtn.className = 'ws-cd-btn ws-cd-btn-primary';
    this._createBtn.textContent = 'Create Workspace';
    this._createBtn.disabled = true;
    this._createBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._createBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar (hidden)
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _validateName() {
    var name = this._nameInput.value;
    this._counterEl.textContent = name.length + ' / ' + WsCreateValidation.NAME_MAX;
    var result = WsCreateValidation.validateName(name, this._existingNames);

    // Remove previous state classes
    this._nameInput.classList.remove('valid', 'invalid');
    this._nameValidEl.style.display = 'none';
    // Remove any existing check icon
    var existing = this._nameInput.parentNode.querySelector('.ws-cd-check');
    if (existing) existing.remove();

    if (!name.trim()) {
      // Empty — neutral
      this._counterEl.style.display = '';
    } else if (result.valid) {
      this._nameInput.classList.add('valid');
      this._counterEl.style.display = 'none';
      var check = document.createElement('span');
      check.className = 'ws-cd-check';
      check.textContent = '\u2713';
      this._nameInput.parentNode.appendChild(check);
    } else {
      this._nameInput.classList.add('invalid');
      this._nameValidEl.textContent = result.error;
      this._nameValidEl.style.display = '';
    }

    this._updateCreateBtn();
  }

  _updateCreateBtn() {
    var nameValid = WsCreateValidation.validateName(this._nameInput.value, this._existingNames).valid;
    var ready = nameValid && this._capacitiesLoaded && this._state === 'idle';
    this._createBtn.disabled = !ready;
    if (ready) {
      this._createBtn.classList.add('ready');
    } else {
      this._createBtn.classList.remove('ready');
    }
  }

  _loadCapacities() {
    var self = this;
    this._api.listCapacities().then(function(resp) {
      var caps = (resp && resp.value) ? resp.value : [];
      self._capacitiesLoaded = true;
      self._renderCapacities(caps);
      self._updateCreateBtn();
    }).catch(function(err) {
      self._capacitiesLoaded = true;
      self._capListEl.innerHTML = '';
      var errCard = document.createElement('div');
      errCard.className = 'ws-cd-cap-error';
      errCard.innerHTML = '<span>\u2715 Could not load capacities</span>';
      var retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', function() {
        self._capListEl.innerHTML =
          '<div class="ws-cd-shimmer"></div><div class="ws-cd-shimmer" style="animation-delay:0.15s"></div>';
        self._capacitiesLoaded = false;
        self._loadCapacities();
      });
      errCard.appendChild(retryBtn);
      self._capListEl.appendChild(errCard);
      self._updateCreateBtn();
    });
  }

  _renderCapacities(caps) {
    var self = this;
    this._capListEl.innerHTML = '';

    // Default (no capacity) option
    var defaultCard = this._buildCapCard({ id: '', displayName: 'Default capacity', sku: '', region: '' });
    defaultCard.classList.add('selected');
    this._selectedCapacity = null;
    this._capListEl.appendChild(defaultCard);

    for (var i = 0; i < caps.length; i++) {
      var card = this._buildCapCard(caps[i]);
      card.style.animationDelay = ((i + 1) * 60) + 'ms';
      this._capListEl.appendChild(card);
    }
  }

  _buildCapCard(cap) {
    var self = this;
    var card = document.createElement('div');
    card.className = 'ws-cd-cap-card';
    card.dataset.capId = cap.id || '';

    var radio = document.createElement('div');
    radio.className = 'ws-cd-cap-radio';
    card.appendChild(radio);

    var name = document.createElement('div');
    name.className = 'ws-cd-cap-name';
    name.textContent = cap.displayName || cap.id || 'Unknown';
    card.appendChild(name);

    if (cap.sku) {
      var sku = document.createElement('span');
      sku.className = 'ws-cd-cap-sku';
      sku.textContent = cap.sku;
      card.appendChild(sku);
    }
    if (cap.region) {
      var region = document.createElement('span');
      region.className = 'ws-cd-cap-region';
      region.textContent = cap.region;
      card.appendChild(region);
    }

    card.addEventListener('click', function() {
      self._capListEl.querySelectorAll('.ws-cd-cap-card').forEach(function(c) {
        c.classList.remove('selected');
      });
      card.classList.add('selected');
      self._selectedCapacity = cap.id || null;
      self._updateCreateBtn();
    });
    return card;
  }

  _submit() {
    if (this._state !== 'idle') return;
    var nameResult = WsCreateValidation.validateName(this._nameInput.value, this._existingNames);
    if (!nameResult.valid) {
      this._nameInput.classList.add('invalid');
      return;
    }

    var self = this;
    var name = this._nameInput.value.trim();
    this._state = 'creating';
    this._createBtn.disabled = true;
    this._createBtn.classList.remove('ready');
    this._createBtn.innerHTML = '<span class="ws-cd-spinner"></span>Creating\u2026';
    this._nameInput.disabled = true;
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';

    this._api.createWorkspace(name, this._selectedCapacity).then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(name, result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Create failed');
    });
  }

  _showSuccess(name, result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-success-name">' + this._esc(name) + '</div>' +
        '<div class="ws-cd-success-sub">Workspace created successfully</div>' +
        '<button class="ws-cd-btn ws-cd-btn-primary">Open Workspace</button>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    body.querySelector('.ws-cd-btn-primary').addEventListener('click', function() {
      self._finish(result);
    });

    // Auto-close after 3s
    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(result);
    }, 3000);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundKeydown);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._nameInput.disabled = false;
    this._createBtn.innerHTML = 'Create Workspace';
    this._createBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  _showNoAuth() {
    if (!this._dialogEl) return;
    var overlay = document.createElement('div');
    overlay.className = 'ws-cd-noauth';
    overlay.innerHTML = '<div class="ws-cd-noauth-msg">Sign in to create workspaces</div>';
    var btn = document.createElement('button');
    btn.className = 'ws-cd-btn ws-cd-btn-primary';
    btn.textContent = 'Close';
    btn.addEventListener('click', this.close.bind(this));
    overlay.appendChild(btn);
    this._dialogEl.appendChild(overlay);
  }
}

/* ═══════════════════════════════════════════════════════════════
   LakehouseCreateDialog— modal for creating a lakehouse in a workspace
   States: empty → valid/invalid → schemas → creating → success/failure
   ═══════════════════════════════════════════════════════════════ */
class LakehouseCreateDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._workspaceId = opts.workspaceId;
    this._workspaceName = opts.workspaceName || '';
    this._existingItemNames = (opts.existingItems || []).map(function(it) { return it.displayName; });
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._descInput = null;
    this._counterEl = null;
    this._descCounterEl = null;
    this._nameValidEl = null;
    this._createBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._schemasEnabled = true;
    this._selectedSchemas = { dbo: true, bronze: false, silver: false, gold: false };
    this._state = 'idle';
    this.onComplete = null;
    this.onClose = null;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    this._nameInput.focus();
    this._boundKeydown = this._onKeydown.bind(this);
    document.addEventListener('keydown', this._boundKeydown);
  }

  close() {
    if (!this._overlayEl) return;
    if (this._state === 'idle' && this._nameInput && this._nameInput.value.trim()) {
      if (!confirm('Discard lakehouse creation?')) return;
    }
    document.removeEventListener('keydown', this._boundKeydown);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') this.close();
    if (e.key === 'Enter' && !this._createBtn.disabled) this._submit();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Create lakehouse');
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    header.innerHTML =
      '<div class="ws-cd-header-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>' +
      '</div>' +
      '<div class="ws-cd-title">Create Lakehouse</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Context chip
    var ctx = document.createElement('div');
    ctx.className = 'ws-cd-context';
    ctx.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
      '<span>' + this._esc(this._workspaceName) + '</span>';
    body.appendChild(ctx);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'ws-cd-field';
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-cd-label';
    nameLabel.textContent = 'LAKEHOUSE NAME';
    nameField.appendChild(nameLabel);
    var nameWrap = document.createElement('div');
    nameWrap.className = 'ws-cd-input-wrap';
    this._nameInput = document.createElement('input');
    this._nameInput.className = 'ws-cd-input';
    this._nameInput.type = 'text';
    this._nameInput.placeholder = 'Enter lakehouse name';
    this._nameInput.maxLength = WsCreateValidation.NAME_MAX;
    this._nameInput.addEventListener('input', function() { self._validateName(); });
    nameWrap.appendChild(this._nameInput);
    this._counterEl = document.createElement('span');
    this._counterEl.className = 'ws-cd-counter';
    this._counterEl.textContent = '0 / ' + WsCreateValidation.NAME_MAX;
    nameWrap.appendChild(this._counterEl);
    nameField.appendChild(nameWrap);
    this._nameValidEl = document.createElement('div');
    this._nameValidEl.className = 'ws-cd-error';
    this._nameValidEl.style.display = 'none';
    nameField.appendChild(this._nameValidEl);
    body.appendChild(nameField);

    // Description field
    var descField = document.createElement('div');
    descField.className = 'ws-cd-field';
    var descLabel = document.createElement('div');
    descLabel.className = 'ws-cd-label';
    descLabel.innerHTML = 'DESCRIPTION <span class="ws-cd-label-opt">(optional)</span>';
    descField.appendChild(descLabel);
    this._descInput = document.createElement('textarea');
    this._descInput.className = 'ws-cd-textarea';
    this._descInput.placeholder = 'What is this lakehouse for?';
    this._descInput.maxLength = 256;
    this._descCounterEl = document.createElement('div');
    this._descCounterEl.className = 'ws-cd-counter';
    this._descCounterEl.style.position = 'static';
    this._descCounterEl.style.textAlign = 'right';
    this._descCounterEl.style.marginTop = '2px';
    this._descCounterEl.textContent = '0 / 256';
    this._descInput.addEventListener('input', function() {
      self._descCounterEl.textContent = self._descInput.value.length + ' / 256';
    });
    descField.appendChild(this._descInput);
    descField.appendChild(this._descCounterEl);
    body.appendChild(descField);

    // Enable Schemas toggle
    var schemaField = document.createElement('div');
    schemaField.className = 'ws-cd-field';
    var toggleRow = document.createElement('div');
    toggleRow.className = 'ws-cd-toggle-row';
    var schemaLabel = document.createElement('div');
    schemaLabel.className = 'ws-cd-label';
    schemaLabel.style.marginBottom = '0';
    schemaLabel.textContent = 'ENABLE SCHEMAS';
    toggleRow.appendChild(schemaLabel);
    this._toggleEl = document.createElement('button');
    this._toggleEl.className = 'ws-cd-toggle on';
    this._toggleEl.setAttribute('role', 'switch');
    this._toggleEl.setAttribute('aria-checked', 'true');
    this._toggleEl.addEventListener('click', function() { self._toggleSchemas(); });
    toggleRow.appendChild(this._toggleEl);
    schemaField.appendChild(toggleRow);
    var hint = document.createElement('div');
    hint.className = 'ws-cd-toggle-hint';
    hint.textContent = 'Enables multi-schema support (dbo, bronze, silver, gold). Required for FLT.';
    schemaField.appendChild(hint);

    // Schema pills
    this._schemasEl = document.createElement('div');
    this._schemasEl.className = 'ws-cd-schemas expanded';
    var SCHEMAS = [
      { id: 'dbo', label: 'dbo', color: 'var(--accent, #6d5cff)', locked: true },
      { id: 'bronze', label: 'bronze', color: '#cd7f32' },
      { id: 'silver', label: 'silver', color: '#a0a0a0' },
      { id: 'gold', label: 'gold', color: '#d4a017' }
    ];
    for (var i = 0; i < SCHEMAS.length; i++) {
      var s = SCHEMAS[i];
      var pill = document.createElement('div');
      pill.className = 'ws-cd-pill' + (s.locked ? ' locked selected' : '');
      pill.dataset.schema = s.id;
      var dot = document.createElement('span');
      dot.className = 'ws-cd-pill-dot';
      dot.style.background = s.color;
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(s.label));
      if (s.locked) {
        var lock = document.createElement('span');
        lock.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle"><path d="M18 10h-1V6A5 5 0 0 0 7 6v4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2m-6 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4M9 10V6a3 3 0 0 1 6 0v4z"/></svg>';
        pill.appendChild(lock);
      }
      if (!s.locked) {
        pill.addEventListener('click', (function(schema, el) {
          return function() {
            self._selectedSchemas[schema] = !self._selectedSchemas[schema];
            el.classList.toggle('selected', self._selectedSchemas[schema]);
          };
        })(s.id, pill));
      }
      this._schemasEl.appendChild(pill);
    }
    schemaField.appendChild(this._schemasEl);
    body.appendChild(schemaField);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._createBtn = document.createElement('button');
    this._createBtn.className = 'ws-cd-btn ws-cd-btn-primary';
    this._createBtn.textContent = 'Create Lakehouse';
    this._createBtn.disabled = true;
    this._createBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._createBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _toggleSchemas() {
    this._schemasEnabled = !this._schemasEnabled;
    this._toggleEl.classList.toggle('on', this._schemasEnabled);
    this._toggleEl.setAttribute('aria-checked', String(this._schemasEnabled));
    this._schemasEl.classList.toggle('expanded', this._schemasEnabled);
    this._schemasEl.classList.toggle('collapsed', !this._schemasEnabled);
  }

  _validateName() {
    var name = this._nameInput.value;
    this._counterEl.textContent = name.length + ' / ' + WsCreateValidation.NAME_MAX;
    var result = WsCreateValidation.validateLakehouseName(name, this._existingItemNames);

    this._nameInput.classList.remove('valid', 'invalid');
    this._nameValidEl.style.display = 'none';
    var existing = this._nameInput.parentNode.querySelector('.ws-cd-check');
    if (existing) existing.remove();

    if (!name.trim()) {
      this._counterEl.style.display = '';
    } else if (result.valid) {
      this._nameInput.classList.add('valid');
      this._counterEl.style.display = 'none';
      var check = document.createElement('span');
      check.className = 'ws-cd-check';
      check.textContent = '\u2713';
      this._nameInput.parentNode.appendChild(check);
    } else {
      this._nameInput.classList.add('invalid');
      this._nameValidEl.textContent = result.error;
      this._nameValidEl.style.display = '';
    }

    this._updateCreateBtn();
  }

  _updateCreateBtn() {
    var nameValid = WsCreateValidation.validateLakehouseName(this._nameInput.value, this._existingItemNames).valid;
    var ready = nameValid && this._state === 'idle';
    this._createBtn.disabled = !ready;
    if (ready) {
      this._createBtn.classList.add('ready');
    } else {
      this._createBtn.classList.remove('ready');
    }
  }

  _submit() {
    if (this._state !== 'idle') return;
    var nameResult = WsCreateValidation.validateLakehouseName(this._nameInput.value, this._existingItemNames);
    if (!nameResult.valid) {
      this._nameInput.classList.add('invalid');
      return;
    }

    var self = this;
    var name = this._nameInput.value.trim();
    var description = this._descInput.value.trim();
    var schemas = [];
    if (this._schemasEnabled) {
      var keys = Object.keys(this._selectedSchemas);
      for (var i = 0; i < keys.length; i++) {
        if (this._selectedSchemas[keys[i]]) schemas.push(keys[i]);
      }
    }

    this._state = 'creating';
    this._createBtn.disabled = true;
    this._createBtn.classList.remove('ready');
    this._createBtn.innerHTML = '<span class="ws-cd-spinner"></span>Creating\u2026';
    this._nameInput.disabled = true;
    this._descInput.disabled = true;
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';

    this._api.createLakehouse(this._workspaceId, name, {
      description: description || undefined,
      enableSchemas: this._schemasEnabled,
      defaultSchemas: this._schemasEnabled ? schemas : undefined
    }).then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(name, result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Create failed');
    });
  }

  _showSuccess(name, result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-success-name">' + this._esc(name) + '</div>' +
        '<div class="ws-cd-success-sub">Lakehouse created in ' + this._esc(this._workspaceName) + '</div>' +
        '<button class="ws-cd-btn ws-cd-btn-primary">Select Lakehouse</button>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    body.querySelector('.ws-cd-btn-primary').addEventListener('click', function() {
      self._finish(result);
    });
    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(result);
    }, 3000);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundKeydown);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._nameInput.disabled = false;
    this._descInput.disabled = false;
    this._createBtn.innerHTML = 'Create Lakehouse';
    this._createBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _showNoAuth() {
    if (!this._dialogEl) return;
    var overlay = document.createElement('div');
    overlay.className = 'ws-cd-noauth';
    overlay.innerHTML = '<div class="ws-cd-noauth-msg">Sign in to create lakehouses</div>';
    var btn = document.createElement('button');
    btn.className = 'ws-cd-btn ws-cd-btn-primary';
    btn.textContent = 'Close';
    btn.addEventListener('click', this.close.bind(this));
    overlay.appendChild(btn);
    this._dialogEl.appendChild(overlay);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

/* ═══════════════════════════════════════════════════════════════
   NotebookCreateDialog — modal for creating a notebook in a workspace
   States: empty → valid/invalid → lakehouse-loading → ready → creating → success/failure
   ═══════════════════════════════════════════════════════════════ */
class NotebookCreateDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._workspaceId = opts.workspaceId;
    this._workspaceName = opts.workspaceName || '';
    this._existingItemNames = (opts.existingItems || []).map(function(it) { return it.displayName; });
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._descInput = null;
    this._counterEl = null;
    this._descCounterEl = null;
    this._nameValidEl = null;
    this._createBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._lhGridEl = null;
    this._selectedLakehouse = null;
    this._lakehousesLoaded = false;
    this._state = 'idle';
    this.onComplete = null;
    this.onClose = null;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    this._nameInput.focus();
    this._loadLakehouses();
    this._boundKeydown = this._onKeydown.bind(this);
    document.addEventListener('keydown', this._boundKeydown);
  }

  close() {
    if (!this._overlayEl) return;
    if (this._state === 'idle' && this._nameInput && this._nameInput.value.trim()) {
      if (!confirm('Discard notebook creation?')) return;
    }
    document.removeEventListener('keydown', this._boundKeydown);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') this.close();
    if (e.key === 'Enter' && !this._createBtn.disabled) this._submit();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Create notebook');
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    header.innerHTML =
      '<div class="ws-cd-header-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>' +
      '</div>' +
      '<div class="ws-cd-title">Create Notebook</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Context chip
    var ctx = document.createElement('div');
    ctx.className = 'ws-cd-context';
    ctx.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
      '<span>' + this._esc(this._workspaceName) + '</span>';
    body.appendChild(ctx);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'ws-cd-field';
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-cd-label';
    nameLabel.textContent = 'NOTEBOOK NAME';
    nameField.appendChild(nameLabel);
    var nameWrap = document.createElement('div');
    nameWrap.className = 'ws-cd-input-wrap';
    this._nameInput = document.createElement('input');
    this._nameInput.className = 'ws-cd-input';
    this._nameInput.type = 'text';
    this._nameInput.placeholder = 'Enter notebook name';
    this._nameInput.maxLength = WsCreateValidation.NAME_MAX;
    this._nameInput.addEventListener('input', function() { self._validateName(); });
    nameWrap.appendChild(this._nameInput);
    this._counterEl = document.createElement('span');
    this._counterEl.className = 'ws-cd-counter';
    this._counterEl.textContent = '0 / ' + WsCreateValidation.NAME_MAX;
    nameWrap.appendChild(this._counterEl);
    nameField.appendChild(nameWrap);
    this._nameValidEl = document.createElement('div');
    this._nameValidEl.className = 'ws-cd-error';
    this._nameValidEl.style.display = 'none';
    nameField.appendChild(this._nameValidEl);
    body.appendChild(nameField);

    // Description field
    var descField = document.createElement('div');
    descField.className = 'ws-cd-field';
    var descLabel = document.createElement('div');
    descLabel.className = 'ws-cd-label';
    descLabel.innerHTML = 'DESCRIPTION <span class="ws-cd-label-opt">(optional)</span>';
    descField.appendChild(descLabel);
    this._descInput = document.createElement('textarea');
    this._descInput.className = 'ws-cd-textarea';
    this._descInput.placeholder = 'What is this notebook for?';
    this._descInput.maxLength = 256;
    this._descCounterEl = document.createElement('div');
    this._descCounterEl.className = 'ws-cd-counter';
    this._descCounterEl.style.position = 'static';
    this._descCounterEl.style.textAlign = 'right';
    this._descCounterEl.style.marginTop = '2px';
    this._descCounterEl.textContent = '0 / 256';
    this._descInput.addEventListener('input', function() {
      self._descCounterEl.textContent = self._descInput.value.length + ' / 256';
    });
    descField.appendChild(this._descInput);
    descField.appendChild(this._descCounterEl);
    body.appendChild(descField);

    // Default lakehouse field
    var lhField = document.createElement('div');
    lhField.className = 'ws-cd-field';
    var lhLabel = document.createElement('div');
    lhLabel.className = 'ws-cd-label';
    lhLabel.textContent = 'DEFAULT LAKEHOUSE';
    lhField.appendChild(lhLabel);
    this._lhGridEl = document.createElement('div');
    this._lhGridEl.className = 'ws-cd-lh-grid';
    this._lhGridEl.innerHTML =
      '<div class="ws-cd-shimmer"></div>' +
      '<div class="ws-cd-shimmer" style="animation-delay:0.15s"></div>';
    lhField.appendChild(this._lhGridEl);
    body.appendChild(lhField);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._createBtn = document.createElement('button');
    this._createBtn.className = 'ws-cd-btn ws-cd-btn-primary';
    this._createBtn.textContent = 'Create Notebook';
    this._createBtn.disabled = true;
    this._createBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._createBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _loadLakehouses() {
    var self = this;
    this._api.listWorkspaceItems(this._workspaceId).then(function(resp) {
      var items = (resp && resp.value) ? resp.value : [];
      var lakehouses = items.filter(function(it) {
        return (it.type || '').toLowerCase().includes('lakehouse');
      });
      self._lakehousesLoaded = true;
      self._renderLakehouses(lakehouses);
      self._updateCreateBtn();
    }).catch(function() {
      self._lakehousesLoaded = true;
      self._lhGridEl.innerHTML = '';
      var errCard = document.createElement('div');
      errCard.className = 'ws-cd-cap-error';
      errCard.innerHTML = '<span>\u2715 Could not load lakehouses</span>';
      var retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', function() {
        self._lhGridEl.innerHTML =
          '<div class="ws-cd-shimmer"></div><div class="ws-cd-shimmer" style="animation-delay:0.15s"></div>';
        self._lakehousesLoaded = false;
        self._loadLakehouses();
      });
      errCard.appendChild(retryBtn);
      self._lhGridEl.appendChild(errCard);
      self._updateCreateBtn();
    });
  }

  _renderLakehouses(lakehouses) {
    var self = this;
    this._lhGridEl.innerHTML = '';

    if (lakehouses.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'ws-cd-lh-empty';
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>' +
        'No lakehouses \u2014 create one first';
      this._lhGridEl.appendChild(empty);
      return;
    }

    for (var i = 0; i < lakehouses.length; i++) {
      var lh = lakehouses[i];
      var card = this._buildLhCard(lh);
      card.style.animationDelay = (i * 60) + 'ms';
      this._lhGridEl.appendChild(card);
    }
  }

  _buildLhCard(lh) {
    var self = this;
    var card = document.createElement('div');
    card.className = 'ws-cd-lh-card';
    card.dataset.lhId = lh.id || '';

    var radio = document.createElement('div');
    radio.className = 'ws-cd-lh-radio';
    card.appendChild(radio);

    var icon = document.createElement('div');
    icon.className = 'ws-cd-lh-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
    card.appendChild(icon);

    var meta = document.createElement('div');
    meta.className = 'ws-cd-lh-meta';
    var nameEl = document.createElement('div');
    nameEl.className = 'ws-cd-lh-name';
    nameEl.textContent = lh.displayName || lh.id;
    meta.appendChild(nameEl);
    if (lh._tableCount !== undefined) {
      var detail = document.createElement('div');
      detail.className = 'ws-cd-lh-detail';
      detail.textContent = lh._tableCount + ' tables';
      meta.appendChild(detail);
    }
    card.appendChild(meta);

    card.addEventListener('click', function() {
      self._lhGridEl.querySelectorAll('.ws-cd-lh-card').forEach(function(c) {
        c.classList.remove('selected');
      });
      card.classList.add('selected');
      self._selectedLakehouse = lh.id || null;
      self._updateCreateBtn();
    });
    return card;
  }

  _validateName() {
    var name = this._nameInput.value;
    this._counterEl.textContent = name.length + ' / ' + WsCreateValidation.NAME_MAX;
    var result = WsCreateValidation.validateLakehouseName(name, this._existingItemNames);

    this._nameInput.classList.remove('valid', 'invalid');
    this._nameValidEl.style.display = 'none';
    var existing = this._nameInput.parentNode.querySelector('.ws-cd-check');
    if (existing) existing.remove();

    if (!name.trim()) {
      this._counterEl.style.display = '';
    } else if (result.valid) {
      this._nameInput.classList.add('valid');
      this._counterEl.style.display = 'none';
      var check = document.createElement('span');
      check.className = 'ws-cd-check';
      check.textContent = '\u2713';
      this._nameInput.parentNode.appendChild(check);
    } else {
      this._nameInput.classList.add('invalid');
      this._nameValidEl.textContent = result.error;
      this._nameValidEl.style.display = '';
    }

    this._updateCreateBtn();
  }

  _updateCreateBtn() {
    var nameValid = WsCreateValidation.validateLakehouseName(this._nameInput.value, this._existingItemNames).valid;
    var ready = nameValid && this._lakehousesLoaded && this._selectedLakehouse && this._state === 'idle';
    this._createBtn.disabled = !ready;
    if (ready) {
      this._createBtn.classList.add('ready');
    } else {
      this._createBtn.classList.remove('ready');
    }
  }

  _submit() {
    if (this._state !== 'idle') return;
    var nameResult = WsCreateValidation.validateLakehouseName(this._nameInput.value, this._existingItemNames);
    if (!nameResult.valid || !this._selectedLakehouse) return;

    var self = this;
    var name = this._nameInput.value.trim();
    this._state = 'creating';
    this._createBtn.disabled = true;
    this._createBtn.classList.remove('ready');
    this._createBtn.innerHTML = '<span class="ws-cd-spinner"></span>Creating\u2026';
    this._nameInput.disabled = true;
    this._descInput.disabled = true;
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';

    this._api.createNotebook(this._workspaceId, name).then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(name, result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Create failed');
    });
  }

  _showSuccess(name, result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-success-name">' + this._esc(name) + '</div>' +
        '<div class="ws-cd-success-sub">Notebook created in ' + this._esc(this._workspaceName) + '</div>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(result);
    }, 3000);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundKeydown);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._nameInput.disabled = false;
    this._descInput.disabled = false;
    this._createBtn.innerHTML = 'Create Notebook';
    this._createBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _showNoAuth() {
    if (!this._dialogEl) return;
    var overlay = document.createElement('div');
    overlay.className = 'ws-cd-noauth';
    overlay.innerHTML = '<div class="ws-cd-noauth-msg">Sign in to create notebooks</div>';
    var btn = document.createElement('button');
    btn.className = 'ws-cd-btn ws-cd-btn-primary';
    btn.textContent = 'Close';
    btn.addEventListener('click', this.close.bind(this));
    overlay.appendChild(btn);
    this._dialogEl.appendChild(overlay);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

/* ═══════════════════════════════════════════════════════════════
   DeleteConfirmDialog — cascade-aware delete confirmation
   Handles: notebook, lakehouse (simple/cascade), workspace
   ═══════════════════════════════════════════════════════════════ */
class DeleteConfirmDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._type = opts.type || 'notebook'; // 'notebook' | 'lakehouse' | 'workspace'
    this._name = opts.name || '';
    this._id = opts.id || '';
    this._workspaceId = opts.workspaceId || '';
    this._workspaceName = opts.workspaceName || '';
    this._tableCount = opts.tableCount || 0;
    this._exclusiveNotebooks = opts.exclusiveNotebooks || [];
    this._detachNotebooks = opts.detachNotebooks || [];
    this._childCounts = opts.childCounts || { lakehouses: 0, notebooks: 0 };
    this._overlayEl = null;
    this._dialogEl = null;
    this._confirmInput = null;
    this._deleteBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._state = 'idle';
    this.onComplete = null;
    this.onClose = null;
  }

  /** Whether this scenario requires type-to-confirm. */
  _needsConfirm() {
    if (this._type === 'workspace') return true;
    if (this._type === 'lakehouse' && this._exclusiveNotebooks.length > 0) return true;
    return false;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    if (this._confirmInput) {
      this._confirmInput.focus();
    }
    this._boundKeydown = this._onKeydown.bind(this);
    document.addEventListener('keydown', this._boundKeydown);
  }

  close() {
    if (!this._overlayEl) return;
    document.removeEventListener('keydown', this._boundKeydown);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') this.close();
    if (e.key === 'Enter' && this._deleteBtn && !this._deleteBtn.disabled) this._submit();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'alertdialog');
    this._dialogEl.setAttribute('aria-label', 'Delete ' + this._type);
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    header.innerHTML =
      '<div class="ws-cd-header-icon" style="color:var(--status-fail,#e5453b)">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M5 6l1 14a2 2 0 002 2h8a2 2 0 002-2l1-14"/></svg>' +
      '</div>' +
      '<div class="ws-cd-title">Delete ' + this._esc(this._type) + '</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Context chip
    if (this._workspaceName && this._type !== 'workspace') {
      var ctx = document.createElement('div');
      ctx.className = 'ws-cd-context';
      ctx.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
        '<span>' + this._esc(this._workspaceName) + '</span>';
      body.appendChild(ctx);
    }

    // Item name being deleted
    var nameBox = document.createElement('div');
    nameBox.className = 'ws-cd-field';
    nameBox.innerHTML =
      '<div style="font-size:15px;font-weight:600;margin-bottom:4px">' + this._esc(this._name) + '</div>' +
      '<div style="font-size:13px;color:var(--text-muted,#8a9099)">This action cannot be undone.</div>';
    body.appendChild(nameBox);

    // Scenario-specific content
    this._buildScenario(body);

    // Type-to-confirm
    if (this._needsConfirm()) {
      var confirmBlock = document.createElement('div');
      confirmBlock.className = 'ws-cd-confirm-block';
      var prompt = document.createElement('div');
      prompt.className = 'ws-cd-confirm-prompt';
      prompt.innerHTML = 'Type <span class="ws-cd-confirm-target">' + this._esc(this._name) + '</span> to confirm';
      confirmBlock.appendChild(prompt);
      this._confirmInput = document.createElement('input');
      this._confirmInput.className = 'ws-cd-confirm-input';
      this._confirmInput.type = 'text';
      this._confirmInput.placeholder = this._name;
      this._confirmInput.addEventListener('input', function() { self._updateDeleteBtn(); });
      confirmBlock.appendChild(this._confirmInput);
      body.appendChild(confirmBlock);
    }

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._deleteBtn = document.createElement('button');
    this._deleteBtn.className = 'ws-cd-btn ws-cd-btn-danger';
    this._deleteBtn.textContent = 'Delete';
    if (!this._needsConfirm()) {
      this._deleteBtn.classList.add('ready');
    }
    this._deleteBtn.disabled = this._needsConfirm();
    this._deleteBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._deleteBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _buildScenario(body) {
    if (this._type === 'notebook') {
      // Scenario A: simple notebook delete — no extra content
      return;
    }

    if (this._type === 'lakehouse') {
      // Show table count
      if (this._tableCount > 0) {
        var tableInfo = document.createElement('div');
        tableInfo.className = 'ws-cd-child-counts';
        tableInfo.innerHTML =
          '<div class="ws-cd-child-count">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>' +
            this._tableCount + ' table' + (this._tableCount !== 1 ? 's' : '') +
          '</div>';
        body.appendChild(tableInfo);
      }

      // Scenario C: cascade — exclusive notebooks will be deleted
      if (this._exclusiveNotebooks.length > 0) {
        var cascadeSection = document.createElement('div');
        cascadeSection.className = 'ws-cd-cascade-section';
        cascadeSection.innerHTML =
          '<div class="ws-cd-cascade-title">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' +
            'Notebooks will also be deleted' +
          '</div>' +
          '<div class="ws-cd-cascade-body">These notebooks have no other lakehouse and will be permanently removed:</div>';
        var pillContainer = document.createElement('div');
        pillContainer.style.marginTop = '8px';
        for (var i = 0; i < this._exclusiveNotebooks.length; i++) {
          var pill = document.createElement('span');
          pill.className = 'ws-cd-cascade-pill';
          pill.textContent = this._exclusiveNotebooks[i];
          pillContainer.appendChild(pill);
        }
        cascadeSection.appendChild(pillContainer);
        body.appendChild(cascadeSection);
      }

      // Scenario B/C: detach notebooks
      if (this._detachNotebooks.length > 0) {
        var detachSection = document.createElement('div');
        detachSection.className = 'ws-cd-detach-section';
        detachSection.innerHTML =
          '<div class="ws-cd-detach-title">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' +
            'Notebooks will be detached' +
          '</div>' +
          '<div class="ws-cd-detach-body">' + this._detachNotebooks.length + ' notebook' + (this._detachNotebooks.length !== 1 ? 's' : '') + ' will be detached but not deleted:</div>';
        var detachPills = document.createElement('div');
        detachPills.style.marginTop = '8px';
        for (var j = 0; j < this._detachNotebooks.length; j++) {
          var dp = document.createElement('span');
          dp.className = 'ws-cd-detach-pill';
          dp.textContent = this._detachNotebooks[j];
          detachPills.appendChild(dp);
        }
        detachSection.appendChild(detachPills);
        body.appendChild(detachSection);
      }
      return;
    }

    if (this._type === 'workspace') {
      // Scenario D: workspace delete — show child counts
      var counts = this._childCounts;
      var countsEl = document.createElement('div');
      countsEl.className = 'ws-cd-child-counts';
      if (counts.lakehouses) {
        countsEl.innerHTML +=
          '<div class="ws-cd-child-count">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>' +
            counts.lakehouses + ' lakehouse' + (counts.lakehouses !== 1 ? 's' : '') +
          '</div>';
      }
      if (counts.notebooks) {
        countsEl.innerHTML +=
          '<div class="ws-cd-child-count">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>' +
            counts.notebooks + ' notebook' + (counts.notebooks !== 1 ? 's' : '') +
          '</div>';
      }
      body.appendChild(countsEl);

      var warnSection = document.createElement('div');
      warnSection.className = 'ws-cd-cascade-section';
      warnSection.innerHTML =
        '<div class="ws-cd-cascade-title">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' +
          'Everything inside will be deleted' +
        '</div>' +
        '<div class="ws-cd-cascade-body">All lakehouses, notebooks, and other items in this workspace will be permanently removed.</div>';
      body.appendChild(warnSection);
    }
  }

  _updateDeleteBtn() {
    if (!this._needsConfirm()) {
      this._deleteBtn.disabled = false;
      this._deleteBtn.classList.add('ready');
      return;
    }
    var match = this._confirmInput && this._confirmInput.value === this._name;
    this._deleteBtn.disabled = !match;
    if (match) {
      this._deleteBtn.classList.add('ready');
    } else {
      this._deleteBtn.classList.remove('ready');
    }
  }

  _submit() {
    if (this._state !== 'idle') return;

    var self = this;
    this._state = 'creating';
    this._deleteBtn.disabled = true;
    this._deleteBtn.classList.remove('ready');
    this._deleteBtn.innerHTML = '<span class="ws-cd-spinner"></span>Deleting\u2026';
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';
    if (this._confirmInput) this._confirmInput.disabled = true;

    var deletePromise;
    if (this._type === 'workspace') {
      deletePromise = this._api.deleteWorkspace(this._id);
    } else if (this._type === 'lakehouse') {
      deletePromise = this._api.deleteLakehouse(this._workspaceId, this._id);
    } else {
      deletePromise = this._api.deleteItem(this._workspaceId, this._id);
    }

    deletePromise.then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Delete failed');
    });
  }

  _showSuccess(result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-success-name">' + this._esc(this._name) + '</div>' +
        '<div class="ws-cd-success-sub">' + this._esc(this._type.charAt(0).toUpperCase() + this._type.slice(1)) + ' deleted</div>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(result);
    }, 1500);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundKeydown);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._deleteBtn.innerHTML = 'Delete';
    this._deleteBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';
    if (this._confirmInput) this._confirmInput.disabled = false;
    this._updateDeleteBtn();

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

/* ═══════════════════════════════════════════════════════════════
   RenameDialog — modal for renaming workspace items
   ═══════════════════════════════════════════════════════════════ */
class RenameDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._type = opts.type || 'notebook'; // 'workspace' | 'lakehouse' | 'notebook'
    this._name = opts.name || '';
    this._id = opts.id || '';
    this._workspaceId = opts.workspaceId || '';
    this._workspaceName = opts.workspaceName || '';
    this._existingNames = opts.existingNames || [];
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._counterEl = null;
    this._nameValidEl = null;
    this._renameBtn = null;
    this._errorBanner = null;
    this._progressEl = null;
    this._diffEl = null;
    this._state = 'idle';
    this.onComplete = null;
    this.onClose = null;
  }

  open() {
    if (this._overlayEl) return;
    this._build();
    document.body.appendChild(this._overlayEl);
    this._nameInput.focus();
    this._nameInput.select();
    this._boundKeydown = this._onKeydown.bind(this);
    document.addEventListener('keydown', this._boundKeydown);
  }

  close() {
    if (!this._overlayEl) return;
    document.removeEventListener('keydown', this._boundKeydown);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') this.close();
    if (e.key === 'Enter' && this._renameBtn && !this._renameBtn.disabled) this._submit();
  }

  _build() {
    var self = this;

    // Overlay
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'ws-cd-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    // Dialog
    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'ws-cd-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Rename ' + this._type);
    this._overlayEl.appendChild(this._dialogEl);

    // Header with type icon
    var header = document.createElement('div');
    header.className = 'ws-cd-header';
    var iconSvg = this._getTypeIcon();
    header.innerHTML =
      '<div class="ws-cd-header-icon">' + iconSvg + '</div>' +
      '<div class="ws-cd-title">Rename ' + this._esc(this._type) + '</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ws-cd-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'ws-cd-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'ws-cd-body';
    this._dialogEl.appendChild(body);

    // Context chip (for non-workspace items)
    if (this._workspaceName && this._type !== 'workspace') {
      var ctx = document.createElement('div');
      ctx.className = 'ws-cd-context';
      ctx.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
        '<span>' + this._esc(this._workspaceName) + '</span>';
      body.appendChild(ctx);
    }

    // Rename diff (shows old → new as user types)
    this._diffEl = document.createElement('div');
    this._diffEl.className = 'ws-cd-rename-diff';
    this._diffEl.style.display = 'none';
    this._diffEl.innerHTML =
      '<span class="ws-cd-rename-from">' + this._esc(this._name) + '</span>' +
      '<span class="ws-cd-rename-arrow">\u2192</span>' +
      '<span class="ws-cd-rename-to"></span>';
    body.appendChild(this._diffEl);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'ws-cd-field';
    var nameLabel = document.createElement('div');
    nameLabel.className = 'ws-cd-label';
    nameLabel.textContent = 'NEW NAME';
    nameField.appendChild(nameLabel);
    var nameWrap = document.createElement('div');
    nameWrap.className = 'ws-cd-input-wrap';
    this._nameInput = document.createElement('input');
    this._nameInput.className = 'ws-cd-input';
    this._nameInput.type = 'text';
    this._nameInput.value = this._name;
    this._nameInput.maxLength = WsCreateValidation.NAME_MAX;
    this._nameInput.addEventListener('input', function() { self._validateName(); });
    nameWrap.appendChild(this._nameInput);
    this._counterEl = document.createElement('span');
    this._counterEl.className = 'ws-cd-counter';
    this._counterEl.textContent = this._name.length + ' / ' + WsCreateValidation.NAME_MAX;
    nameWrap.appendChild(this._counterEl);
    nameField.appendChild(nameWrap);
    this._nameValidEl = document.createElement('div');
    this._nameValidEl.className = 'ws-cd-error';
    this._nameValidEl.style.display = 'none';
    nameField.appendChild(this._nameValidEl);
    body.appendChild(nameField);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ws-cd-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-cd-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._renameBtn = document.createElement('button');
    this._renameBtn.className = 'ws-cd-btn ws-cd-btn-primary';
    this._renameBtn.textContent = 'Rename';
    this._renameBtn.disabled = true;
    this._renameBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._renameBtn);
    this._dialogEl.appendChild(footer);

    // Progress bar
    this._progressEl = document.createElement('div');
    this._progressEl.className = 'ws-cd-progress';
    this._progressEl.style.display = 'none';
    this._progressEl.innerHTML = '<div class="ws-cd-progress-bar"></div>';
    this._dialogEl.appendChild(this._progressEl);
  }

  _getTypeIcon() {
    if (this._type === 'workspace') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
    }
    if (this._type === 'lakehouse') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>';
  }

  _validateName() {
    var name = this._nameInput.value;
    this._counterEl.textContent = name.length + ' / ' + WsCreateValidation.NAME_MAX;

    // Filter out the current name from existing names (allow keeping same casing)
    var filteredNames = this._existingNames.filter(function(n) {
      return (n || '').toLowerCase() !== (this._name || '').toLowerCase();
    }.bind(this));

    var result;
    if (this._type === 'workspace') {
      result = WsCreateValidation.validateName(name, filteredNames);
    } else {
      result = WsCreateValidation.validateLakehouseName(name, filteredNames);
    }

    this._nameInput.classList.remove('valid', 'invalid');
    this._nameValidEl.style.display = 'none';
    var existing = this._nameInput.parentNode.querySelector('.ws-cd-check');
    if (existing) existing.remove();

    var trimmed = (name || '').trim();
    var unchanged = trimmed === this._name;

    if (!trimmed) {
      this._counterEl.style.display = '';
    } else if (result.valid && !unchanged) {
      this._nameInput.classList.add('valid');
      this._counterEl.style.display = 'none';
      var check = document.createElement('span');
      check.className = 'ws-cd-check';
      check.textContent = '\u2713';
      this._nameInput.parentNode.appendChild(check);
    } else if (!result.valid) {
      this._nameInput.classList.add('invalid');
      this._nameValidEl.textContent = result.error;
      this._nameValidEl.style.display = '';
    }

    // Update diff row
    if (trimmed && trimmed !== this._name) {
      this._diffEl.style.display = '';
      this._diffEl.querySelector('.ws-cd-rename-to').textContent = trimmed;
    } else {
      this._diffEl.style.display = 'none';
    }

    this._updateRenameBtn();
  }

  _updateRenameBtn() {
    var name = (this._nameInput.value || '').trim();
    var unchanged = name === this._name;
    var filteredNames = this._existingNames.filter(function(n) {
      return (n || '').toLowerCase() !== (this._name || '').toLowerCase();
    }.bind(this));

    var result;
    if (this._type === 'workspace') {
      result = WsCreateValidation.validateName(name, filteredNames);
    } else {
      result = WsCreateValidation.validateLakehouseName(name, filteredNames);
    }

    var ready = result.valid && !unchanged && this._state === 'idle';
    this._renameBtn.disabled = !ready;
    if (ready) {
      this._renameBtn.classList.add('ready');
    } else {
      this._renameBtn.classList.remove('ready');
    }
  }

  _submit() {
    if (this._state !== 'idle') return;
    var newName = this._nameInput.value.trim();
    if (newName === this._name) return;

    var self = this;
    this._state = 'creating';
    this._renameBtn.disabled = true;
    this._renameBtn.classList.remove('ready');
    this._renameBtn.innerHTML = '<span class="ws-cd-spinner"></span>Renaming\u2026';
    this._nameInput.disabled = true;
    this._progressEl.style.display = '';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '60%';
    this._errorBanner.style.display = 'none';

    var renamePromise;
    if (this._type === 'workspace') {
      renamePromise = this._api.renameWorkspace(this._id, newName);
    } else if (this._type === 'lakehouse') {
      renamePromise = this._api.renameLakehouse(this._workspaceId, this._id, newName);
    } else {
      renamePromise = this._api.renameItem(this._workspaceId, this._id, newName);
    }

    renamePromise.then(function(result) {
      self._progressEl.querySelector('.ws-cd-progress-bar').style.width = '100%';
      self._state = 'success';
      self._showSuccess(newName, result);
    }).catch(function(err) {
      self._state = 'failed';
      self._showError(err.message || 'Rename failed');
    });
  }

  _showSuccess(newName, result) {
    var self = this;
    var body = this._dialogEl.querySelector('.ws-cd-body');
    var footer = this._dialogEl.querySelector('.ws-cd-footer');
    body.innerHTML =
      '<div class="ws-cd-success">' +
        '<div class="ws-cd-success-icon">\u2713</div>' +
        '<div class="ws-cd-rename-diff" style="justify-content:center">' +
          '<span class="ws-cd-rename-from">' + this._esc(this._name) + '</span>' +
          '<span class="ws-cd-rename-arrow">\u2192</span>' +
          '<span class="ws-cd-rename-to">' + this._esc(newName) + '</span>' +
        '</div>' +
        '<div class="ws-cd-success-sub">Renamed successfully</div>' +
      '</div>';
    footer.style.display = 'none';
    this._progressEl.style.display = 'none';

    var finishResult = result || {};
    finishResult.newName = newName;

    setTimeout(function() {
      if (self._overlayEl && self._state === 'success') self._finish(finishResult);
    }, 1500);
  }

  _finish(result) {
    document.removeEventListener('keydown', this._boundKeydown);
    if (this._overlayEl) this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onComplete) this.onComplete(result);
  }

  _showError(msg) {
    this._nameInput.disabled = false;
    this._renameBtn.innerHTML = 'Rename';
    this._renameBtn.disabled = false;
    this._state = 'idle';
    this._progressEl.style.display = 'none';
    this._progressEl.querySelector('.ws-cd-progress-bar').style.width = '0%';
    this._updateRenameBtn();

    this._errorBanner.style.display = '';
    var self = this;
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

class WorkspaceExplorer {
  constructor(apiClient) {
    this._api = apiClient;
    this._treeEl = document.getElementById('ws-tree-content');
    this._contentEl = document.getElementById('ws-content-body');
    this._inspectorEl = document.getElementById('ws-inspector-content');
    this._favoritesEl = document.getElementById('ws-favorites-list');

    this._selectedItem = null;
    this._selectedWorkspace = null;
    this._workspaces = [];
    this._expanded = new Set();
    this._children = {};
    this._favorites = [];
    this._toastEl = null;
    this._toastTimer = null;
    this._ctxMenu = null;
    this._ctxTarget = null;

    this._isMock = new URLSearchParams(window.location.search).has('mock');

    /** @type {{ col: string|null, dir: 'asc'|'desc'|null }} */
    this._tableSort = { col: null, dir: null };
    /** @type {HTMLElement[]|null} original row order before sorting */
    this._tableSortOriginalRows = null;

    /** @type {object[]|null} Current table list for enrichment merging */
    this._currentTables = null;

    /** @type {Intl.NumberFormat} Shared formatter for row counts */
    this._numFmt = new Intl.NumberFormat('en-IN');

    /** @type {Object<string, object[]>} Notebook properties per workspace */
    this._notebookCache = {};
    /** @type {Object<string, object[]>} Environment properties per workspace */
    this._environmentCache = {};
    /** @type {NotebookView|null} Active notebook IDE instance */
    this._activeNotebookView = null;

    /** @type {Set<HTMLElement>} Sample-rows blocks with a modal currently open. */
    this._openSampleModals = new Set();
  }

  async init() {
    this._createToast();
    this._createContextMenu();
    this._loadFavorites();
    this._renderFavorites();
    this._bindRefresh();
    this._bindTreeHeaderAdd();
    this._bindNewEnvironment();
    this._bindWorkspaceSelectEvent();
    this._bindGlobalKeys();
    this._showEmptyContent();
    this._clearInspector();
    await this.loadWorkspaces();
  }

  // ────────────────────────────────────────────
  // Toast
  // ────────────────────────────────────────────

  _createToast() {
    let el = document.querySelector('.edog-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'edog-toast';
      document.body.appendChild(el);
    }
    this._toastEl = el;
  }

  /** @param {string} msg  @param {'success'|'error'|'info'} type */
  _toast(msg, type = 'info') {
    if (!this._toastEl) return;
    this._toastEl.textContent = msg;
    this._toastEl.classList.remove('visible', 'error', 'success', 'has-actions');
    if (type === 'error') this._toastEl.classList.add('error');
    else if (type === 'success') this._toastEl.classList.add('success');
    // Force reflow so transition plays even if already visible
    void this._toastEl.offsetWidth;
    this._toastEl.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastEl.classList.remove('visible');
    }, 2500);
  }

  /**
   * Show a toast with Confirm / Cancel buttons. Returns a Promise<boolean>.
   * Auto-cancels after timeoutMs (default 5000).
   */
  _toastConfirm(msg, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!this._toastEl) { resolve(false); return; }
      clearTimeout(this._toastTimer);
      this._toastEl.classList.remove('visible', 'error', 'success', 'has-actions');

      this._toastEl.innerHTML = '';
      const msgSpan = document.createElement('span');
      msgSpan.className = 'edog-toast-msg';
      msgSpan.textContent = msg;
      this._toastEl.appendChild(msgSpan);

      const actions = document.createElement('span');
      actions.className = 'edog-toast-actions';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'edog-toast-btn confirm';
      confirmBtn.textContent = 'Confirm';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'edog-toast-btn';
      cancelBtn.textContent = 'Cancel';

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      this._toastEl.appendChild(actions);

      this._toastEl.classList.add('has-actions');
      void this._toastEl.offsetWidth;
      this._toastEl.classList.add('visible');

      let settled = false;
      const dismiss = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(this._toastTimer);
        this._toastEl.classList.remove('visible');
        resolve(result);
      };

      confirmBtn.addEventListener('click', () => dismiss(true));
      cancelBtn.addEventListener('click', () => dismiss(false));

      this._toastTimer = setTimeout(() => dismiss(false), timeoutMs);
    });
  }

  // ────────────────────────────────────────────
  // Context Menu
  // ────────────────────────────────────────────

  _createContextMenu() {
    let el = document.querySelector('.ws-ctx-menu');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ws-ctx-menu';
      document.body.appendChild(el);
    }
    this._ctxMenu = el;

    document.addEventListener('click', () => this._hideContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // If the right-click is outside the tree, hide the menu
      if (!this._treeEl || !this._treeEl.contains(e.target)) {
        this._hideContextMenu();
      }
    });
  }

  _hideContextMenu() {
    if (this._ctxMenu) this._ctxMenu.classList.remove('visible');
    this._ctxTarget = null;
  }

  /**
   * @param {MouseEvent} e
   * @param {object} nodeData  { item, workspace, isWorkspace, isLakehouse }
   */
  _showContextMenu(e, nodeData) {
    e.preventDefault();
    e.stopPropagation();
    if (!this._ctxMenu) return;

    this._ctxTarget = nodeData;
    const items = [];

    if (nodeData.isLakehouse) {
      items.push({ label: 'Deploy to this Lakehouse', cls: 'accent', action: () => this._ctxDeploy() });
      items.push({ sep: true });
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
      items.push({ sep: true });
      items.push({ label: 'Save as Favorite', action: () => this._ctxSaveFavorite() });
    } else if (nodeData.isWorkspace) {
      items.push({ label: 'Create Lakehouse', action: () => this._ctxCreateLakehouse() });
      items.push({ label: 'Create Notebook', action: () => this._ctxCreateNotebook() });
      items.push({ sep: true });
      items.push({ label: 'New Infrastructure\u2026', cls: 'accent', action: () => this._ctxNewInfra() });
      items.push({ sep: true });
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
    } else {
      items.push({ label: 'Rename', action: () => this._ctxRename() });
      items.push({ label: 'Delete', cls: 'danger', action: () => this._ctxDelete() });
      items.push({ sep: true });
      items.push({ label: 'Open in Fabric', action: () => this._ctxOpenInFabric() });
      items.push({ label: 'Copy ID', action: () => this._ctxCopyId() });
      items.push({ label: 'Copy Name', action: () => this._ctxCopyName() });
    }

    this._ctxMenu.innerHTML = '';
    for (const it of items) {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'ws-ctx-sep';
        this._ctxMenu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.className = 'ws-ctx-item' + (it.cls ? ` ${it.cls}` : '');
        el.textContent = it.label;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          it.action();
          this._hideContextMenu();
        });
        this._ctxMenu.appendChild(el);
      }
    }

    // Position within viewport
    const menuW = 220;
    const menuH = this._ctxMenu.children.length * 32;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;

    this._ctxMenu.style.left = `${x}px`;
    this._ctxMenu.style.top = `${y}px`;
    this._ctxMenu.classList.add('visible');
  }

  // Context menu actions

  _ctxNewInfra() {
    if (InfraWizardDialog.isActive()) {
      InfraWizardDialog.getActive().restore();
      return;
    }
    const wizard = new InfraWizardDialog(this._api, {
      existingWorkspaces: this._workspaces
    });
    wizard.onClose = () => { this.loadWorkspaces(); };
    wizard.onComplete = () => { this.loadWorkspaces(); };
    wizard.open();
  }

  /** Open the Infra Wizard pre-filled with the selected workspace/lakehouse config. */
  _cloneEnvironment(ws) {
    if (InfraWizardDialog.isActive()) {
      InfraWizardDialog.getActive().restore();
      return;
    }
    const lh = this._selectedItem;
    const seedState = {
      workspaceName: (ws.displayName || '') + ' (Clone)',
      lakehouseName: lh ? (lh.displayName || '') : '',
      capacityId: ws._capacityId || null,
      capacityDisplayName: ws._capacityDisplayName || '',
      capacitySku: ws._capacitySku || '',
      capacityRegion: ws._region || '',
    };
    const wizard = new InfraWizardDialog(this._api, {
      initialState: seedState,
      existingWorkspaces: this._workspaces
    });
    wizard.onClose = () => { this.loadWorkspaces(); };
    wizard.onComplete = () => { this.loadWorkspaces(); };
    wizard.open();
  }

  _ctxDeploy() {
    const t = this._ctxTarget;
    if (!t || !t.isLakehouse) return;
    this._selectItem(t.item, t.workspace);
  }

  async _ctxRename() {
    const t = this._ctxTarget;
    if (!t) return;

    const oldName = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const isWs = t.isWorkspace;
    const isLH = !isWs && this._isLakehouse(t.item);
    const type = isWs ? 'workspace' : (isLH ? 'lakehouse' : 'notebook');

    // Collect sibling names for duplicate detection
    var existingNames = [];
    if (isWs) {
      existingNames = this._workspaces.map(function(w) { return w.displayName; });
    } else {
      var children = this._children[t.workspace.id] || [];
      existingNames = children.map(function(c) { return c.displayName; });
    }

    var self = this;
    var dialog = new RenameDialog(this._api, {
      type: type,
      name: oldName,
      id: isWs ? t.workspace.id : t.item.id,
      workspaceId: isWs ? t.workspace.id : t.workspace.id,
      workspaceName: t.workspace.displayName,
      existingNames: existingNames
    });
    dialog.onComplete = function(result) {
      var newName = result && result.newName ? result.newName : oldName;
      if (isWs) {
        t.workspace.displayName = newName;
      } else {
        t.item.displayName = newName;
      }
      self._renderTree();
      if (self._selectedItem && self._selectedItem.id === (t.item ? t.item.id : t.workspace.id)) {
        if (isWs) {
          self._selectWorkspace(t.workspace);
        } else {
          self._selectItem(t.item, t.workspace);
        }
      }
    };
    dialog.open();
  }

  /**
   * Locate the tree row DOM element for a given context-menu target.
   * @param {object} t - Context target { workspace, item, isWorkspace }
   * @returns {HTMLElement|null}
   */
  _findTreeRow(t) {
    if (!this._treeEl) return null;
    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const nodes = this._treeEl.querySelectorAll('.ws-tree-item');
    for (const node of nodes) {
      const nameEl = node.querySelector('.ws-tree-name');
      if (nameEl && nameEl.textContent === name) return node;
    }
    return null;
  }

  async _ctxDelete() {
    const t = this._ctxTarget;
    if (!t) return;

    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    const isWs = t.isWorkspace;
    const isLH = !isWs && this._isLakehouse(t.item);
    const type = isWs ? 'workspace' : (isLH ? 'lakehouse' : 'notebook');

    var opts = {
      type: type,
      name: name,
      id: isWs ? t.workspace.id : t.item.id,
      workspaceId: isWs ? t.workspace.id : t.workspace.id,
      workspaceName: t.workspace.displayName
    };

    if (isWs) {
      // Count children for workspace delete
      var wsChildren = this._children[t.workspace.id] || [];
      var lhCount = 0;
      var nbCount = 0;
      for (var ci = 0; ci < wsChildren.length; ci++) {
        if (this._isLakehouse(wsChildren[ci])) lhCount++;
        else nbCount++;
      }
      opts.childCounts = { lakehouses: lhCount, notebooks: nbCount };
    } else if (isLH) {
      // Compute cascade info for lakehouse delete
      var children = this._children[t.workspace.id] || [];
      var notebooks = children.filter(function(c) {
        return !(c.type || '').toLowerCase().includes('lakehouse');
      });
      opts.tableCount = t.item._tableCount || 0;
      opts.exclusiveNotebooks = [];
      opts.detachNotebooks = [];
      // For notebooks: if they only reference this lakehouse, they are exclusive
      // Since we don't have full lakehouse-attachment data in the tree,
      // we approximate: notebooks with no known multi-lakehouse info are exclusive
      for (var ni = 0; ni < notebooks.length; ni++) {
        var nb = notebooks[ni];
        var lhIds = nb._lakehouseIds || [];
        if (lhIds.length === 0) {
          // No attachment data — treat as potentially exclusive
          opts.exclusiveNotebooks.push(nb.displayName);
        } else if (lhIds.length === 1 && lhIds[0] === t.item.id) {
          opts.exclusiveNotebooks.push(nb.displayName);
        } else if (lhIds.indexOf(t.item.id) !== -1) {
          opts.detachNotebooks.push(nb.displayName);
        }
      }
    }

    var self = this;
    var dialog = new DeleteConfirmDialog(this._api, opts);
    dialog.onComplete = function() {
      if (isWs) {
        self._workspaces = self._workspaces.filter(function(w) { return w.id !== t.workspace.id; });
        delete self._children[t.workspace.id];
        self._expanded.delete(t.workspace.id);
      } else {
        var ch = self._children[t.workspace.id];
        if (ch) {
          self._children[t.workspace.id] = ch.filter(function(c) { return c.id !== t.item.id; });
        }
      }
      self._renderTree();
      self._showEmptyContent();
      self._clearInspector();
      self._selectedItem = null;
      self._selectedWorkspace = null;
    };
    dialog.open();
  }

  _ctxOpenInFabric() {
    const t = this._ctxTarget;
    if (!t) return;
    const wsId = t.isWorkspace ? t.workspace.id : t.workspace.id;
    const url = `https://app.fabric.microsoft.com/groups/${wsId}`;
    window.open(url, '_blank');
  }

  _ctxCopyId() {
    const t = this._ctxTarget;
    if (!t) return;
    const id = t.isWorkspace ? t.workspace.id : t.item.id;
    this._copyToClipboard(id, 'ID copied');
  }

  /** Start inline rename from hover action button (wraps _ctxRename). */
  _startRename(target) {
    this._ctxTarget = target;
    this._ctxRename();
  }

  /** Trigger delete from hover action button (wraps _ctxDelete). */
  _handleDelete(target) {
    this._ctxTarget = target;
    this._ctxDelete();
  }

  _ctxCopyName() {
    const t = this._ctxTarget;
    if (!t) return;
    const name = t.isWorkspace ? t.workspace.displayName : t.item.displayName;
    this._copyToClipboard(name, 'Name copied');
  }

  _ctxSaveFavorite() {
    const t = this._ctxTarget;
    if (!t || !t.item) return;
    this._saveFavorite({
      displayName: t.item.displayName,
      id: t.item.id,
      workspaceId: t.workspace.id,
      workspaceName: t.workspace.displayName,
    });
    this._toast(`"${t.item.displayName}" saved to favorites`, 'success');
  }

  // ────────────────────────────────────────────
  // Clipboard
  // ────────────────────────────────────────────

  _copyToClipboard(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this._toast(successMsg || 'Copied', 'success'),
        () => this._toast('Copy failed', 'error')
      );
    } else {
      this._toast('Clipboard not available', 'error');
    }
  }

  // ────────────────────────────────────────────
  // Global bindings
  // ────────────────────────────────────────────

  _bindRefresh() {
    const btn = document.querySelector('.ws-tree-refresh');
    if (btn) btn.addEventListener('click', () => this.loadWorkspaces());
  }

  /** Bind the "+" button in the tree header to create a new workspace. */
  _bindTreeHeaderAdd() {
    const header = document.querySelector('.ws-tree-header');
    if (!header) return;
    // Only add once
    if (header.querySelector('.ws-tree-add')) return;
    const addBtn = document.createElement('button');
    addBtn.className = 'ws-tree-add';
    addBtn.textContent = '+';
    addBtn.title = 'Create workspace';
    addBtn.setAttribute('aria-label', 'Create workspace');
    addBtn.addEventListener('click', () => this._showCreateWorkspaceInput());
    header.appendChild(addBtn);
  }

  /** Bind "New Infra" button in the tree header to open Infra Wizard. */
  _bindNewEnvironment() {
    var header = document.querySelector('.ws-tree-header');
    if (!header) return;
    if (header.querySelector('.ws-new-env-btn')) return;

    var self = this;
    var newEnvBtn = document.createElement('button');
    newEnvBtn.className = 'ws-toolbar-btn ws-new-env-btn';
    newEnvBtn.title = 'Create new infra environment';
    newEnvBtn.textContent = '+ New Infra';
    newEnvBtn.addEventListener('click', function() {
      self._ctxNewInfra();
    });
    header.appendChild(newEnvBtn);
  }

  /** Listen for post-creation workspace navigation from Infra Wizard. */
  _bindWorkspaceSelectEvent() {
    var self = this;
    document.addEventListener('edog:select-workspace', function(e) {
      if (e.detail && e.detail.id) {
        self.selectWorkspace(e.detail.id);
      }
    });
  }

  /** Select a workspace by ID — refreshes list and highlights the target. */
  selectWorkspace(id) {
    var self = this;
    this.loadWorkspaces().then(function() {
      var ws = self._workspaces.find(function(w) { return w.id === id; });
      if (ws) {
        self._selectWorkspace(ws);
      }
    });
  }

  /** Open modal dialog for creating a new workspace. */
  _showCreateWorkspaceInput() {
    var self = this;
    var hasAuth = this._api.hasBearerToken();
    var dialog = new WorkspaceCreateDialog(this._api, {
      existingWorkspaces: this._workspaces
    });
    dialog.onComplete = function(result) {
      self.loadWorkspaces().then(function() {
        if (result && result.id) {
          self._expanded.add(result.id);
          self._renderTree();
        }
      });
    };
    dialog.open();
    if (!hasAuth) dialog._showNoAuth();
  }

  /** Context menu action: create lakehouse inside selected workspace. */
  async _ctxCreateLakehouse() {
    var t = this._ctxTarget;
    if (!t || !t.isWorkspace) return;
    var ws = t.workspace;
    var hasAuth = this._api.hasBearerToken();

    // Get existing items for duplicate name detection
    var children = this._children[ws.id] || [];
    var self = this;

    var dialog = new LakehouseCreateDialog(this._api, {
      workspaceId: ws.id,
      workspaceName: ws.displayName,
      existingItems: children
    });
    dialog.onComplete = function() {
      // Refresh workspace children
      delete self._children[ws.id];
      self._expanded.add(ws.id);
      self.loadWorkspaces().then(function() {
        self._renderTree();
      });
    };
    dialog.open();
    if (!hasAuth) dialog._showNoAuth();
  }

  /** Context menu action: create notebook inside selected workspace. */
  async _ctxCreateNotebook() {
    var t = this._ctxTarget;
    if (!t || !t.isWorkspace) return;
    var ws = t.workspace;
    var hasAuth = this._api.hasBearerToken();

    var children = this._children[ws.id] || [];
    var self = this;

    var dialog = new NotebookCreateDialog(this._api, {
      workspaceId: ws.id,
      workspaceName: ws.displayName,
      existingItems: children
    });
    dialog.onComplete = function() {
      delete self._children[ws.id];
      self._expanded.add(ws.id);
      self.loadWorkspaces().then(function() {
        self._renderTree();
      });
    };
    dialog.open();
    if (!hasAuth) dialog._showNoAuth();
  }

  _bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideContextMenu();
      // Ctrl+F inside content panel → focus table filter
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const filterInput = this._contentEl?.querySelector('.ws-filter-input');
        if (filterInput && this._contentEl.contains(document.activeElement)) {
          e.preventDefault();
          filterInput.focus();
          filterInput.select();
        }
      }
    });
  }

  /**
   * Insert a filter bar above the table container inside ws-tables-list.
   * @param {HTMLElement} tablesEl - the ws-tables-list element
   */
  _insertTableFilter(tablesEl) {
    // The filter sits above the schemas container (or legacy single-table container).
    const container = tablesEl.querySelector('.ws-schemas-container') || tablesEl.querySelector('.ws-table-container');
    if (!container) return;

    const filterDiv = document.createElement('div');
    filterDiv.className = 'ws-table-filter';
    filterDiv.innerHTML =
      '<svg class="ws-filter-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14.5" y2="14.5"/></svg>' +
      '<input class="ws-filter-input" placeholder="Filter tables..." />' +
      '<span class="ws-filter-count" style="display:none"></span>' +
      '<button class="ws-filter-clear" style="display:none">\u2715</button>';

    tablesEl.insertBefore(filterDiv, container);

    const input = filterDiv.querySelector('.ws-filter-input');
    const countEl = filterDiv.querySelector('.ws-filter-count');
    const clearBtn = filterDiv.querySelector('.ws-filter-clear');
    const rows = container.querySelectorAll('.ws-table-row[data-table-name]');
    const totalCount = rows.length;

    const applyFilter = () => {
      const query = input.value.toLowerCase();
      let visible = 0;
      // Track visible-row count per section so we can dim empty sections.
      const visibleBySchema = new Map();
      rows.forEach(row => {
        const name = (row.dataset.tableName || '').toLowerCase();
        const match = !query || name.includes(query);
        row.style.display = match ? '' : 'none';
        if (match) visible++;
        const schema = row.dataset.schemaName || 'dbo';
        if (match) visibleBySchema.set(schema, (visibleBySchema.get(schema) || 0) + 1);
      });
      // When filtering, hide sections with zero matches; restore them when cleared.
      container.querySelectorAll('.ws-schema-group').forEach(group => {
        const schema = group.dataset.schema;
        if (!query) {
          group.style.display = '';
        } else {
          group.style.display = visibleBySchema.get(schema) ? '' : 'none';
        }
      });
      if (query) {
        countEl.textContent = `${visible} of ${totalCount}`;
        countEl.style.display = '';
        clearBtn.style.display = '';
      } else {
        countEl.style.display = 'none';
        clearBtn.style.display = 'none';
      }
    };

    const clearFilter = () => {
      input.value = '';
      applyFilter();
      input.focus();
    };

    input.addEventListener('input', applyFilter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        clearFilter();
      }
    });
    clearBtn.addEventListener('click', clearFilter);
  }

  // ────────────────────────────────────────────
  // Data loading (API + mock)
  // ────────────────────────────────────────────

  async loadWorkspaces() {
    if (!this._treeEl) return;
    this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Loading...</div>';
    try {
      if (this._isMock && typeof MockData !== 'undefined') {
        this._workspaces = MockData.workspaces || [];
      } else {
        const data = await this._api.listWorkspaces();
        this._workspaces = (data && data.value) || [];
      }
      this._renderTree();
    } catch (err) {
      this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">Could not load workspaces</div>';
      this._toast(`Failed to load workspaces: ${err.message}`, 'error');
    }
  }

  async _loadChildren(ws) {
    if (this._isMock && typeof MockData !== 'undefined') {
      const wsIdx = this._workspaces.indexOf(ws);
      const items = MockData.getItemsForWorkspace(wsIdx >= 0 ? wsIdx : 0);
      return items || [];
    }
    const data = await this._api.listWorkspaceItems(ws.id);
    return (data && data.value) || [];
  }

  async _loadTables(wsId, lhId, capId) {
    if (this._isMock && typeof MockData !== 'undefined') {
      const tables = MockData.tablesForLakehouse || [];
      return { tables, schemas: [], errors: [] };
    }
    // Try public API first (works for non-schema lakehouses).
    // Public API returns a flat list with no schema metadata — synthesize an empty
    // schemas array so the renderer falls back to a single implicit "dbo" section.
    try {
      const data = await this._api.listTables(wsId, lhId);
      const tables = (data && (data.value || data.data)) || [];
      return { tables, schemas: [], errors: [] };
    } catch (e) {
      // 400 = schemas-enabled lakehouse → fall back to capacity host which
      // enumerates schemas via OneLake DFS and merges across them.
      if (e.status === 400 && capId) {
        const data = await this._api.listTablesViaCapacity(wsId, lhId, capId);
        const tables = (data && (data.value || data.data)) || [];
        const schemas = (data && data.schemas) || [];
        const errors = (data && data.errors) || [];
        return { tables, schemas, errors };
      }
      throw e;
    }
  }

  // ────────────────────────────────────────────
  // Tree rendering
  // ────────────────────────────────────────────

  _renderTree() {
    if (!this._treeEl) return;
    this._treeEl.innerHTML = '';
    if (this._workspaces.length === 0) {
      this._treeEl.innerHTML = '<div class="ws-tree-item dimmed" style="justify-content:center">No workspaces found</div>';
      return;
    }

    for (const ws of this._workspaces) {
      const isExpanded = this._expanded.has(ws.id);
      const isSelected = this._selectedWorkspace && this._selectedWorkspace.id === ws.id && !this._selectedItem;
      const children = this._children[ws.id];
      const childCount = children ? children.length : null;

      const wsEl = this._buildTreeNode({
        name: ws.displayName,
        depth: 0,
        isWorkspace: true,
        expanded: isExpanded,
        selected: isSelected,
        countBadge: childCount,
        actions: true,
      });

      // Click toggle arrow → expand/collapse; click name → select AND expand
      const toggleEl = wsEl.querySelector('.ws-tree-toggle');
      const nameEl = wsEl.querySelector('.ws-tree-name');
      if (toggleEl) {
        toggleEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleWorkspace(ws);
        });
      }
      if (nameEl) {
        nameEl.addEventListener('click', (e) => {
          e.stopPropagation();
          // Select workspace AND expand if not already expanded
          if (!this._expanded.has(ws.id)) {
            this._toggleWorkspace(ws);
          }
          this._selectWorkspace(ws);
        });
      }
      // Fallback: clicking the row toggles + selects
      wsEl.addEventListener('click', () => {
        if (!this._expanded.has(ws.id)) {
          this._toggleWorkspace(ws);
        }
        this._selectWorkspace(ws);
      });

      // Action button events
      if (wsEl._renameBtn) {
        wsEl._renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._startRename({ workspace: ws, isWorkspace: true });
        });
      }
      if (wsEl._deleteBtn) {
        wsEl._deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._handleDelete({ workspace: ws, isWorkspace: true });
        });
      }
      if (wsEl._moreBtn) {
        wsEl._moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showContextMenu(e, { workspace: ws, item: null, isWorkspace: true, isLakehouse: false });
        });
      }

      // Context menu
      wsEl.addEventListener('contextmenu', (e) => {
        this._showContextMenu(e, { workspace: ws, item: null, isWorkspace: true, isLakehouse: false });
      });

      this._treeEl.appendChild(wsEl);

      if (isExpanded) {
        if (!this._children[ws.id]) {
          // Loading indicator while children are being fetched
          const loadEl = document.createElement('div');
          loadEl.className = 'ws-tree-item dimmed';
          loadEl.setAttribute('data-depth', '1');
          loadEl.textContent = 'Loading\u2026';
          this._treeEl.appendChild(loadEl);
        } else {
          for (const item of this._children[ws.id]) {
          const isLH = this._isLakehouse(item);
          const isItemSelected = this._selectedItem && this._selectedItem.id === item.id;
          const itemEl = this._buildTreeNode({
            name: item.displayName,
            depth: 1,
            dotColor: this._getItemColor(item.type),
            typeBadge: this._getTypeAbbrev(item.type),
            dimmed: !isLH,
            selected: isItemSelected,
            childAnim: true,
            actions: true,
          });

          itemEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this._selectItem(item, ws);
          });

          // Action button events for child items
          if (itemEl._renameBtn) {
            itemEl._renameBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this._startRename({ workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
            });
          }
          if (itemEl._deleteBtn) {
            itemEl._deleteBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this._handleDelete({ workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
            });
          }
          if (itemEl._moreBtn) {
            itemEl._moreBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              this._showContextMenu(e, { workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
            });
          }

          itemEl.addEventListener('contextmenu', (e) => {
            this._showContextMenu(e, { workspace: ws, item, isWorkspace: false, isLakehouse: isLH });
          });

          this._treeEl.appendChild(itemEl);
          }
        }
      }
    }
  }

  /**
   * Build a single tree-node DOM element.
   * Supports: SVG chevron toggle, folder icon, color dot, type badge,
   * count badge, hover action buttons (rename/delete/more).
   * @param {object} opts
   */
  _buildTreeNode(opts) {
    const el = document.createElement('div');
    let cls = 'ws-tree-item';
    if (opts.dimmed) cls += ' dimmed';
    if (opts.selected) cls += ' selected';
    if (opts.childAnim) cls += ' ws-tree-child';
    el.className = cls;
    el.setAttribute('data-depth', String(opts.depth || 0));

    // SVG chevron toggle (workspaces only)
    if (opts.isWorkspace) {
      const toggle = document.createElement('span');
      toggle.className = 'ws-tree-toggle' + (opts.expanded ? ' expanded' : '');
      toggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      el.appendChild(toggle);

      // Folder icon
      const folder = document.createElement('span');
      folder.className = 'ws-tree-folder-icon';
      folder.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
      el.appendChild(folder);
    }

    // Color dot (child items)
    if (opts.dotColor) {
      const dot = document.createElement('span');
      dot.className = 'ws-tree-dot';
      dot.style.background = opts.dotColor;
      el.appendChild(dot);
    }

    // Name label
    const nameEl = document.createElement('span');
    nameEl.className = 'ws-tree-name';
    nameEl.textContent = opts.name;
    el.appendChild(nameEl);

    // Type badge for child items ("LH", "NB", etc.)
    if (opts.typeBadge) {
      const badge = document.createElement('span');
      badge.className = 'ws-tree-type-badge';
      badge.textContent = opts.typeBadge;
      el.appendChild(badge);
    }

    // Count badge for workspaces ("N items")
    if (opts.countBadge !== undefined && opts.countBadge !== null) {
      const count = document.createElement('span');
      count.className = 'ws-tree-count';
      count.textContent = opts.countBadge === 1 ? '1 item' : `${opts.countBadge} items`;
      el.appendChild(count);
    }

    // Hover action buttons: rename, delete, ⋯
    if (opts.actions) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'ws-tree-actions';

      // Rename
      const renBtn = document.createElement('button');
      renBtn.className = 'ws-tree-action-btn';
      renBtn.title = 'Rename';
      renBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
      actionsEl.appendChild(renBtn);

      // Delete
      const delBtn = document.createElement('button');
      delBtn.className = 'ws-tree-action-btn danger';
      delBtn.title = 'Delete';
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
      actionsEl.appendChild(delBtn);

      // More (⋯)
      const moreBtn = document.createElement('button');
      moreBtn.className = 'ws-tree-action-btn';
      moreBtn.title = 'More actions';
      moreBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
      actionsEl.appendChild(moreBtn);

      el.appendChild(actionsEl);

      // Store refs for event binding
      el._renameBtn = renBtn;
      el._deleteBtn = delBtn;
      el._moreBtn = moreBtn;
    }

    return el;
  }

  // ────────────────────────────────────────────
  // Tree interactions
  // ────────────────────────────────────────────

  async _toggleWorkspace(ws) {
    if (this._expanded.has(ws.id)) {
      this._expanded.delete(ws.id);
    } else {
      this._expanded.add(ws.id);
      if (!this._children[ws.id]) {
        // Show loading state immediately
        this._renderTree();
        try {
          let items = await this._loadChildren(ws);
          // Filter out internal artifacts (SqlAnalyticsEndpoint, etc.)
          items = items.filter(i => {
            const t = (i.type || '').toLowerCase();
            return !t.includes('sqlanalyticsendpoint') && !t.includes('kqlquerysetoverride');
          });
          items.sort((a, b) => {
            const aLH = this._isLakehouse(a) ? 0 : 1;
            const bLH = this._isLakehouse(b) ? 0 : 1;
            return aLH - bLH || (a.displayName || '').localeCompare(b.displayName || '');
          });
          this._children[ws.id] = items;
        } catch (err) {
          this._toast(`Failed to load items: ${err.message}`, 'error');
          this._expanded.delete(ws.id);
        }
      }
    }
    this._renderTree();
    // Refresh content panel if this workspace is currently selected
    if (this._selectedWorkspace && this._selectedWorkspace.id === ws.id && !this._selectedItem) {
      this._showWorkspaceContent(ws);
    }
  }

  _selectWorkspace(ws) {
    this._selectedWorkspace = ws;
    this._selectedItem = null;
    this._showWorkspaceContent(ws);
    this._showWorkspaceInspector(ws);
    this._renderTree();
  }

  _selectItem(item, workspace) {
    // Clean up active notebook IDE if navigating away
    if (this._activeNotebookView) {
      this._activeNotebookView.destroy();
      this._activeNotebookView = null;
      const inspectorPanel = document.getElementById('ws-inspector-panel');
      if (inspectorPanel) inspectorPanel.style.display = '';
    }

    this._selectedItem = { ...item, workspaceId: workspace.id, workspaceName: workspace.displayName };
    this._selectedWorkspace = workspace;

    this._showItemContent(item, workspace);
    this._clearInspector();
    this._renderTree();
  }

  // ────────────────────────────────────────────
  // Content panel: Workspace
  // ────────────────────────────────────────────

  _showWorkspaceContent(ws) {
    if (!this._contentEl) return;
    const capacityId = ws.capacityId || '';
    const envLabel = this._getEnvironmentLabel(ws);

    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(ws.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-guid" title="Click to copy" data-copy-id="${this._esc(ws.id)}">${this._esc(ws.id)}</span>`;
    if (capacityId) {
      html += `<span class="ws-meta-badge ws-badge-env">${this._esc(envLabel)}</span>`;
    }
    html += '</div></div>';

    // Action buttons with icons
    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="rename-ws"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>Rename</button>';
    html += '<button class="ws-action-btn" data-action="open-fabric-ws"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open in Fabric</button>';
    html += '<button class="ws-action-btn danger" data-action="delete-ws"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>Delete</button>';
    html += '</div>';

    // Items table
    const children = this._children[ws.id] || [];
    if (children.length > 0) {
      html += `<div class="ws-section"><div class="ws-section-title">Items<span class="ws-section-count">(${children.length})</span></div>`;
      html += '<table class="ws-table"><thead><tr>';
      html += '<th>Name</th><th>Type</th><th>Status</th><th>Last Modified</th>';
      html += '</tr></thead><tbody>';
      for (const item of children) {
        const isLH = this._isLakehouse(item);
        const rowCls = isLH ? 'ws-table-row' : 'ws-table-row dimmed';
        const modified = item.lastModified ? this._formatDate(item.lastModified) : '\u2014';
        html += `<tr class="${rowCls}" data-item-id="${this._esc(item.id)}">`;
        html += `<td class="ws-table-name">${this._esc(item.displayName)}</td>`;
        html += `<td><span class="ws-type-badge">${this._esc(item.type || 'Item')}</span></td>`;
        html += `<td>${this._esc(item.status || 'Active')}</td>`;
        html += `<td class="ws-meta-modified">${modified}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    } else {
      // If expanded but no children loaded yet, or genuinely empty
      if (this._expanded.has(ws.id)) {
        html += '<div class="ws-section"><div class="ws-section-title">Items</div>';
        html += '<div class="ws-tree-item dimmed" style="justify-content:center">No items</div></div>';
      }
    }

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
  }

  _bindContentActions(ws) {
    if (!this._contentEl) return;

    // Click-to-copy on ID (supports both .ws-meta-id and .ws-guid)
    const idEl = this._contentEl.querySelector('.ws-meta-id') || this._contentEl.querySelector('.ws-guid');
    if (idEl) {
      idEl.addEventListener('click', () => {
        const copyId = idEl.dataset.copyId || ws.id;
        this._copyToClipboard(copyId, 'Copied!');
        idEl.classList.add('copied');
        const origText = idEl.textContent;
        idEl.textContent = 'Copied!';
        setTimeout(() => {
          idEl.classList.remove('copied');
          idEl.textContent = origText;
        }, 1200);
      });
    }

    // Action buttons
    this._contentEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'rename-ws') {
          this._ctxTarget = { workspace: ws, item: null, isWorkspace: true, isLakehouse: false };
          this._ctxRename();
        } else if (action === 'delete-ws') {
          this._ctxTarget = { workspace: ws, item: null, isWorkspace: true, isLakehouse: false };
          this._ctxDelete();
        } else if (action === 'open-fabric-ws') {
          window.open(`https://app.fabric.microsoft.com/groups/${ws.id}`, '_blank');
        } else if (action === 'rename-lh') {
          const lh = this._selectedItem;
          if (lh) {
            this._ctxTarget = { workspace: ws, item: lh, isWorkspace: false, isLakehouse: true };
            this._ctxRename();
          }
        } else if (action === 'open-fabric-lh') {
          window.open(`https://app.fabric.microsoft.com/groups/${ws.id}`, '_blank');
        } else if (action === 'clone-env') {
          this._cloneEnvironment(ws);
        } else if (action === 'open-notebook-ide') {
          this._openNotebookIDE(this._selectedItem, this._selectedWorkspace);
        } else if (action === 'rename-item') {
          const itm = this._selectedItem;
          if (itm) {
            this._ctxTarget = { workspace: ws, item: itm, isWorkspace: false, isLakehouse: false };
            this._ctxRename();
          }
        } else if (action === 'delete-item') {
          const itm = this._selectedItem;
          if (itm) {
            this._ctxTarget = { workspace: ws, item: itm, isWorkspace: false, isLakehouse: false };
            this._ctxDelete();
          }
        }
      });
    });

    // Table row clicks → select that item
    this._contentEl.querySelectorAll('.ws-table-row[data-item-id]').forEach(row => {
      row.addEventListener('click', () => {
        const itemId = row.dataset.itemId;
        const children = this._children[ws.id] || [];
        const item = children.find(c => c.id === itemId);
        if (item) this._selectItem(item, ws);
      });
    });
  }

  // ────────────────────────────────────────────
  // Content panel: Lakehouse
  // ────────────────────────────────────────────

  async _showLakehouseContent(lh, ws) {
    if (!this._contentEl) return;

    const envLabel = this._getEnvironmentLabel(ws);
    const health = this._getHealthStatus(ws);
    const lastMod = lh.lastUpdatedDate ? this._formatDate(lh.lastUpdatedDate) : null;

    // V2 Header — icon + name + status pill + meta row
    let html = '<div class="ws-lh-header">';
    html += '<div class="ws-lh-header-icon">';
    html += '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
    html += '</div>';
    html += '<div class="ws-lh-header-info">';
    html += '<div class="ws-lh-name-row">';
    html += `<div class="ws-content-name">${this._esc(lh.displayName)}</div>`;
    html += '<span class="ws-status-pill ws-pill-hidden" id="ws-status-pill"></span>';
    html += '</div>';
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-guid" data-copy-id="${this._esc(lh.id)}" title="Click to copy full ID: ${this._esc(lh.id)}">${this._esc(lh.id)}</span>`;
    html += `<span class="ws-badge ws-badge-env">${this._esc(envLabel)}</span>`;
    if (ws._region) {
      html += `<span class="ws-badge ws-badge-region">${this._esc(ws._region)}</span>`;
    }
    if (lastMod) {
      html += `<span class="ws-modified">Modified ${lastMod}</span>`;
    }
    html += '</div>';
    html += '</div></div>';

    // V2 Action Bar — primary left, secondary right
    html += '<div class="ws-v2-actions" id="ws-content-actions">';
    html += '<div class="ws-v2-actions-left">';
    html += '<button class="ws-btn-primary" id="ws-deploy-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg> Deploy</button>';
    html += '</div>';
    html += '<div class="ws-v2-actions-right">';
    html += '<button class="ws-btn-ghost" data-action="open-fabric-lh"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open in Fabric</button>';
    html += '<button class="ws-btn-ghost" data-action="rename-lh"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>Rename</button>';
    html += '<button class="ws-btn-ghost" data-action="clone-env"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Clone</button>';
    html += '</div></div>';

    // Deploy progress container
    html += '<div id="ws-deploy-progress" class="ws-deploy-progress" style="display:none"></div>';

    // Tables section
    html += '<div class="ws-section"><div class="ws-section-title">Tables</div>';
    html += '<div id="ws-tables-list">Loading tables...</div></div>';

    this._contentEl.innerHTML = html;

    // Bind GUID click-to-copy
    const guidEl = this._contentEl.querySelector('.ws-guid[data-copy-id]');
    if (guidEl) {
      guidEl.addEventListener('click', () => {
        const fullId = guidEl.dataset.copyId;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(fullId).then(() => {
            guidEl.classList.add('copied');
            this._toast('ID copied to clipboard', 'success');
            setTimeout(() => guidEl.classList.remove('copied'), 2000);
          });
        }
      });
    }

    // Sync deploy button state from studio status
    this._syncDeployButtons(lh, ws);

    // Bind actions
    const deployBtn = document.getElementById('ws-deploy-btn');
    if (deployBtn) {
      deployBtn.addEventListener('click', () => this._deployToLakehouse(lh, ws));
    }
    this._bindContentActions(ws);

    // Load tables — show shimmer while fetching
    try {
      let tablesEl = document.getElementById('ws-tables-list');
      if (tablesEl) {
        tablesEl.innerHTML =
          '<div class="ws-table-container">' +
          '<div class="skel-wrap">' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--md"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--md"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '<div class="skel-row"><div class="skel-circle"></div><div class="skel-lines"><div class="skel-line skel-line--lg"></div><div class="skel-line skel-line--sm"></div></div></div>' +
          '</div></div>';
      }
      const { tables, schemas, errors } = await this._loadTables(ws.id, lh.id, ws.capacityId);
      tablesEl = document.getElementById('ws-tables-list');
      if (!tablesEl) return;

      // Update section title with count
      const titleEl = tablesEl.closest('.ws-section')?.querySelector('.ws-section-title');
      if (titleEl) titleEl.innerHTML = `Tables <span class="ws-section-count">${tables.length}</span>`;

      if (tables.length === 0 && schemas.length === 0) {
        tablesEl.innerHTML =
          '<div class="ws-empty-state ws-empty-inline">' +
          '<div class="ws-empty-title">No tables</div>' +
          '<div class="ws-empty-desc">Tables appear after data is written to this lakehouse</div>' +
          '</div>';
        return;
      }

      // Reset sort state
      this._tableSort = { col: 'name', dir: 'asc' };
      this._tableSortOriginalRows = null;

      // Store tables for enrichment merging — normalize field names. Each row keeps
      // its `schemaName` (server-annotated) so the inspector + enrichment can
      // disambiguate same-named tables in different schemas.
      this._currentTables = tables.map(t => ({
        ...t,
        type: t.tableType || t.type || '',
        format: t.tableFormat || t.format || 'delta',
        schemaName: t.schemaName || 'dbo',
      }));

      // Build the schema sections: one collapsible card per schema with its own
      // table inside. For non-schemas-enabled lakehouses (public REST path) the
      // backend returns no `schemas` array; we synthesize a single implicit "dbo"
      // section so the renderer is uniform.
      this._renderTablesBySchema(tablesEl, this._currentTables, schemas, errors, ws.id, lh.id);

      // Insert table filter bar above the schema container
      this._insertTableFilter(tablesEl);

      // Bind sort handlers on every section's column headers
      tablesEl.querySelectorAll('.ws-table th.sortable').forEach(th => {
        th.addEventListener('click', () => this._sortTable(th.dataset.col, tablesEl));
      });

      // Bind table row clicks → inspector. Rows now carry both data-table-name
      // and data-schema-name so we look up by the (name, schema) pair.
      tablesEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
        row.addEventListener('click', () => {
          tablesEl.querySelectorAll('.ws-table-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          const src = this._currentTables || tables;
          const tbl = src.find(x =>
            x.name === row.dataset.tableName &&
            (x.schemaName || 'dbo') === (row.dataset.schemaName || 'dbo'),
          );
          if (tbl) this._showTableInspector(tbl);
        });
      });

      // Auto-enrich: fetch detailed metadata (type, schema, rowCount, size) in
      // background. We MUST pass (name, schema) per table — schemas-enabled
      // lakehouses route batchGetTableDetails through `/schemas/{name}/...`.
      if (ws.capacityId && tables.length > 0) {
        const enrichList = this._currentTables.map(t => ({
          name: t.name,
          schema: t.schemaName || 'dbo',
        }));
        this._api.getTableDetails(ws.id, lh.id, ws.capacityId, enrichList)
          .then(result => this._enrichTableRows(result))
          .catch(() => this._clearTableShimmer());

        // Fetch row count + size for each table via OneLake delta log.
        // OneLake paths include the schema (`Tables/{schema}/{name}/_delta_log`),
        // so we MUST pass the schema for non-dbo tables or the backend 502s.
        for (const t of this._currentTables) {
          const schemaName = t.schemaName || 'dbo';
          this._api.getTableStats(ws.id, lh.id, t.name, schemaName)
            .then(stats => {
              if (!stats) return;
              const hasRows = stats.rowCount != null;
              const hasSize = stats.sizeBytes != null;
              if (!hasRows && !hasSize) return;
              const stored = (this._currentTables || []).find(x =>
                x.name === t.name && (x.schemaName || 'dbo') === schemaName,
              );
              if (stored) {
                if (hasRows) stored.rowCount = stats.rowCount;
                if (hasSize) stored.sizeInBytes = stats.sizeBytes;
              }
              // DOM update — disambiguate by both name + schema
              const row = tablesEl.querySelector(
                `.ws-table-row[data-table-name="${CSS.escape(t.name)}"][data-schema-name="${CSS.escape(schemaName)}"]`,
              );
              if (row) {
                const rowsCell = row.children[3];
                const sizeCell = row.children[4];
                if (rowsCell && hasRows) {
                  rowsCell.className = 'num';
                  rowsCell.textContent = this._numFmt.format(stats.rowCount);
                }
                if (sizeCell && hasSize) {
                  sizeCell.className = 'num';
                  sizeCell.textContent = this._formatSize(stats.sizeBytes);
                }
              }
            })
            .catch(() => {}); // silently degrade — enrichTableRows already set dashes
        }
      }
    } catch (err) {
      const errEl = document.getElementById('ws-tables-list');
      if (errEl) {
        let title = 'Could not load tables';
        let detail = err.message || 'Unknown error';
        let actionHtml = '';
        const lhRef = lh;
        const wsRef = ws;

        if (err.status === 502) {
          title = 'Capacity host unavailable (502)';
          detail = 'The capacity may be restarting.';
          actionHtml = '<button class="ws-action-btn ws-retry-btn">Retry</button>';
        } else if (err.status === 401 || err.status === 403 || (err.message && err.message.toLowerCase().includes('auth'))) {
          title = 'Authentication error';
          detail = 'Could not generate MWC token';
          actionHtml = '<button class="ws-action-btn ws-retry-btn">Re-authenticate</button>';
        } else {
          actionHtml = '<button class="ws-action-btn ws-retry-btn">Retry</button>';
        }

        errEl.innerHTML =
          '<div class="ws-error-state">' +
          '<div class="ws-error-icon">\u2715</div>' +
          '<div class="ws-error-title">' + this._esc(title) + '</div>' +
          '<div class="ws-error-detail">' + this._esc(detail) + '</div>' +
          actionHtml +
          '</div>';

        const retryBtn = errEl.querySelector('.ws-retry-btn');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => {
            this._showLakehouseContent(lhRef, wsRef);
          });
        }
      }
      this._toast(`Tables: ${err.message}`, 'error');
    }
  }

  // ────────────────────────────────────────────
  // Schema-grouped table rendering
  // ────────────────────────────────────────────

  /**
   * Render tables grouped into collapsible sections by schema.
   * @param {HTMLElement} tablesEl - the #ws-tables-list container
   * @param {Array<object>} tables - normalized tables (each with `schemaName`)
   * @param {Array<{name,isShortcut,tableCount,error?}>} schemas - server-reported schemas
   * @param {Array<{schema,error}>} errors - per-schema fetch errors from the server
   * @param {string} wsId
   * @param {string} lhId
   */
  _renderTablesBySchema(tablesEl, tables, schemas, errors, wsId, lhId) {
    // Group tables by schema name.
    const bySchema = new Map();
    for (const t of tables) {
      const s = t.schemaName || 'dbo';
      if (!bySchema.has(s)) bySchema.set(s, []);
      bySchema.get(s).push(t);
    }

    // Build authoritative schema list: prefer the server-reported order
    // (preserves OneLake DFS directory order). Fall back to whatever names
    // we saw on the rows themselves (non-schemas-enabled lakehouses).
    let schemaList;
    if (schemas && schemas.length > 0) {
      schemaList = schemas.map(s => ({
        name: s.name,
        isShortcut: !!s.isShortcut,
        error: s.error || null,
        tables: bySchema.get(s.name) || [],
      }));
    } else if (bySchema.size > 0) {
      schemaList = Array.from(bySchema.keys()).sort().map(name => ({
        name, isShortcut: false, error: null, tables: bySchema.get(name),
      }));
    } else {
      schemaList = [{ name: 'dbo', isShortcut: false, error: null, tables: [] }];
    }

    // Surface schema-level fetch errors that weren't already in `schemas`.
    if (errors && errors.length > 0) {
      const seen = new Set(schemaList.map(s => s.name));
      for (const e of errors) {
        if (!seen.has(e.schema)) {
          schemaList.push({ name: e.schema, isShortcut: false, error: e.error, tables: [] });
        }
      }
    }

    const collapseState = this._loadSchemaCollapseState(wsId, lhId);
    const showSingle = schemaList.length > 1;

    const parts = ['<div class="ws-schemas-container">'];
    for (const s of schemaList) {
      const safeName = this._esc(s.name);
      const sid = `ws-schema-body-${s.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const collapsed = collapseState[s.name] === 'closed';
      const mlvCount = s.tables.filter(t => (t.tableType || t.type || '').toUpperCase() === 'MATERIALIZED_LAKE_VIEW').length;
      const tableCount = s.tables.length;
      let metaText;
      if (tableCount === 0) {
        metaText = s.error ? 'fetch failed' : 'empty';
      } else if (mlvCount > 0) {
        const tCount = tableCount - mlvCount;
        const tWord = tCount === 1 ? 'table' : 'tables';
        const mWord = mlvCount === 1 ? 'MLV' : 'MLVs';
        metaText = tCount > 0 ? `${tCount} ${tWord} · ${mlvCount} ${mWord}` : `${mlvCount} ${mWord}`;
      } else {
        metaText = `${tableCount} ${tableCount === 1 ? 'table' : 'tables'}`;
      }

      const badges = [];
      if (s.isShortcut) badges.push('<span class="ws-schema-tag shortcut">shortcut</span>');
      if (s.error) badges.push('<span class="ws-schema-tag error">error</span>');

      parts.push(
        `<section class="ws-schema-group" data-schema="${safeName}" data-collapsed="${collapsed}">` +
        `<button class="ws-schema-header" type="button" aria-expanded="${!collapsed}" aria-controls="${sid}">` +
        '<span class="ws-schema-chevron" aria-hidden="true">\u25BE</span>' +
        `<span class="ws-schema-name">${safeName}</span>` +
        `<span class="ws-schema-meta">${this._esc(metaText)}</span>` +
        (badges.length ? `<span class="ws-schema-badges">${badges.join('')}</span>` : '') +
        '</button>' +
        `<div class="ws-schema-body" id="${sid}">`,
      );

      if (s.error) {
        parts.push(`<div class="ws-schema-error-detail">${this._esc(s.error)}</div>`);
      }

      if (s.tables.length === 0 && !s.error) {
        parts.push('<div class="ws-schema-empty">No tables in this schema</div>');
      } else if (s.tables.length > 0) {
        parts.push('<table class="ws-table"><thead><tr>');
        parts.push('<th class="sortable sorted" data-col="name">Name <span class="sort-icon">\u25B2</span></th>');
        parts.push('<th class="sortable" data-col="type">Type <span class="sort-icon">\u25B2\u25BC</span></th>');
        parts.push('<th class="sortable" data-col="format">Format <span class="sort-icon">\u25B2\u25BC</span></th>');
        parts.push('<th class="sortable num" data-col="rows">Rows <span class="sort-icon">\u25B2\u25BC</span></th>');
        parts.push('<th class="sortable num" data-col="size">Size <span class="sort-icon">\u25B2\u25BC</span></th>');
        parts.push('</tr></thead><tbody>');
        for (const t of s.tables) {
          const tType = t.tableType || t.type || '';
          const tFormat = t.tableFormat || t.format || 'delta';
          const iconCls = this._tableIconClass(tType);
          const iconChar = this._tableIconChar(tType);
          parts.push(
            `<tr class="ws-table-row" data-table-name="${this._esc(t.name)}" data-schema-name="${safeName}">` +
            `<td class="ws-table-name"><span class="ws-table-icon ${iconCls}">${iconChar}</span>${this._esc(t.name)}</td>` +
            `<td><span class="ws-type-badge ${iconCls}">${this._esc(this._tableTypeBadge(tType))}</span></td>` +
            `<td>${this._esc(tFormat)}</td>` +
            '<td class="num">\u2014</td>' +
            '<td class="num">\u2014</td>' +
            '</tr>',
          );
        }
        parts.push('</tbody></table>');
      }

      parts.push('</div></section>');
    }
    parts.push('</div>');
    tablesEl.innerHTML = parts.join('');

    // Wire collapse/expand toggles.
    tablesEl.querySelectorAll('.ws-schema-header').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.ws-schema-group');
        if (!group) return;
        const wasCollapsed = group.dataset.collapsed === 'true';
        group.dataset.collapsed = wasCollapsed ? 'false' : 'true';
        btn.setAttribute('aria-expanded', wasCollapsed ? 'true' : 'false');
        const name = group.dataset.schema;
        const state = this._loadSchemaCollapseState(wsId, lhId);
        if (wasCollapsed) delete state[name];
        else state[name] = 'closed';
        this._saveSchemaCollapseState(wsId, lhId, state);
      });
    });

    // If single schema and user has never customized state, leave open — no
    // section header collapsing surprise. (Multi-schema case is the default.)
    void showSingle;
  }

  _schemaStateKey(wsId, lhId) {
    return `edog:ws-explorer:schema-state:${wsId}:${lhId}`;
  }

  _loadSchemaCollapseState(wsId, lhId) {
    try {
      const raw = localStorage.getItem(this._schemaStateKey(wsId, lhId));
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }

  _saveSchemaCollapseState(wsId, lhId, state) {
    try {
      localStorage.setItem(this._schemaStateKey(wsId, lhId), JSON.stringify(state));
    } catch {
      // localStorage may be unavailable (private mode); ignore.
    }
  }

  // ────────────────────────────────────────────
  // Table sorting (DOM-only, no re-fetch)
  // ────────────────────────────────────────────

  /**
   * Cycle sort: asc → desc → neutral (original order).
   * @param {string} column - data-col value (name, type, format)
   * @param {HTMLElement} container - the ws-tables-list element
   */
  _sortTable(column, container) {
    const tables = container.querySelectorAll('.ws-table');
    if (tables.length === 0) return;

    // Capture original order on first sort interaction — per tbody (each
    // section has its own table, so we keep one snapshot per tbody).
    if (!this._tableSortOriginalRows) {
      this._tableSortOriginalRows = new Map();
      tables.forEach(tbl => {
        const tb = tbl.querySelector('tbody');
        if (tb) this._tableSortOriginalRows.set(tb, Array.from(tb.querySelectorAll('tr')));
      });
    }

    // Determine next direction (single global state shared across sections)
    let nextDir;
    if (this._tableSort.col === column) {
      if (this._tableSort.dir === 'asc') nextDir = 'desc';
      else if (this._tableSort.dir === 'desc') nextDir = null;
      else nextDir = 'asc';
    } else {
      nextDir = 'asc';
    }

    this._tableSort = { col: nextDir ? column : null, dir: nextDir };

    const colIndex = { name: 0, type: 1, format: 2, rows: 3, size: 4 }[column] ?? 0;
    const isNumeric = column === 'rows' || column === 'size';

    // Apply sort to every section's tbody independently.
    tables.forEach(tbl => {
      const tbody = tbl.querySelector('tbody');
      if (!tbody) return;
      if (!nextDir) {
        const snap = this._tableSortOriginalRows.get(tbody) || [];
        for (const row of snap) tbody.appendChild(row);
        return;
      }
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const mult = nextDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const aText = (a.children[colIndex]?.textContent || '').trim();
        const bText = (b.children[colIndex]?.textContent || '').trim();
        if (isNumeric) {
          const aNum = parseFloat(aText.replace(/[^0-9.]/g, '')) || 0;
          const bNum = parseFloat(bText.replace(/[^0-9.]/g, '')) || 0;
          return (aNum - bNum) * mult;
        }
        const aLow = aText.toLowerCase();
        const bLow = bText.toLowerCase();
        return aLow < bLow ? -1 * mult : aLow > bLow ? 1 * mult : 0;
      });
      for (const row of rows) tbody.appendChild(row);
    });

    // Update header icons across every section.
    container.querySelectorAll('.ws-table th.sortable').forEach(th => {
      const icon = th.querySelector('.sort-icon');
      if (!icon) return;
      if (th.dataset.col === this._tableSort.col) {
        th.classList.add('sorted');
        icon.textContent = this._tableSort.dir === 'asc' ? '\u25B2' : '\u25BC';
      } else {
        th.classList.remove('sorted');
        icon.textContent = '\u25B2\u25BC';
      }
    });
  }

  // ────────────────────────────────────────────
  // Table enrichment (auto-fetch rows/size/schema)
  // ────────────────────────────────────────────

  /**
   * Map a table type string to a short display badge label.
   * @param {string} type - e.g. "MATERIALIZED_LAKE_VIEW", "EXTERNAL", "MANAGED"
   * @returns {string} Short badge label
   */
  _tableTypeBadge(type) {
    const map = {
      'MATERIALIZED_LAKE_VIEW': 'MLV',
      'EXTERNAL': 'External',
      'MANAGED': 'Managed',
    };
    return map[type] || type || 'Table';
  }

  /**
   * Map a table type to a CSS class for the colored icon badge.
   * @param {string} type
   * @returns {string} CSS class name (mlv, managed, external)
   */
  _tableIconClass(type) {
    const map = {
      'MATERIALIZED_LAKE_VIEW': 'mlv',
      'EXTERNAL': 'external',
      'MANAGED': 'managed',
    };
    return map[type] || '';
  }

  /**
   * Map a table type to a single-character icon.
   * @param {string} type
   * @returns {string}
   */
  _tableIconChar(type) {
    const map = {
      'MATERIALIZED_LAKE_VIEW': 'M',
      'EXTERNAL': 'E',
      'MANAGED': 'T',
    };
    return map[type] || 'T';
  }

  /**
   * Format byte counts to human-readable size strings.
   * @param {number} bytes
   * @returns {string} e.g. "156 MB", "1.2 GB"
   */
  _formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '\u2014';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
  }

  /**
   * Enrich rendered table rows with data from batchGetTableDetails response.
   * Updates shimmer cells with actual values and merges data onto stored tables.
   * @param {object} result - Response from getTableDetails API
   */
  _enrichTableRows(result) {
    // API response shapes (in order of precedence):
    //   - New schemas-aware shape: `{ tables: [...] }` — rows already have `schemaName`
    //   - LRO poll shape: `{ result: { value: [...] } }` — legacy single-schema path
    //   - Direct shape: `{ value: [...] }`
    const items = result?.tables || result?.result?.value || result?.value || [];

    // Map by (schemaName, tableName) so same-named tables in different schemas
    // don't shadow each other.
    const detailMap = new Map();
    const keyOf = (schema, name) => `${schema || 'dbo'}::${name}`;
    for (const item of items) {
      const name = item.tableName || item.name;
      if (!name) continue;
      detailMap.set(keyOf(item.schemaName, name), item);
    }

    // Merge onto stored table objects for inspector use
    if (this._currentTables) {
      for (const tbl of this._currentTables) {
        const detail = detailMap.get(keyOf(tbl.schemaName, tbl.name));
        if (!detail) continue;
        if (detail.result) {
          tbl.location = detail.result.location || tbl.location;
          tbl.schema = detail.result.schema || tbl.schema;
          tbl._enrichedType = detail.result.type || null;
          if (detail.result.format) tbl.format = detail.result.format;
        }
        tbl.schemaName = detail.schemaName || tbl.schemaName;
        tbl.status = detail.status;
        tbl.rowCount = detail.result?.rowCount ?? null;
        tbl.sizeInBytes = detail.result?.sizeInBytes ?? null;
      }
    }

    // Update DOM cells — match each row by (schemaName, tableName)
    const tablesEl = document.getElementById('ws-tables-list');
    if (!tablesEl) return;

    tablesEl.querySelectorAll('.ws-table-row[data-table-name]').forEach(row => {
      const name = row.dataset.tableName;
      const schema = row.dataset.schemaName || 'dbo';
      const detail = detailMap.get(keyOf(schema, name));

      const rowsCell = row.children[3];
      const sizeCell = row.children[4];

      if (detail && detail.result) {
        const typeBadge = row.children[1]?.querySelector('.ws-type-badge');
        if (typeBadge && detail.result.type) {
          typeBadge.textContent = this._tableTypeBadge(detail.result.type);
        }
        if (rowsCell && detail.result.rowCount != null) {
          rowsCell.className = 'num';
          rowsCell.textContent = this._numFmt.format(detail.result.rowCount);
        }
        if (sizeCell && detail.result.sizeInBytes != null) {
          sizeCell.className = 'num';
          sizeCell.textContent = this._formatSize(detail.result.sizeInBytes);
        }
      }
    });

    // If inspector is showing a table that just got enriched, refresh it
    const inspNameEl = this._inspectorEl?.querySelector('.ws-insp-kv dd');
    if (inspNameEl && this._currentTables) {
      const inspName = inspNameEl.textContent;
      const enrichedTable = this._currentTables.find(t => t.name === inspName);
      if (enrichedTable && enrichedTable.schema && enrichedTable.schema.length > 0) {
        this._showTableInspector(enrichedTable);
      }
    }
  }

  /**
   * Remove shimmer from Rows/Size cells, replacing with dash placeholders.
   * Called when enrichment is skipped (no capacityId) or fails.
   */
  _clearTableShimmer() {
    const tablesEl = document.getElementById('ws-tables-list');
    if (!tablesEl) return;
    tablesEl.querySelectorAll('.skel-cell').forEach(cell => {
      cell.className = 'num';
      cell.textContent = '\u2014';
    });
  }

  // ────────────────────────────────────────────
  // Content panel: Type dispatcher
  // ────────────────────────────────────────────

  _showItemContent(item, ws) {
    if (!this._contentEl) return;
    const type = (item.type || '').toLowerCase();

    if (type === 'lakehouse') {
      this._showLakehouseContent(item, ws);
    } else if (type === 'notebook') {
      this._showNotebookContent(item, ws);
    } else if (type === 'environment') {
      this._showEnvironmentContent(item, ws);
    } else {
      this._showGenericItemContent(item, ws);
    }
  }

  // ──── Type-Specific Content Views ────

  async _showNotebookContent(item, ws) {
    // Fetch notebook properties (cached per workspace)
    if (!this._notebookCache[ws.id]) {
      try {
        const resp = await this._api.listNotebooks(ws.id);
        this._notebookCache[ws.id] = resp.value || [];
      } catch (e) {
        this._notebookCache[ws.id] = [];
      }
    }
    const nbData = this._notebookCache[ws.id].find(n => n.id === item.id);
    const props = nbData?.properties || {};
    const defaultLH = props.defaultLakehouse;
    const attachedEnv = props.attachedEnvironment;

    let html = this._buildRichHeader(item, ws);

    // Action bar
    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn accent" data-action="open-notebook-ide" title="Open notebook cell editor">&#9654; Open Notebook IDE</button>';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh" title="Open in Fabric portal">Open in Fabric</button>';
    html += `<button class="ws-action-btn" data-action="rename-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}" title="Rename notebook">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}" title="Delete notebook">Delete</button>`;
    html += '</div>';

    // Linked item cards
    if (defaultLH || attachedEnv) {
      html += '<div class="ws-linked-cards">';
      if (defaultLH) {
        const lhName = this._resolveItemName(ws.id, defaultLH.itemId) || defaultLH.itemId;
        html += this._buildLinkedCard(lhName, 'Default Lakehouse', 'LH', defaultLH.itemId, 'var(--status-succeeded)');
      }
      if (attachedEnv) {
        const envName = this._resolveItemName(ws.id, attachedEnv.itemId) || attachedEnv.itemId;
        html += this._buildLinkedCard(envName, 'Attached Environment', 'ENV', attachedEnv.itemId, 'var(--comp-onelake)');
      }
      html += '</div>';
    }

    // Notebook info card
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Notebook Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Default Lakehouse', defaultLH ? (this._resolveItemName(ws.id, defaultLH.itemId) || defaultLH.itemId) : '\u2014');
    html += this._infoRow('Attached Environment', attachedEnv ? (this._resolveItemName(ws.id, attachedEnv.itemId) || attachedEnv.itemId) : '\u2014');
    html += this._infoRow('Description', item.description || '\u2014');
    html += '</div></div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._bindLinkedCardClicks(ws);
    this._showItemInspector(item, ws, { defaultLH, attachedEnv });
  }

  async _showEnvironmentContent(item, ws) {
    if (!this._environmentCache[ws.id]) {
      try {
        const resp = await this._api.listEnvironments(ws.id);
        this._environmentCache[ws.id] = resp.value || [];
      } catch (e) {
        this._environmentCache[ws.id] = [];
      }
    }
    const envData = this._environmentCache[ws.id].find(e => e.id === item.id);
    const props = envData?.properties || {};
    const publish = props.publishDetails || {};
    const state = publish.state || 'Unknown';

    let html = this._buildRichHeader(item, ws);

    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>';
    html += `<button class="ws-action-btn" data-action="rename-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Delete</button>`;
    html += '</div>';

    // Publish status card
    const stateClass = state === 'Success' ? 'success' : state === 'Running' ? 'running' : state === 'Failed' ? 'failed' : '';
    html += '<div class="ws-env-publish"><div class="ws-env-publish-header">Publish Status</div><div class="ws-env-publish-body">';
    html += `<div class="ws-status-row"><span class="ws-status-dot ${stateClass}"></span><span class="ws-status-label">State</span><span class="ws-status-value">${this._esc(state)}</span></div>`;

    if (publish.targetVersion) {
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:var(--space-4)">Version</span><span class="ws-status-value mono">${this._esc(publish.targetVersion)}</span></div>`;
    }
    if (publish.startTime) {
      const start = new Date(publish.startTime);
      const end = publish.endTime ? new Date(publish.endTime) : null;
      const duration = end ? ((end - start) / 1000).toFixed(1) + 's' : 'In progress';
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:var(--space-4)">Published</span><span class="ws-status-value">${start.toLocaleString()}</span></div>`;
      html += `<div class="ws-status-row"><span class="ws-status-label" style="margin-left:var(--space-4)">Duration</span><span class="ws-status-value">${this._esc(duration)}</span></div>`;
    }

    // Component breakdown
    const components = publish.componentPublishInfo || {};
    if (Object.keys(components).length > 0) {
      html += `<div style="margin-top:var(--space-3);font-size:var(--text-xs);font-weight:600;color:var(--text-muted)">Components</div>`;
      for (const [name, comp] of Object.entries(components)) {
        const cState = comp?.state || 'Unknown';
        const cClass = cState === 'Success' ? 'success' : cState === 'Running' ? 'running' : 'failed';
        const label = name === 'sparkLibraries' ? 'Spark Libraries' : name === 'sparkSettings' ? 'Spark Settings' : name;
        html += `<div class="ws-status-row"><span class="ws-status-dot ${cClass}"></span><span class="ws-status-label">${this._esc(label)}</span><span class="ws-status-value">${this._esc(cState)}</span></div>`;
      }
    }
    html += '</div></div>';

    // Environment info
    html += '<div class="ws-item-info"><div class="ws-item-info-header">Environment Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Description', item.description || 'Environment');
    html += this._infoRow('Workspace', ws.name || ws.displayName || ws.id);
    html += '</div></div>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._showItemInspector(item, ws, { publish });
  }

  _showGenericItemContent(item, ws) {
    let html = this._buildRichHeader(item, ws);

    html += '<div class="ws-content-actions">';
    html += '<button class="ws-action-btn" data-action="open-fabric-lh">Open in Fabric</button>';
    html += `<button class="ws-action-btn" data-action="rename-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Rename</button>`;
    html += `<button class="ws-action-btn danger" data-action="delete-item" data-item-id="${this._esc(item.id)}" data-ws-id="${this._esc(ws.id)}">Delete</button>`;
    html += '</div>';

    html += '<div class="ws-item-info"><div class="ws-item-info-header">Item Info</div><div class="ws-item-info-body">';
    html += this._infoRow('Type', item.type || 'Unknown');
    html += this._infoRow('Description', item.description || '\u2014');
    html += this._infoRow('Workspace', ws.name || ws.displayName || ws.id);
    html += this._infoRow('ID', item.id);
    html += '</div></div>';

    html += '<a class="ws-fabric-link" href="#" data-action="open-fabric-lh">More details available in Fabric \u2197</a>';

    this._contentEl.innerHTML = html;
    this._bindContentActions(ws);
    this._showItemInspector(item, ws, {});
  }

  // ────────────────────────────────────────────
  // Content panel: Empty state
  // ────────────────────────────────────────────

  _showEmptyContent() {
    if (!this._contentEl) return;
    this._contentEl.innerHTML =
      '<div class="ws-empty-state">' +
      '<svg class="ws-empty-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<path d="M6 10a2 2 0 012-2h10l4 4h18a2 2 0 012 2v24a2 2 0 01-2 2H8a2 2 0 01-2-2V10z"/>' +
      '<path d="M6 18h36" stroke-dasharray="2 2" opacity="0.4"/>' +
      '</svg>' +
      '<div class="ws-empty-title">Select a workspace or lakehouse</div>' +
      '<div class="ws-empty-desc">Browse the tree on the left to explore your Fabric environment</div>' +
      '</div>';
  }

  // ────────────────────────────────────────────
  // Inspector panel
  // ────────────────────────────────────────────

  _showTableInspector(table) {
    if (!this._inspectorEl) return;
    // Switching tables must dismiss any open sample-rows modal — the inspector
    // is about to rewrite its innerHTML, which would orphan the modal's block.
    if (this._openSampleModals && this._openSampleModals.size) {
      for (const blk of Array.from(this._openSampleModals)) {
        this._closeSampleRowsModal(blk);
      }
    }
    this._selectedTable = table;
    let html = '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Table Info</div>';
    html += '<dl class="ws-insp-kv">';
    const fields = [
      ['Name', table.name],
      ['Type', this._tableTypeBadge(table.tableType || table.type || table._enrichedType || '')],
      ['Format', table.tableFormat || table.format || 'delta'],
    ];
    if (table.location) {
      fields.push(['Location', table.location]);
    }
    if (table.schemaName) {
      fields.push(['Schema', table.schemaName]);
    }
    for (const [label, val] of fields) {
      html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
    }
    html += '</dl></div>';

    // Schema section — render immediately if available, otherwise show shimmer
    if (table.schema && table.schema.length > 0) {
      html += this._renderSchemaSection(table.schema);
    } else if (this._selectedWorkspace && this._selectedWorkspace.capacityId) {
      html += this._renderSchemaShimmer();
    }

    // Preview section — column headers from schema or placeholder
    html += this._renderPreviewSection(table);

    this._inspectorEl.innerHTML = html;

    this._bindPreviewActions(table);

    // Auto-load schema if not already enriched
    if (!(table.schema && table.schema.length > 0) &&
        this._selectedWorkspace && this._selectedWorkspace.capacityId) {
      this._autoLoadSchema(table);
    }
  }

  /** Render the schema columns section from an array of column descriptors. */
  _renderSchemaSection(schema) {
    let html = '<div class="ws-insp-section">';
    html += `<div class="ws-insp-title">Schema <span class="ws-insp-count">${schema.length} columns</span></div>`;
    html += '<table class="ws-insp-cols"><thead><tr><th>Column</th><th>Type</th><th>Null</th></tr></thead><tbody>';
    for (const col of schema) {
      html += '<tr>';
      html += `<td class="ws-col-name">${this._esc(col.name)}</td>`;
      html += `<td class="ws-col-type">${this._esc(col.type)}</td>`;
      html += `<td>${col.nullable ? '\u2713' : ''}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  /** Render shimmer skeleton placeholder for schema loading. */
  _renderSchemaShimmer() {
    let html = '<div class="ws-insp-section ws-insp-schema-loading">';
    html += '<div class="ws-insp-title">Schema</div>';
    html += '<div class="ws-insp-skel">';
    html += '<div class="skel-line skel-line--lg"></div>';
    html += '<div class="skel-line skel-line--md"></div>';
    html += '<div class="skel-line skel-line--sm"></div>';
    html += '</div></div>';
    return html;
  }

  /** Render inline error with retry for failed schema load. */
  _renderSchemaError(table) {
    let html = '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Schema</div>';
    html += '<div class="ws-error-inline">Could not load schema ';
    html += '<button class="ws-retry-link">Retry</button></div></div>';
    return html;
  }

  /** Render the Preview/Definition section.
   *
   * The Preview area is rendered as a "tap to load" stub on first paint so we
   * don't hit OneLake for every selected table. Loading state, the actual
   * fetched metadata, and error states are all rendered by `_handlePreviewLoad`
   * (single source of truth for that lifecycle).
   *
   * Why a button instead of auto-load: the table metadata is a separate
   * OneLake DFS round-trip per table; opening a workspace with 100 tables
   * would otherwise fan out 100 requests. Tap-to-load keeps it scoped.
   */
  _renderPreviewSection(table) {
    const isMlv =
      table?.tableType === 'MATERIALIZED_LAKE_VIEW' ||
      (table?.type || '').toUpperCase().includes('MATERIALIZED');
    const sectionTitle = isMlv ? 'Definition' : 'Preview';
    const ctaLabel = isMlv ? 'View SELECT statement' : 'View DDL & properties';
    let html = `<div class="ws-insp-section ws-preview-section" data-loaded="false">`;
    html += `<div class="ws-insp-title">${sectionTitle}</div>`;
    html += '<div class="ws-preview-placeholder">';
    html += `<div class="ws-empty-desc">${isMlv ? 'Tap to load the materialized lake view SELECT.' : 'Tap to load CREATE TABLE DDL and table properties.'}</div>`;
    html += `<button class="ws-action-btn ws-preview-btn" type="button">${ctaLabel}</button>`;
    html += '</div></div>';
    return html;
  }

  /** Bind click handler for the Load Preview button. */
  _bindPreviewActions(table) {
    if (!this._inspectorEl) return;
    const btn = this._inspectorEl.querySelector('.ws-preview-btn');
    if (!btn) return;
    btn.addEventListener('click', () => this._handlePreviewLoad(table));
  }

  /** Handle Preview/Definition load — fetch OneLake metadata and render. */
  async _handlePreviewLoad(table) {
    if (!this._inspectorEl) return;
    const section = this._inspectorEl.querySelector('.ws-preview-section');
    if (!section) return;
    if (section.getAttribute('data-loading') === 'true') return;
    section.setAttribute('data-loading', 'true');

    const isMlv =
      table?.tableType === 'MATERIALIZED_LAKE_VIEW' ||
      (table?.type || '').toUpperCase().includes('MATERIALIZED');
    const sectionTitle = isMlv ? 'Definition' : 'Preview';

    // Shimmer
    let shimmer = `<div class="ws-insp-title">${sectionTitle}</div>`;
    shimmer += '<div class="ws-insp-skel">';
    shimmer += '<div class="skel-line skel-line--lg"></div>';
    shimmer += '<div class="skel-line skel-line--lg"></div>';
    shimmer += '<div class="skel-line skel-line--md"></div>';
    shimmer += '</div>';
    section.innerHTML = shimmer;

    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;
    const schema = table?.schemaName || 'dbo';
    const tableName = table?.name;

    if (!ws || !lh || !tableName) {
      this._renderPreviewError(section, sectionTitle, 'Missing workspace / lakehouse context.');
      section.removeAttribute('data-loading');
      return;
    }

    let metadata;
    try {
      metadata = await this._api.getTableMetadata(ws.id, lh.id, schema, tableName);
    } catch (err) {
      const detail = err?.body?.message || err?.message || 'Unknown error.';
      this._renderPreviewError(section, sectionTitle, detail);
      section.removeAttribute('data-loading');
      return;
    }

    if (!metadata) {
      // No FLT-managed metadata. Fall back to the schema we already have on
      // the inspector — we can still render a synthesized DDL from it.
      this._renderPreviewFallbackDdl(section, table, sectionTitle);
      section.setAttribute('data-loaded', 'true');
      section.removeAttribute('data-loading');
      return;
    }

    if (isMlv && metadata.viewText) {
      this._renderPreviewMlv(section, metadata, table);
    } else {
      this._renderPreviewTable(section, metadata, table);
    }
    section.setAttribute('data-loaded', 'true');
    section.removeAttribute('data-loading');
  }

  /** Render a clear error state inside the preview section. */
  _renderPreviewError(section, title, message) {
    let html = `<div class="ws-insp-title">${title}</div>`;
    html += '<div class="ws-preview-placeholder ws-preview-error">';
    html += `<div class="ws-empty-desc">${this._esc(message)}</div>`;
    html += '<button class="ws-action-btn ws-preview-btn" type="button">Retry</button>';
    html += '</div>';
    section.innerHTML = html;
    section.removeAttribute('data-loaded');
    const btn = section.querySelector('.ws-preview-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const t = this._selectedTable;
        if (t) this._handlePreviewLoad(t);
      });
    }
  }

  /** MLV → render the SELECT statement and source entities. */
  _renderPreviewMlv(section, md, table) {
    const lang = (md.properties?.['fabric.mlv.source.language'] || 'sql').toUpperCase();
    const refresh = md.properties?.['fabric.mlv.refreshTimestamp'];
    const sparkVer = md.properties?.['fabric.mlv.sparkversion'];

    let html = '<div class="ws-insp-title">Definition</div>';

    // SELECT statement block
    html += '<div class="ws-preview-block">';
    html += '<div class="ws-preview-block-head">';
    html += `<span class="ws-preview-block-label">SELECT</span>`;
    html += `<span class="ws-preview-lang-badge">${this._esc(lang)}</span>`;
    html += '<button class="ws-preview-copy-btn" type="button" data-copy="sql" title="Copy SELECT">Copy</button>';
    html += '</div>';
    html += `<pre class="ws-sql-block" data-sql>${this._esc(md.viewText)}</pre>`;
    html += '</div>';

    // Source entities
    if (Array.isArray(md.sourceEntities) && md.sourceEntities.length > 0) {
      html += '<div class="ws-preview-block">';
      html += '<div class="ws-preview-block-head"><span class="ws-preview-block-label">Source tables</span></div>';
      html += '<ul class="ws-source-entities">';
      for (const e of md.sourceEntities) {
        const ns = e.namespace || {};
        const fqn = [ns.workspaceName, ns.artifactName, ns.schemaName, e.tableName].filter(Boolean).join('.');
        const cdf = e.properties?.cdfEnabled === 'true';
        const sourceSchema = ns.schemaName || 'dbo';
        const localMatch = Array.isArray(this._currentTables)
          ? this._currentTables.find(t =>
              (t.schemaName || 'dbo') === sourceSchema && t.name === e.tableName,
            )
          : null;
        const isLink = !!localMatch;
        const classes = ['ws-source-entity'];
        if (isLink) classes.push('is-link');
        else classes.push('is-foreign');

        const attrs = isLink
          ? ` role="button" tabindex="0" data-source-schema="${this._esc(sourceSchema)}" data-source-table="${this._esc(e.tableName)}" title="Open ${this._esc(fqn)}"`
          : ` title="Not in the currently loaded tables view"`;

        html += `<li class="${classes.join(' ')}"${attrs}>`;
        html += `<span class="ws-source-fqn">${this._esc(fqn)}</span>`;
        if (cdf) html += '<span class="ws-source-tag">CDF</span>';
        if (isLink) html += '<span class="ws-source-arrow" aria-hidden="true">\u203A</span>';
        html += '</li>';
      }
      html += '</ul></div>';
    }

    // Refresh metadata
    html += '<dl class="ws-insp-kv ws-preview-meta">';
    if (refresh) html += `<dt>Last refresh</dt><dd>${this._esc(this._formatTs(refresh))}</dd>`;
    if (sparkVer) html += `<dt>Spark version</dt><dd>${this._esc(sparkVer)}</dd>`;
    const sourceInfo = this._parseMlvSourceInfo(md.properties?.['fabric.mlv.sourceinfo']);
    if (sourceInfo) {
      const url = `https://app.fabric.microsoft.com/groups/${encodeURIComponent(sourceInfo.workspaceId)}/synapsenotebooks/${encodeURIComponent(sourceInfo.notebookId)}`;
      const title = `Notebook ${sourceInfo.notebookId} in workspace ${sourceInfo.workspaceId}`;
      const label = sourceInfo.entryFunction
        ? `Open in Fabric \u00b7 ${sourceInfo.entryFunction}()`
        : 'Open in Fabric';
      html += `<dt>Source notebook</dt><dd><a class="ws-preview-link" href="${this._esc(url)}" target="_blank" rel="noopener" title="${this._esc(title)}">${this._esc(label)} \u2197</a></dd>`;
    }
    if (md.properties?.['delta.enableChangeDataFeed'] === 'true') {
      html += '<dt>CDF</dt><dd>Enabled</dd>';
    }
    html += '</dl>';

    html += this._renderPreviewSampleRowsBlock(table?.schemaName || 'dbo', table?.name || '');

    section.innerHTML = html;
    this._wirePreviewCopyButtons(section);
    this._wirePreviewSourceLinks(section);
    this._wirePreviewSampleRows(section);
  }

  /**
   * Wire click + keyboard handlers on `.ws-source-entity.is-link` items.
   * Activating a row swaps the inspector to the matching local table.
   */
  _wirePreviewSourceLinks(section) {
    const items = section.querySelectorAll('.ws-source-entity.is-link[data-source-table]');
    items.forEach((el) => {
      const open = () => {
        const schemaName = el.getAttribute('data-source-schema') || 'dbo';
        const tableName = el.getAttribute('data-source-table');
        if (!tableName || !Array.isArray(this._currentTables)) return;
        const target = this._currentTables.find(t =>
          (t.schemaName || 'dbo') === schemaName && t.name === tableName,
        );
        if (target) this._showTableInspector(target);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      });
    });
  }

  /**
   * Parse the `fabric.mlv.sourceinfo` catalog property (a JSON string written
   * by Fabric when an MLV is created). Returns `{ workspaceId, notebookId,
   * entryFunction }` when both IDs are present and valid, or `null` for any
   * absent / empty / malformed / partial value. SQL MLVs may legally omit
   * sourceinfo entirely.
   */
  _parseMlvSourceInfo(raw) {
    if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const workspaceId = typeof obj.source_workspace_id === 'string' ? obj.source_workspace_id.trim() : '';
    const notebookId = typeof obj.source_notebook_id === 'string' ? obj.source_notebook_id.trim() : '';
    if (!workspaceId || !notebookId) return null;
    return {
      workspaceId,
      notebookId,
      entryFunction: typeof obj.source_entry_function === 'string' ? obj.source_entry_function.trim() : '',
    };
  }

  /**
   * Sample-rows block — initial HTML.
   *
   * Renders the collapsed "Sample rows" affordance — a tap-to-load button.
   * Tap-to-load (not auto-load) is deliberate: same Preview discipline as the
   * outer block. Avoids fan-out for users who only want to read the DDL.
   *
   * `schemaName`/`tableName` ride on the DOM so the click handler can read
   * them without closure threading on re-render.
   *
   * Control glyphs (refresh / expand) are appended dynamically once the block
   * reaches the `loaded` state, so the pre-load affordance stays minimal.
   *
   * Single source of truth: after wiring, the DOM block owns a `_rowsState`
   * property; both inline and modal views render purely from that state, so
   * a refresh from either surface keeps the other in sync.
   */
  _renderPreviewSampleRowsBlock(schemaName, tableName) {
    if (!tableName) return '';
    return (
      '<div class="ws-preview-block ws-preview-rows-block" ' +
      `data-rows-schema="${this._esc(schemaName)}" ` +
      `data-rows-table="${this._esc(tableName)}">` +
      '<div class="ws-preview-block-head">' +
      '<span class="ws-preview-block-label">Sample rows</span>' +
      '<span class="ws-preview-lang-badge">DATA</span>' +
      '</div>' +
      '<button class="ws-preview-rows-load-btn" type="button" data-rows-load>' +
      'Load first 10 rows' +
      '</button>' +
      '</div>'
    );
  }

  /**
   * Wire the sample-rows block: initialize its `_rowsState` and attach the
   * first-load click handler. Idempotent guards live inside the load/refresh
   * handlers (status checks), not here.
   */
  _wirePreviewSampleRows(section) {
    const block = section.querySelector('.ws-preview-rows-block');
    if (!block) return;
    block._rowsState = {
      status: 'idle',
      result: null,
      prevResult: null,
      error: null,
      schemaName: block.getAttribute('data-rows-schema') || 'dbo',
      tableName: block.getAttribute('data-rows-table') || '',
      limit: 10,
      modalEl: null,
      modalBodyEl: null,
      modalMetaEl: null,
      prevActiveElement: null,
      escHandler: null,
    };
    const btn = block.querySelector('[data-rows-load]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!block._rowsState.tableName) return;
      this._handlePreviewSampleFirstLoad(block);
    });
  }

  /**
   * First-load fetch path: shows shimmer in the body while the request is in
   * flight, then transitions to `loaded` (grid + controls) or `error`.
   */
  async _handlePreviewSampleFirstLoad(block) {
    const state = block._rowsState;
    if (!state || state.status === 'loading' || !state.tableName) return;
    state.status = 'loading';
    state.error = null;

    // Clear any leftover load button / error block / previous body.
    const oldBtn = block.querySelector('[data-rows-load]');
    if (oldBtn) oldBtn.remove();
    const oldErr = block.querySelector('.ws-preview-rows-error');
    if (oldErr) oldErr.remove();
    const oldBody = block.querySelector('.ws-preview-rows-body');
    if (oldBody) oldBody.remove();

    const skel = document.createElement('div');
    skel.className = 'ws-insp-skel ws-preview-rows-skel';
    skel.innerHTML =
      '<div class="skel-line skel-line--lg"></div>' +
      '<div class="skel-line skel-line--lg"></div>' +
      '<div class="skel-line skel-line--md"></div>';
    block.appendChild(skel);

    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;
    if (!ws || !lh) {
      state.status = 'error';
      state.error = 'Missing workspace / lakehouse context.';
      skel.remove();
      this._renderPreviewSampleError(block);
      return;
    }

    let result;
    try {
      result = await this._api.getTablePreviewRows(
        ws.id,
        lh.id,
        state.schemaName,
        state.tableName,
        state.limit,
      );
    } catch (err) {
      state.status = 'error';
      state.error = err?.body?.message || err?.message || 'Unknown error.';
      skel.remove();
      this._renderPreviewSampleError(block);
      return;
    }

    state.status = 'loaded';
    state.result = result;
    skel.remove();
    this._renderSampleRowsLoaded(block);
  }

  /**
   * Refresh path — optimistic: the existing grid stays mounted (dimmed via
   * `data-refreshing="true"`) while the new fetch is in flight. We never wipe
   * to a shimmer; that would feel like a blank page on every refresh.
   *
   * On success: swap the grid contents in place (inline + modal, if open).
   * On failure: restore the previous result, show a transient toast.
   */
  async _handleSampleRowsRefresh(block) {
    const state = block._rowsState;
    if (!state || state.status === 'loading' || !state.tableName) return;

    state.status = 'loading';
    state.prevResult = state.result;
    state.error = null;

    block.setAttribute('data-refreshing', 'true');
    if (state.modalEl) state.modalEl.setAttribute('data-refreshing', 'true');
    this._setRefreshButtonsBusy(block, true);

    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;
    const restoreOnFailure = (message) => {
      state.status = 'loaded';
      state.result = state.prevResult;
      state.prevResult = null;
      state.error = message;
      block.removeAttribute('data-refreshing');
      if (state.modalEl) state.modalEl.removeAttribute('data-refreshing');
      this._setRefreshButtonsBusy(block, false);
      this._showRefreshErrorToast(block, message);
    };

    if (!ws || !lh) {
      restoreOnFailure('Missing workspace / lakehouse context.');
      return;
    }

    let result;
    try {
      result = await this._api.getTablePreviewRows(
        ws.id,
        lh.id,
        state.schemaName,
        state.tableName,
        state.limit,
      );
    } catch (err) {
      restoreOnFailure(err?.body?.message || err?.message || 'Unknown error.');
      return;
    }

    state.status = 'loaded';
    state.result = result;
    state.prevResult = null;
    block.removeAttribute('data-refreshing');
    if (state.modalEl) state.modalEl.removeAttribute('data-refreshing');
    this._setRefreshButtonsBusy(block, false);

    // Re-render both surfaces from the (now updated) single source of truth.
    this._renderSampleRowsLoaded(block);
  }

  /**
   * Render the `loaded` state: replace the inline body, ensure the header
   * controls exist, and mirror the result into the modal if one is open.
   */
  _renderSampleRowsLoaded(block) {
    const state = block._rowsState;
    let body = block.querySelector('.ws-preview-rows-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'ws-preview-rows-body';
      block.appendChild(body);
    }
    this._renderSampleRowsBody(body, state.result, { modal: false });
    this._ensureSampleRowsControls(block);
    if (state.modalEl && state.modalBodyEl) {
      this._renderSampleRowsBody(state.modalBodyEl, state.result, { modal: true });
      this._updateModalMeta(block);
    }
  }

  /**
   * Pure-DOM render of the grid (+ warnings + truncation note) into a
   * container. Inline and modal both go through this, so they cannot drift.
   * `opts.modal: true` adds the `--wide` modifier (no max-width clamp, 12px).
   */
  _renderSampleRowsBody(container, result, opts) {
    container.innerHTML = '';
    if (result === null) {
      const empty = document.createElement('div');
      empty.className = 'ws-preview-empty-block';
      empty.textContent =
        'No Delta log for this table — not materialized yet, or not a Delta table.';
      container.appendChild(empty);
      return;
    }

    if (Array.isArray(result.warnings) && result.warnings.length) {
      for (const w of result.warnings) {
        const warn = document.createElement('div');
        warn.className = opts && opts.modal
          ? 'ws-preview-rows-warning ws-sample-modal-warning'
          : 'ws-preview-rows-warning';
        warn.textContent = w;
        container.appendChild(warn);
      }
    }

    const cols = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!cols.length || !rows.length) {
      const empty = document.createElement('div');
      empty.className = 'ws-preview-empty-block';
      empty.textContent = rows.length
        ? 'Rows returned but column schema is empty.'
        : 'Table is empty — no rows in any active Delta file.';
      container.appendChild(empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'ws-preview-rows-wrap';
    const tbl = document.createElement('table');
    tbl.className =
      'ws-preview-rows-grid' + (opts && opts.modal ? ' ws-preview-rows-grid--wide' : '');
    let thead = '<thead><tr>';
    for (const c of cols) {
      const pcCls = c.isPartition ? ' is-partition' : '';
      const title = c.isPartition
        ? `${c.name} (partition column, ${c.type})`
        : `${c.name} (${c.type})`;
      thead +=
        `<th class="ws-preview-rows-th${pcCls}" title="${this._esc(title)}">` +
        `<span class="ws-preview-rows-col-name">${this._esc(c.name)}</span>` +
        `<span class="ws-preview-rows-col-type">${this._esc(c.type)}</span>` +
        '</th>';
    }
    thead += '</tr></thead>';
    let tbody = '<tbody>';
    for (const r of rows) {
      tbody += '<tr>';
      for (const c of cols) {
        const v = r[c.name];
        tbody += `<td class="ws-preview-rows-td">${this._formatCellValue(v)}</td>`;
      }
      tbody += '</tr>';
    }
    tbody += '</tbody>';
    tbl.innerHTML = thead + tbody;
    wrap.appendChild(tbl);
    container.appendChild(wrap);

    if (result.truncated || result.fileCount > 1) {
      const note = document.createElement('div');
      note.className = 'ws-preview-note-line';
      const truncTxt = result.truncated
        ? `Showing first ${result.rowsReturned} rows`
        : `Showing ${result.rowsReturned} rows`;
      const fileTxt =
        result.fileCount > 1 ? ` from 1 of ${result.fileCount} active files.` : '.';
      note.textContent = truncTxt + fileTxt;
      container.appendChild(note);
    }
  }

  /**
   * Append the `↻` `⤢` control cluster to the block header. No-op if already
   * present — `_renderSampleRowsLoaded` is called on every refresh, so this
   * must be idempotent.
   */
  _ensureSampleRowsControls(block) {
    const head = block.querySelector('.ws-preview-block-head');
    if (!head) return;
    if (head.querySelector('.ws-preview-rows-controls')) return;
    const controls = document.createElement('div');
    controls.className = 'ws-preview-rows-controls';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ws-rows-icon-btn ws-rows-icon-btn--refresh';
    refresh.title = 'Refresh';
    refresh.setAttribute('aria-label', 'Refresh sample rows');
    refresh.innerHTML = '<span class="ws-rows-icon ws-rows-icon--refresh">\u21BB</span>';
    refresh.addEventListener('click', () => this._handleSampleRowsRefresh(block));

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'ws-rows-icon-btn ws-rows-icon-btn--expand';
    expand.title = 'Expand';
    expand.setAttribute('aria-label', 'Expand sample rows');
    expand.innerHTML = '<span class="ws-rows-icon ws-rows-icon--expand">\u2922</span>';
    expand.addEventListener('click', () => this._openSampleRowsModal(block));

    controls.appendChild(refresh);
    controls.appendChild(expand);
    head.appendChild(controls);
  }

  /**
   * Reflect the in-flight refresh on every refresh button (inline + modal).
   * The CSS handles the spinning glyph and dimmed grid via `data-refreshing`.
   */
  _setRefreshButtonsBusy(block, busy) {
    const state = block._rowsState;
    const targets = [];
    block.querySelectorAll('.ws-rows-icon-btn--refresh').forEach((b) => targets.push(b));
    if (state && state.modalEl) {
      state.modalEl
        .querySelectorAll('.ws-rows-icon-btn--refresh')
        .forEach((b) => targets.push(b));
    }
    for (const b of targets) {
      if (busy) {
        b.setAttribute('aria-busy', 'true');
        b.disabled = true;
      } else {
        b.removeAttribute('aria-busy');
        b.disabled = false;
      }
    }
  }

  /**
   * Show a transient error toast inside the inline body (and modal body, if
   * open) for ~4s. Used when refresh fails — we keep the existing grid.
   */
  _showRefreshErrorToast(block, message) {
    const msg = 'Refresh failed: ' + (message || 'Unknown error.');
    const targets = [];
    const inlineBody = block.querySelector('.ws-preview-rows-body');
    if (inlineBody) targets.push(inlineBody);
    const state = block._rowsState;
    if (state && state.modalBodyEl) targets.push(state.modalBodyEl);

    const toasts = [];
    for (const t of targets) {
      const old = t.querySelector(':scope > .ws-rows-toast');
      if (old) old.remove();
      const toast = document.createElement('div');
      toast.className = 'ws-rows-toast';
      toast.setAttribute('role', 'alert');
      toast.textContent = msg;
      t.insertBefore(toast, t.firstChild);
      toasts.push(toast);
    }
    setTimeout(() => {
      for (const t of toasts) {
        if (t && t.parentNode) t.parentNode.removeChild(t);
      }
    }, 4000);
  }

  /**
   * Render the error state for a *first* load (no controls, Retry button).
   * Refresh errors take a different path — `_showRefreshErrorToast` — so the
   * grid never disappears under a developer's hands.
   */
  _renderPreviewSampleError(block) {
    const state = block._rowsState;
    block.removeAttribute('data-rows-loading');

    const oldErr = block.querySelector('.ws-preview-rows-error');
    if (oldErr) oldErr.remove();
    const oldRetry = block.querySelector('.ws-preview-rows-load-btn');
    if (oldRetry) oldRetry.remove();

    const err = document.createElement('div');
    err.className = 'ws-preview-empty-block ws-preview-rows-error';
    err.textContent = (state && state.error) || 'Unknown error.';
    block.appendChild(err);

    const retry = document.createElement('button');
    retry.className = 'ws-preview-rows-load-btn';
    retry.type = 'button';
    retry.setAttribute('data-rows-load', '');
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      err.remove();
      retry.remove();
      if (state) state.status = 'idle';
      this._handlePreviewSampleFirstLoad(block);
    });
    block.appendChild(retry);
  }

  /**
   * Build and mount the modal. Renders content from `state.result` (cheap —
   * no fetch). Carries over `data-refreshing` if a refresh is in flight, so
   * the modal's refresh icon spins in sync with the inline one.
   */
  _openSampleRowsModal(block) {
    const state = block._rowsState;
    if (!state || state.modalEl) return;
    state.prevActiveElement = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'ws-sample-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute(
      'aria-label',
      `Sample rows: ${state.schemaName}.${state.tableName}`,
    );
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeSampleRowsModal(block);
    });

    const dialog = document.createElement('div');
    dialog.className = 'ws-sample-modal-dialog';

    const header = document.createElement('div');
    header.className = 'ws-sample-modal-header';

    const title = document.createElement('div');
    title.className = 'ws-sample-modal-title';
    title.textContent = `${state.schemaName}.${state.tableName}`;
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'ws-sample-modal-meta';
    header.appendChild(meta);
    state.modalMetaEl = meta;

    const actions = document.createElement('div');
    actions.className = 'ws-sample-modal-actions';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ws-rows-icon-btn ws-rows-icon-btn--refresh';
    refresh.title = 'Refresh';
    refresh.setAttribute('aria-label', 'Refresh sample rows');
    refresh.innerHTML = '<span class="ws-rows-icon ws-rows-icon--refresh">\u21BB</span>';
    refresh.addEventListener('click', () => this._handleSampleRowsRefresh(block));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ws-rows-icon-btn ws-rows-icon-btn--close';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close sample rows');
    close.innerHTML = '<span class="ws-rows-icon ws-rows-icon--close">\u2715</span>';
    close.addEventListener('click', () => this._closeSampleRowsModal(block));

    actions.appendChild(refresh);
    actions.appendChild(close);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'ws-sample-modal-body';

    dialog.appendChild(header);
    dialog.appendChild(body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    state.modalEl = overlay;
    state.modalBodyEl = body;
    this._openSampleModals.add(block);

    this._renderSampleRowsBody(body, state.result, { modal: true });
    this._updateModalMeta(block);

    // Carry over a refresh-in-flight from inline → modal.
    if (block.getAttribute('data-refreshing') === 'true') {
      overlay.setAttribute('data-refreshing', 'true');
      refresh.setAttribute('aria-busy', 'true');
      refresh.disabled = true;
    }

    state.escHandler = (e) => {
      if (e.key === 'Escape') this._closeSampleRowsModal(block);
    };
    document.addEventListener('keydown', state.escHandler);

    // Focus close button; restore on teardown.
    try { close.focus(); } catch (_e) { /* focus is best-effort */ }
  }

  /**
   * Tear down the modal and restore focus to the trigger (typically the
   * expand button). The inline grid is already correct (same state object),
   * so no re-render is needed — just unmount the overlay.
   */
  _closeSampleRowsModal(block) {
    const state = block._rowsState;
    if (!state || !state.modalEl) return;
    if (state.modalEl.parentNode) {
      state.modalEl.parentNode.removeChild(state.modalEl);
    }
    if (state.escHandler) {
      document.removeEventListener('keydown', state.escHandler);
      state.escHandler = null;
    }
    state.modalEl = null;
    state.modalBodyEl = null;
    state.modalMetaEl = null;
    this._openSampleModals.delete(block);
    const prev = state.prevActiveElement;
    state.prevActiveElement = null;
    if (prev && document.body.contains(prev)) {
      try { prev.focus(); } catch (_e) { /* focus restore is best-effort */ }
    }
  }

  /** Compose the modal header meta line from the current result. */
  _updateModalMeta(block) {
    const state = block._rowsState;
    if (!state || !state.modalMetaEl) return;
    const r = state.result;
    if (!r) {
      state.modalMetaEl.textContent = 'No Delta log';
      return;
    }
    const rowCount = Array.isArray(r.rows) ? r.rows.length : r.rowsReturned || 0;
    let txt = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`;
    if (r.fileCount && r.fileCount > 1) {
      txt += ` \u00b7 1 of ${r.fileCount} files`;
    }
    if (Array.isArray(r.warnings) && r.warnings.length) {
      txt += ` \u00b7 ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`;
    }
    state.modalMetaEl.textContent = txt;
  }

  /**
   * Format a single sample-row cell for the grid:
   *   - null         → muted "NULL"
   *   - objects/arrays → pretty JSON in a mono span
   *   - everything else → escaped string
   */
  _formatCellValue(v) {
    if (v === null || v === undefined) {
      return '<span class="ws-preview-rows-null">NULL</span>';
    }
    if (typeof v === 'object') {
      try {
        return `<span class="ws-preview-rows-nested">${this._esc(JSON.stringify(v))}</span>`;
      } catch {
        return `<span class="ws-preview-rows-nested">${this._esc(String(v))}</span>`;
      }
    }
    return this._esc(String(v));
  }

  /** Regular table → render synthesized DDL + Delta properties. */
  _renderPreviewTable(section, md, table) {
    // Prefer metadata columns, fall back to inspector's schema (auto-discovered
    // tables have empty allColumns in _metadata/table.json.gz).
    let cols = Array.isArray(md.allColumns) && md.allColumns.length > 0 ? md.allColumns : null;
    if (!cols && Array.isArray(table?.schema)) {
      cols = table.schema.map((c) => ({
        name: c.name,
        colType: c.type || c.dataType || 'string',
        nullable: c.nullable !== false,
      }));
    }
    const partKeys = Array.isArray(md.partitionColumnNames) ? md.partitionColumnNames : [];
    const fqn = `${table?.schemaName || 'dbo'}.${table?.name || ''}`;

    let html = '<div class="ws-insp-title">Preview</div>';

    // DDL
    html += '<div class="ws-preview-block">';
    html += '<div class="ws-preview-block-head">';
    html += '<span class="ws-preview-block-label">CREATE TABLE</span>';
    html += '<span class="ws-preview-lang-badge">DDL</span>';
    if (cols && cols.length) {
      html += '<button class="ws-preview-copy-btn" type="button" data-copy="sql" title="Copy DDL">Copy</button>';
    }
    html += '</div>';
    if (cols && cols.length > 0) {
      html += `<pre class="ws-sql-block" data-sql>${this._esc(this._buildDdl(fqn, cols, partKeys, md.provider))}</pre>`;
    } else {
      html += '<div class="ws-preview-empty-block">Columns not yet materialized — Delta log has no committed schema.</div>';
    }
    html += '</div>';

    // Storage
    if (md.storage?.locationUri) {
      html += '<div class="ws-preview-block">';
      html += '<div class="ws-preview-block-head"><span class="ws-preview-block-label">Storage</span></div>';
      html += `<pre class="ws-sql-block ws-storage-uri">${this._esc(md.storage.locationUri)}</pre>`;
      html += '</div>';
    }

    // Properties — filter to Delta-relevant + Fabric source keys
    const props = md.properties || {};
    const interesting = [
      'provider',
      'delta.lastCommitTimestamp',
      'delta.lastUpdateVersion',
      'delta.minReaderVersion',
      'delta.minWriterVersion',
      'delta.enableChangeDataFeed',
      'trident.autodiscovered.table',
      'fabric.source.creationCompletedAt',
    ];
    const rows = [];
    if (md.provider) rows.push(['Provider', md.provider]);
    if (partKeys.length) rows.push(['Partition keys', partKeys.join(', ')]);
    for (const key of interesting) {
      if (key === 'provider') continue;
      const v = props[key];
      if (v === undefined) continue;
      if (key === 'delta.lastCommitTimestamp') {
        rows.push(['Last commit', this._formatTs(Number(v))]);
        continue;
      }
      if (key === 'fabric.source.creationCompletedAt') {
        rows.push(['Created', this._formatTs(v)]);
        continue;
      }
      rows.push([this._propLabel(key), v]);
    }
    if (rows.length) {
      html += '<dl class="ws-insp-kv ws-preview-meta">';
      for (const [k, v] of rows) {
        html += `<dt>${this._esc(k)}</dt><dd>${this._esc(String(v))}</dd>`;
      }
      html += '</dl>';
    }

    html += this._renderPreviewSampleRowsBlock(table?.schemaName || 'dbo', table?.name || '');

    section.innerHTML = html;
    this._wirePreviewCopyButtons(section);
    this._wirePreviewSampleRows(section);
  }

  /** Last-resort: no _metadata/table.json.gz at all. Use inspector's schema. */
  _renderPreviewFallbackDdl(section, table, title) {
    const cols = Array.isArray(table?.schema) ? table.schema : [];
    const fqn = `${table?.schemaName || 'dbo'}.${table?.name || ''}`;
    let html = `<div class="ws-insp-title">${title}</div>`;
    html += '<div class="ws-preview-block">';
    html += '<div class="ws-preview-block-head">';
    html += '<span class="ws-preview-block-label">CREATE TABLE</span>';
    html += '<span class="ws-preview-lang-badge">DDL</span>';
    if (cols.length) html += '<button class="ws-preview-copy-btn" type="button" data-copy="sql" title="Copy DDL">Copy</button>';
    html += '</div>';
    if (cols.length) {
      const mapped = cols.map((c) => ({
        name: c.name,
        colType: c.type || c.dataType || 'string',
        nullable: c.nullable !== false,
      }));
      html += `<pre class="ws-sql-block" data-sql>${this._esc(this._buildDdl(fqn, mapped, [], 'delta'))}</pre>`;
    } else {
      html += '<div class="ws-preview-empty-block">No catalog metadata available for this table.</div>';
    }
    html += '</div>';
    html += '<div class="ws-preview-note-line">No FLT-managed metadata; DDL synthesized from inspector schema.</div>';
    html += this._renderPreviewSampleRowsBlock(table?.schemaName || 'dbo', table?.name || '');
    section.innerHTML = html;
    this._wirePreviewCopyButtons(section);
    this._wirePreviewSampleRows(section);
  }

  /** Build a CREATE TABLE DDL string from an allColumns-style list. */
  _buildDdl(fqn, cols, partKeys, provider) {
    const lines = [`CREATE TABLE ${fqn} (`];
    const colLines = cols.map((c, i) => {
      const t = this._parseColType(c.colType);
      const nn = c.nullable === false ? ' NOT NULL' : '';
      const sep = i === cols.length - 1 ? '' : ',';
      return `  ${c.name} ${t}${nn}${sep}`;
    });
    lines.push(...colLines);
    lines.push(')');
    lines.push(`USING ${provider || 'delta'}`);
    if (partKeys && partKeys.length) {
      lines.push(`PARTITIONED BY (${partKeys.join(', ')})`);
    }
    return lines.join('\n');
  }

  /** colType from FLT comes as a JSON-encoded type string like "\"integer\"" or
   *  "{\"type\":\"struct\",...}". Strip the outer quoting and pretty up common types. */
  _parseColType(raw) {
    if (raw == null) return 'string';
    if (typeof raw !== 'string') return String(raw);
    let s = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') s = parsed;
      else if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'array' && parsed.elementType) return `ARRAY<${parsed.elementType}>`;
        if (parsed.type === 'struct') return 'STRUCT';
        if (parsed.type) return String(parsed.type);
      }
    } catch {
      // raw wasn't JSON; use as-is
    }
    return s.toUpperCase();
  }

  /** Friendly label for known property keys. */
  _propLabel(key) {
    const map = {
      'delta.lastUpdateVersion': 'Delta version',
      'delta.minReaderVersion': 'Min reader version',
      'delta.minWriterVersion': 'Min writer version',
      'delta.enableChangeDataFeed': 'CDF',
      'trident.autodiscovered.table': 'Auto-discovered',
    };
    return map[key] || key;
  }

  /** Format unix-ms or ISO timestamp for display. */
  _formatTs(v) {
    if (v == null || v === '') return '\u2014';
    let d;
    if (typeof v === 'number') d = new Date(v);
    else d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }

  /** Wire Copy buttons inside a preview section. */
  _wirePreviewCopyButtons(section) {
    const buttons = section.querySelectorAll('.ws-preview-copy-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const pre = btn.closest('.ws-preview-block')?.querySelector('[data-sql]');
        if (!pre) return;
        const text = pre.textContent || '';
        navigator.clipboard.writeText(text).then(
          () => {
            const orig = btn.textContent;
            btn.textContent = 'Copied';
            btn.classList.add('is-copied');
            setTimeout(() => {
              btn.textContent = orig;
              btn.classList.remove('is-copied');
            }, 1200);
          },
          () => {
            btn.textContent = 'Copy failed';
          },
        );
      });
    });
  }

  /** Auto-fetch schema for a single table and update the inspector in-place. */
  async _autoLoadSchema(table) {
    const ws = this._selectedWorkspace;
    const lh = this._selectedItem;
    if (!ws || !lh) return;

    try {
      const result = await this._api.getTableDetails(
        ws.id, lh.id, ws.capacityId,
        [{ name: table.name, schema: table.schemaName || 'dbo' }],
      );
      // Response shape: `{ tables: [...] }` (new) or `{ result: { value: [...] } }` (legacy).
      const allDetails = result?.tables || result?.result?.value || result?.value || [];
      const details = allDetails.find(v =>
        (v.tableName || v.name) === table.name &&
        (v.schemaName || 'dbo') === (table.schemaName || 'dbo'),
      ) || null;

      if (details && details.result) {
        // Merge enrichment onto the stored table object
        if (this._currentTables) {
          const stored = this._currentTables.find(t => t.name === table.name);
          if (stored) {
            stored.schema = details.result.schema || stored.schema;
            stored.location = details.result.location || stored.location;
            stored.schemaName = details.schemaName || stored.schemaName;
            if (details.result.format) stored.format = details.result.format;
            stored._enrichedType = details.result.type || null;
          }
        }

        const schema = details.result.schema;
        if (schema && schema.length > 0) {
          this._replaceSchemaShimmer(this._renderSchemaSection(schema));
          this._updatePreviewWithSchema(table);
          return;
        }
      }
      // No schema in response — remove shimmer, show nothing
      this._replaceSchemaShimmer('');
    } catch {
      this._replaceSchemaShimmerWithError(table);
    }
  }

  /** Replace the shimmer placeholder with rendered schema HTML. */
  _replaceSchemaShimmer(html) {
    if (!this._inspectorEl) return;
    const shimmer = this._inspectorEl.querySelector('.ws-insp-schema-loading');
    if (!shimmer) return;
    if (!html) { shimmer.remove(); return; }
    const frag = document.createRange().createContextualFragment(html);
    shimmer.replaceWith(frag);
  }

  /** Replace shimmer with error + retry button. */
  _replaceSchemaShimmerWithError(table) {
    if (!this._inspectorEl) return;
    const shimmer = this._inspectorEl.querySelector('.ws-insp-schema-loading');
    if (!shimmer) return;
    const errHtml = this._renderSchemaError(table);
    const frag = document.createRange().createContextualFragment(errHtml);
    const retryBtn = frag.querySelector('.ws-retry-link');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        // Replace error with shimmer and retry
        const parent = retryBtn.closest('.ws-insp-section');
        if (parent) {
          const shimmerFrag = document.createRange().createContextualFragment(this._renderSchemaShimmer());
          parent.replaceWith(shimmerFrag);
        }
        this._autoLoadSchema(table);
      });
    }
    shimmer.replaceWith(frag);
  }

  /** Update the preview section in-place once schema becomes available.
   *
   * Bails if the user already triggered Preview load (data-loaded or
   * data-loading set) — otherwise a slow schema fetch would clobber
   * the already-rendered DDL/SELECT block. */
  _updatePreviewWithSchema(table) {
    if (!this._inspectorEl) return;
    const section = this._inspectorEl.querySelector('.ws-preview-section');
    if (!section) return;
    if (section.getAttribute('data-loaded') === 'true' ||
        section.getAttribute('data-loading') === 'true') {
      return;
    }
    const previewHtml = this._renderPreviewSection(table);
    const frag = document.createRange().createContextualFragment(previewHtml);
    const btn = frag.querySelector('.ws-preview-btn');
    if (btn) btn.addEventListener('click', () => this._handlePreviewLoad(table));
    section.replaceWith(frag);
  }

  _showWorkspaceInspector(ws) {
    if (!this._inspectorEl) return;

    let html = '<div class="ws-insp-section">';
    html += '<div class="ws-insp-title">Workspace Info</div>';
    html += '<dl class="ws-insp-kv">';
    const fields = [
      ['Name', ws.displayName],
      ['ID', ws.id],
      ['Capacity', ws.capacityId || 'N/A'],
      ['State', ws.state || 'Active'],
      ['Description', ws.description || '\u2014'],
    ];
    for (const [label, val] of fields) {
      html += `<dt>${this._esc(label)}</dt><dd>${this._esc(val || '')}</dd>`;
    }
    html += '</dl></div>';

    // Item counts by type with lakehouse highlighting
    const children = this._children[ws.id] || [];
    if (children.length > 0) {
      const counts = {};
      let lhCount = 0;
      for (const item of children) {
        const type = item.type || 'Unknown';
        counts[type] = (counts[type] || 0) + 1;
        if (this._isLakehouse(item)) lhCount++;
      }
      html += '<div class="ws-insp-section">';
      html += '<div class="ws-insp-title">Item Counts</div>';
      html += '<dl class="ws-insp-kv">';
      if (lhCount > 0) {
        html += `<dt>Lakehouses</dt><dd style="color:var(--status-succeeded);font-weight:600">${lhCount}</dd>`;
      }
      for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        if (!type.toLowerCase().includes('lakehouse')) {
          html += `<dt>${this._esc(type)}</dt><dd>${count}</dd>`;
        }
      }
      html += `<dt style="font-weight:600;padding-top:var(--space-1)">Total</dt><dd style="font-weight:600;padding-top:var(--space-1)">${children.length}</dd>`;
      html += '</dl></div>';
    } else if (this._expanded.has(ws.id)) {
      html += '<div class="ws-insp-section">';
      html += '<div class="ws-insp-title">Items</div>';
      html += '<p style="font-size:var(--text-xs);color:var(--text-muted)">No items in this workspace</p>';
      html += '</div>';
    }

    this._inspectorEl.innerHTML = html;
  }

  _clearInspector() {
    if (!this._inspectorEl) return;
    this._inspectorEl.innerHTML =
      '<div class="ws-empty-state ws-empty-inline">' +
      '<div class="ws-empty-title">Inspector</div>' +
      '<div class="ws-empty-desc">Select an item to see details</div>' +
      '</div>';
  }

  // ────────────────────────────────────────────
  // Deploy flow (SSE-backed via DeployFlow)
  // ────────────────────────────────────────────

  async _deployToLakehouse(lh, ws) {
    const progressEl = document.getElementById('ws-deploy-progress');
    const btnEl = document.getElementById('ws-deploy-btn');
    if (!progressEl) return;

    if (btnEl) btnEl.style.display = 'none';
    progressEl.style.display = 'block';

    if (!this._deployFlow) {
      this._deployFlow = new DeployFlow(progressEl);
      this._deployFlow.onUpdate = (state) => this._onDeployUpdate(state, lh, ws);
    }

    const capacityId = ws.capacityId || '';
    this._lastDeployTarget = { workspaceId: ws.id, artifactId: lh.id, capacityId: capacityId, lakehouseName: lh.displayName || '', workspaceName: ws.displayName || '' };
    this._deployFlow.startDeploy(ws.id, lh.id, capacityId, lh.displayName || '', false, ws.displayName || '');
  }

  _onDeployUpdate(state, lh, ws) {
    const pill = document.getElementById('ws-status-pill');
    if (state.status === 'deploying') {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('deploying');
      if (pill) {
        pill.className = 'ws-status-pill deploying';
        pill.innerHTML = '<span class="ws-pill-dot"></span> Deploying\u2026';
      }
      // Update deploy button to deploying state
      const btnEl = document.getElementById('ws-deploy-btn');
      if (btnEl) {
        btnEl.className = 'ws-btn-deploying';
        btnEl.innerHTML = '<span class="ws-spinner"></span> Deploying\u2026';
      }
    } else if (state.status === 'running') {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('connected');
      if (window.edogSidebar) window.edogSidebar.setPhase('connected');
      if (state.fltPort && window.edogWs) window.edogWs.setPort(state.fltPort);
      if (window.edogApp && window.edogApp.loadInitialData) window.edogApp.loadInitialData();
      this._toast('Connected to ' + (lh.displayName || lh.id), 'success');
      // Set status pill to running
      if (pill) {
        pill.className = 'ws-status-pill running';
        const portHtml = state.fltPort ? ' <span class="ws-port-badge">:' + state.fltPort + '</span>' : '';
        pill.innerHTML = '<span class="ws-pill-dot"></span> Running' + portHtml;
      }
      // Show undeploy button if this lakehouse's content panel is still displayed
      if (document.getElementById('ws-deploy-btn')) {
        this._showUndeployButton(lh);
      }
      // Show deploy summary (collapsed success state)
      this._showDeploySummary(state);
      // Fire completion burst
      this._fireCompletionBurst();
    } else if (state.status === 'stopped' && state.error) {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('failed');
      if (pill) {
        pill.className = 'ws-status-pill failed';
        pill.innerHTML = '<span class="ws-pill-dot"></span> Deploy Failed';
      }
      const btnEl = document.getElementById('ws-deploy-btn');
      if (btnEl) {
        btnEl.className = 'ws-btn-primary';
        btnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg> Retry Deploy';
        btnEl.style.display = '';
      }
    } else if (state.status === 'stopped' || state.status === 'idle') {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('stopped');
      if (window.edogSidebar) window.edogSidebar.setPhase('disconnected');
      // Clear logs and telemetry — stale data from dead service
      if (window.edogApp) {
        window.edogApp.state.logBuffer.clear();
        window.edogApp.state.telemetryBuffer = [];
        window.edogApp.state.stats = { totalLogs: 0, totalEvents: 0, verbose: 0, message: 0, warning: 0, error: 0, succeeded: 0, failed: 0 };
        window.edogApp.renderer.containerReady = false;
        window.edogApp.renderer.scheduleRender();
      }
      if (window.edogWs) window.edogWs.disconnect();
      if (pill) {
        pill.className = 'ws-status-pill stopped';
        pill.innerHTML = '<span class="ws-pill-dot"></span> Stopped';
      }
      const btnEl = document.getElementById('ws-deploy-btn');
      if (btnEl) {
        btnEl.className = 'ws-btn-primary';
        btnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg> Deploy';
        btnEl.style.display = '';
      }
      // Remove undeploy button
      const undeployBtn = document.getElementById('ws-undeploy-btn');
      if (undeployBtn) undeployBtn.remove();
    } else if (state.status === 'crashed') {
      if (window.edogTopBar) window.edogTopBar.setDeployStatus('crashed');
    }
  }

  /**
   * Show the collapsed deploy summary line after successful deploy.
   */
  _showDeploySummary(state) {
    const progressEl = document.getElementById('ws-deploy-progress');
    if (!progressEl) return;
    const elapsed = this._deployFlow?._startTime
      ? Math.floor((Date.now() - this._deployFlow._startTime) / 1000)
      : 0;
    const portStr = state.fltPort ? ' \u00B7 :' + state.fltPort : '';

    progressEl.innerHTML =
      '<div class="ws-deploy-summary" id="ws-deploy-summary">' +
        '<span class="ws-check-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg></span>' +
        '<span class="ws-summary-text"><strong>Deployed</strong> ' + elapsed + 's' + portStr + '</span>' +
        '<span class="ws-expand-hint"><span class="ws-summary-chevron" style="font-size:10px;">\u25B6</span> Logs</span>' +
      '</div>';
    progressEl.style.display = 'block';
  }

  /**
   * Fire completion burst particles (V2 celebration animation).
   */
  _fireCompletionBurst() {
    let container = document.querySelector('.ws-completion-burst');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ws-completion-burst';
      document.body.appendChild(container);
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const colors = ['#6d5cff','#8577ff','#34d399','#a78bfa','#22c55e','#f0b429','#5b9bff'];
    for (let i = 0; i < 30; i++) {
      const p = document.createElement('div');
      p.className = 'ws-burst-particle';
      const angle = (Math.PI * 2 * i) / 30 + (Math.random() - 0.5) * 0.5;
      const dist = 80 + Math.random() * 150;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 60;
      const sz = 3 + Math.random() * 4;
      p.style.cssText = 'left:' + cx + 'px;top:' + cy + 'px;background:' + colors[i % colors.length] +
        ';width:' + sz + 'px;height:' + sz + 'px;--dx:' + dx + 'px;--dy:' + dy +
        'px;animation-duration:' + (0.6 + Math.random() * 0.8) + 's;';
      container.appendChild(p);
      setTimeout(() => p.remove(), 1500);
    }
  }

  /**
   * Sync deploy/undeploy buttons to match server-side deploy state.
   * Called every time a lakehouse content panel is rendered.
   */
  async _syncDeployButtons(lh, ws) {
    try {
      const resp = await fetch('/api/studio/status');
      if (!resp.ok) return;
      const state = await resp.json();

      const btnEl = document.getElementById('ws-deploy-btn');
      if (!btnEl) return;

      const isDeployed = state.phase === 'running' || state.phase === 'crashed';
      const deployedToThis = isDeployed && state.deployTarget &&
        state.deployTarget.artifactId === lh.id;
      const deployedToOther = isDeployed && state.deployTarget &&
        state.deployTarget.artifactId !== lh.id;

      if (deployedToThis) {
        // Set status pill to running
        const pill = document.getElementById('ws-status-pill');
        if (pill) {
          const portHtml = state.fltPort ? ' <span class="ws-port-badge">:' + state.fltPort + '</span>' : '';
          pill.className = 'ws-status-pill running';
          pill.innerHTML = '<span class="ws-pill-dot"></span> Running' + portHtml;
        }
        // Show re-deploy + stop buttons
        this._showUndeployButton(lh);
        // Show deploy summary
        this._showDeploySummary(state);
        // Also attach DeployFlow for undeploy capability
        const progressEl = document.getElementById('ws-deploy-progress');
        if (!this._deployFlow && progressEl) {
          this._deployFlow = new DeployFlow(progressEl);
          this._deployFlow.onUpdate = (s) => this._onDeployUpdate(s, lh, ws);
        }
      } else if (deployedToOther) {
        // Different lakehouse is deployed — indicate switch
        const otherName = state.deployTarget.lakehouseName || state.deployTarget.artifactId || '';
        btnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg> Deploy (switch from ' + this._esc(otherName) + ')';
        btnEl.title = 'Currently deployed to ' + otherName + '. Click to switch.';
      }
      // else: nothing deployed — default button is fine
    } catch {
      // Studio status not available — keep default button
    }
  }

  _showUndeployButton(lh) {
    // Replace deploy button with re-deploy styling
    const btnEl = document.getElementById('ws-deploy-btn');
    if (btnEl) {
      btnEl.className = 'ws-btn-primary';
      btnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Re-deploy';
    }
    // Add stop button if not exists
    if (!document.getElementById('ws-undeploy-btn')) {
      const actionsLeft = this._contentEl.querySelector('.ws-v2-actions-left');
      if (actionsLeft) {
        const stopBtn = document.createElement('button');
        stopBtn.id = 'ws-undeploy-btn';
        stopBtn.className = 'ws-btn-danger';
        stopBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop Service';
        stopBtn.addEventListener('click', async () => {
          stopBtn.disabled = true;
          stopBtn.textContent = 'Stopping\u2026';
          try {
            await fetch('/api/command/undeploy', { method: 'POST' });
          } catch { /* best effort */ }
          // Disconnect WebSocket (prevent reconnect spam to dead service)
          if (window.edogWs) window.edogWs.disconnect();
          // Clear logs and telemetry — stale data from dead service
          if (window.edogApp) {
            window.edogApp.state.logBuffer.clear();
            window.edogApp.state.telemetryBuffer = [];
            window.edogApp.state.stats = { totalLogs: 0, totalEvents: 0, verbose: 0, message: 0, warning: 0, error: 0, succeeded: 0, failed: 0 };
            window.edogApp.renderer.containerReady = false;
            window.edogApp.renderer.scheduleRender();
          }
          // Reset UI to Phase 1
          if (window.edogTopBar) window.edogTopBar.setDeployStatus('stopped');
          if (window.edogSidebar) window.edogSidebar.setPhase('disconnected');
          // Update status pill
          const pill = document.getElementById('ws-status-pill');
          if (pill) {
            pill.className = 'ws-status-pill stopped';
            pill.innerHTML = '<span class="ws-pill-dot"></span> Stopped';
          }
          // Clean up deploy flow if exists
          if (this._deployFlow) {
            this._deployFlow.destroy();
            this._deployFlow = null;
          }
          // Reset buttons
          stopBtn.remove();
          if (btnEl) {
            btnEl.className = 'ws-btn-primary';
            btnEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg> Deploy';
            btnEl.style.display = '';
          }
          const progressEl = document.getElementById('ws-deploy-progress');
          if (progressEl) { progressEl.style.display = 'none'; progressEl.innerHTML = ''; }
          this._toast('Service stopped', 'info');
        });
        actionsLeft.appendChild(stopBtn);
      }
    }
  }

  // ────────────────────────────────────────────
  // Favorites
  // ────────────────────────────────────────────

  _loadFavorites() {
    try {
      this._favorites = JSON.parse(localStorage.getItem('edog-favorites') || '[]');
    } catch {
      this._favorites = [];
    }
  }

  _saveFavorites() {
    localStorage.setItem('edog-favorites', JSON.stringify(this._favorites));
  }

  _saveFavorite(item) {
    if (this._favorites.find(f => f.id === item.id)) return;
    this._favorites.push({
      name: item.displayName,
      id: item.id,
      workspaceId: item.workspaceId,
      workspaceName: item.workspaceName || '',
    });
    this._saveFavorites();
    this._renderFavorites();
  }

  _renderFavorites() {
    if (!this._favoritesEl) return;
    this._favoritesEl.innerHTML = '';
    if (this._favorites.length === 0) {
      this._favoritesEl.innerHTML = '<div class="ws-tree-item dimmed" style="font-size:var(--text-xs)">No favorites yet</div>';
      return;
    }
    for (const fav of this._favorites) {
      const el = document.createElement('div');
      el.className = 'ws-fav-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ws-fav-name';
      nameSpan.textContent = fav.name;
      el.appendChild(nameSpan);

      if (fav.workspaceName) {
        const detail = document.createElement('span');
        detail.className = 'ws-fav-detail';
        detail.textContent = fav.workspaceName;
        el.appendChild(detail);
      }

      this._favoritesEl.appendChild(el);
    }
  }

  // ──── Type-Specific Content Helpers ────

  /** Build a rich content header with name, type badge, full GUID, and description. */
  _buildRichHeader(item, ws) {
    const color = this._getItemColor(item.type);
    const badge = this._getTypeAbbrev(item.type);
    let html = '<div class="ws-content-header">';
    html += `<div class="ws-content-name">${this._esc(item.displayName)}</div>`;
    html += '<div class="ws-content-meta">';
    html += `<span class="ws-type-badge" style="color:${color}">${badge}</span>`;
    html += ` <span class="ws-guid" title="Click to copy" data-copy-id="${this._esc(item.id)}">${this._esc(item.id)}</span>`;
    html += '</div>';
    if (item.description) {
      html += `<div style="font-size:var(--text-sm);color:var(--text-dim);margin-top:var(--space-1)">${this._esc(item.description)}</div>`;
    }
    html += '</div>';
    return html;
  }

  /** Build a clickable linked item card. */
  _buildLinkedCard(name, label, typeBadge, itemId, dotColor) {
    return `<div class="ws-linked-card" data-navigate-item="${this._esc(itemId)}">
      <div class="ws-linked-card-header">
        <span class="ws-linked-card-dot" style="background:${dotColor}"></span>
        <span class="ws-linked-card-name">${this._esc(name)}</span>
      </div>
      <div class="ws-linked-card-label">${this._esc(label)}</div>
      <div class="ws-linked-card-id">${this._esc(typeBadge)} \u00b7 ${this._esc(String(itemId))}</div>
    </div>`;
  }

  /** Build an info row for item info cards. */
  _infoRow(key, value) {
    return `<div class="ws-item-info-row"><span class="ws-item-info-key">${this._esc(key)}</span><span class="ws-item-info-val">${this._esc(String(value))}</span></div>`;
  }

  /** Resolve item name from workspace children cache. */
  _resolveItemName(wsId, itemId) {
    const children = this._children[wsId] || [];
    const found = children.find(c => c.id === itemId);
    return found ? found.displayName : null;
  }

  /** Bind click handlers for linked item cards — navigate to that item in the tree. */
  _bindLinkedCardClicks(ws) {
    if (!this._contentEl) return;
    this._contentEl.querySelectorAll('[data-navigate-item]').forEach(card => {
      card.addEventListener('click', () => {
        const targetId = card.dataset.navigateItem;
        const children = this._children[ws.id] || [];
        const target = children.find(c => c.id === targetId);
        if (target) {
          this._selectItem(target, ws);
          // Highlight in tree
          if (this._treeEl) {
            this._treeEl.querySelectorAll('.ws-tree-item.selected').forEach(el => el.classList.remove('selected'));
            const treeItem = this._treeEl.querySelector(`[data-item-id="${targetId}"]`);
            if (treeItem) {
              treeItem.classList.add('selected');
              treeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        }
      });
    });
  }

  /** Populate inspector panel for any item type. */
  _showItemInspector(item, ws, extra) {
    if (!this._inspectorEl) return;
    let html = '<div class="ws-insp-section"><div class="ws-insp-title">Item Info</div>';
    html += '<dl class="ws-insp-kv">';
    html += `<dt>Name</dt><dd>${this._esc(item.displayName)}</dd>`;
    html += `<dt>Type</dt><dd>${this._esc(item.type || 'Unknown')}</dd>`;
    html += `<dt>ID</dt><dd style="font-family:var(--font-mono);font-size:10px;word-break:break-all">${this._esc(item.id)}</dd>`;
    html += `<dt>Workspace</dt><dd>${this._esc(ws.name || ws.displayName || ws.id)}</dd>`;
    if (item.description) {
      html += `<dt>Description</dt><dd>${this._esc(item.description)}</dd>`;
    }
    if (extra.defaultLH) {
      const lhName = this._resolveItemName(ws.id, extra.defaultLH.itemId) || extra.defaultLH.itemId;
      html += `<dt>Default LH</dt><dd>${this._esc(lhName)}</dd>`;
    }
    if (extra.attachedEnv) {
      const envName = this._resolveItemName(ws.id, extra.attachedEnv.itemId) || extra.attachedEnv.itemId;
      html += `<dt>Environment</dt><dd>${this._esc(envName)}</dd>`;
    }
    if (extra.publish) {
      html += `<dt>Publish State</dt><dd>${this._esc(extra.publish.state || 'Unknown')}</dd>`;
    }
    html += '</dl></div>';
    this._inspectorEl.innerHTML = html;
  }

  /** Open the full notebook IDE, replacing content+inspector panels. */
  async _openNotebookIDE(item, ws) {
    if (!this._contentEl || !item) return;

    if (typeof NotebookView === 'undefined') {
      this._toast('Notebook IDE not yet available', 'info');
      return;
    }

    // Hide inspector panel to give notebook full width
    const inspectorPanel = document.getElementById('ws-inspector-panel');
    if (inspectorPanel) inspectorPanel.style.display = 'none';

    // Create and load notebook view
    this._activeNotebookView = new NotebookView(
      this._contentEl, this._api, ws.id, item, { capacityId: ws.capacityId }
    );
    await this._activeNotebookView.load();
  }

  // ────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────

  /** Map item type to a color for the tree dot indicator. */
  _getItemColor(type) {
    const colors = {
      'Lakehouse': 'var(--status-succeeded)',
      'Notebook': '#2d7ff9',
      'Pipeline': '#e5940c',
      'MLExperiment': '#a855f7',
      'Report': 'var(--text-muted)',
      'Environment': '#0d9488',
      'SemanticModel': '#6d5cff',
    };
    return colors[type] || 'var(--text-muted)';
  }

  /** Get short type abbreviation for tree type badge. */
  _getTypeAbbrev(type) {
    const abbrevs = {
      'Lakehouse': 'LH',
      'Notebook': 'NB',
      'Pipeline': 'PL',
      'MLExperiment': 'ML',
      'Report': 'RPT',
      'Environment': 'ENV',
      'SemanticModel': 'SM',
      'SQLEndpoint': 'SQL',
    };
    return abbrevs[type] || type?.substring(0, 3)?.toUpperCase() || '';
  }

  _isLakehouse(item) {
    return (item.type || '').toLowerCase().includes('lakehouse');
  }

  /**
   * Derive environment label from workspace/capacity context.
   * @param {object} ws - Workspace object with capacityId.
   * @returns {string} Environment label like "PPE", "Prod", or truncated ID.
   */
  _getEnvironmentLabel(ws) {
    const cap = ws.capacityId || '';
    if (cap.includes('ppe') || cap.includes('PPE')) return 'PPE';
    if (cap.includes('prod') || cap.includes('PROD')) return 'Prod';
    if (cap.includes('test') || cap.includes('TEST')) return 'Test';
    // Detect from API host configuration
    const host = this._api?._baseUrl || window.location.hostname || '';
    if (host.includes('-int-') || host.includes('ppe') || host.includes('windows-int')) return 'PPE';
    if (host.includes('fabric.microsoft.com')) return 'Prod';
    return cap ? 'PPE' : 'Unknown';
  }

  /**
   * Derive health status from workspace/capacity state.
   * @param {object} ws - Workspace object.
   * @returns {{status: string, color: string}} Health status.
   */
  _getHealthStatus(ws) {
    const state = (ws.state || 'Active').toLowerCase();
    if (state === 'active') return { status: 'Healthy', color: 'var(--status-succeeded)' };
    if (state === 'throttled') return { status: 'Throttled', color: 'var(--level-warning)' };
    return { status: 'Unknown', color: 'var(--text-muted)' };
  }

  _formatDate(isoStr) {
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '\u2014';
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return '\u2014';
    }
  }

  _esc(text) {
    const d = document.createElement('div');
    d.textContent = text || '';
    return d.innerHTML;
  }
}
