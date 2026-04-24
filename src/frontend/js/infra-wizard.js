/**
 * InfraWizardDialog — Modal wizard for creating Fabric infrastructure.
 *
 * 5-step wizard: Setup -> Theme -> Build -> Review -> Deploy
 * Phase 1 implements pages 1 (Setup) and 2 (Theme). Pages 3-5 are stubs.
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
   ═══════════════════════════════════════════════════════════════════ */
function createWizardState() {
  return {
    workspaceName: '',
    capacityId: '',
    capacityDisplayName: '',
    lakehouseName: '',
    notebookName: '',
    lakehouseManuallyEdited: false,
    notebookManuallyEdited: false,
    theme: null,
    schemas: { dbo: true, bronze: false, silver: false, gold: false },
    nodes: [],
    connections: [],
    nextNodeId: 1,
    execution: null,
    createdAt: null,
    templateName: null,
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
    this._createDOM();
    this._bindEvents();
    this._initializePages();
    this._goToPage(this._startPage, false);
    this._dialogState = 'open';
  }

  close() {
    if (this._dialogState === 'closed') return;
    // If executing, minimize instead
    if (this._currentPage === 4 && this._state.execution && this._state.execution.status === 'running') {
      this.minimize();
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
    // Phase 1 stub — will implement FloatingBadge in Phase 4
    this._dialogState = 'minimized';
    if (this._overlayEl) this._overlayEl.style.display = 'none';
    if (this._dialogEl) this._dialogEl.style.display = 'none';
  }

  restore() {
    if (this._dialogState !== 'minimized') return;
    this._dialogState = 'open';
    if (this._overlayEl) this._overlayEl.style.display = '';
    if (this._dialogEl) this._dialogEl.style.display = '';
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
    var w = Math.min(920, vw * 0.88);
    var h = Math.min(680, vh * 0.88);
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

    // Pages 2-4: Stubs (Phase 2-4)
    for (var i = 2; i <= 4; i++) {
      var stubContent = this._pageContainerEl.querySelector('#iw-page-' + i + ' .iw-page-content');
      stubContent.innerHTML = '<div class="iw-stub-page">Phase ' + (i <= 2 ? '2' : i <= 3 ? '3' : '4') + ' \u2014 ' + IW_STEPS[i].label + ' (coming soon)</div>';
      this._pages[i] = {
        activate: function() {},
        deactivate: function() {},
        validate: function() { return null; },
        collectState: function() {},
        destroy: function() {},
        getElement: function() { return null; }
      };
    }
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
      pages[fromIndex].classList.add(direction === 'forward' ? 'exit-left' : '');
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
    var error = page.validate ? page.validate() : null;
    if (error) {
      // Validation failed — page component shows inline errors
      return;
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
    confirmEl.innerHTML =
      '<div class="iw-confirm-box">' +
        '<div class="iw-confirm-title">Discard wizard?</div>' +
        '<div class="iw-confirm-text">All entered data will be lost. This action cannot be undone.</div>' +
        '<div class="iw-confirm-actions">' +
          '<button class="iw-btn iw-btn-ghost" id="iw-confirm-cancel">Cancel</button>' +
          '<button class="iw-btn iw-btn-danger" id="iw-confirm-discard">Discard</button>' +
        '</div>' +
      '</div>';
    this._dialogEl.appendChild(confirmEl);

    confirmEl.querySelector('#iw-confirm-cancel').addEventListener('click', function() {
      confirmEl.parentNode.removeChild(confirmEl);
    });
    confirmEl.querySelector('#iw-confirm-discard').addEventListener('click', function() {
      self._performClose();
    });
  }

  _showLockInConfirmation() {
    // Phase 4 will implement the full "Lock In & Create" flow
    // For Phase 1, just move to page 4 (stub)
    this._goToPage(4, true);
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
