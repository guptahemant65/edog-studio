/**
 * EDOG Real-Time Log Viewer - Filter Manager
 */

// ===== SEARCH & FILTER =====

class FilterManager {
  constructor(state, renderer) {
    this.state = state;
    this.renderer = renderer;
    this.searchTimeout = null;
    this.timeFilterInterval = null;
  }
  
  setSearch = (text) => {
    // Debounce search
    clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => {
      this.setSearchImmediate(text);
    }, 300);
  }

  /**
   * #2 (2026-06-07): synchronous search application.
   *
   * On non-empty: pause stream with reason 'search', sync renderer's
   * search term, rebuild filter index, navigate to first match.
   * On empty: clear renderer's search term, drop the current match,
   * resume LIVE if the pause was search-driven.
   *
   * Used directly by the Enter / Shift+Enter keyboard wiring (and tests)
   * so the user gets immediate feedback when pressing the key. The 300ms
   * debounce above is only for the typing path.
   */
  setSearchImmediate = (text) => {
    const next = (text || '').trim();
    const prev = (this.state.searchText || '').trim();
    this.state.searchText = next;
    this.renderer.setSearchTerm(next);

    if (next) {
      // Auto-pause so new logs don't shove the viewport while reading hits.
      if (this.state.streamMode === 'LIVE') {
        this.state.streamMode = 'PAUSED';
        this.state.pauseReason = 'search';
        this.state.bufferedCount = 0;
        if (typeof this.renderer._updateStreamBadge === 'function') {
          this.renderer._updateStreamBadge();
        }
      } else if (this.state.pauseReason !== 'search') {
        // Stickier pause reason — search wins over hover/scroll so a later
        // hover-leave doesn't accidentally resume mid-search.
        this.state.pauseReason = 'search';
      }
      // Rebuild filter index synchronously so navigateMatch sees the new
      // results in this same tick. applyFilters() also schedules a render
      // which will repaint the current-match row.
      this.renderer.rerenderAllLogs();
      this.renderer.navigateMatch('first');
    } else if (prev) {
      // Cleared by user. Drop the current match and (if we paused for
      // search) resume LIVE. Hover/scroll-pauses are left alone.
      this.renderer.setSearchTerm('');
      if (this.state.pauseReason === 'search') {
        this.state.streamMode = 'LIVE';
        this.state.pauseReason = null;
        this.state.bufferedCount = 0;
        if (typeof this.renderer._updateStreamBadge === 'function') {
          this.renderer._updateStreamBadge();
        }
      }
      this.applyFilters();
    } else {
      // Idempotent re-set with empty string — still apply so any UI sync
      // happens (e.g. search-count cleared on a programmatic clear).
      this.applyFilters();
    }

    if (typeof this.renderer._updateSearchCountUi === 'function') {
      this.renderer._updateSearchCountUi();
    }
  }
  
  toggleLevel = (level) => {
    if (this.state.activeLevels.has(level)) {
      this.state.activeLevels.delete(level);
    } else {
      this.state.activeLevels.add(level);
    }
    
    // Update button visual state
    const button = document.querySelector(`[data-level="${level}"]`);
    if (button) {
      button.classList.toggle('active', this.state.activeLevels.has(level));
    }
    
    this.applyFilters();
  }
  
  setCorrelationFilter = (rootActivityId) => {
    this.state.correlationFilter = rootActivityId;
    this.showCorrelationBadge(rootActivityId);
    this.applyFilters();
  }
  
  clearCorrelationFilter = () => {
    this.state.correlationFilter = null;
    this.hideCorrelationBadge();
    this.applyFilters();
  }

  updateTimeFilter = (seconds) => {
    this.state.timeRangeSeconds = seconds;
    if (this.timeFilterInterval) clearInterval(this.timeFilterInterval);
    if (seconds > 0) {
      this.timeFilterInterval = setInterval(() => this.applyFilters(), 10000);
    }
    this.applyFilters();
  }
  
  showCorrelationBadge = (id) => {
    const badge = document.getElementById('correlation-badge');
    const idSpan = document.getElementById('correlation-id');
    if (badge && idSpan) {
      idSpan.textContent = id.substring(0, 8) + '...';
      badge.style.display = 'block';
    }
  }
  
  hideCorrelationBadge = () => {
    const badge = document.getElementById('correlation-badge');
    if (badge) {
      badge.style.display = 'none';
    }
  }
  
  applyFilters = () => {
    // PR-C: route through rAF scheduler so click bursts + subscriber-driven
    // re-renders coalesce into one frame. Fallback runs sync if the scheduler
    // module didn't load (unbundled dev, smoke tests).
    const schedule = window.scheduleRender || ((fn) => fn());
    schedule(() => this.renderer.rerenderAllLogs());
    schedule(() => this.renderer.rerenderTelemetry());
  }
  
  // Component noise filtering is owned by the BACKEND (edog-blocklist.json +
  // EdogLogInterceptor): platform chatter is dropped server-side before it is
  // ever forwarded, and Errors/Warnings are always surfaced. The frontend used
  // to ALSO apply a hardcoded FLT include-allowlist here (COMPONENT_PRESETS),
  // but that silently re-dropped genuine FLT logs and real platform errors —
  // see renderer.js::passesFilter (P0, 2026-06-10) and
  // tests/test_logs_flt_backend_owns_filtering.py. The allowlist is gone; the
  // ALL/DAG/Spark preset bar and applyPreset were already removed in #3.
  // Manual narrowing still works via the component dropdown and
  // pill-click-to-exclude (state.excludedComponents).
  
  excludeComponent = (component) => {
    this.state.excludedComponents.add(component);
    // #3: presets are gone. Just narrow within the FLT baseline.
    this.applyFilters();
  }

  clearAll = () => {
    // Clear search
    this.state.searchText = '';
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    
    // Reset levels (include all levels)
    this.state.activeLevels = new Set(['Verbose', 'Message', 'Warning', 'Error']);
    document.querySelectorAll('.level-btn').forEach(btn => {
      btn.classList.add('active');
    });
    
    // Reset component exclusions. Backend owns noise filtering; no frontend baseline.
    this.state.excludedComponents.clear();
    
    // Reset time filter
    this.updateTimeFilter(0);
    document.querySelectorAll('.time-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.range === '0');
    });
    
    // Clear correlation
    this.clearCorrelationFilter();
    
    // Re-render with all filters cleared (backend-forwarded logs all show).
    this.applyFilters();
  }
}
