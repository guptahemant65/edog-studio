# EDOG Studio — Robustness & Deep Performance

> **Companion to:** PERFORMANCE_ARCHITECTURE.md (the 3 shifts)
> **This doc:** Everything else that makes it unbreakable at 8 hours

---

## 1. Error Isolation — One Module Crashes, App Lives

**Problem:** One JS error in the DAG renderer takes down the entire app.

```javascript
// Error boundary per view — inspired by React but vanilla JS
class ViewBoundary {
  static wrap(viewId, initFn) {
    try {
      return initFn();
    } catch (e) {
      console.error(`[${viewId}] crashed:`, e);
      const panel = document.getElementById(`view-${viewId}`);
      if (panel) {
        panel.innerHTML = `
          <div class="view-error-state">
            <span class="error-icon">⚠</span>
            <span>${viewId} encountered an error</span>
            <button onclick="location.reload()">Reload</button>
            <pre class="error-detail">${e.message}\n${e.stack}</pre>
          </div>`;
      }
      return null;
    }
  }
}

// Usage
const dagStudio = ViewBoundary.wrap('dag', () => new DagStudio(apiClient));
const sparkInspector = ViewBoundary.wrap('spark', () => new SparkInspector(apiClient));
// If DAG crashes, Spark Inspector still works
```

---

## 2. Never Show a Blank Screen — Graceful Degradation

| Failure | Current | Robust |
|---------|---------|--------|
| No bearer token | Empty tree | Show "Authenticate to browse workspaces" + auth button |
| API returns 401 | Toast "error" | Auto-retry token refresh → retry API → only then show error |
| API returns 500 | Toast "error" | Show cached data (stale) + amber "Offline — showing cached data" badge |
| WebSocket drops | Silent reconnect | Visual indicator: "Reconnecting..." pulse in topbar |
| Proxy server down | Blank screen | Detect on first failed fetch → show "EDOG server not running — start with `edog` command" |
| Capacity host unreachable | Error | Show "FLT service not running" + "Deploy to connect" CTA |

```javascript
// Stale-while-revalidate pattern
class ResilientFetch {
  async get(url, cacheKey, options = {}) {
    const cached = this._cache.get(cacheKey);

    try {
      const fresh = await fetch(url, options);
      if (!fresh.ok) throw new Error(fresh.status);
      const data = await fresh.json();
      this._cache.set(cacheKey, { data, time: Date.now() });
      return { data, stale: false };
    } catch (e) {
      if (cached) {
        // Show stale data + visual indicator
        return { data: cached.data, stale: true, error: e };
      }
      throw e; // No cache, no data — show error state
    }
  }
}
```

---

## 3. Request Intelligence

### Deduplication
```javascript
// Two views request same workspace items → single API call
class RequestDedup {
  constructor() { this._inflight = new Map(); }

  async fetch(key, fetchFn) {
    if (this._inflight.has(key)) {
      return this._inflight.get(key); // Return existing promise
    }
    const promise = fetchFn().finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }
}
```

### Cancellation
```javascript
// Switch views → cancel in-flight requests for old view
class CancellableRequests {
  constructor() { this._controllers = new Map(); }

  forView(viewId) {
    // Cancel previous requests for this view
    this._controllers.get(viewId)?.abort();
    const controller = new AbortController();
    this._controllers.set(viewId, controller);
    return controller.signal;
  }
}

// Usage
const signal = cancellable.forView('dag');
const data = await fetch(url, { signal }); // Auto-cancelled on view switch
```

### Circuit Breaker
```javascript
// API fails 3 times → stop calling for 30s
class CircuitBreaker {
  constructor(threshold = 3, cooldownMs = 30000) {
    this._failures = new Map(); // path → { count, openedAt }
    this._threshold = threshold;
    this._cooldown = cooldownMs;
  }

  canCall(path) {
    const state = this._failures.get(path);
    if (!state || state.count < this._threshold) return true;
    if (Date.now() - state.openedAt > this._cooldown) {
      this._failures.delete(path); // Half-open: try again
      return true;
    }
    return false; // Circuit open: skip call
  }

  recordFailure(path) {
    const state = this._failures.get(path) || { count: 0, openedAt: 0 };
    state.count++;
    if (state.count >= this._threshold) state.openedAt = Date.now();
    this._failures.set(path, state);
  }

  recordSuccess(path) { this._failures.delete(path); }
}
```

### Retry with Backoff
```javascript
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return resp;
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}
```

---

## 4. State Persistence — Survive Crashes

```javascript
// Save UI state every 5s — restore on reload
class SessionState {
  constructor() {
    this._key = 'edog-session-state';
    this._debounce = null;
  }

  save(state) {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      localStorage.setItem(this._key, JSON.stringify({
        activeView: state.activeView,
        expandedWorkspaces: [...state.expanded],
        selectedItem: state.selectedItem,
        scrollPositions: state.scrollPositions,
        searchText: state.searchText,
        activeFilters: state.filters,
        timestamp: Date.now(),
      }));
    }, 2000);
  }

  restore() {
    try {
      const raw = localStorage.getItem(this._key);
      if (!raw) return null;
      const state = JSON.parse(raw);
      // Only restore if < 30 minutes old
      if (Date.now() - state.timestamp > 1800000) return null;
      return state;
    } catch { return null; }
  }
}
```

---

## 5. Deep CSS Performance

```css
/* GPU compositing for scrollable containers */
.log-scroll,
.ws-tree-content,
.ws-content-body {
  will-change: scroll-position;
  transform: translateZ(0); /* Force GPU layer */
}

/* Content visibility — browser skips rendering hidden views entirely */
.view-panel:not(.active) {
  content-visibility: hidden;  /* Not just display:none — saves layout + paint */
}

/* Contain everything — changes never leak across components */
.view-panel { contain: strict; }
.ws-tree-panel { contain: layout paint; }
.ws-content-panel { contain: layout paint; }
.ws-inspector-panel { contain: layout paint; }
.log-scroll { contain: strict; }

/* Prevent scrollbar layout shift */
.ws-tree-content,
.ws-content-body,
.log-scroll {
  scrollbar-gutter: stable;
  overflow-y: auto;
}

/* CSS layers for predictable cascade (no specificity wars) */
@layer base, layout, components, utilities;

/* Reduce paint complexity — avoid expensive properties in animated elements */
.ws-tree-item:hover {
  background: var(--surface-2); /* Simple property — cheap repaint */
  /* NEVER: box-shadow, filter, clip-path on hover for list items */
}

/* Font optimization */
@font-face {
  font-family: 'Cascadia Code';
  font-display: swap; /* Show fallback immediately, swap when loaded */
}
```

---

## 6. Network Optimization

### Parallel API Calls
```javascript
// When expanding workspace: fetch items + lakehouse details simultaneously
async _expandWorkspace(ws) {
  const [items, lakehouses] = await Promise.all([
    this._api.listWorkspaceItems(ws.id),
    this._api.listLakehouses(ws.id),  // Richer data for lakehouse nodes
  ]);
  // Merge: lakehouses have properties (oneLakePaths, sqlEndpoint) that items don't
  const enriched = items.value.map(item => {
    const lh = lakehouses.value.find(l => l.id === item.id);
    return lh ? { ...item, properties: lh.properties } : item;
  });
}
```

### Compression
```python
# dev-server.py: gzip responses
import gzip

def _serve_html(self):
    content = HTML_PATH.read_bytes()
    accept_enc = self.headers.get('Accept-Encoding', '')
    if 'gzip' in accept_enc:
        compressed = gzip.compress(content, compresslevel=6)
        self.send_response(200)
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Content-Length', str(len(compressed)))
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(compressed)  # 2.5MB → ~400KB
        return
    # Fallback: uncompressed
    ...
```

### Connection Keep-Alive
```python
# Reuse connections to redirect host (currently creates new urllib connection per request)
import urllib3

# Single pool for all Fabric API proxy calls
_pool = urllib3.HTTPSPoolManager(maxsize=10, retries=3)
```

---

## 7. Deferred Initialization

Not everything needs to run at startup:

```javascript
// Priority levels for module initialization
const INIT_IMMEDIATE = 0;  // Sidebar, topbar, active view
const INIT_IDLE = 1;       // Smart context, anomaly detector, error intel
const INIT_LAZY = 2;       // Other views (loaded on first switch)

class AppBootstrap {
  async init() {
    // Phase 1: Critical path (< 50ms)
    this.apiClient = new FabricApiClient();
    await this.apiClient.init();
    this.sidebar = new Sidebar();
    this.sidebar.init();
    this.topbar = new TopBar();
    this.topbar.init();
    await this.workspaceExplorer.init();

    // Phase 2: When idle (requestIdleCallback)
    requestIdleCallback(() => {
      this.smartContext = new SmartContextBar();
      this.errorIntel = new ErrorIntelligence();
      this.anomaly = new AnomalyDetector();
      this.commandPalette = new CommandPalette();
      this.commandPalette.init();
    });

    // Phase 3: WebSocket (non-blocking)
    setTimeout(() => this.ws.connect(), 100);
  }
}
```

---

## 8. Built-in Health Dashboard (for developers of EDOG)

```javascript
// Ctrl+Shift+P → Performance overlay (dev-only)
class PerfOverlay {
  constructor() {
    this._el = null;
    this._fps = 0;
    this._frameCount = 0;
    this._lastTime = performance.now();
  }

  show() {
    this._el = document.createElement('div');
    this._el.className = 'perf-overlay';
    this._el.style.cssText = 'position:fixed;top:0;right:0;background:rgba(0,0,0,.85);color:#0f0;' +
      'font:11px/1.3 monospace;padding:8px 12px;z-index:9999;pointer-events:none;min-width:200px';
    document.body.appendChild(this._el);
    this._tick();
  }

  _tick() {
    this._frameCount++;
    const now = performance.now();
    if (now - this._lastTime >= 1000) {
      this._fps = this._frameCount;
      this._frameCount = 0;
      this._lastTime = now;
      this._render();
    }
    requestAnimationFrame(() => this._tick());
  }

  _render() {
    const mem = performance.memory;
    const heap = mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) : '?';
    const heapTotal = mem ? (mem.totalJSHeapSize / 1048576).toFixed(0) : '?';
    const domNodes = document.querySelectorAll('*').length;
    const fpsColor = this._fps >= 55 ? '#0f0' : this._fps >= 30 ? '#ff0' : '#f00';

    this._el.innerHTML = `
      <span style="color:${fpsColor}">${this._fps} FPS</span><br>
      Heap: ${heap}/${heapTotal} MB<br>
      DOM: ${domNodes} nodes<br>
      Views loaded: ${document.querySelectorAll('script[data-loaded]').length}/6
    `;
  }
}
```

---

## Summary: The Full Stack

| Layer | Technique | Impact |
|-------|-----------|--------|
| **Parse** | Lazy view loading | 500ms → 100ms startup |
| **Compute** | Web Worker | 60fps during log bursts |
| **DOM** | Virtual rendering | <500 nodes always |
| **CSS** | Containment + content-visibility | Zero cross-view layout cost |
| **Network** | Cache + prefetch + compression | 0ms perceived for cached, 400KB wire |
| **Errors** | View boundaries + graceful degradation | Never blank screen |
| **Requests** | Dedup + cancel + circuit breaker + retry | Smart network behavior |
| **State** | Persist + restore | Survive crashes |
| **Init** | Deferred (idle callback) | Only critical path at startup |
| **GPU** | translateZ(0) on scroll containers | Hardware-accelerated scrolling |
| **Monitoring** | FPS + heap + DOM count + long task | Self-aware performance |
