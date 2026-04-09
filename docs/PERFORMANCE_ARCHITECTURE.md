# EDOG Studio — Performance Architecture

> **Status:** PROPOSED
> **Author:** Sana Reeves (Tech Lead) + Zara Okonkwo (Frontend)
> **Date:** 2026-04-09

## Current State

- Single HTML file: 435KB (12K lines) with 7 features implemented
- Projected at 44 features: ~2.5MB (70K+ lines)
- Performance targets from ENGINEERING_STANDARDS.md:
  - Initial render: < 200ms
  - Log append: < 5ms per entry
  - View switch: < 50ms
  - Memory (1h): < 200MB

## Problem

At 44 features, the single-file approach will:
- Take 300-500ms to parse 2.5MB of JS (violates 200ms render target)
- Load ALL code for ALL views at startup even though user only sees one view
- Risk memory leaks across 44 interconnected modules over 8-hour sessions
- Create layout thrashing as multiple views try to update simultaneously

## Architecture: Three Shifts

### Shift 1: Lazy View Loading

**Current:** All 44 modules parsed at startup.
**New:** Only parse the active view's code. Load other views on first access.

```
build-html.py change:
- Instead of inlining ALL JS into one <script> block
- Generate per-view <script> blocks with type="module/lazy" (custom attr)
- App bootstraps with only: state.js, api-client.js, sidebar.js, topbar.js, main.js (~80KB)
- When user clicks view 3 (DAG): dynamically inject the DAG script block
- View code is ALREADY in the HTML (single-file preserved) but not parsed until needed
```

**Implementation:**
```javascript
// In main.js — lazy view loader
class ViewLoader {
  constructor() {
    this._loaded = new Set(['workspace']); // Workspace loads immediately (default view)
    this._scripts = {}; // Pre-extracted from HTML at build time
  }

  async ensureLoaded(viewId) {
    if (this._loaded.has(viewId)) return;
    const scriptEl = document.getElementById(`view-script-${viewId}`);
    if (scriptEl) {
      // Script is in HTML but type="text/lazy" — change to execute
      const exec = document.createElement('script');
      exec.textContent = scriptEl.textContent;
      document.head.appendChild(exec);
      this._loaded.add(viewId);
    }
  }
}
```

**Result:** Initial parse: ~80KB (~50ms). Each view: 30-60KB on first access (~20ms). User never notices.

### Shift 2: Web Worker for Heavy Processing

**Current:** Log filtering, search, JSON parsing — all on main thread. Blocks rendering.
**New:** Dedicated worker for data processing. Main thread only does DOM.

```
Main Thread                          Worker Thread
─────────────                        ─────────────
WebSocket receives logs ──────────►  Parse JSON batch
                                     Filter by level/search/RAID
Render filtered entries ◄────────── Return visible entries only
                                     Update ring buffer
                                     Compute stats

User types search ─────────────────► Re-filter entire buffer
                                     (10K entries, ~2ms in worker)
Render results ◄────────────────────  Return matching indices
```

**What moves to the worker:**
- Log ring buffer (entire 10K entries live in worker)
- Filter index computation
- Text search (regex matching)
- DAG execution metric aggregation
- Capacity health data processing
- Table schema diffing

**Result:** Main thread does ZERO data processing. Only DOM manipulation. 60fps guaranteed even during 1000 logs/sec bursts.

### Shift 3: DOM Virtualization Everywhere

**Current:** Virtual scroll only for log entries.
**New:** Virtual rendering for everything with >20 items.

| Component | Current | New |
|-----------|---------|-----|
| Log entries | Virtual scroll ✓ | Keep (ring buffer + virtual scroll) |
| Workspace tree | Full DOM (all nodes) | Virtual: only render visible tree nodes |
| Table preview | Full table DOM | Virtual rows + virtual columns (50+ cols) |
| DAG nodes | Full SVG (all nodes) | Viewport culling: only render visible nodes |
| Capacity list | Full DOM | Virtual if >10 capacities |
| Feature flags | Full DOM (28 rows) | OK as-is (small dataset) |
| Command palette results | Full DOM | Virtual if >50 results |

**Implementation pattern:**
```javascript
class VirtualList {
  constructor(container, rowHeight, renderFn) {
    this._container = container;
    this._rowHeight = rowHeight;
    this._renderFn = renderFn;
    this._data = [];
    this._scrollTop = 0;
    this._visibleCount = Math.ceil(container.clientHeight / rowHeight) + 2;
    
    // Use passive scroll listener (never blocks)
    container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  _onScroll() {
    // Use rAF to batch DOM updates
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._render();
      this._rafPending = false;
    });
  }

  _render() {
    const startIdx = Math.floor(this._container.scrollTop / this._rowHeight);
    const endIdx = Math.min(startIdx + this._visibleCount, this._data.length);
    
    // Reuse existing DOM elements (object pooling)
    // Only update content, never create/destroy nodes
  }
}
```

## Additional Performance Techniques

### CSS Containment
```css
/* Isolate each view panel — changes in one panel never trigger layout in another */
.view-panel {
  contain: strict;        /* Layout + paint + size containment */
  content-visibility: auto; /* Skip rendering of off-screen views */
}

/* Isolate heavy components */
.log-scroll { contain: strict; }
.ws-tree-content { contain: layout paint; }
.dag-canvas { contain: strict; }
```

`content-visibility: auto` is massive — browser skips rendering entirely for inactive views. Free performance.

### Render Batching
```javascript
// NEVER do this:
logs.forEach(log => container.appendChild(createLogRow(log)));

// ALWAYS do this:
const fragment = document.createDocumentFragment();
logs.forEach(log => fragment.appendChild(createLogRow(log)));
container.appendChild(fragment); // Single DOM mutation
```

### API Response Caching + Prefetching
```javascript
class ApiCache {
  constructor(defaultTTL = 60000) {
    this._cache = new Map();
    this._ttl = defaultTTL;
  }

  async get(key, fetchFn, ttl = this._ttl) {
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.time < ttl) {
      return cached.data; // Instant (0ms)
    }
    const data = await fetchFn();
    this._cache.set(key, { data, time: Date.now() });
    return data;
  }

  // Prefetch: call in the background before user needs it
  prefetch(key, fetchFn) {
    if (!this._cache.has(key)) {
      fetchFn().then(data => this._cache.set(key, { data, time: Date.now() }));
    }
  }
}

// Usage: when user hovers over a workspace, prefetch its items
wsEl.addEventListener('mouseenter', () => {
  apiCache.prefetch(`items-${ws.id}`, () => api.listWorkspaceItems(ws.id));
});
// When they click, data is already cached → instant
```

### Optimistic UI
```javascript
// Rename: don't wait for API response
async _handleRename(item, newName) {
  const oldName = item.displayName;
  item.displayName = newName;      // Update immediately
  this._renderTree();               // Show new name NOW (0ms)
  this._showToast('Renamed');

  try {
    await this._api.renameWorkspace(item.id, newName);
  } catch (e) {
    item.displayName = oldName;     // Rollback on failure
    this._renderTree();
    this._showToast('Rename failed', 'error');
  }
}
```

### Memory Management
```javascript
// Enforce memory budget per module
class MemoryBudget {
  static check() {
    if (performance.memory) {
      const usedMB = performance.memory.usedJSHeapSize / 1048576;
      if (usedMB > 180) {
        // Approaching 200MB limit — trim caches
        apiCache.evictOldest(10);
        logWorker.postMessage({ type: 'trim', keepLast: 5000 });
        console.warn(`[PERF] Memory pressure: ${usedMB.toFixed(0)}MB — trimmed caches`);
      }
    }
  }
}

// Run every 60 seconds
setInterval(MemoryBudget.check, 60000);
```

### Performance Monitoring (built-in)
```javascript
// Self-monitoring — every critical path timed
class PerfMonitor {
  static mark(name) { performance.mark(name); }
  
  static measure(name, start, end) {
    performance.measure(name, start, end);
    const entry = performance.getEntriesByName(name).pop();
    if (entry.duration > 50) {
      console.warn(`[PERF] Slow: ${name} took ${entry.duration.toFixed(1)}ms`);
    }
  }

  // Long task observer — catch anything >50ms on main thread
  static init() {
    if ('PerformanceObserver' in window) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          console.warn(`[PERF] Long task: ${entry.duration.toFixed(0)}ms`);
        }
      }).observe({ entryTypes: ['longtask'] });
    }
  }
}
```

## Performance Budget

| Metric | Target | Enforcement |
|--------|--------|-------------|
| Initial JS parse | < 100ms | Lazy loading — only bootstrap (~80KB) |
| View switch | < 30ms | CSS `content-visibility` + lazy script load |
| Log append (1000/sec) | < 1ms each | Worker thread processing |
| Search across 10K logs | < 10ms | Worker thread regex |
| Memory (1h, active use) | < 150MB | Periodic budget checks + cache eviction |
| Memory (8h, heavy use) | < 200MB | Aggressive trimming at 180MB |
| DOM nodes (any view) | < 500 visible | Virtual scroll/render everywhere |
| API response (cached) | 0ms | In-memory cache with TTL |
| API response (prefetched) | 0ms | Hover-to-prefetch pattern |
| Rename/delete feedback | 0ms perceived | Optimistic UI |
| Build (build-html.py) | < 3s | Parallel CSS/JS concatenation |
| Single HTML file size | < 800KB | Code review gate |

## Implementation Priority

1. **CSS containment** (5 min) — Add `contain: strict` + `content-visibility: auto` to view panels. Instant win.
2. **Render batching** (1 hour) — DocumentFragment for all list rendering.
3. **API caching + prefetch** (2 hours) — Cache layer with hover-prefetch.
4. **Optimistic UI** (2 hours) — Rename, delete, favorites — instant feedback.
5. **Web Worker for logs** (1 day) — Move ring buffer + filtering to worker.
6. **Lazy view loading** (1 day) — Modify build-html.py for per-view script blocks.
7. **Virtual scroll everywhere** (2 days) — Shared VirtualList class for tree, tables, results.
8. **Performance monitoring** (2 hours) — PerfMonitor class + long task observer.
9. **Memory budget enforcement** (1 hour) — Periodic check + cache eviction.

## The Single-File Constraint

All of this works within the single-file constraint:
- Web Worker code is inlined as a Blob URL (no external file)
- Lazy scripts are `<script type="text/lazy" id="view-script-dag">` blocks in the same HTML
- CSS containment is just CSS properties
- Everything stays in one `edog-logs.html`

## Expected Result

| Scenario | Current | After |
|----------|---------|-------|
| Page load (7 features) | ~200ms | ~80ms |
| Page load (44 features) | ~500ms (projected) | ~100ms (lazy) |
| View switch | ~50ms | ~15ms (CSS containment) |
| Log burst (1000/sec for 10s) | Jank probable | Smooth (worker) |
| Search 10K logs | 50-100ms (blocks UI) | <10ms (worker, async) |
| Memory after 8 hours | Unknown (no monitoring) | <200MB (enforced) |
| Rename lakehouse | 500ms-2s (wait for API) | 0ms perceived (optimistic) |
| Expand workspace | 1-2s (API latency visible) | 0ms if prefetched |
