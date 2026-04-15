/**
 * DiRegistryTab — DI container state viewer.
 *
 * Internals sub-tab showing all service registrations captured at startup.
 * Topic: 'di'. Buffer: 100. Mostly static — registrations happen once.
 *
 * Event schema (DiRegistrationEvent):
 *   { serviceType, implementationType, lifetime,
 *     isEdogIntercepted, originalImplementation, registrationPhase }
 *
 * Pattern: constructor(containerEl, signalr), activate(), deactivate(), _onEvent, _render
 * Reference: f04-mock-10-di-registry.html
 */

class DiRegistryTab {
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    // Data
    this._registrations = [];   // Array of normalised registration objects
    this._filtered = [];        // After search/filter/sort
    this._nextId = 1;

    // State
    this._selectedId = null;
    this._searchText = '';
    this._lifetimeFilter = 'all';
    this._edogOnly = false;
    this._sortCol = 'service';
    this._sortAsc = true;
    this._exportOpen = false;
    this._active = false;

    // Bound handler for SignalR
    this._onEvent = this._handleEvent.bind(this);

    // Build DOM
    this._build();
  }

  /* ─────────────────────────────────────────────
     LIFECYCLE
     ───────────────────────────────────────────── */

  activate() {
    this._active = true;
    if (this._signalr) {
      this._signalr.on('di', this._onEvent);
      this._signalr.subscribeTopic('di');
    }
    document.addEventListener('click', this._onDocClick);
    this._applyFilters();
  }

  deactivate() {
    this._active = false;
    document.removeEventListener('click', this._onDocClick);
    if (this._signalr) {
      this._signalr.off('di', this._onEvent);
      this._signalr.unsubscribeTopic('di');
    }
  }

  /* ─────────────────────────────────────────────
     EVENT HANDLING
     ───────────────────────────────────────────── */

  _handleEvent(event) {
    if (!event) return;

    // Normalise from SignalR schema to internal format
    const reg = {
      id: this._nextId++,
      service: event.serviceType || '',
      impl: event.implementationType || '',
      lifetime: event.lifetime || 'Singleton',
      edog: !!event.isEdogIntercepted,
      original: event.originalImplementation || '',
      phase: event.registrationPhase || '',
    };

    // Deduplicate by service type + implementation
    const dedupKey = reg.service + '::' + reg.impl;
    const existing = this._registrations.findIndex(r => (r.service + '::' + r.impl) === dedupKey);
    if (existing !== -1) {
      reg.id = this._registrations[existing].id;
      this._registrations[existing] = reg;
    } else {
      // Cap at 100
      if (this._registrations.length >= 100) {
        this._registrations.shift();
      }
      this._registrations.push(reg);
    }

    // If empty state is showing, flip to table
    if (this._registrations.length > 0) {
      this._emptyEl.classList.add('hidden');
      this._tablePaneEl.classList.add('visible');
    }

    if (this._active) {
      this._applyFilters();
    }
  }

  /* ─────────────────────────────────────────────
     DOM CONSTRUCTION
     ───────────────────────────────────────────── */

  _build() {
    const root = document.createElement('div');
    root.className = 'di-tab';

    // ── Toolbar ──
    const toolbar = this._buildToolbar();
    root.appendChild(toolbar);

    // ── Content area ──
    const content = document.createElement('div');
    content.className = 'di-content';

    // Empty state
    this._emptyEl = this._buildEmptyState();
    content.appendChild(this._emptyEl);

    // Table pane
    this._tablePaneEl = document.createElement('div');
    this._tablePaneEl.className = 'di-table-pane';

    const tableWrap = document.createElement('div');
    tableWrap.className = 'di-table-wrap';

    this._tableEl = this._buildTable();
    tableWrap.appendChild(this._tableEl);

    // No results
    this._noResultsEl = this._buildNoResults();
    tableWrap.appendChild(this._noResultsEl);

    this._tablePaneEl.appendChild(tableWrap);
    content.appendChild(this._tablePaneEl);

    // Detail panel
    this._detailEl = this._buildDetailPanel();
    content.appendChild(this._detailEl);

    root.appendChild(content);

    this._container.appendChild(root);

    // Keyboard
    this._container.addEventListener('keydown', (e) => this._handleKeyboard(e));
  }

  _buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'di-toolbar';

    // Search
    const search = document.createElement('div');
    search.className = 'di-search';
    search.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<circle cx="6.5" cy="6.5" r="5"/><line x1="10" y1="10" x2="14" y2="14"/>' +
      '</svg>';

    this._searchInput = document.createElement('input');
    this._searchInput.type = 'text';
    this._searchInput.placeholder = 'Search types...';
    this._searchInput.setAttribute('aria-label', 'Search DI registrations');
    search.appendChild(this._searchInput);

    this._searchClear = document.createElement('div');
    this._searchClear.className = 'di-search-clear';
    this._searchClear.textContent = '\u2715';
    this._searchClear.title = 'Clear search';
    search.appendChild(this._searchClear);

    this._searchInput.addEventListener('input', () => {
      this._searchText = this._searchInput.value.trim().toLowerCase();
      this._searchClear.classList.toggle('visible', this._searchText.length > 0);
      this._applyFilters();
    });

    this._searchClear.addEventListener('click', () => {
      this._searchInput.value = '';
      this._searchText = '';
      this._searchClear.classList.remove('visible');
      this._applyFilters();
    });

    toolbar.appendChild(search);

    // Separator
    toolbar.appendChild(this._sep());

    // Lifetime pills
    const pills = document.createElement('div');
    pills.className = 'di-lt-pills';

    const lifetimes = [
      { key: 'all', label: 'All' },
      { key: 'Singleton', label: 'Singleton' },
      { key: 'Transient', label: 'Transient' },
      { key: 'Scoped', label: 'Scoped' },
    ];

    lifetimes.forEach(lt => {
      const pill = document.createElement('div');
      pill.className = 'di-lt-pill' + (lt.key === 'all' ? ' active' : '');
      pill.textContent = lt.label;
      pill.dataset.lt = lt.key;
      pill.setAttribute('role', 'button');
      pill.setAttribute('tabindex', '0');
      pill.addEventListener('click', () => this._setLifetimeFilter(lt.key));
      pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._setLifetimeFilter(lt.key);
        }
      });
      pills.appendChild(pill);
    });

    this._pillsEl = pills;
    toolbar.appendChild(pills);

    // Separator
    toolbar.appendChild(this._sep());

    // EDOG toggle
    this._edogToggleEl = document.createElement('div');
    this._edogToggleEl.className = 'di-edog-toggle';
    this._edogToggleEl.setAttribute('role', 'switch');
    this._edogToggleEl.setAttribute('aria-checked', 'false');
    this._edogToggleEl.setAttribute('tabindex', '0');
    this._edogToggleEl.innerHTML =
      '<div class="di-toggle-track"><div class="di-toggle-knob"></div></div>' +
      'EDOG Only';

    this._edogToggleEl.addEventListener('click', () => this._toggleEdogOnly());
    this._edogToggleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._toggleEdogOnly();
      }
    });

    toolbar.appendChild(this._edogToggleEl);

    // Separator
    toolbar.appendChild(this._sep());

    // Counter
    this._counterEl = document.createElement('span');
    this._counterEl.className = 'di-reg-counter';
    this._counterEl.innerHTML = '<strong>0</strong> registrations';
    toolbar.appendChild(this._counterEl);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.marginLeft = 'auto';
    toolbar.appendChild(spacer);

    // Export button
    this._exportBtnEl = document.createElement('div');
    this._exportBtnEl.className = 'di-export-btn';
    this._exportBtnEl.setAttribute('tabindex', '0');
    this._exportBtnEl.innerHTML =
      'Export <span class="di-export-chevron">\u25BE</span>';

    this._exportDropdownEl = document.createElement('div');
    this._exportDropdownEl.className = 'di-export-dropdown';

    const formats = [
      { key: 'json', label: 'Export as JSON' },
      { key: 'csv', label: 'Export as CSV' },
    ];

    formats.forEach(f => {
      const item = document.createElement('div');
      item.className = 'di-export-dd-item';
      item.textContent = f.label;
      item.dataset.format = f.key;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this._exportAs(f.key);
        this._closeExportDropdown();
      });
      this._exportDropdownEl.appendChild(item);
    });

    this._exportBtnEl.appendChild(this._exportDropdownEl);

    this._exportBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._exportOpen) {
        this._closeExportDropdown();
      } else {
        this._openExportDropdown();
      }
    });

    // Close export on outside click — registered in activate(), removed in deactivate()
    this._onDocClick = () => {
      if (!this._active) return;
      if (this._exportOpen) this._closeExportDropdown();
    };

    toolbar.appendChild(this._exportBtnEl);

    return toolbar;
  }

  _buildEmptyState() {
    const el = document.createElement('div');
    el.className = 'di-empty';
    el.innerHTML =
      '<svg viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<rect x="8" y="12" width="40" height="32" rx="4"/>' +
        '<line x1="18" y1="22" x2="38" y2="22"/>' +
        '<line x1="18" y1="28" x2="38" y2="28"/>' +
        '<line x1="18" y1="34" x2="32" y2="34"/>' +
        '<circle cx="13" cy="22" r="2" fill="currentColor" opacity="0.3"/>' +
        '<circle cx="13" cy="28" r="2" fill="currentColor" opacity="0.3"/>' +
        '<circle cx="13" cy="34" r="2" fill="currentColor" opacity="0.3"/>' +
      '</svg>' +
      '<div class="di-empty-title">DI registry not yet captured</div>' +
      '<div class="di-empty-hint">Container state will appear after service ' +
        'initialization. Ensure FLT is running with the EDOG interceptor active.</div>';
    return el;
  }

  _buildTable() {
    const table = document.createElement('table');
    table.className = 'di-table';
    table.setAttribute('role', 'grid');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const columns = [
      { key: 'service', label: 'Service Type', cls: 'di-col-service' },
      { key: 'impl', label: 'Implementation', cls: 'di-col-impl' },
      { key: 'lifetime', label: 'Lifetime', cls: 'di-col-lifetime' },
      { key: 'edog', label: 'EDOG', cls: 'di-col-edog' },
      { key: 'phase', label: 'Phase', cls: 'di-col-phase' },
    ];

    columns.forEach(col => {
      const th = document.createElement('th');
      th.className = col.cls + (col.key === this._sortCol ? ' sorted' : '');
      th.dataset.col = col.key;
      th.setAttribute('role', 'columnheader');
      th.setAttribute('tabindex', '0');
      th.innerHTML = col.label + ' <span class="di-sort-arrow">\u25B2</span>';
      th.addEventListener('click', () => this._handleSort(col.key));
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._handleSort(col.key);
        }
      });
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    this._tbodyEl = document.createElement('tbody');
    table.appendChild(this._tbodyEl);

    return table;
  }

  _buildNoResults() {
    const el = document.createElement('div');
    el.className = 'di-no-results';
    el.innerHTML =
      '<div class="di-no-results-icon">\u2205</div>' +
      '<div class="di-no-results-title">No matching registrations</div>' +
      '<div class="di-no-results-hint">Try adjusting your search or filters</div>';
    return el;
  }

  _buildDetailPanel() {
    const panel = document.createElement('div');
    panel.className = 'di-detail';

    const header = document.createElement('div');
    header.className = 'di-detail-header';

    this._detailTitleEl = document.createElement('h3');
    this._detailTitleEl.textContent = 'Service Detail';
    header.appendChild(this._detailTitleEl);

    const actions = document.createElement('div');
    actions.className = 'di-detail-actions';

    const copyBtn = document.createElement('button');
    copyBtn.title = 'Copy details';
    copyBtn.textContent = '\u2398';
    copyBtn.addEventListener('click', () => this._copyDetail());
    actions.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => this._closeDetail());
    actions.appendChild(closeBtn);

    header.appendChild(actions);
    panel.appendChild(header);

    this._detailBodyEl = document.createElement('div');
    this._detailBodyEl.className = 'di-detail-body';
    panel.appendChild(this._detailBodyEl);

    return panel;
  }

  /* ─────────────────────────────────────────────
     FILTERING & SORTING
     ───────────────────────────────────────────── */

  _applyFilters() {
    let data = this._registrations.slice();

    // Search
    if (this._searchText) {
      data = data.filter(r =>
        r.service.toLowerCase().includes(this._searchText) ||
        r.impl.toLowerCase().includes(this._searchText) ||
        r.phase.toLowerCase().includes(this._searchText)
      );
    }

    // Lifetime
    if (this._lifetimeFilter !== 'all') {
      data = data.filter(r => r.lifetime === this._lifetimeFilter);
    }

    // EDOG only
    if (this._edogOnly) {
      data = data.filter(r => r.edog);
    }

    // Sort
    data.sort((a, b) => {
      let va, vb;
      switch (this._sortCol) {
        case 'service': va = a.service; vb = b.service; break;
        case 'impl': va = a.impl; vb = b.impl; break;
        case 'lifetime': va = a.lifetime; vb = b.lifetime; break;
        case 'edog': va = a.edog ? 1 : 0; vb = b.edog ? 1 : 0; break;
        case 'phase': va = a.phase; vb = b.phase; break;
        default: va = a.service; vb = b.service;
      }
      if (typeof va === 'string') {
        const cmp = va.localeCompare(vb);
        return this._sortAsc ? cmp : -cmp;
      }
      return this._sortAsc ? va - vb : vb - va;
    });

    this._filtered = data;
    this._render();
    this._updateCounter();
  }

  _setLifetimeFilter(key) {
    this._lifetimeFilter = key;
    this._pillsEl.querySelectorAll('.di-lt-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.lt === key);
    });
    this._applyFilters();
  }

  _toggleEdogOnly() {
    this._edogOnly = !this._edogOnly;
    this._edogToggleEl.classList.toggle('active', this._edogOnly);
    this._edogToggleEl.setAttribute('aria-checked', String(this._edogOnly));
    this._applyFilters();
  }

  _handleSort(col) {
    if (this._sortCol === col) {
      this._sortAsc = !this._sortAsc;
    } else {
      this._sortCol = col;
      this._sortAsc = true;
    }

    // Update header UI
    this._tableEl.querySelectorAll('th[data-col]').forEach(th => {
      const isActive = th.dataset.col === this._sortCol;
      th.classList.toggle('sorted', isActive);
      const arrow = th.querySelector('.di-sort-arrow');
      if (arrow) {
        arrow.textContent = isActive ? (this._sortAsc ? '\u25B2' : '\u25BC') : '\u25B2';
      }
    });

    this._applyFilters();
  }

  /* ─────────────────────────────────────────────
     RENDERING
     ───────────────────────────────────────────── */

  _render() {
    const tbody = this._tbodyEl;
    tbody.innerHTML = '';

    if (this._filtered.length === 0) {
      this._noResultsEl.classList.add('visible');
      return;
    }
    this._noResultsEl.classList.remove('visible');

    const fragment = document.createDocumentFragment();

    this._filtered.forEach((reg, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.id = reg.id;
      tr.setAttribute('role', 'row');
      tr.setAttribute('tabindex', '-1');
      if (reg.edog) tr.classList.add('di-edog-row');
      if (reg.id === this._selectedId) tr.classList.add('di-selected');
      tr.classList.add('di-row-enter');

      // Service Type
      const tdService = document.createElement('td');
      tdService.textContent = reg.service;
      tdService.title = reg.service;
      tr.appendChild(tdService);

      // Implementation
      const tdImpl = document.createElement('td');
      tdImpl.textContent = reg.impl;
      tdImpl.title = reg.impl;
      tr.appendChild(tdImpl);

      // Lifetime badge
      const tdLifetime = document.createElement('td');
      const ltClass = reg.lifetime.toLowerCase();
      const ltIcons = { Singleton: '\u221E', Transient: '\u21BB', Scoped: '\u25CE' };
      const badge = document.createElement('span');
      badge.className = 'di-lt-badge ' + ltClass;
      badge.innerHTML = '<span class="di-lt-icon">' +
        (ltIcons[reg.lifetime] || '') + '</span> ' + reg.lifetime;
      tdLifetime.appendChild(badge);
      tr.appendChild(tdLifetime);

      // EDOG badge
      const tdEdog = document.createElement('td');
      tdEdog.style.textAlign = 'center';
      if (reg.edog) {
        const edogBadge = document.createElement('span');
        edogBadge.className = 'di-edog-badge';
        edogBadge.textContent = '\u26A1';
        edogBadge.title = 'EDOG intercepted';
        tdEdog.appendChild(edogBadge);
      }
      tr.appendChild(tdEdog);

      // Phase
      const tdPhase = document.createElement('td');
      const phaseSpan = document.createElement('span');
      phaseSpan.className = 'di-phase-text';
      phaseSpan.textContent = reg.phase;
      phaseSpan.title = reg.phase;
      tdPhase.appendChild(phaseSpan);
      tr.appendChild(tdPhase);

      tr.addEventListener('click', () => this._selectRow(reg.id));

      // Stagger the entrance animation
      tr.style.animationDelay = Math.min(idx * 15, 300) + 'ms';

      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
  }

  _updateCounter() {
    const total = this._registrations.length;
    const shown = this._filtered.length;
    const isFiltered = this._searchText || this._lifetimeFilter !== 'all' || this._edogOnly;

    if (isFiltered) {
      this._counterEl.innerHTML = '<strong>' + shown + '</strong> of ' + total + ' registrations';
    } else {
      this._counterEl.innerHTML = '<strong>' + total + '</strong> registrations';
    }
  }

  /* ─────────────────────────────────────────────
     ROW SELECTION & DETAIL
     ───────────────────────────────────────────── */

  _selectRow(id) {
    this._selectedId = id;

    // Update row highlights
    this._tbodyEl.querySelectorAll('tr').forEach(tr => {
      tr.classList.toggle('di-selected', parseInt(tr.dataset.id, 10) === id);
    });

    const reg = this._registrations.find(r => r.id === id);
    if (reg) this._showDetail(reg);
  }

  _showDetail(reg) {
    this._detailEl.classList.add('open');
    this._detailTitleEl.textContent = reg.service;

    let html = '';

    // Service Type
    html += '<div class="di-detail-section">' +
      '<div class="di-detail-label">Service Type</div>' +
      '<div class="di-detail-value mono">' + this._esc(reg.service) + '</div>' +
    '</div>';

    // Implementation
    html += '<div class="di-detail-section">' +
      '<div class="di-detail-label">Implementation</div>' +
      '<div class="di-detail-value mono">' + this._esc(reg.impl) + '</div>' +
    '</div>';

    // Lifetime
    const ltClass = reg.lifetime.toLowerCase();
    html += '<div class="di-detail-section">' +
      '<div class="di-detail-label">Lifetime</div>' +
      '<div class="di-detail-value"><span class="di-lt-badge ' + ltClass +
        '" style="font-size:12px;padding:3px 10px">' + this._esc(reg.lifetime) + '</span></div>' +
    '</div>';

    // EDOG Interception
    if (reg.edog && reg.original) {
      html += '<div class="di-detail-section">' +
        '<div class="di-detail-label">EDOG Interception</div>' +
        '<div class="di-intercept-chain">' +
          '<div class="di-intercept-box original">' +
            '<div class="di-intercept-label">Original</div>' +
            this._esc(reg.original) +
          '</div>' +
          '<div class="di-intercept-arrow">' +
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
              '<path d="M8 3v10M4 9l4 4 4-4"/>' +
            '</svg>' +
          '</div>' +
          '<div class="di-intercept-box wrapper">' +
            '<div class="di-intercept-label">Wrapped by EDOG</div>' +
            this._esc(reg.impl) +
          '</div>' +
        '</div>' +
      '</div>';
    }

    // Registration Phase
    if (reg.phase) {
      html += '<div class="di-detail-section">' +
        '<div class="di-detail-label">Registration Phase</div>' +
        '<div class="di-reg-source">' +
          '<span class="method">' + this._esc(reg.phase) + '</span>' +
          '<span class="punct">()</span>' +
        '</div>' +
      '</div>';
    }

    this._detailBodyEl.innerHTML = html;
  }

  _closeDetail() {
    this._detailEl.classList.remove('open');
    this._selectedId = null;
    this._tbodyEl.querySelectorAll('tr.di-selected').forEach(tr => {
      tr.classList.remove('di-selected');
    });
  }

  _copyDetail() {
    const reg = this._registrations.find(r => r.id === this._selectedId);
    if (!reg) return;
    const text = reg.service + ' \u2192 ' + reg.impl + ' (' + reg.lifetime + ')' +
      (reg.edog ? ' [EDOG]' : '') +
      '\nPhase: ' + reg.phase;
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  }

  /* ─────────────────────────────────────────────
     EXPORT
     ───────────────────────────────────────────── */

  _openExportDropdown() {
    this._exportOpen = true;
    this._exportDropdownEl.classList.add('open');
    this._exportBtnEl.classList.add('open');
  }

  _closeExportDropdown() {
    this._exportOpen = false;
    this._exportDropdownEl.classList.remove('open');
    this._exportBtnEl.classList.remove('open');
  }

  _exportAs(format) {
    const data = this._filtered;
    if (data.length === 0) return;

    let content, mimeType, filename;

    if (format === 'json') {
      const exported = data.map(r => ({
        serviceType: r.service,
        implementationType: r.impl,
        lifetime: r.lifetime,
        isEdogIntercepted: r.edog,
        originalImplementation: r.original || null,
        registrationPhase: r.phase,
      }));
      content = JSON.stringify(exported, null, 2);
      mimeType = 'application/json';
      filename = 'di-registry.json';
    } else {
      // CSV
      const header = 'Service Type,Implementation,Lifetime,EDOG Intercepted,Original,Phase';
      const rows = data.map(r =>
        [r.service, r.impl, r.lifetime, r.edog, r.original, r.phase]
          .map(v => '"' + String(v).replace(/"/g, '""') + '"')
          .join(',')
      );
      content = header + '\n' + rows.join('\n');
      mimeType = 'text/csv';
      filename = 'di-registry.csv';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ─────────────────────────────────────────────
     KEYBOARD NAVIGATION
     ───────────────────────────────────────────── */

  _handleKeyboard(e) {
    const isSearch = document.activeElement === this._searchInput;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (this._detailEl.classList.contains('open')) {
        this._closeDetail();
      } else if (isSearch) {
        this._searchInput.blur();
      }
      return;
    }

    // "/" to focus search
    if (e.key === '/' && !isSearch) {
      e.preventDefault();
      this._searchInput.focus();
      return;
    }

    // Ctrl+E to toggle EDOG only
    if (e.ctrlKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      this._toggleEdogOnly();
      return;
    }

    if (isSearch) return;

    // Arrow up/down to navigate rows
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateRows(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    // Enter to open detail
    if (e.key === 'Enter' && this._selectedId) {
      e.preventDefault();
      const reg = this._registrations.find(r => r.id === this._selectedId);
      if (reg) this._showDetail(reg);
      return;
    }
  }

  _navigateRows(dir) {
    if (this._filtered.length === 0) return;
    const currentIdx = this._filtered.findIndex(r => r.id === this._selectedId);
    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = dir === 1 ? 0 : this._filtered.length - 1;
    } else {
      nextIdx = currentIdx + dir;
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= this._filtered.length) nextIdx = this._filtered.length - 1;
    }
    this._selectRow(this._filtered[nextIdx].id);

    // Scroll into view
    const row = this._tbodyEl.querySelector('tr[data-id="' + this._filtered[nextIdx].id + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  /* ─────────────────────────────────────────────
     UTILITIES
     ───────────────────────────────────────────── */

  _sep() {
    const s = document.createElement('div');
    s.className = 'di-toolbar-sep';
    return s;
  }

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}
