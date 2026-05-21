/**
 * InfraWizardDialog — Modal wizard for creating Fabric infrastructure.
 *
 * 5-step wizard: Setup -> Theme -> Build -> Review -> Deploy
 * Phase 1 implements pages 1 (Setup) and 2 (Theme). Phase 2A implements page 3 (Build/DAG Canvas).
 *
 * CSS prefix: .iw-
 * Singleton: Only one wizard can be open at a time.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   STEP DEFINITIONS
   ═══════════════════════════════════════════════════════════════════ */
var IW_STEPS = [
  { index: 0, id: 'setup',  label: 'Setup',  showBack: false, nextLabel: 'Next \u2192', nextClass: 'iw-btn-primary', showFooter: true },
  { index: 1, id: 'theme',  label: 'Theme',  showBack: true,  nextLabel: 'Next \u2192', nextClass: 'iw-btn-primary', showFooter: true },
  { index: 2, id: 'build',  label: 'Build',  showBack: true,  nextLabel: 'Next \u2192', nextClass: 'iw-btn-primary', showFooter: true },
  { index: 3, id: 'review', label: 'Review', showBack: true,  nextLabel: 'Lock In & Create \u25B6', nextClass: 'iw-btn-create', showFooter: true },
  { index: 4, id: 'deploy', label: 'Deploy', showBack: false, nextLabel: '',            nextClass: '',                showFooter: false },
];

/* ═══════════════════════════════════════════════════════════════════
   WIZARD STATE FACTORY

   Central WizardState — owned by InfraWizardDialog (C01).
   Passed to all child page components by reference.
   Serialized by TemplateManager (C12) for save/load.
   Frozen (Object.freeze) before passing to ExecutionPipeline (C10).

   Data shapes (canonical contracts — all components build against these):

   DagNodeData: {
     id: string,                  // "node-1", "node-2", ...
     name: string,                // user-editable, e.g. "orders"
     type: string,                // 'sql-table' | 'sql-mlv' | 'pyspark-mlv'
     schema: string,              // 'dbo' | 'bronze' | 'silver' | 'gold'
     x: number,                   // canvas position (top-left corner)
     y: number,
     width: number,               // default 180
     height: number,              // default 72
     sequenceNumber: number,      // auto-name counter per type
     createdAt: number            // Date.now() for tiebreaking
   }

   ConnectionData: {
     id: string,                  // "conn-1", "conn-2", ...
     sourceNodeId: string,        // parent/upstream node
     targetNodeId: string         // child/downstream node
   }

   ViewportState: {
     panX: number,                // canvas-space translation
     panY: number,
     zoom: number                 // 0.25 to 4.0 (25% to 400%)
   }

   ═══════════════════════════════════════════════════════════════════ */

/* ─── Event Name Constants ─── */
var IW_EVENTS = {
  // Canvas events (C04)
  NODE_ADDED:          'canvas:node-added',
  NODE_REMOVED:        'canvas:node-removed',
  NODE_MOVED:          'canvas:node-moved',
  NODE_SELECTED:       'canvas:node-selected',
  SELECTION_CLEARED:   'canvas:selection-cleared',
  ZOOM_CHANGED:        'canvas:zoom-changed',
  STATE_CHANGED:       'canvas:state-changed',
  LAYOUT_COMPLETE:     'canvas:layout-complete',

  // Connection events (C07)
  CONNECTION_CREATED:  'connection:created',
  CONNECTION_REMOVED:  'connection:removed',
  CONNECTION_STARTED:  'connection:started',
  CONNECTION_CANCELLED:'connection:cancelled',

  // DagNode events (C06)
  NODE_RENAMED:        'node:renamed',
  NODE_TYPE_CHANGED:   'node:type-changed',
  NODE_SCHEMA_CHANGED: 'node:schema-changed',

  // Code generation (C08)
  CODE_STALE:          'code:stale',
  CODE_REGENERATED:    'code:regenerated',

  // Wizard navigation (C01)
  PAGE_CHANGED:        'wizard:page-changed',
  STATE_DIRTY:         'wizard:state-dirty',

  // Template events (C12)
  TEMPLATE_LOADED:     'template:loaded',
  TEMPLATE_SAVED:      'template:saved',

  // Review events (C09)
  REVIEW_VALIDATED:    'review:validated',

  // Execution events (C10)
  EXECUTION_STARTED:   'execution:started',
  EXECUTION_STEP:      'execution:step',
  EXECUTION_COMPLETE:  'execution:complete',
  EXECUTION_FAILED:    'execution:failed',
  NAVIGATE_WORKSPACE:  'iw:navigate-workspace',

  // Undo/Redo events (C14)
  UNDO:                'undo:performed',
  REDO:                'redo:performed'
};

function createWizardState() {
  return {
    // Page 0: Infrastructure Setup (C02)
    workspaceName: '',
    workspaceNameManuallyEdited: false,
    capacityId: null,
    capacityDisplayName: '',
    capacitySku: '',
    capacityRegion: '',
    lakehouseName: '',
    lakehouseNameManuallyEdited: false,
    notebookName: '',
    notebookNameManuallyEdited: false,

    // Page 1: Theme & Schema (C03)
    theme: null,
    schemas: { dbo: true, bronze: false, silver: false, gold: false },

    // Page 2: DAG Canvas (C04-C08, C13-C14)
    nodes: [],
    connections: [],
    nextNodeId: 1,
    nextConnectionId: 1,
    viewport: { panX: 0, panY: 0, zoom: 1.0 },

    // Page 4: Execution (C10) — null until "Lock In & Create"
    execution: null,

    // Meta
    currentPage: 0,
    highestVisitedPage: 0,
    createdAt: null,
    templateName: null,
    templateId: null,
    dirty: false
  };
}

/* ═══════════════════════════════════════════════════════════════════
   INFRA WIZARD DIALOG
   ═══════════════════════════════════════════════════════════════════ */
class InfraWizardDialog {

  /**
   * @param {FabricApiClient} apiClient
   * @param {object} [options]
   * @param {object} [options.initialState] — pre-fill (template/resume)
   * @param {number} [options.startPage] — page index (default: 0)
   * @param {Array}  [options.existingWorkspaces] — for name collision checking
   */
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._state = opts.initialState ? Object.assign(createWizardState(), opts.initialState) : createWizardState();
    this._startPage = opts.startPage || 0;
    this._existingWorkspaces = opts.existingWorkspaces || [];
    this._currentPage = this._startPage;
    this._transitioning = false;
    this._dialogState = 'closed';  // closed | open | minimized

    // DOM references
    this._overlayEl = null;
    this._dialogEl = null;
    this._stepperEl = null;
    this._pageContainerEl = null;
    this._footerEl = null;
    this._nextBtn = null;
    this._backBtn = null;

    // Page component instances
    this._pages = [null, null, null, null, null];

    // Drag state
    this._dragState = null;

    // Bound event handlers (for cleanup)
    this._boundEsc = null;
    this._boundResize = null;

    // Per-instance EventBus (shared across all page components)
    this._eventBus = null;

    // Template manager (lazy — created on open)
    this._templateMgr = null;

    // Floating badge for minimized execution state
    this._floatingBadge = null;

    // Callbacks
    this.onComplete = null;
    this.onClose = null;
    this.onPageChange = null;
    this.onStateChange = null;
    this.onError = null;
  }

  /* ─── Singleton ─── */
  static _activeInstance = null;

  static isActive() {
    return InfraWizardDialog._activeInstance !== null;
  }

  static getActive() {
    return InfraWizardDialog._activeInstance;
  }

  /* ─── Public API ─── */

  open() {
    if (InfraWizardDialog._activeInstance) {
      InfraWizardDialog._activeInstance.restore();
      return;
    }
    if (!this._api || !this._api.hasBearerToken()) {
      if (window.edogToast) {
        window.edogToast('Authentication required \u2014 connect to Fabric first', 'error');
      }
      return;
    }
    InfraWizardDialog._activeInstance = this;
    this._state.createdAt = Date.now();
    this._eventBus = new WizardEventBus();
    this._templateMgr = new TemplateManager({ eventBus: this._eventBus });
    this._createDOM();
    this._bindEvents();
    this._initializePages();
    this._goToPage(this._startPage, false);
    this._dialogState = 'open';
  }

  close() {
    if (this._dialogState === 'closed') return;
    // If executing (Page 4 active, pipeline running), minimize to badge instead
    if (this._currentPage === 4 && this._pages[4] && this._pages[4]._state && this._pages[4]._state.status === 'executing') {
      this._minimizeToFloatingBadge();
      return;
    }
    // If dirty, show confirmation
    if (this._state.dirty) {
      this._showCloseConfirmation();
      return;
    }
    this._performClose();
  }

  minimize() {
    this._minimizeToFloatingBadge();
  }

  restore() {
    if (this._dialogState !== 'minimized') return;
    this._restoreFromBadge();
  }

  getState() {
    return Object.assign({}, this._state);
  }

  goToPage(index) {
    this._goToPage(index, true);
  }

  destroy() {
    this._removeDOM();
    this._unbindEvents();
    this._destroyPages();
    if (this._eventBus) {
      this._eventBus.destroy();
      this._eventBus = null;
    }
    if (this._floatingBadge) {
      this._floatingBadge.destroy();
      this._floatingBadge = null;
    }
    this._templateMgr = null;
    InfraWizardDialog._activeInstance = null;
    this._dialogState = 'closed';
  }

  isOpen() {
    return this._dialogState === 'open';
  }

  isMinimized() {
    return this._dialogState === 'minimized';
  }

  isExecuting() {
    return this._state.execution && this._state.execution.status === 'running';
  }

  /* ─── DOM Creation ─── */

  _createDOM() {
    // Overlay
    var overlay = document.createElement('div');
    overlay.className = 'iw-overlay';
    overlay.id = 'iw-overlay';
    document.body.appendChild(overlay);
    this._overlayEl = overlay;

    // Dialog
    var dialog = document.createElement('div');
    dialog.className = 'iw-dialog';
    dialog.id = 'iw-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'New Infrastructure Wizard');
    dialog.tabIndex = -1;

    // Header
    var header = document.createElement('div');
    header.className = 'iw-header';
    header.innerHTML =
      '<div class="iw-drag-hint"></div>' +
      '<div class="iw-title">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>' +
        '</svg>' +
        'New Infrastructure' +
      '</div>' +
      '<button class="iw-close-btn" title="Close">\u2715</button>';
    dialog.appendChild(header);
    this._headerEl = header;

    // Stepper
    var stepper = document.createElement('div');
    stepper.className = 'iw-stepper';
    stepper.id = 'iw-stepper';
    var stepperHtml = '';
    for (var s = 0; s < IW_STEPS.length; s++) {
      if (s > 0) {
        stepperHtml += '<div class="iw-step-connector" data-conn="' + (s - 1) + '"><div class="iw-conn-fill"></div></div>';
      }
      stepperHtml +=
        '<div class="iw-step-group">' +
          '<div class="iw-step-item" data-step="' + s + '">' +
            '<div class="iw-step-circle">' +
              '<span class="iw-step-num">' + (s + 1) + '</span>' +
              '<span class="iw-step-check">\u2713</span>' +
            '</div>' +
          '</div>' +
          '<div class="iw-step-label">' + IW_STEPS[s].label + '</div>' +
        '</div>';
    }
    stepper.innerHTML = stepperHtml;
    dialog.appendChild(stepper);
    this._stepperEl = stepper;

    // Page container
    var pageContainer = document.createElement('div');
    pageContainer.className = 'iw-page-container';
    pageContainer.id = 'iw-page-container';
    for (var p = 0; p < 5; p++) {
      var page = document.createElement('div');
      page.className = 'iw-page';
      page.id = 'iw-page-' + p;
      var content = document.createElement('div');
      content.className = 'iw-page-content';
      page.appendChild(content);
      pageContainer.appendChild(page);
    }
    dialog.appendChild(pageContainer);
    this._pageContainerEl = pageContainer;

    // Footer
    var footer = document.createElement('div');
    footer.className = 'iw-footer';
    footer.id = 'iw-footer';
    footer.innerHTML =
      '<button class="iw-btn iw-btn-ghost" id="iw-back-btn" style="visibility:hidden">\u2190 Back</button>' +
      '<div></div>' +
      '<button class="iw-btn iw-btn-primary" id="iw-next-btn">Next \u2192</button>';
    dialog.appendChild(footer);
    this._footerEl = footer;
    this._backBtn = footer.querySelector('#iw-back-btn');
    this._nextBtn = footer.querySelector('#iw-next-btn');

    overlay.appendChild(dialog);
    this._dialogEl = dialog;

    // Center dialog
    this._centerDialog();
  }

  _centerDialog() {
    if (!this._dialogEl) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = Math.min(vw * 0.96, vw - 32);
    var h = Math.min(vh * 0.94, vh - 32);
    this._dialogEl.style.width = w + 'px';
    this._dialogEl.style.height = h + 'px';
    this._dialogEl.style.left = ((vw - w) / 2) + 'px';
    this._dialogEl.style.top = ((vh - h) / 2) + 'px';
  }

  _removeDOM() {
    if (this._overlayEl && this._overlayEl.parentNode) {
      this._overlayEl.parentNode.removeChild(this._overlayEl);
    }
    this._overlayEl = null;
    this._dialogEl = null;
    this._stepperEl = null;
    this._pageContainerEl = null;
    this._footerEl = null;
    this._nextBtn = null;
    this._backBtn = null;
    this._headerEl = null;
  }

  /* ─── Event Binding ─── */

  _bindEvents() {
    var self = this;

    // Close button
    var closeBtn = this._dialogEl.querySelector('.iw-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() { self.close(); });
    }

    // Next button
    this._nextBtn.addEventListener('click', function() { self._handleNext(); });

    // Back button
    this._backBtn.addEventListener('click', function() { self._handleBack(); });

    // Escape key
    this._boundEsc = function(e) {
      if (e.key === 'Escape' && self._dialogState === 'open') {
        self.close();
      }
    };
    document.addEventListener('keydown', this._boundEsc);

    // Ctrl+Enter shortcut
    this._dialogEl.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.key === 'Enter') {
        self._handleNext();
      }
    });

    // Window resize
    this._boundResize = function() {
      if (self._dialogState === 'open') {
        self._constrainToViewport();
      }
    };
    window.addEventListener('resize', this._boundResize);

    // Stepper click
    this._stepperEl.addEventListener('click', function(e) {
      var stepItem = e.target.closest('.iw-step-item');
      if (!stepItem) return;
      var stepIdx = parseInt(stepItem.getAttribute('data-step'), 10);
      if (isNaN(stepIdx)) return;
      // Only allow clicking completed steps to go back
      if (stepItem.classList.contains('completed') && stepIdx < self._currentPage) {
        self._goToPage(stepIdx, true);
      }
    });

    // Header drag
    this._headerEl.addEventListener('pointerdown', function(e) {
      if (e.target.closest('.iw-close-btn')) return;
      self._startDrag(e);
    });

    // Header double-click re-center
    this._headerEl.addEventListener('dblclick', function(e) {
      if (e.target.closest('.iw-close-btn')) return;
      self._centerDialog();
    });

    // Focus trap
    this._dialogEl.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        self._trapFocus(e);
      }
    });

    // Navigate to workspace (post-creation)
    if (this._eventBus) {
      this._eventBus.on(IW_EVENTS.NAVIGATE_WORKSPACE, function(data) {
        self._performClose();
        document.dispatchEvent(new CustomEvent('edog:select-workspace', {
          detail: { id: data.workspaceId }
        }));
      });
    }
  }

  _unbindEvents() {
    if (this._boundEsc) {
      document.removeEventListener('keydown', this._boundEsc);
      this._boundEsc = null;
    }
    if (this._boundResize) {
      window.removeEventListener('resize', this._boundResize);
      this._boundResize = null;
    }
  }

  /* ─── Page Initialization ─── */

  _initializePages() {
    // Page 0: Setup
    var page0Content = this._pageContainerEl.querySelector('#iw-page-0 .iw-page-content');
    var self = this;
    this._pages[0] = new InfraSetupPage({
      apiClient: this._api,
      existingWorkspaces: this._existingWorkspaces,
      containerEl: page0Content,
      onValidationChange: function(isValid) { self._onPageValidationChange(isValid); }
    });

    // Page 1: Theme & Schema
    var page1Content = this._pageContainerEl.querySelector('#iw-page-1 .iw-page-content');
    this._pages[1] = new ThemeSchemaPage({
      containerEl: page1Content,
      onValidationChange: function(isValid) { self._onPageValidationChange(isValid); }
    });

    // Page 2: DAG Canvas (Build)
    var page2Content = this._pageContainerEl.querySelector('#iw-page-2 .iw-page-content');
    this._pages[2] = new DagCanvasPage({
      eventBus: this._eventBus,
      schemas: this._state.schemas,
      theme: this._state.theme,
      onStateChange: function() {
        self._state.dirty = true;
        if (self.onStateChange) self.onStateChange(self._state);
      }
    });
    page2Content.appendChild(this._pages[2].getElement());

    // Page 3: Review Summary
    var page3Content = this._pageContainerEl.querySelector('#iw-page-3 .iw-page-content');
    this._pages[3] = new ReviewSummaryPage({
      eventBus: this._eventBus,
      onNavigateToPage: function(pageIndex) { self._goToPage(pageIndex, true); },
      onConfirm: function() { self._showLockInConfirmation(); }
    });
    page3Content.appendChild(this._pages[3].getElement());

    // Page 4: Execution Pipeline
    var page4Content = this._pageContainerEl.querySelector('#iw-page-4 .iw-page-content');
    this._pages[4] = new ExecutionPipeline({
      eventBus: this._eventBus,
      onMinimize: function() { self._minimizeToFloatingBadge(); },
      onComplete: function(artifacts) {
        self._state.execution = { status: 'succeeded', artifacts: artifacts };
        if (self.onComplete) self.onComplete(self._state);
      },
      onFailed: function(error) {
        self._state.execution = { status: 'failed', error: error };
        if (self.onError) self.onError(error);
      }
    });
    page4Content.appendChild(this._pages[4].getElement());
  }

  _destroyPages() {
    for (var i = 0; i < this._pages.length; i++) {
      if (this._pages[i] && this._pages[i].destroy) {
        this._pages[i].destroy();
      }
      this._pages[i] = null;
    }
  }

  /* ─── Navigation ─── */

  _goToPage(targetIndex, animate) {
    if (this._transitioning) return;
    if (targetIndex < 0 || targetIndex >= 5) return;
    if (targetIndex === this._currentPage && animate) return;

    var fromIndex = this._currentPage;
    var direction = targetIndex > fromIndex ? 'forward' : 'backward';

    // Deactivate current page
    if (this._pages[fromIndex] && this._pages[fromIndex].deactivate) {
      this._pages[fromIndex].deactivate();
    }

    // Collect state from current page before leaving
    if (this._pages[fromIndex] && this._pages[fromIndex].collectState) {
      this._pages[fromIndex].collectState(this._state);
    }

    // Update page visibility with transition
    var pages = this._pageContainerEl.querySelectorAll('.iw-page');
    var self = this;

    if (animate) {
      this._transitioning = true;

      // Exit current page
      pages[fromIndex].classList.remove('active');
      // exit-left is only meaningful when moving forward; for backward the
      // inline transform style handles the slide-right animation. Passing an
      // empty string to classList.add throws a DOMException and halts the
      // entire navigation mid-flight, leaving both pages without `.active`
      // (hence blank wizard body).
      if (direction === 'forward') {
        pages[fromIndex].classList.add('exit-left');
      }
      pages[fromIndex].style.transform = direction === 'forward' ? 'translateX(-60px)' : 'translateX(60px)';
      pages[fromIndex].style.opacity = '0';

      // Enter target page
      pages[targetIndex].style.transform = direction === 'forward' ? 'translateX(60px)' : 'translateX(-60px)';
      pages[targetIndex].style.opacity = '0';
      pages[targetIndex].classList.add('active');

      // Force reflow
      void pages[targetIndex].offsetHeight;

      pages[targetIndex].style.transform = '';
      pages[targetIndex].style.opacity = '';

      setTimeout(function() {
        pages[fromIndex].classList.remove('exit-left');
        pages[fromIndex].style.transform = '';
        pages[fromIndex].style.opacity = '';
        self._transitioning = false;
      }, 360);
    } else {
      for (var i = 0; i < pages.length; i++) {
        pages[i].classList.remove('active', 'exit-left');
        pages[i].style.transform = '';
        pages[i].style.opacity = '';
      }
      pages[targetIndex].classList.add('active');
    }

    this._currentPage = targetIndex;
    this._state.currentPage = targetIndex;
    if (targetIndex > this._state.highestVisitedPage) {
      this._state.highestVisitedPage = targetIndex;
    }

    // Activate target page
    if (this._pages[targetIndex] && this._pages[targetIndex].activate) {
      this._pages[targetIndex].activate(this._state);
    }

    // Update stepper
    this._updateStepper();

    // Update footer
    this._updateFooter();

    // Fire callback
    if (this.onPageChange && animate) {
      this.onPageChange(fromIndex, targetIndex);
    }
  }

  _handleNext() {
    if (this._transitioning) return;
    var page = this._pages[this._currentPage];
    if (!page) return;

    // Validate current page
    // Pages return either a string (legacy) or {valid, errors, warnings} (Phase 2+)
    var result = page.validate ? page.validate() : null;
    if (result) {
      if (typeof result === 'string') {
        // Legacy string error — page handles inline display
        return;
      }
      if (typeof result === 'object' && result.valid === false) {
        // Structured validation — page handles inline display
        return;
      }
    }

    // Collect state
    if (page.collectState) {
      page.collectState(this._state);
    }

    // Special case: Page 3 → Page 4 (Lock In & Create) needs confirmation
    if (this._currentPage === 3) {
      this._showLockInConfirmation();
      return;
    }

    // Move forward
    if (this._currentPage < 4) {
      this._goToPage(this._currentPage + 1, true);
    }
  }

  _handleBack() {
    if (this._transitioning) return;
    if (this._currentPage > 0) {
      this._goToPage(this._currentPage - 1, true);
    }
  }

  /* ─── Stepper Update ─── */

  _updateStepper() {
    var stepItems = this._stepperEl.querySelectorAll('.iw-step-item');
    var connectors = this._stepperEl.querySelectorAll('.iw-step-connector');

    for (var i = 0; i < stepItems.length; i++) {
      stepItems[i].classList.remove('active', 'completed');
      if (i < this._currentPage) {
        stepItems[i].classList.add('completed');
      } else if (i === this._currentPage) {
        stepItems[i].classList.add('active');
      }
    }

    for (var c = 0; c < connectors.length; c++) {
      if (c < this._currentPage) {
        connectors[c].classList.add('filled');
      } else {
        connectors[c].classList.remove('filled');
      }
    }
  }

  /* ─── Footer Update ─── */

  _updateFooter() {
    var step = IW_STEPS[this._currentPage];
    if (!step.showFooter) {
      this._footerEl.style.display = 'none';
      return;
    }
    this._footerEl.style.display = '';

    // Back button
    this._backBtn.style.visibility = step.showBack ? 'visible' : 'hidden';

    // Next button
    this._nextBtn.textContent = step.nextLabel;
    this._nextBtn.className = 'iw-btn ' + step.nextClass;
  }

  /* ─── Validation Callback ─── */

  _onPageValidationChange(isValid) {
    if (this._nextBtn) {
      this._nextBtn.disabled = !isValid;
    }
  }

  /* ─── Dirty Tracking ─── */

  _markDirty() {
    if (!this._state.dirty) {
      this._state.dirty = true;
      if (this.onStateChange) this.onStateChange(this._state);
    }
  }

  /* ─── Close Confirmation ─── */

  _showCloseConfirmation() {
    if (this._dialogEl.querySelector('.iw-confirm-overlay')) return;

    var self = this;
    var confirmEl = document.createElement('div');
    confirmEl.className = 'iw-confirm-overlay';
    confirmEl.setAttribute('role', 'alertdialog');
    confirmEl.setAttribute('aria-modal', 'true');
    confirmEl.setAttribute('aria-labelledby', 'iw-confirm-close-title');
    confirmEl.setAttribute('aria-describedby', 'iw-confirm-close-text');
    confirmEl.innerHTML =
      '<div class="iw-confirm-box">' +
        '<div class="iw-confirm-title" id="iw-confirm-close-title">Discard wizard?</div>' +
        '<div class="iw-confirm-text" id="iw-confirm-close-text">All entered data will be lost. This action cannot be undone.</div>' +
        '<div class="iw-confirm-actions">' +
          '<button class="iw-btn iw-btn-ghost" id="iw-confirm-cancel">Cancel</button>' +
          '<button class="iw-btn iw-btn-danger" id="iw-confirm-discard">Discard</button>' +
        '</div>' +
      '</div>';
    this._dialogEl.appendChild(confirmEl);

    // Focus trap
    var triggerEl = document.activeElement;
    var trapHandler = function(e) {
      if (e.key !== 'Tab') return;
      var focusable = confirmEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { last.focus(); e.preventDefault(); }
      } else {
        if (document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    confirmEl.addEventListener('keydown', trapHandler);

    var cancelBtn = confirmEl.querySelector('#iw-confirm-cancel');
    cancelBtn.focus();

    cancelBtn.addEventListener('click', function() {
      confirmEl.removeEventListener('keydown', trapHandler);
      confirmEl.parentNode.removeChild(confirmEl);
      if (triggerEl && triggerEl.focus) triggerEl.focus();
    });
    const discardBtn = confirmEl.querySelector('#iw-confirm-discard');
    if (discardBtn) {
      discardBtn.addEventListener('click', function() {
        confirmEl.removeEventListener('keydown', trapHandler);
        self._performClose();
      });
    }
  }

  _showLockInConfirmation() {
    var self = this;
    // Show confirmation overlay before proceeding to execution
    var confirmEl = document.createElement('div');
    confirmEl.className = 'iw-confirm-overlay iw-confirm-overlay--lockin';
    confirmEl.setAttribute('role', 'alertdialog');
    confirmEl.setAttribute('aria-modal', 'true');
    confirmEl.setAttribute('aria-labelledby', 'iw-lockin-title');
    confirmEl.setAttribute('aria-describedby', 'iw-lockin-body');
    confirmEl.innerHTML =
      '<div class="iw-confirm-panel">' +
        '<div class="iw-confirm-icon">\u25C6</div>' +
        '<div class="iw-confirm-title" id="iw-lockin-title">Confirm Environment Creation</div>' +
        '<div class="iw-confirm-body" id="iw-lockin-body">You are about to create real cloud resources. This will:</div>' +
        '<ul class="iw-confirm-list">' +
          '<li>Create a Fabric workspace</li>' +
          '<li>Assign capacity (may incur costs)</li>' +
          '<li>Create a lakehouse with schema support</li>' +
          '<li>Create and execute a notebook</li>' +
        '</ul>' +
        '<div class="iw-confirm-footer-text">This action cannot be undone.</div>' +
        '<div class="iw-confirm-actions">' +
          '<button class="iw-btn iw-btn-ghost" id="iw-lockin-cancel">Cancel</button>' +
          '<button class="iw-btn iw-btn-create" id="iw-lockin-confirm">Confirm & Create</button>' +
        '</div>' +
      '</div>';
    this._dialogEl.appendChild(confirmEl);

    // Focus trap
    var triggerEl = document.activeElement;
    var trapHandler = function(e) {
      if (e.key !== 'Tab') return;
      var focusable = confirmEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { last.focus(); e.preventDefault(); }
      } else {
        if (document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    confirmEl.addEventListener('keydown', trapHandler);

    var cancelBtn = confirmEl.querySelector('#iw-lockin-cancel');
    cancelBtn.focus();

    cancelBtn.addEventListener('click', function() {
      confirmEl.removeEventListener('keydown', trapHandler);
      confirmEl.parentNode.removeChild(confirmEl);
      if (triggerEl && triggerEl.focus) triggerEl.focus();
    });
    const lockinBtn = confirmEl.querySelector('#iw-lockin-confirm');
    if (lockinBtn) {
      lockinBtn.addEventListener('click', function() {
        confirmEl.removeEventListener('keydown', trapHandler);
        confirmEl.parentNode.removeChild(confirmEl);
        self._goToPage(4, true);
      });
    }
  }

  _minimizeToFloatingBadge() {
    var self = this;
    // Hide the dialog but keep execution running
    if (this._dialogEl) this._dialogEl.style.display = 'none';
    if (this._overlayEl) this._overlayEl.style.display = 'none';
    this._dialogState = 'minimized';

    // Create floating badge
    this._floatingBadge = new FloatingBadge({
      onRestore: function() { self._restoreFromBadge(); }
    });

    // Show badge with current step info
    var pipeline = this._pages[4];
    if (pipeline && pipeline._state) {
      var activeIdx = pipeline._state.activeStepIndex || 0;
      var stepName = pipeline._state.steps[activeIdx] ? pipeline._state.steps[activeIdx].name : 'Executing';
      this._floatingBadge.show(activeIdx, stepName);
    } else {
      this._floatingBadge.show(0, 'Executing');
    }

    // Listen for step updates to keep badge in sync
    if (this._eventBus) {
      this._eventBus.on('execution:step', function(data) {
        if (self._floatingBadge && data) {
          if (data.status === 'running') {
            self._floatingBadge.updateStep(data.stepIndex, data.stepName || '');
          }
        }
      });
      this._eventBus.on('execution:complete', function() {
        if (self._floatingBadge) self._floatingBadge.showSuccess();
      });
      this._eventBus.on('execution:failed', function() {
        if (self._floatingBadge) self._floatingBadge.showFailure('Execution failed');
      });
    }
  }

  _restoreFromBadge() {
    // Destroy badge and restore dialog
    if (this._floatingBadge) {
      this._floatingBadge.hide();
      this._floatingBadge = null;
    }
    if (this._dialogEl) this._dialogEl.style.display = '';
    if (this._overlayEl) this._overlayEl.style.display = '';
    this._dialogState = 'open';
  }

  _performClose() {
    var self = this;
    // Play exit animation
    if (this._dialogEl) this._dialogEl.classList.add('closing');
    if (this._overlayEl) this._overlayEl.classList.add('closing');

    setTimeout(function() {
      self._removeDOM();
      self._unbindEvents();
      self._destroyPages();
      if (self._eventBus) {
        self._eventBus.destroy();
        self._eventBus = null;
      }
      self._templateMgr = null;
      InfraWizardDialog._activeInstance = null;
      self._dialogState = 'closed';
      if (self.onClose) self.onClose();
    }, 300);
  }

  /* ─── Drag ─── */

  _startDrag(e) {
    if (!this._dialogEl) return;
    var rect = this._dialogEl.getBoundingClientRect();
    this._dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top
    };
    this._dialogEl.classList.add('dragging');
    this._dialogEl.style.position = 'fixed';
    this._dialogEl.style.left = rect.left + 'px';
    this._dialogEl.style.top = rect.top + 'px';

    var self = this;
    var onMove = function(ev) {
      if (!self._dragState) return;
      var dx = ev.clientX - self._dragState.startX;
      var dy = ev.clientY - self._dragState.startY;
      var newLeft = self._dragState.origLeft + dx;
      var newTop = self._dragState.origTop + dy;
      // Constrain: keep at least 48px of header visible
      newTop = Math.max(-self._dialogEl.offsetHeight + 48, newTop);
      newTop = Math.min(window.innerHeight - 48, newTop);
      newLeft = Math.max(-self._dialogEl.offsetWidth + 48, newLeft);
      newLeft = Math.min(window.innerWidth - 48, newLeft);
      self._dialogEl.style.left = newLeft + 'px';
      self._dialogEl.style.top = newTop + 'px';
    };
    var onUp = function() {
      self._dragState = null;
      self._dialogEl.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  _constrainToViewport() {
    if (!this._dialogEl) return;
    var rect = this._dialogEl.getBoundingClientRect();
    var changed = false;
    var left = rect.left;
    var top = rect.top;
    if (rect.right < 48) { left = 48 - rect.width; changed = true; }
    if (rect.left > window.innerWidth - 48) { left = window.innerWidth - 48; changed = true; }
    if (rect.bottom < 48) { top = 48 - rect.height; changed = true; }
    if (rect.top > window.innerHeight - 48) { top = window.innerHeight - 48; changed = true; }
    if (changed) {
      this._dialogEl.style.left = left + 'px';
      this._dialogEl.style.top = top + 'px';
    }
  }

  /* ─── Focus Trap ─── */

  _trapFocus(e) {
    var focusable = this._dialogEl.querySelectorAll(
      'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   NAME GENERATOR DATA — Docker-style random names
   ═══════════════════════════════════════════════════════════════════ */
var IW_ADJECTIVES = [
  'brave','calm','bold','keen','wise','fair','pure','warm','cool','kind',
  'glad','fond','mild','true','free','swift','quick','fast','brisk','agile',
  'fleet','rapid','lively','nimble','zippy','bright','sharp','clear','deep','smart',
  'lucid','astute','clever','witty','adept','tough','solid','steady','firm','stout',
  'hardy','robust','stable','deft','able','vivid','crisp','fresh','lush','sleek',
  'noble','prime','grand','neat','happy','jolly','merry','proud','eager','loyal'
];

var IW_NOUNS = [
  'turing','lovelace','hopper','dijkstra','knuth','ritchie','thompson','mccarthy','backus','liskov',
  'gosling','torvalds','pike','kernighan','stroustrup','hejlsberg','matsumoto','wozniak','cerf','berners_lee',
  'minsky','shannon','church','babbage','von_neumann','hamilton','boole','curry','haskell','erlang',
  'carmack','dean','norvig','hinton','lecun','bengio','goodfellow','sutskever','ng','pearl',
  'goldberg','lamport','wing','keller','shaw','bartik','holberton','sammet','allen','estrin',
  'moore','grove','noyce','kilby','engelbart','postel','metcalfe','baran','clark','floyd'
];

function iwGenerateRandomName() {
  var adj = IW_ADJECTIVES[Math.floor(Math.random() * IW_ADJECTIVES.length)];
  var noun = IW_NOUNS[Math.floor(Math.random() * IW_NOUNS.length)];
  var num = Math.floor(Math.random() * 90) + 10;
  return adj + '_' + noun + '_' + num;
}

function iwGenerateUniqueRandomName(existingWorkspaces) {
  var existingNames = {};
  for (var i = 0; i < existingWorkspaces.length; i++) {
    existingNames[existingWorkspaces[i].displayName.toLowerCase()] = true;
  }
  for (var attempt = 0; attempt < 5; attempt++) {
    var candidate = iwGenerateRandomName();
    if (!existingNames[candidate.toLowerCase()]) return candidate;
  }
  var base = iwGenerateRandomName();
  var suffix = Date.now().toString(36).slice(-4);
  return base + '_' + suffix;
}

/* ═══════════════════════════════════════════════════════════════════
   INFRA SETUP PAGE (Page 1)
   ═══════════════════════════════════════════════════════════════════ */
class InfraSetupPage {
  constructor(options) {
    this._api = options.apiClient;
    this._existingWorkspaces = options.existingWorkspaces || [];
    this._containerEl = options.containerEl;
    this._onValidationChange = options.onValidationChange;

    this._fields = {
      workspace: { value: '', valid: false, error: null, touched: false },
      capacity: { value: '', valid: false, error: null, touched: false },
      lakehouse: { value: '', valid: false, error: null, touched: false },
      notebook: { value: '', valid: false, error: null, touched: false }
    };
    this._lakehouseManual = false;
    this._notebookManual = false;
    this._capacities = null;
    this._capacityLoading = false;
    this._firstActivation = true;

    this._render();
    this._bindEvents();
  }

  activate(wizardState) {
    if (this._firstActivation) {
      this._firstActivation = false;
      // Generate initial random name
      var name = iwGenerateUniqueRandomName(this._existingWorkspaces);
      this._wsInput.value = name;
      this._fields.workspace.value = name;
      this._cascadeNames();
      // Load capacities
      this._loadCapacities();
    }
    // Restore state if navigating back
    if (wizardState && wizardState.workspaceName) {
      this._wsInput.value = wizardState.workspaceName;
      this._fields.workspace.value = wizardState.workspaceName;
      this._lhInput.value = wizardState.lakehouseName;
      this._fields.lakehouse.value = wizardState.lakehouseName;
      this._nbInput.value = wizardState.notebookName;
      this._fields.notebook.value = wizardState.notebookName;
      this._lakehouseManual = wizardState.lakehouseNameManuallyEdited || false;
      this._notebookManual = wizardState.notebookNameManuallyEdited || false;
      if (wizardState.capacityId && this._capSelect) {
        this._capSelect.value = wizardState.capacityId;
        this._fields.capacity.value = wizardState.capacityId;
      }
    }
    this._validateAllFields();
  }

  deactivate() {}

  validate() {
    this._validateAllFields();
    var allValid = this._fields.workspace.valid &&
                   this._fields.capacity.valid &&
                   this._fields.lakehouse.valid &&
                   this._fields.notebook.valid;
    if (!allValid) return 'Please fill in all required fields';
    return null;
  }

  collectState(state) {
    state.workspaceName = this._fields.workspace.value;
    state.capacityId = this._fields.capacity.value || null;
    state.capacityDisplayName = this._capSelect ? this._capSelect.options[this._capSelect.selectedIndex].text : '';
    // Extract SKU and region from the selected capacity object
    var selectedCap = null;
    if (this._capacities && state.capacityId) {
      for (var ci = 0; ci < this._capacities.length; ci++) {
        if (this._capacities[ci].id === state.capacityId) {
          selectedCap = this._capacities[ci];
          break;
        }
      }
    }
    state.capacitySku = selectedCap ? (selectedCap.sku || '') : '';
    state.capacityRegion = selectedCap ? (selectedCap.region || selectedCap.displayName || '') : '';
    state.lakehouseName = this._fields.lakehouse.value;
    state.notebookName = this._fields.notebook.value;
    state.lakehouseNameManuallyEdited = this._lakehouseManual;
    state.notebookNameManuallyEdited = this._notebookManual;
    state.dirty = true;
  }

  destroy() {
    this._containerEl.innerHTML = '';
  }

  getElement() {
    return this._containerEl;
  }

  randomize() {
    var name = iwGenerateUniqueRandomName(this._existingWorkspaces);
    this._wsInput.value = name;
    this._fields.workspace.value = name;
    this._lakehouseManual = false;
    this._notebookManual = false;
    this._cascadeNames();
    this._validateAllFields();
    // Spin animation on randomize button
    var btn = this._containerEl.querySelector('.iw-randomize-btn');
    if (btn) {
      btn.classList.add('spinning');
      setTimeout(function() { btn.classList.remove('spinning'); }, 300);
    }
  }

  /* --- Render --- */

  _render() {
    this._containerEl.innerHTML =
      '<div class="iw-form-group">' +
        '<label class="iw-form-label">Workspace Name</label>' +
        '<div class="iw-input-wrapper">' +
          '<input class="iw-form-input mono" id="iw-ws-name" spellcheck="false" placeholder="e.g. brave_turing_42">' +
          '<button class="iw-input-icon iw-randomize-btn" title="Randomize name">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="iw-form-hint"><span class="iw-dot">\u25CF</span> Unique name, underscores allowed</div>' +
        '<div class="iw-form-error" id="iw-ws-error"></div>' +
      '</div>' +

      '<div class="iw-form-group">' +
        '<label class="iw-form-label">Capacity</label>' +
        '<div class="iw-select-wrapper">' +
          '<select class="iw-form-select" id="iw-cap-select">' +
            '<option value="" disabled selected>Loading capacities\u2026</option>' +
          '</select>' +
          '<span class="iw-select-arrow">\u25BE</span>' +
        '</div>' +
        '<button type="button" class="iw-create-cap-btn" id="iw-create-cap-btn">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
          '<span>Create New Capacity</span>' +
        '</button>' +
        '<div class="iw-form-error" id="iw-cap-error"></div>' +
      '</div>' +

      '<div class="iw-form-row">' +
        '<div class="iw-form-group">' +
          '<label class="iw-form-label">Lakehouse Name</label>' +
          '<div class="iw-input-wrapper">' +
            '<input class="iw-form-input mono" id="iw-lh-name" spellcheck="false" placeholder="auto-generated">' +
            '<span class="iw-input-icon valid" id="iw-lh-icon" style="display:none">\u2713</span>' +
          '</div>' +
          '<div class="iw-form-hint"><span class="iw-dot">\u25CF</span> Schema-enabled (always)</div>' +
          '<div class="iw-form-error" id="iw-lh-error"></div>' +
        '</div>' +
        '<div class="iw-form-group">' +
          '<label class="iw-form-label">Notebook Name</label>' +
          '<div class="iw-input-wrapper">' +
            '<input class="iw-form-input mono" id="iw-nb-name" spellcheck="false" placeholder="auto-generated">' +
            '<span class="iw-input-icon valid" id="iw-nb-icon" style="display:none">\u2713</span>' +
          '</div>' +
          '<div class="iw-form-hint"><span class="iw-dot">\u25CF</span> Auto-generated from workspace</div>' +
          '<div class="iw-form-error" id="iw-nb-error"></div>' +
        '</div>' +
      '</div>';

    // Cache DOM refs
    this._wsInput = this._containerEl.querySelector('#iw-ws-name');
    this._capSelect = this._containerEl.querySelector('#iw-cap-select');
    this._lhInput = this._containerEl.querySelector('#iw-lh-name');
    this._nbInput = this._containerEl.querySelector('#iw-nb-name');
  }

  /* --- Events --- */

  _bindEvents() {
    var self = this;

    // Workspace name: sanitize + cascade
    this._wsInput.addEventListener('input', function() {
      var v = self._wsInput.value.replace(/[^a-zA-Z0-9_]/g, '');
      self._wsInput.value = v;
      self._fields.workspace.value = v;
      self._cascadeNames();
      if (self._fields.workspace.touched) self._validateField('workspace');
    });
    this._wsInput.addEventListener('blur', function() {
      self._fields.workspace.touched = true;
      self._validateField('workspace');
    });

    // Capacity select
    this._capSelect.addEventListener('change', function() {
      self._fields.capacity.value = self._capSelect.value;
      self._fields.capacity.touched = true;
      self._validateField('capacity');
    });

    // Lakehouse name: detect manual edit
    this._lhInput.addEventListener('input', function() {
      var v = self._lhInput.value.replace(/[^a-zA-Z0-9_]/g, '');
      self._lhInput.value = v;
      self._fields.lakehouse.value = v;
      self._lakehouseManual = true;
      if (self._fields.lakehouse.touched) self._validateField('lakehouse');
    });
    this._lhInput.addEventListener('blur', function() {
      self._fields.lakehouse.touched = true;
      self._validateField('lakehouse');
    });

    // Notebook name: detect manual edit
    this._nbInput.addEventListener('input', function() {
      var v = self._nbInput.value.replace(/[^a-zA-Z0-9_]/g, '');
      self._nbInput.value = v;
      self._fields.notebook.value = v;
      self._notebookManual = true;
      if (self._fields.notebook.touched) self._validateField('notebook');
    });
    this._nbInput.addEventListener('blur', function() {
      self._fields.notebook.touched = true;
      self._validateField('notebook');
    });

    // Randomize button
    var randBtn = this._containerEl.querySelector('.iw-randomize-btn');
    if (randBtn) {
      randBtn.addEventListener('click', function() { self.randomize(); });
    }

    // Create-capacity button
    var createCapBtn = this._containerEl.querySelector('#iw-create-cap-btn');
    if (createCapBtn) {
      createCapBtn.addEventListener('click', function() { self._showCreateCapacityDialog(); });
    }
  }

  _showCreateCapacityDialog() {
    var self = this;
    var existing = this._capacities || [];
    var dlg = new InfraCapacityCreateDialog(this._api, { existingCapacities: existing });
    dlg.onComplete = function(newCap) {
      // Prepend the new capacity to the list and select it
      var caps = self._capacities || [];
      caps.unshift(newCap);
      self._capacities = caps;
      self._renderCapacityOptions();
      self._capSelect.value = newCap.id;
      self._fields.capacity.value = newCap.id;
      self._fields.capacity.touched = true;
      self._validateField('capacity');
    };
    dlg.open();
  }

  /* --- Cascade --- */

  _cascadeNames() {
    var base = this._fields.workspace.value;
    if (!this._lakehouseManual) {
      var lhVal = base ? base + '_lh' : '';
      this._lhInput.value = lhVal;
      this._fields.lakehouse.value = lhVal;
    }
    if (!this._notebookManual) {
      var nbVal = base ? base + '_nb' : '';
      this._nbInput.value = nbVal;
      this._fields.notebook.value = nbVal;
    }
  }

  /* --- Validation --- */

  _validateField(fieldName) {
    var field = this._fields[fieldName];
    var value = field.value;
    field.error = null;
    field.valid = false;

    if (fieldName === 'workspace') {
      if (!value) { field.error = 'Workspace name is required'; }
      else if (value.length < 3) { field.error = 'Must be at least 3 characters'; }
      else if (value.length > 64) { field.error = 'Must be 64 characters or fewer'; }
      else if (!/^[a-zA-Z]/.test(value)) { field.error = 'Must start with a letter'; }
      else {
        // Check collision
        var lower = value.toLowerCase();
        for (var i = 0; i < this._existingWorkspaces.length; i++) {
          if (this._existingWorkspaces[i].displayName.toLowerCase() === lower) {
            field.error = 'Workspace name already exists';
            break;
          }
        }
      }
      if (!field.error) field.valid = true;
    }

    if (fieldName === 'capacity') {
      if (!value) { field.error = 'Please select a capacity'; }
      else { field.valid = true; }
    }

    if (fieldName === 'lakehouse' || fieldName === 'notebook') {
      if (!value) { field.error = (fieldName === 'lakehouse' ? 'Lakehouse' : 'Notebook') + ' name is required'; }
      else if (value.length < 3) { field.error = 'Must be at least 3 characters'; }
      else if (value.length > 64) { field.error = 'Must be 64 characters or fewer'; }
      else if (!/^[a-zA-Z]/.test(value)) { field.error = 'Must start with a letter'; }
      else { field.valid = true; }
    }

    this._updateFieldUI(fieldName);
    this._emitValidation();
  }

  _validateAllFields() {
    this._validateField('workspace');
    this._validateField('capacity');
    this._validateField('lakehouse');
    this._validateField('notebook');
  }

  _updateFieldUI(fieldName) {
    var field = this._fields[fieldName];
    var inputEl, errorEl, iconEl;

    if (fieldName === 'workspace') {
      inputEl = this._wsInput;
      errorEl = this._containerEl.querySelector('#iw-ws-error');
    } else if (fieldName === 'capacity') {
      inputEl = this._capSelect;
      errorEl = this._containerEl.querySelector('#iw-cap-error');
    } else if (fieldName === 'lakehouse') {
      inputEl = this._lhInput;
      errorEl = this._containerEl.querySelector('#iw-lh-error');
      iconEl = this._containerEl.querySelector('#iw-lh-icon');
    } else if (fieldName === 'notebook') {
      inputEl = this._nbInput;
      errorEl = this._containerEl.querySelector('#iw-nb-error');
      iconEl = this._containerEl.querySelector('#iw-nb-icon');
    }

    if (!inputEl) return;

    inputEl.classList.remove('error', 'valid');
    if (field.touched && field.error) {
      inputEl.classList.add('error');
      if (errorEl) { errorEl.textContent = field.error; errorEl.classList.add('show'); }
      if (iconEl) iconEl.style.display = 'none';
    } else if (field.touched && field.valid) {
      inputEl.classList.add('valid');
      if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
      if (iconEl) iconEl.style.display = '';
    } else {
      if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('show'); }
      if (iconEl) iconEl.style.display = 'none';
    }
  }

  _emitValidation() {
    var allValid = this._fields.workspace.valid &&
                   this._fields.capacity.valid &&
                   this._fields.lakehouse.valid &&
                   this._fields.notebook.valid;
    if (this._onValidationChange) this._onValidationChange(allValid);
  }

  /* --- Capacity Loading --- */

  _loadCapacities() {
    var self = this;
    this._capacityLoading = true;
    this._capSelect.classList.add('loading');

    var isMock = new URLSearchParams(window.location.search).has('mock');
    if (isMock) {
      // Mock data for development
      setTimeout(function() {
        self._capacities = [
          { id: 'f4-east',  displayName: 'F4 \u2014 East US', state: 'Active', sku: 'F4' },
          { id: 'f8-west',  displayName: 'F8 \u2014 West US 2', state: 'Active', sku: 'F8' },
          { id: 'f16-eu',   displayName: 'F16 \u2014 North Europe', state: 'Suspended', sku: 'F16' },
          { id: 'f2-sea',   displayName: 'F2 \u2014 Southeast Asia', state: 'Active', sku: 'F2' }
        ];
        self._renderCapacityOptions();
      }, 500);
      return;
    }

    this._api.listCapacities().then(function(data) {
      self._capacities = (data && data.value) || [];
      self._renderCapacityOptions();
    }).catch(function(err) {
      self._capacities = [];
      self._renderCapacityOptions();
      self._fields.capacity.error = 'Failed to load capacities: ' + err.message;
      self._updateFieldUI('capacity');
    });
  }

  _renderCapacityOptions() {
    this._capacityLoading = false;
    this._capSelect.classList.remove('loading');
    var html = '<option value="" disabled selected>Select capacity\u2026</option>';
    if (this._capacities && this._capacities.length > 0) {
      for (var i = 0; i < this._capacities.length; i++) {
        var cap = this._capacities[i];
        var stateLabel = cap.state === 'Active' ? 'Running' : cap.state === 'Suspended' ? 'Paused' : cap.state;
        html += '<option value="' + cap.id + '">' +
          (cap.sku || '') + ' \u2014 ' + cap.displayName + ' (' + stateLabel + ')' +
        '</option>';
      }
    } else {
      html = '<option value="" disabled selected>No capacities available</option>';
    }
    this._capSelect.innerHTML = html;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   InfraCapacityCreateDialog — mini-modal for creating a Fabric capacity
   ═══════════════════════════════════════════════════════════════════ */
var IW_CAP_SKUS = [
  { sku: 'F2',   vcores: 1,    memory: '1 GB' },
  { sku: 'F4',   vcores: 1,    memory: '2 GB' },
  { sku: 'F8',   vcores: 1,    memory: '3 GB' },
  { sku: 'F16',  vcores: 2,    memory: '5 GB' },
  { sku: 'F32',  vcores: 4,    memory: '10 GB' },
  { sku: 'F64',  vcores: 8,    memory: '25 GB' },
  { sku: 'P1',   vcores: 8,    memory: '25 GB' },
  { sku: 'P2',   vcores: 16,   memory: '50 GB' },
  { sku: 'P3',   vcores: 32,   memory: '100 GB' },
  { sku: 'P4',   vcores: 64,   memory: '200 GB' }
];

var IW_CAP_REGIONS = [
  { code: 'westus2',       label: 'West US 2' },
  { code: 'eastus',        label: 'East US' },
  { code: 'northeurope',   label: 'North Europe' },
  { code: 'westeurope',    label: 'West Europe' },
  { code: 'southeastasia', label: 'Southeast Asia' }
];

function iwGenerateCapacityName() {
  var chars = 'abcdefghjkmnpqrstuvwxyz';
  var s = '';
  for (var i = 0; i < 2; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'fmlv_cap_' + s;
}

class InfraCapacityCreateDialog {
  constructor(apiClient, options) {
    var opts = options || {};
    this._api = apiClient;
    this._existing = opts.existingCapacities || [];
    this._overlayEl = null;
    this._dialogEl = null;
    this._nameInput = null;
    this._skuSelect = null;
    this._regionSelect = null;
    this._createBtn = null;
    this._errorBanner = null;
    this._state = 'idle'; // idle | creating | success | failed
    this.onComplete = null;
    this.onClose = null;
    this._boundKeydown = null;
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
    if (this._state === 'creating') return;
    document.removeEventListener('keydown', this._boundKeydown);
    this._overlayEl.remove();
    this._overlayEl = null;
    if (this.onClose) this.onClose();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') this.close();
    if (e.key === 'Enter' && this._state === 'idle' && !this._createBtn.disabled) this._submit();
  }

  _detectDefaultRegion() {
    // Match an existing capacity's region (display name or code) to our list
    for (var i = 0; i < this._existing.length; i++) {
      var r = (this._existing[i].region || '').toLowerCase().replace(/\s+/g, '');
      for (var j = 0; j < IW_CAP_REGIONS.length; j++) {
        var entry = IW_CAP_REGIONS[j];
        if (r === entry.code || r === entry.label.toLowerCase().replace(/\s+/g, '')) {
          return entry.code;
        }
      }
    }
    return 'westus2';
  }

  _build() {
    var self = this;

    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'iw-cap-overlay';
    this._overlayEl.addEventListener('click', function(e) {
      if (e.target === self._overlayEl) self.close();
    });

    this._dialogEl = document.createElement('div');
    this._dialogEl.className = 'iw-cap-dialog';
    this._dialogEl.setAttribute('role', 'dialog');
    this._dialogEl.setAttribute('aria-label', 'Create capacity');
    this._overlayEl.appendChild(this._dialogEl);

    // Header
    var header = document.createElement('div');
    header.className = 'iw-cap-header';
    header.innerHTML =
      '<div class="iw-cap-header-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' +
      '</div>' +
      '<div class="iw-cap-title">Create Capacity</div>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'iw-cap-close';
    closeBtn.innerHTML = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', function() { self.close(); });
    header.appendChild(closeBtn);
    this._dialogEl.appendChild(header);

    // Error banner (hidden)
    this._errorBanner = document.createElement('div');
    this._errorBanner.className = 'iw-cap-banner error';
    this._errorBanner.style.display = 'none';
    this._dialogEl.appendChild(this._errorBanner);

    // Body
    var body = document.createElement('div');
    body.className = 'iw-cap-body';
    this._dialogEl.appendChild(body);

    // Name field
    var nameField = document.createElement('div');
    nameField.className = 'iw-cap-field';
    nameField.innerHTML =
      '<div class="iw-cap-label">CAPACITY NAME</div>' +
      '<input class="iw-cap-input mono" type="text" maxlength="63" spellcheck="false">';
    body.appendChild(nameField);
    this._nameInput = nameField.querySelector('input');
    this._nameInput.value = iwGenerateCapacityName();
    this._nameInput.addEventListener('input', function() {
      // Capacity names: letters, digits, underscores, hyphens
      self._nameInput.value = self._nameInput.value.replace(/[^a-zA-Z0-9_-]/g, '');
      self._updateCreateBtn();
    });

    // SKU field
    var skuField = document.createElement('div');
    skuField.className = 'iw-cap-field';
    var skuOptions = '';
    for (var i = 0; i < IW_CAP_SKUS.length; i++) {
      var s = IW_CAP_SKUS[i];
      var sel = s.sku === 'P3' ? ' selected' : '';
      skuOptions += '<option value="' + s.sku + '"' + sel + '>' +
        s.sku + ' \u2014 ' + s.vcores + ' vCores, ' + s.memory + '</option>';
    }
    skuField.innerHTML =
      '<div class="iw-cap-label">SKU</div>' +
      '<div class="iw-cap-select-wrap">' +
        '<select class="iw-cap-select">' + skuOptions + '</select>' +
        '<span class="iw-cap-select-arrow">\u25BE</span>' +
      '</div>';
    body.appendChild(skuField);
    this._skuSelect = skuField.querySelector('select');

    // Region field
    var regionField = document.createElement('div');
    regionField.className = 'iw-cap-field';
    var defaultRegion = this._detectDefaultRegion();
    var regionOptions = '';
    for (var k = 0; k < IW_CAP_REGIONS.length; k++) {
      var r = IW_CAP_REGIONS[k];
      var rsel = r.code === defaultRegion ? ' selected' : '';
      regionOptions += '<option value="' + r.code + '"' + rsel + '>' + r.label + '</option>';
    }
    regionField.innerHTML =
      '<div class="iw-cap-label">REGION</div>' +
      '<div class="iw-cap-select-wrap">' +
        '<select class="iw-cap-select">' + regionOptions + '</select>' +
        '<span class="iw-cap-select-arrow">\u25BE</span>' +
      '</div>';
    body.appendChild(regionField);
    this._regionSelect = regionField.querySelector('select');

    // Footer
    var footer = document.createElement('div');
    footer.className = 'iw-cap-footer';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'iw-cap-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { self.close(); });
    footer.appendChild(cancelBtn);
    this._createBtn = document.createElement('button');
    this._createBtn.className = 'iw-cap-btn iw-cap-btn-primary ready';
    this._createBtn.textContent = 'Create Capacity';
    this._createBtn.addEventListener('click', function() { self._submit(); });
    footer.appendChild(this._createBtn);
    this._dialogEl.appendChild(footer);
  }

  _updateCreateBtn() {
    var name = (this._nameInput.value || '').trim();
    var ready = name.length >= 3 && this._state === 'idle';
    this._createBtn.disabled = !ready;
    if (ready) this._createBtn.classList.add('ready');
    else this._createBtn.classList.remove('ready');
  }

  _submit() {
    if (this._state !== 'idle') return;
    var name = (this._nameInput.value || '').trim();
    if (name.length < 3) return;
    var sku = this._skuSelect.value;
    var region = this._regionSelect.value;

    var self = this;
    this._state = 'creating';
    this._createBtn.disabled = true;
    this._createBtn.classList.remove('ready');
    this._createBtn.innerHTML = '<span class="iw-cap-spinner"></span>Creating\u2026';
    this._nameInput.disabled = true;
    this._skuSelect.disabled = true;
    this._regionSelect.disabled = true;
    this._errorBanner.style.display = 'none';

    this._api.createCapacity(name, sku, region).then(function(result) {
      self._state = 'success';
      var newCap = self._normalizeCapacity(result, name, sku, region);
      self._showSuccess(newCap);
    }).catch(function(err) {
      self._showError(err && err.message ? err.message : 'Capacity creation failed');
    });
  }

  _normalizeCapacity(raw, name, sku, region) {
    // Server may return Fabric public API shape ({id, displayName, sku, region})
    // or Power BI internal shape (capacityObjectId / metadata.configuration.*).
    // Normalize to {id, displayName, sku, region, state}.
    var r = raw || {};
    var id = r.id || r.capacityObjectId || r.objectId || '';
    if (!id && r.metadata) id = r.metadata.capacityObjectId || '';
    var cfg = (r.metadata && r.metadata.configuration) || {};
    return {
      id: id,
      displayName: r.displayName || cfg.displayName || name,
      sku: r.sku || cfg.sku || sku,
      region: r.region || cfg.region || region,
      state: r.state || 'Active'
    };
  }

  _showSuccess(newCap) {
    var self = this;
    var body = this._dialogEl.querySelector('.iw-cap-body');
    var footer = this._dialogEl.querySelector('.iw-cap-footer');
    body.innerHTML =
      '<div class="iw-cap-success">' +
        '<div class="iw-cap-success-icon">\u2713</div>' +
        '<div class="iw-cap-success-name">' + this._esc(newCap.displayName) + '</div>' +
        '<div class="iw-cap-success-sub">' +
          this._esc(newCap.sku) + ' \u2014 ' + this._esc(newCap.region) +
        '</div>' +
      '</div>';
    footer.style.display = 'none';

    setTimeout(function() {
      if (!self._overlayEl) return;
      document.removeEventListener('keydown', self._boundKeydown);
      self._overlayEl.remove();
      self._overlayEl = null;
      if (self.onComplete) self.onComplete(newCap);
    }, 1500);
  }

  _showError(msg) {
    var self = this;
    this._state = 'idle';
    this._nameInput.disabled = false;
    this._skuSelect.disabled = false;
    this._regionSelect.disabled = false;
    this._createBtn.innerHTML = 'Create Capacity';
    this._updateCreateBtn();

    this._errorBanner.style.display = '';
    this._errorBanner.innerHTML = '<span>\u2715 ' + this._esc(msg) + '</span>';
    var retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', function() { self._submit(); });
    this._errorBanner.appendChild(retryBtn);
  }

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   THEME DEFINITIONS
   ═══════════════════════════════════════════════════════════════════ */
var IW_THEMES = [
  {
    id: 'ecommerce',
    name: 'E-Commerce',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
    tables: 'orders, customers, products, categories, reviews, inventory'
  },
  {
    id: 'sales',
    name: 'Sales Analytics',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    tables: 'opportunities, accounts, contacts, activities, pipeline, quotas'
  },
  {
    id: 'iot',
    name: 'IoT / Sensors',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    tables: 'sensors, readings, alerts, devices, maintenance, locations'
  },
  {
    id: 'hr',
    name: 'HR & People',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    tables: 'employees, departments, payroll, attendance, reviews, positions'
  },
  {
    id: 'finance',
    name: 'Finance',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    tables: 'transactions, accounts, invoices, payments, budgets, categories'
  },
  {
    id: 'healthcare',
    name: 'Healthcare',
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    tables: 'patients, appointments, prescriptions, labs, providers, claims'
  }
];

/* ═══════════════════════════════════════════════════════════════════
   THEME SCHEMA PAGE (Page 2)
   ═══════════════════════════════════════════════════════════════════ */
class ThemeSchemaPage {
  constructor(options) {
    this._containerEl = options.containerEl;
    this._onValidationChange = options.onValidationChange;

    this._selectedTheme = null;
    // NOTE: medallion-on state is DERIVED from this._schemas (see _isMedallionOn).
    // Do not store a separate _medallionOn flag — it has caused desync bugs where
    // a chip click turned the toggle off (see fix history for the chip handler).
    this._schemas = { dbo: true, bronze: false, silver: false, gold: false };

    this._render();
    this._bindEvents();
  }

  _isMedallionOn() {
    return !!(this._schemas.bronze || this._schemas.silver || this._schemas.gold);
  }

  activate(wizardState) {
    // Restore state if navigating back
    if (wizardState && wizardState.theme) {
      this._selectedTheme = wizardState.theme;
      this._schemas = Object.assign({ dbo: true, bronze: false, silver: false, gold: false }, wizardState.schemas);
      this._updateThemeUI();
      this._updateMedallionUI();
    }
    this._emitValidation();
  }

  deactivate() {}

  validate() {
    if (!this._selectedTheme) return 'Please select a data theme';
    return null;
  }

  collectState(state) {
    state.theme = this._selectedTheme;
    state.schemas = Object.assign({}, this._schemas);
    state.dirty = true;
  }

  destroy() {
    this._containerEl.innerHTML = '';
  }

  getElement() {
    return this._containerEl;
  }

  /* --- Render --- */

  _render() {
    var html =
      '<div class="iw-form-group">' +
        '<label class="iw-form-label">Data Theme</label>' +
        '<div class="iw-theme-grid" id="iw-theme-grid">';

    for (var i = 0; i < IW_THEMES.length; i++) {
      var t = IW_THEMES[i];
      html +=
        '<div class="iw-theme-card" data-theme="' + t.id + '">' +
          '<div class="iw-theme-icon">' + t.icon + '</div>' +
          '<div class="iw-theme-name">' + t.name + '</div>' +
          '<div class="iw-theme-tables">' + t.tables + '</div>' +
        '</div>';
    }

    html += '</div></div>';

    // Schema section
    html +=
      '<div class="iw-schema-section">' +
        '<label class="iw-form-label">Schemas</label>' +
        '<div class="iw-schema-row">' +
          '<span class="iw-chip iw-chip-dbo">\u25CF dbo</span>' +
          '<span style="font-size:10px;color:var(--text-muted,#8e95a5)">Always included</span>' +
        '</div>' +
        '<div class="iw-schema-row" style="margin-top:12px">' +
          '<button type="button" class="iw-toggle-track" id="iw-medallion-toggle" aria-pressed="false" aria-label="Toggle medallion schemas">' +
            '<div class="iw-toggle-thumb"></div>' +
          '</button>' +
          '<span class="iw-toggle-label">Add medallion schemas</span>' +
        '</div>' +
        '<div class="iw-medallion-chips" id="iw-medallion-chips">' +
          '<div class="iw-medallion-chip" data-schema="bronze">' +
            '<div class="iw-medallion-check">\u2713</div>' +
            'Bronze' +
          '</div>' +
          '<div class="iw-medallion-chip" data-schema="silver">' +
            '<div class="iw-medallion-check">\u2713</div>' +
            'Silver' +
          '</div>' +
          '<div class="iw-medallion-chip" data-schema="gold">' +
            '<div class="iw-medallion-check">\u2713</div>' +
            'Gold' +
          '</div>' +
        '</div>' +
      '</div>';

    this._containerEl.innerHTML = html;
  }

  /* --- Events --- */

  _bindEvents() {
    var self = this;

    // Theme card clicks
    var grid = this._containerEl.querySelector('#iw-theme-grid');
    if (grid) {
      grid.addEventListener('click', function(e) {
        var card = e.target.closest('.iw-theme-card');
        if (!card) return;
        self._selectedTheme = card.getAttribute('data-theme');
        self._updateThemeUI();
        self._emitValidation();
      });
    }

    // Medallion toggle — flips ALL three medallion schemas together.
    // _isMedallionOn() reads schemas, so we don't track a separate flag.
    var toggle = this._containerEl.querySelector('#iw-medallion-toggle');
    if (toggle) {
      toggle.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var isOn = self._isMedallionOn();
        if (isOn) {
          // Turn OFF: disable all medallion schemas
          self._schemas.bronze = false;
          self._schemas.silver = false;
          self._schemas.gold = false;
        } else {
          // Turn ON: enable all three by default
          self._schemas.bronze = true;
          self._schemas.silver = true;
          self._schemas.gold = true;
        }
        self._updateMedallionUI();
      });
    }

    // Medallion chip clicks — enforce hierarchy: Bronze → Silver → Gold.
    // Selecting a higher tier auto-enables all lower tiers.
    // Deselecting a lower tier auto-disables all higher tiers.
    var chips = this._containerEl.querySelector('#iw-medallion-chips');
    if (chips) {
      chips.addEventListener('click', function(e) {
        var chip = e.target.closest('.iw-medallion-chip');
        if (!chip) return;
        var schema = chip.getAttribute('data-schema');
        if (!schema || !(schema in self._schemas) || schema === 'dbo') return;
        e.preventDefault();
        e.stopPropagation();
        var wasOn = self._schemas[schema];
        if (wasOn) {
          // Deselecting: turn off this + everything above
          if (schema === 'bronze') { self._schemas.bronze = false; self._schemas.silver = false; self._schemas.gold = false; }
          else if (schema === 'silver') { self._schemas.silver = false; self._schemas.gold = false; }
          else if (schema === 'gold') { self._schemas.gold = false; }
        } else {
          // Selecting: turn on this + everything below
          if (schema === 'gold') { self._schemas.bronze = true; self._schemas.silver = true; self._schemas.gold = true; }
          else if (schema === 'silver') { self._schemas.bronze = true; self._schemas.silver = true; }
          else if (schema === 'bronze') { self._schemas.bronze = true; }
        }
        self._updateMedallionUI();
      });
    }
  }

  /* --- UI Updates --- */

  _updateThemeUI() {
    var cards = this._containerEl.querySelectorAll('.iw-theme-card');
    for (var i = 0; i < cards.length; i++) {
      var isSelected = cards[i].getAttribute('data-theme') === this._selectedTheme;
      if (isSelected) {
        cards[i].classList.add('selected');
      } else {
        cards[i].classList.remove('selected');
      }
    }
  }

  _updateMedallionUI() {
    var toggle = this._containerEl.querySelector('#iw-medallion-toggle');
    var chipsContainer = this._containerEl.querySelector('#iw-medallion-chips');
    var on = this._isMedallionOn();

    if (toggle) {
      toggle.classList.toggle('on', on);
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    if (chipsContainer) {
      chipsContainer.classList.toggle('show', on);
    }

    // Update individual chips
    var chipEls = this._containerEl.querySelectorAll('.iw-medallion-chip');
    for (var i = 0; i < chipEls.length; i++) {
      var schema = chipEls[i].getAttribute('data-schema');
      if (this._schemas[schema]) {
        chipEls[i].classList.add('active');
      } else {
        chipEls[i].classList.remove('active');
      }
    }
  }

  _emitValidation() {
    var isValid = this._selectedTheme !== null;
    if (this._onValidationChange) this._onValidationChange(isValid);
  }
}
