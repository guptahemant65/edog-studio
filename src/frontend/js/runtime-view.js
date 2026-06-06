/**
 * RuntimeView — Tab bar orchestrator with phase transitions.
 *
 * Manages the Runtime View shell:
 *   - Tab bar: sliding underline, active state, keyboard Alt+1-5
 *   - Internals dropdown: open/close, selection, label rewrite
 *   - Connection status bar: dot colour, throughput, port
 *   - Phase transitions: Phase 1 overlay, Phase 2 unlock
 *   - Tab lifecycle: activate()/deactivate() on registered modules
 *
 * Reference: f04-runtime-view-integrated.html (shell architecture)
 */
class RuntimeView {
  constructor(signalr) {
    this._signalr = signalr;
    this._tabs = {};           // tabId → { module, el }
    // PR-A: seed initial tab from studioState (URL hash or localStorage)
    // so deep links + reload land on the right tab. Falls back to 'logs'.
    this._activeTab = (window.studioState && window.studioState.get().activeTab) || 'logs';
    this._phase = 'disconnected';
    this._internalsOpen = false;
    this._internalsActiveId = null;
    this._connectionStatus = 'disconnected';

    // Top-level tab IDs (order matches tab bar)
    this._topTabIds = ['logs', 'telemetry', 'sysfiles', 'spark', 'nexus'];

    // Internals sub-view IDs
    this._internalsIds = ['tokens', 'caches', 'http', 'retries', 'flags', 'di', 'perf'];

    // DOM references — populated in init()
    this._tabBar = null;
    this._tabBarInner = null;
    this._indicator = null;
    this._tabEls = null;
    this._internalsTab = null;
    this._internalsLabel = null;
    this._internalsChevron = null;
    this._dropdown = null;
    this._phase1Overlay = null;
    this._stoppedOverlay = null;
    this._connDot = null;
    this._connLabel = null;
    this._connThroughput = null;
    this._connPort = null;
    this._sidebarDot = null;
    this._sidebarLock = null;
  }

  init() {
    // Cache DOM
    this._tabBar = document.getElementById('rt-tab-bar');
    this._tabBarInner = document.getElementById('rt-tab-bar-inner');
    this._indicator = document.getElementById('rt-tab-indicator');
    this._internalsTab = document.getElementById('rt-tab-internals');
    this._internalsLabel = document.getElementById('rt-internals-label');
    this._internalsChevron = document.getElementById('rt-internals-chevron');
    this._dropdown = document.getElementById('rt-internals-dropdown');
    this._phase1Overlay = document.getElementById('rt-phase1-overlay');
    this._stoppedOverlay = document.getElementById('rt-stopped-overlay');
    this._connDot = document.getElementById('rt-conn-dot');
    this._connLabel = document.getElementById('rt-conn-label');
    this._connThroughput = document.getElementById('rt-conn-throughput');
    this._connPort = document.getElementById('rt-conn-port');
    this._sidebarDot = document.getElementById('rt-sidebar-dot');
    this._sidebarLock = document.getElementById('rt-sidebar-lock');

    if (!this._tabBar) return;

    // Collect tab elements
    this._tabEls = this._tabBarInner
      ? Array.from(this._tabBarInner.querySelectorAll('.rt-tab'))
      : [];

    // Bind top-level tab clicks
    this._tabEls.forEach(el => {
      const tabId = el.dataset.tab;
      if (!tabId) return;

      if (tabId === 'internals') {
        el.addEventListener('click', (e) => {
          // Don't toggle if clicking a dropdown item
          if (e.target.closest('.rt-dd-item')) return;
          this.toggleInternals();
        });
      } else {
        el.addEventListener('click', () => this.switchTab(tabId));
      }
    });

    // Bind dropdown item clicks
    if (this._dropdown) {
      this._dropdown.querySelectorAll('.rt-dd-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const subId = item.dataset.sub;
          if (subId) this.selectInternal(subId);
        });
      });
    }

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (this._internalsOpen && !e.target.closest('.rt-tab-internals')) {
        this._closeInternals();
      }
    });

    // Phase 1 "Go to Workspace" button
    const goWsBtn = document.getElementById('rt-phase1-go-ws');
    if (goWsBtn) {
      goWsBtn.addEventListener('click', () => {
        if (window.edogSidebar) window.edogSidebar.switchView('workspace');
      });
    }

    // Keyboard: Alt+1-6 for tabs within Runtime View
    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    // PR-A: reconcile the seeded `_activeTab` (which may be a deep-link
    // from #tab=<id>, NOT the HTML-default 'logs') with the DOM. Index.html
    // hard-codes Logs as active; without this reconcile a deep-link only
    // moves the indicator and never fires the tab module's activate().
    // _applyTab is idempotent — calling it for 'logs' just no-ops on class
    // toggles and fires logs.activate() (which is itself idempotent).
    this._applyTab(this._activeTab);
  }

  /** Register a tab module. Called by main.js for each tab. */
  registerTab(tabId, module) {
    this._tabs[tabId] = {
      module: module,
      el: document.getElementById('rt-tab-' + tabId)
    };
  }

  /** Switch to a tab. Handles deactivate/activate lifecycle. */
  switchTab(tabId) {
    if (tabId === this._activeTab) return;

    // PR-A: studioState is the single source of truth for activeTab.
    // Publish first so URL/localStorage sync + any other subscribers see
    // the change. The store dedupes via shallowEqual, and the subscriber
    // in main.js no-ops when runtimeView is already on this tab — so no
    // re-entrancy loop on user-initiated clicks.
    if (window.studioState) window.studioState.set({ activeTab: tabId });

    this._applyTab(tabId);
  }

  /**
   * Apply a tab to the DOM and module lifecycle. Unguarded — callers
   * (switchTab, init) own the "is this a real change?" decision. Safe to
   * call with `tabId === this._activeTab` for initial reconcile.
   */
  _applyTab(tabId) {
    // Close Internals dropdown if switching away
    if (this._internalsOpen) this._closeInternals();

    // Deactivate previous tab module if it's actually a different tab.
    // (init() calls us with tabId === _activeTab; skip the deactivate
    // round-trip in that case so we don't fire deactivate→activate on a
    // module that was never activated.)
    const prevTab = this._activeTab;
    if (prevTab !== tabId) {
      const current = this._tabs[prevTab];
      if (current && current.module && current.module.deactivate) {
        current.module.deactivate();
      }
      if (current && current.el) current.el.classList.remove('active');
    }

    // Update tab bar active state
    this._tabEls.forEach(el => el.classList.remove('active'));

    // Determine which tab bar element to activate
    const isInternals = this._internalsIds.indexOf(tabId) !== -1;
    if (isInternals) {
      // Internals sub-view — activate the Internals tab element
      if (this._internalsTab) this._internalsTab.classList.add('active');
      this._internalsActiveId = tabId;
      this._updateInternalsLabel(tabId);
      this._updateInternalsDropdownActive(tabId);
      this._updateTabIndicator('internals');
    } else {
      // Top-level tab
      const tabEl = this._tabEls.find(el => el.dataset.tab === tabId);
      if (tabEl) tabEl.classList.add('active');
      this._internalsActiveId = null;
      this._resetInternalsLabel();
      this._updateTabIndicator(tabId);
    }

    // Activate new tab
    this._activeTab = tabId;
    const next = this._tabs[tabId];
    if (next && next.el) {
      // Reconcile content-pane active class: index.html hard-codes 'logs'
      // as active, so on a deep-link we must clear the others first.
      Object.keys(this._tabs).forEach(id => {
        const t = this._tabs[id];
        if (t && t.el && id !== tabId) t.el.classList.remove('active');
      });
      next.el.classList.add('active');
    }
    if (next && next.module && next.module.activate) {
      next.module.activate();
    }
  }

  /** Open/close Internals dropdown. */
  toggleInternals() {
    if (this._internalsOpen) {
      this._closeInternals();
    } else {
      this._openInternals();
    }
  }

  /** Select an Internals sub-view. */
  selectInternal(subId) {
    this._closeInternals();
    this.switchTab(subId);
  }

  /** Set connection status (connected/reconnecting/failed/disconnected). */
  setConnectionStatus(status, throughput) {
    this._connectionStatus = status;

    if (this._connDot) {
      this._connDot.className = 'rt-conn-dot';
      if (status === 'connected' || status === 'reconnecting' || status === 'failed') {
        this._connDot.classList.add(status);
      }
    }

    if (this._connLabel) {
      this._connLabel.className = 'rt-conn-label';
      const labels = {
        'connected': 'Connected',
        'reconnecting': 'Reconnecting...',
        'failed': 'Connection Failed',
        'disconnected': 'Disconnected',
        'connecting': 'Connecting...'
      };
      this._connLabel.textContent = labels[status] || status;
      if (status === 'connected' || status === 'reconnecting' || status === 'failed') {
        this._connLabel.classList.add(status);
      }
    }

    // Update sidebar green dot
    if (this._sidebarDot) {
      if (status === 'connected') {
        this._sidebarDot.classList.add('on');
      } else {
        this._sidebarDot.classList.remove('on');
      }
    }

    if (throughput !== undefined && this._connThroughput) {
      this._connThroughput.textContent = throughput + ' msg/s';
    }
  }

  /** Update port display. */
  setPort(port) {
    if (this._connPort && port) {
      this._connPort.textContent = 'Port: ' + port;
    }
  }

  /** Set phase (disconnected/connected). */
  setPhase(phase) {
    this._phase = phase;

    // Always re-query overlay DOM in case init() hasn't run or bailed early
    const overlay = this._phase1Overlay || document.getElementById('rt-phase1-overlay');
    const lock = this._sidebarLock || document.getElementById('rt-sidebar-lock');

    if (phase === 'connected') {
      // Hide Phase 1 overlay
      if (overlay) overlay.classList.add('hidden');
      // Hide lock on sidebar
      if (lock) lock.classList.remove('on');
      // Animate tab labels enabling with stagger
      this._tabEls.forEach((el, i) => {
        setTimeout(() => {
          el.classList.add('enabling');
          setTimeout(() => el.classList.remove('enabling'), 200);
        }, i * 100);
      });
    } else {
      // Show Phase 1 overlay
      if (overlay) overlay.classList.remove('hidden');
      // Show lock on sidebar
      if (lock) lock.classList.add('on');
      // Hide stopped overlay
      if (this._stoppedOverlay) this._stoppedOverlay.classList.remove('on');
    }
  }

  /** Show/hide service stopped overlay. */
  setServiceStopped(stopped, timestamp) {
    if (!this._stoppedOverlay) return;
    if (stopped) {
      this._stoppedOverlay.classList.add('on');
      const timeEl = document.getElementById('rt-stopped-time');
      if (timeEl && timestamp) {
        timeEl.textContent = 'Last data received at ' + timestamp;
      }
    } else {
      this._stoppedOverlay.classList.remove('on');
    }
  }

  // ── Private Methods ──

  _openInternals() {
    this._internalsOpen = true;
    if (this._dropdown) this._dropdown.classList.add('open');
    if (this._internalsChevron) this._internalsChevron.classList.add('open');
  }

  _closeInternals() {
    this._internalsOpen = false;
    if (this._dropdown) {
      this._dropdown.classList.add('closing');
      this._dropdown.classList.remove('open');
      setTimeout(() => {
        if (this._dropdown) this._dropdown.classList.remove('closing');
      }, 80);
    }
    if (this._internalsChevron) this._internalsChevron.classList.remove('open');
  }

  _updateInternalsLabel(subId) {
    if (!this._internalsLabel) return;
    const nameMap = {
      'tokens': 'Tokens',
      'caches': 'Caches',
      'http': 'HTTP Pipeline',
      'retries': 'Retries',
      'flags': 'Feature Flags',
      'di': 'DI Registry',
      'perf': 'Perf Markers'
    };
    this._internalsLabel.textContent = 'Internals: ' + (nameMap[subId] || subId);
  }

  _resetInternalsLabel() {
    if (this._internalsLabel) this._internalsLabel.textContent = 'Internals';
    this._updateInternalsDropdownActive(null);
  }

  _updateInternalsDropdownActive(subId) {
    if (!this._dropdown) return;
    this._dropdown.querySelectorAll('.rt-dd-item').forEach(item => {
      if (item.dataset.sub === subId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  /** Slide the tab indicator line to the target tab. */
  _updateTabIndicator(tabId) {
    if (!this._indicator || !this._tabBarInner) return;

    // Find the tab element — for internals sub-views, target the Internals tab
    const targetId = this._internalsIds.indexOf(tabId) !== -1 ? 'internals' : tabId;
    const tabEl = this._tabEls.find(el => el.dataset.tab === targetId);
    if (!tabEl) return;

    // Don't attempt to measure if the tab is not in a laid-out subtree.
    // offsetParent === null catches: detached nodes, display:none (self or
    // any ancestor), Phase 1 overlay covering the runtime view at boot.
    // This is the bound on the RAF retry below — if visibility never
    // resolves, we never re-enter. Whoever makes the view visible later
    // (a real switchTab on view change) re-fires the indicator update.
    if (tabEl.offsetParent === null) return;

    const barRect = this._tabBarInner.getBoundingClientRect();
    const tabRect = tabEl.getBoundingClientRect();

    // Even when offsetParent is set, width can briefly be 0 during paint
    // warmup on the first frame after DOMContentLoaded. Retry next frame.
    // Bounded by the offsetParent guard above — if the ancestor goes
    // hidden between frames, the retry bails immediately.
    if (tabRect.width === 0) {
      requestAnimationFrame(() => this._updateTabIndicator(tabId));
      return;
    }

    this._indicator.style.left = (tabRect.left - barRect.left) + 'px';
    this._indicator.style.width = tabRect.width + 'px';
  }

  /** Keyboard shortcuts: Alt+1-5 for top tabs, Alt+6 for Internals toggle. */
  _onKeyDown(e) {
    if (!e.altKey) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Only handle when Runtime View is active
    const rtPanel = document.getElementById('view-runtime');
    if (!rtPanel || !rtPanel.classList.contains('active')) return;

    const num = parseInt(e.key);
    if (num >= 1 && num <= 5) {
      e.preventDefault();
      this.switchTab(this._topTabIds[num - 1]);
    } else if (num === 6) {
      e.preventDefault();
      this.toggleInternals();
    }
  }
}
