/* =============================================================================
 * tab-spark.js — Spark Sessions runtime view.
 *
 * Wires the live FabricLiveTable Spark session telemetry (Created,
 * TransformSubmitted, TransformPolled, TransformCompleted, TransformCancelled,
 * Disposed) into the Spark Sessions tab UI defined by the approved Phantom
 * mock (docs/design/mocks/spark-sessions-v2.html).
 *
 * Pixel — EDOG Studio Frontend Engineer
 * =============================================================================
 */

class SparkSessionsTab {
  constructor(containerEl, signalr) {
    this.container = containerEl;
    this._signalr = signalr;

    this._sessions = new Map();
    this._rawEvents = [];

    this._filter = "all";
    this._search = "";
    this._selectedId = null;
    this._selectedTxfId = null;
    this._expanded = new Set();
    this._detailTab = "spans";
    this._live = true;
    this._swimCollapsed = true;
    this._active = false;

    this._renderRAF = 0;
    this._tickInterval = 0;
    this._debounceTimer = 0;
    this._searchDebounce = 0;

    this._boundOnEvent = this._onSparkEvent.bind(this);
    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundDocClick = this._onDocClick.bind(this);

    this._maxSessions = 200;
    this._maxPollsPerTxf = 500;
    this._maxRawEvents = 2000;
    this._renderDebounceMs = 80;

    this._buildDOM();
    this._bindStaticListeners();
    this._tooltipEl = null;

    // Subscribe to spark topic immediately so events accumulate
    // even before the tab is first activated.
    if (this._signalr) {
      this._signalr.on("spark", this._boundOnEvent);
      this._signalr.subscribeTopic("spark");
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  activate() {
    if (this._active) return;
    this._active = true;

    // SignalR subscription is done in constructor — no need to re-subscribe here

    document.addEventListener("keydown", this._boundKeyDown);
    document.addEventListener("click", this._boundDocClick);

    this._tickInterval = setInterval(() => this._tick(), 1000);

    this._scheduleRender();
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;

    // Don't unsubscribe from SignalR — events should accumulate while tab is hidden

    document.removeEventListener("keydown", this._boundKeyDown);
    document.removeEventListener("click", this._boundDocClick);

    if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = 0; }
    if (this._renderRAF) { cancelAnimationFrame(this._renderRAF); this._renderRAF = 0; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = 0; }
    if (this._searchDebounce) { clearTimeout(this._searchDebounce); this._searchDebounce = 0; }

    this._hideTooltip();
    if (this._tooltipEl && this._tooltipEl.parentNode) {
      this._tooltipEl.parentNode.removeChild(this._tooltipEl);
      this._tooltipEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  _buildDOM() {
    this.container.innerHTML = "";
    this.container.classList.add("sp-root");

    this.container.innerHTML = `
      <div class="sp-toolbar" role="toolbar" aria-label="Spark sessions toolbar">
        <div class="sp-filter-pills" role="tablist" aria-label="Status filter">
          <button class="sp-pill active" data-filter="all" role="tab" aria-selected="true">All <span class="sp-pill-count" data-count="all">0</span></button>
          <button class="sp-pill" data-filter="running" role="tab" aria-selected="false"><span class="sp-pill-dot" style="background:var(--sp-blue)"></span>Running <span class="sp-pill-count" data-count="running">0</span></button>
          <button class="sp-pill" data-filter="succeeded" role="tab" aria-selected="false"><span class="sp-pill-dot" style="background:var(--sp-green)"></span>Succeeded <span class="sp-pill-count" data-count="succeeded">0</span></button>
          <button class="sp-pill" data-filter="failed" role="tab" aria-selected="false"><span class="sp-pill-dot" style="background:var(--sp-red)"></span>Failed <span class="sp-pill-count" data-count="failed">0</span></button>
          <button class="sp-pill" data-filter="cancelled" role="tab" aria-selected="false"><span class="sp-pill-dot" style="background:var(--sp-grey)"></span>Cancelled <span class="sp-pill-count" data-count="cancelled">0</span></button>
        </div>
        <div class="sp-toolbar-sep"></div>
        <div class="sp-search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path></svg>
          <input type="text" placeholder="Search session, transform, error code…" data-role="search" />
          <span class="sp-kbd">/</span>
        </div>
        <div class="sp-spacer"></div>
        <button class="sp-live-toggle on" data-role="live">
          <span class="sp-led"></span>
          <span data-role="live-label">Live</span>
        </button>
        <div class="sp-export-wrap">
          <button class="sp-menu-btn" data-role="export">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            Export
          </button>
          <div class="sp-export-dd" data-role="export-dd">
            <button data-export="json">Export JSON</button>
            <button data-export="csv">Export CSV</button>
          </div>
        </div>
      </div>

      <div class="sp-swimlane collapsed" data-role="swimlane">
        <div class="sp-swimlane-head" data-role="swim-head">
          <svg class="sp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          <span>Timeline</span>
          <div class="sp-legend">
            <span class="sp-legend-item"><span class="sp-sw" style="background:var(--sp-blue)"></span>Running</span>
            <span class="sp-legend-item"><span class="sp-sw" style="background:var(--sp-green)"></span>Succeeded</span>
            <span class="sp-legend-item"><span class="sp-sw" style="background:var(--sp-red)"></span>Failed</span>
            <span class="sp-legend-item"><span class="sp-sw" style="background:var(--sp-grey)"></span>Cancelled</span>
          </div>
        </div>
        <div class="sp-swimlane-canvas" data-role="swim-canvas"></div>
      </div>

      <div class="sp-content" data-role="content">
        <div class="sp-list-pane" data-role="list" tabindex="0"></div>
        <div class="sp-detail-pane" data-role="detail"></div>
      </div>

      <div class="sp-footer">
        <span class="sp-kbd-hint"><span class="sp-kbd">j</span><span class="sp-kbd">k</span> navigate</span>
        <span class="sp-kbd-hint"><span class="sp-kbd">Space</span> expand</span>
        <span class="sp-kbd-hint"><span class="sp-kbd">Enter</span> detail</span>
        <span class="sp-kbd-hint"><span class="sp-kbd">Esc</span> close</span>
        <span class="sp-kbd-hint"><span class="sp-kbd">/</span> search</span>
        <div class="sp-spacer"></div>
        <span class="sp-stat"><strong data-stat="sessions">0</strong> sessions</span>
        <span class="sp-stat"><strong data-stat="transforms">0</strong> transforms</span>
        <span class="sp-stat"><strong data-stat="polls">0</strong> polls</span>
      </div>
    `;

    this._elToolbar = this.container.querySelector(".sp-toolbar");
    this._elSearch = this.container.querySelector('[data-role="search"]');
    this._elSwim = this.container.querySelector('[data-role="swimlane"]');
    this._elSwimHead = this.container.querySelector('[data-role="swim-head"]');
    this._elSwimCanvas = this.container.querySelector('[data-role="swim-canvas"]');
    this._elContent = this.container.querySelector('[data-role="content"]');
    this._elList = this.container.querySelector('[data-role="list"]');
    this._elDetail = this.container.querySelector('[data-role="detail"]');
    this._elLiveBtn = this.container.querySelector('[data-role="live"]');
    this._elExportBtn = this.container.querySelector('[data-role="export"]');
    this._elExportDD = this.container.querySelector('[data-role="export-dd"]');
  }

  _bindStaticListeners() {
    this._elToolbar.addEventListener("click", (e) => {
      const pill = e.target.closest(".sp-pill");
      if (pill) {
        this._filter = pill.dataset.filter;
        this._elToolbar.querySelectorAll(".sp-pill").forEach((p) => {
          const on = p === pill;
          p.classList.toggle("active", on);
          p.setAttribute("aria-selected", on ? "true" : "false");
        });
        this._scheduleRender();
        return;
      }
      if (e.target.closest('[data-role="live"]')) {
        this._live = !this._live;
        this._elLiveBtn.classList.toggle("on", this._live);
        this._elLiveBtn.querySelector('[data-role="live-label"]').textContent = this._live ? "Live" : "Paused";
        if (this._live) this._scheduleRender();
        return;
      }
      if (e.target.closest('[data-role="export"]')) {
        e.stopPropagation();
        this._elExportDD.classList.toggle("open");
        return;
      }
      const exportBtn = e.target.closest("[data-export]");
      if (exportBtn) {
        this._elExportDD.classList.remove("open");
        if (exportBtn.dataset.export === "json") this._exportJSON();
        else this._exportCSV();
        return;
      }
    });

    this._elSearch.addEventListener("input", (e) => {
      const v = e.target.value || "";
      if (this._searchDebounce) clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => {
        this._search = v.toLowerCase().trim();
        this._scheduleRender();
      }, 120);
    });
    this._elSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.target.value = ""; this._search = ""; e.target.blur(); this._scheduleRender(); }
    });

    this._elSwimHead.addEventListener("click", () => {
      this._swimCollapsed = !this._swimCollapsed;
      this._elSwim.classList.toggle("collapsed", this._swimCollapsed);
    });

    this._elList.addEventListener("click", (e) => this._onListClick(e));
    this._elList.addEventListener("mouseover", (e) => this._onHoverIn(e));
    this._elList.addEventListener("mouseout", (e) => this._onHoverOut(e));

    this._elSwimCanvas.addEventListener("click", (e) => {
      const bar = e.target.closest(".sp-bar");
      if (bar && bar.dataset.id) this._openDetail(bar.dataset.id);
    });
    this._elSwimCanvas.addEventListener("mouseover", (e) => this._onHoverIn(e));
    this._elSwimCanvas.addEventListener("mouseout", (e) => this._onHoverOut(e));

    this._elDetail.addEventListener("click", (e) => this._onDetailClick(e));
    this._elDetail.addEventListener("mouseover", (e) => this._onHoverIn(e));
    this._elDetail.addEventListener("mouseout", (e) => this._onHoverOut(e));
  }

  _onDocClick(e) {
    if (!this._elExportDD.classList.contains("open")) return;
    if (e.target.closest(".sp-export-wrap")) return;
    this._elExportDD.classList.remove("open");
  }

  // ---------------------------------------------------------------------------
  // Event ingestion
  // ---------------------------------------------------------------------------

  _onSparkEvent(envelope) {
    if (!envelope) return;
    const data = envelope.data || envelope;
    const kind = data.event || envelope.event;
    if (!kind) return;

    if (this._rawEvents.length >= this._maxRawEvents) this._rawEvents.shift();
    this._rawEvents.push({ at: Date.now(), kind, sid: data.sessionTrackingId, data });

    switch (kind) {
      case "Created": this._onCreated(data); break;
      case "Error": this._onError(data); break;
      case "TransformSubmitted": this._onSubmitted(data); break;
      case "TransformPolled": this._onPolled(data); break;
      case "TransformCompleted": this._onCompleted(data); break;
      case "TransformCancelled": this._onCancelled(data); break;
      case "Disposed": this._onDisposed(data); break;
      default: break;
    }

    if (this._live) this._scheduleRender();
  }

  _onCreated(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    // Don't create a session card yet — the GTS session doesn't exist until
    // TransformSubmitted returns with a gtsSessionId. Store factory metadata
    // so _onSubmitted can merge it when the real session is confirmed.
    if (!this._pendingCreated) this._pendingCreated = new Map();
    this._pendingCreated.set(sid, {
      iterationId: d.iterationId,
      tenantId: d.tenantId,
      workspaceId: d.workspaceId,
      workspaceName: d.workspaceName,
      artifactId: d.artifactId,
      artifactName: d.artifactName,
      createdDurationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
      warm: (typeof d.durationMs === "number" ? d.durationMs : 0) < 100,
      createError: d.error || null,
      createdAt: Date.now(),
      rawEvent: d,
    });
    // If factory failed, show the error immediately as a session
    if (d.error) {
      const s = this._getOrCreateSession(sid);
      this._mergePendingCreated(s, sid);
      s._sessionRawEvents.push({ at: Date.now(), kind: "Created", data: d });
      this._recomputeStatus(s);
    }
  }

  _onError(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    const s = this._getOrCreateSession(sid);
    this._mergePendingCreated(s, sid);
    s.createError = d.error || "Unknown factory error";
    s.errorType = d.errorType || null;
    s.errorStack = d.stackTrace || null;
    s.disposed = true;
    s.disposedAt = Date.now();
    s._sessionRawEvents.push({ at: Date.now(), kind: "Error", data: d });
    this._recomputeStatus(s);
  }

  /** Merge pending Created metadata into session when first TransformSubmitted arrives */
  _mergePendingCreated(s, sid) {
    if (!this._pendingCreated || !this._pendingCreated.has(sid)) return;
    const p = this._pendingCreated.get(sid);
    s.iterationId = p.iterationId || s.iterationId;
    s.tenantId = p.tenantId || s.tenantId;
    s.workspaceId = p.workspaceId || s.workspaceId;
    s.workspaceName = p.workspaceName || s.workspaceName;
    s.artifactId = p.artifactId || s.artifactId;
    s.artifactName = p.artifactName || s.artifactName;
    s.createdDurationMs = p.createdDurationMs;
    s.warm = p.warm;
    s.createError = p.createError;
    s.startedAt = p.createdAt;
    s._sessionRawEvents.push({ at: p.createdAt, kind: "Created", data: p.rawEvent });
    this._pendingCreated.delete(sid);
  }

  _onSubmitted(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    const s = this._getOrCreateSession(sid);
    // Merge factory metadata from Created event (if we haven't already)
    this._mergePendingCreated(s, sid);
    const t = this._getOrCreateTransform(s, d.transformationId);
    const now = Date.now();
    t.name = d.nodeName || t.name;
    t.nodeId = d.nodeId || t.nodeId;
    t.nodeKind = (d.nodeKind || t.nodeKind || "").toLowerCase();
    t.refreshMode = d.refreshMode || t.refreshMode;
    t.gts = d.gtsSessionId || t.gts;
    t.replId = d.replId || t.replId;
    t.state = d.state || "Submitted";
    t.submittedAt = now;
    t.submitDurationMs = typeof d.durationMs === "number" ? d.durationMs : t.submitDurationMs;
    t.retriable = !!d.retriable;
    t.retryAfterMs = d.retryAfterMs ?? null;
    if (d.error) t.submitError = d.error;
    if (t.gts) {
      if (!s.gtsRepls.has(t.gts)) s.gtsRepls.set(t.gts, new Set());
      if (t.replId) s.gtsRepls.get(t.gts).add(t.replId);
    }
    s._sessionRawEvents.push({ at: now, kind: "TransformSubmitted", data: d });
    this._recomputeStatus(s);
  }

  _onPolled(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    const s = this._getOrCreateSession(sid);
    const t = this._getOrCreateTransform(s, d.transformationId);
    const now = Date.now();
    const prev = t.state;
    t.previousState = d.previousState || prev;
    t.state = d.state || t.state;
    t.polls.push({
      at: now,
      state: t.state,
      previousState: t.previousState,
      stateChanged: !!d.stateChanged,
      durationMs: d.durationMs,
      retryAfterMs: d.retryAfterMs,
    });
    if (t.polls.length > this._maxPollsPerTxf) {
      t.polls.splice(0, t.polls.length - this._maxPollsPerTxf);
    }
    s._sessionRawEvents.push({ at: now, kind: "TransformPolled", data: d });
    this._recomputeStatus(s);
  }

  _onCompleted(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    const s = this._getOrCreateSession(sid);
    const t = this._getOrCreateTransform(s, d.transformationId);
    const now = Date.now();
    t.state = d.state || t.state;
    t.terminalState = d.state || null;
    t.completedAt = now;
    t.completeDurationMs = typeof d.durationMs === "number" ? d.durationMs : null;
    if (d.state === "Succeeded") {
      t.refreshOutput = {
        refreshPolicy: d.refreshPolicy || null,
        totalRowsProcessed: d.totalRowsProcessed ?? null,
        totalRowsDropped: d.totalRowsDropped ?? null,
        mlvNamespace: d.mlvNamespace || null,
        mlvName: d.mlvName || null,
        mlvId: d.mlvId || null,
        refreshTimestamp: d.refreshTimestamp || null,
        outputMessage: d.outputMessage || null,
        totalViolations: d.totalViolations ?? 0,
        violationsPerConstraint: d.violationsPerConstraint || null,
      };
    } else if (d.state === "Failed") {
      t.error = {
        code: d.errorCode || null,
        message: d.errorMessage || null,
        source: d.errorSource || null,
        stage: d.errorStage || null,
        stackTrace: Array.isArray(d.stackTrace) ? d.stackTrace : null,
        retriable: !!d.retriable,
        retryAfterMs: d.retryAfterMs ?? null,
      };
    }
    s._sessionRawEvents.push({ at: now, kind: "TransformCompleted", data: d });
    this._recomputeStatus(s);
  }

  _onCancelled(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    const s = this._getOrCreateSession(sid);
    const t = this._getOrCreateTransform(s, d.transformationId);
    const now = Date.now();
    t.state = d.state || "Cancelled";
    t.terminalState = "Cancelled";
    t.completedAt = now;
    t.completeDurationMs = typeof d.durationMs === "number" ? d.durationMs : null;
    if (d.error) {
      t.error = { code: null, message: d.error, source: null, stage: null, stackTrace: null, retriable: false, retryAfterMs: d.retryAfterMs ?? null };
    }
    s._sessionRawEvents.push({ at: now, kind: "TransformCancelled", data: d });
    this._recomputeStatus(s);
  }

  _onDisposed(d) {
    const sid = d.sessionTrackingId;
    if (!sid) return;
    const s = this._getOrCreateSession(sid);
    const now = Date.now();
    s.disposed = true;
    s.disposedAt = now;
    s.lifetimeMs = typeof d.lifetimeMs === "number" ? d.lifetimeMs : (now - (s.startedAt || now));
    s.transformCount = typeof d.transformCount === "number" ? d.transformCount : s.transforms.length;
    s.lastState = d.lastState || s.lastState;
    s._sessionRawEvents.push({ at: now, kind: "Disposed", data: d });
    this._recomputeStatus(s);
  }

  _getOrCreateSession(id) {
    let s = this._sessions.get(id);
    if (s) return s;
    s = {
      id,
      iterationId: null,
      tenantId: null,
      workspaceId: null,
      workspaceName: null,
      artifactId: null,
      artifactName: null,
      status: "running",
      startedAt: Date.now(),
      createdDurationMs: 0,
      warm: false,
      createError: null,
      transforms: [],
      _txfIdx: new Map(),
      gtsRepls: new Map(),
      lastState: null,
      disposed: false,
      disposedAt: null,
      lifetimeMs: null,
      transformCount: null,
      _sessionRawEvents: [],
    };
    this._sessions.set(id, s);
    return s;
  }

  _getOrCreateTransform(session, txfId) {
    if (!txfId) txfId = `_anon_${session.transforms.length + 1}`;
    let t = session._txfIdx.get(txfId);
    if (t) return t;
    t = {
      id: txfId,
      name: txfId,
      nodeId: null,
      nodeKind: "",
      refreshMode: null,
      gts: null,
      replId: null,
      state: "Submitted",
      previousState: null,
      terminalState: null,
      submittedAt: Date.now(),
      submitDurationMs: null,
      completedAt: null,
      completeDurationMs: null,
      polls: [],
      retriable: false,
      retryAfterMs: null,
      refreshOutput: null,
      error: null,
      submitError: null,
    };
    session.transforms.push(t);
    session._txfIdx.set(txfId, t);
    return t;
  }

  _recomputeStatus(s) {
    const txs = s.transforms;
    if (txs.length === 0) {
      s.status = s.disposed ? this._statusFromLastState(s.lastState) : "running";
      return;
    }
    const anyFailed = txs.some((t) => t.terminalState === "Failed");
    const allTerminal = txs.every((t) => !!t.terminalState);
    const anySucceeded = txs.some((t) => t.terminalState === "Succeeded");
    const allCancelled = allTerminal && txs.every((t) => t.terminalState === "Cancelled");
    if (anyFailed) { s.status = "failed"; return; }
    if (allTerminal && allCancelled) { s.status = "cancelled"; return; }
    if (allTerminal && anySucceeded) { s.status = "succeeded"; return; }
    if (s.disposed) {
      const anyRunning = txs.some((t) => !t.terminalState);
      if (!anyRunning) { s.status = this._statusFromLastState(s.lastState); return; }
    }
    s.status = "running";
  }

  _statusFromLastState(state) {
    if (!state) return "succeeded";
    const lower = String(state).toLowerCase();
    if (lower.includes("fail") || lower.includes("error")) return "failed";
    if (lower.includes("cancel")) return "cancelled";
    return "succeeded";
  }

  _pruneOldest() {
    if (this._sessions.size <= this._maxSessions) return;
    const arr = Array.from(this._sessions.values()).sort((a, b) => a.startedAt - b.startedAt);
    while (arr.length > this._maxSessions) {
      const drop = arr.shift();
      this._sessions.delete(drop.id);
      if (this._selectedId === drop.id) { this._selectedId = null; this._selectedTxfId = null; }
      this._expanded.delete(drop.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Render scheduling
  // ---------------------------------------------------------------------------

  _scheduleRender() {
    if (!this._active) return;
    if (this._renderRAF) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = 0;
      this._renderRAF = requestAnimationFrame(() => {
        this._renderRAF = 0;
        this._renderAll();
      });
    }, this._renderDebounceMs);
  }

  _tick() {
    let anyRunning = false;
    for (const s of this._sessions.values()) { if (s.status === "running") { anyRunning = true; break; } }
    if (!anyRunning) return;
    if (this._live) this._scheduleRender();
  }

  _renderAll() {
    const sessions = this._sortedSessions();
    const visible = this._filterSessions(sessions);
    this._renderToolbarCounts(sessions);
    this._renderSwimlane(visible);
    this._renderCards(visible);
    if (this._selectedId) this._renderDetail();
    this._renderFooter(sessions);
  }

  _sortedSessions() {
    return Array.from(this._sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  _filterSessions(sessions) {
    const f = this._filter;
    const q = this._search;
    return sessions.filter((s) => {
      if (f !== "all" && s.status !== f) return false;
      if (!q) return true;
      if (s.id.toLowerCase().includes(q)) return true;
      if (s.artifactName && s.artifactName.toLowerCase().includes(q)) return true;
      if (s.workspaceName && s.workspaceName.toLowerCase().includes(q)) return true;
      for (const t of s.transforms) {
        if (t.name && t.name.toLowerCase().includes(q)) return true;
        if (t.error && t.error.code && t.error.code.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }

  _renderToolbarCounts(sessions) {
    const counts = { all: sessions.length, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const s of sessions) counts[s.status] = (counts[s.status] || 0) + 1;
    for (const k of Object.keys(counts)) {
      const el = this._elToolbar.querySelector(`[data-count="${k}"]`);
      if (el) el.textContent = String(counts[k]);
    }
  }

  _renderFooter(sessions) {
    let txfCount = 0;
    let pollCount = 0;
    for (const s of sessions) {
      txfCount += s.transforms.length;
      for (const t of s.transforms) pollCount += t.polls.length;
    }
    const set = (k, v) => {
      const el = this.container.querySelector(`[data-stat="${k}"]`);
      if (el) el.textContent = String(v);
    };
    set("sessions", sessions.length);
    set("transforms", txfCount);
    set("polls", pollCount);
  }

  // ---------------------------------------------------------------------------
  // Swimlane
  // ---------------------------------------------------------------------------

  _renderSwimlane(visible) {
    if (visible.length === 0) {
      this._elSwimCanvas.innerHTML = `<div class="sp-empty" style="padding:18px;font-size:11px;">No sessions to display.</div>`;
      return;
    }
    const lanes = visible.slice(0, 8);
    const overflow = visible.length - lanes.length;
    const now = Date.now();
    const earliest = Math.min(...lanes.map((s) => s.startedAt));
    const latest = Math.max(now, ...lanes.map((s) => s.disposed && s.disposedAt ? s.disposedAt : now));
    const span = Math.max(latest - earliest, 1);

    const ticks = this._axisTicks(span);
    const tickHtml = ticks.map((t) => {
      const pct = (t / span) * 100;
      return `<div class="sp-tick" style="left:${pct.toFixed(2)}%"></div><div class="sp-tick-label" style="left:${pct.toFixed(2)}%">+${this._fmtDuration(t)}</div>`;
    }).join("");

    let html = "";
    for (const s of lanes) {
      const start = ((s.startedAt - earliest) / span) * 100;
      const end = (((s.disposed && s.disposedAt ? s.disposedAt : now) - earliest) / span) * 100;
      const width = Math.max(end - start, 0.6);
      const cls = s.status === "running" ? "in-progress" : s.status;
      const selected = s.id === this._selectedId ? " selected" : "";
      const elapsed = (s.disposed && s.disposedAt ? s.disposedAt : now) - s.startedAt;
      const tt = `${this._esc(s.artifactName || s.id)} · ${s.status} · ${this._fmtDuration(elapsed)}`;
      html += `
        <div class="sp-lane">
          <div class="sp-lane-label">
            <span class="sp-lane-dot" style="background:${this._statusColor(s.status)}"></span>
            <span>${this._esc(this._shortId(s.id))}</span>
            <span class="sp-lane-meta">${this._esc((s.artifactName || "").slice(0, 18))}</span>
          </div>
          <div class="sp-lane-track">
            <div class="sp-lane-grid"></div>
            <div class="sp-bar ${cls}${selected}" data-id="${this._esc(s.id)}" data-tt="${this._esc(tt)}" style="left:${start.toFixed(2)}%;width:${width.toFixed(2)}%">
              <span class="sp-bar-label">${this._esc(this._shortId(s.id))} · ${this._fmtDuration(elapsed)}</span>
            </div>
          </div>
        </div>`;
    }
    html += `<div class="sp-lane-axis">${tickHtml}</div>`;
    if (overflow > 0) {
      html += `<div class="sp-lane-overflow">+${overflow} more session${overflow > 1 ? "s" : ""}</div>`;
    }
    this._elSwimCanvas.innerHTML = html;
  }

  _axisTicks(spanMs) {
    const targets = 5;
    const raw = spanMs / targets;
    const steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    let step = steps[0];
    for (const s of steps) { if (s >= raw) { step = s; break; } step = s; }
    const out = [];
    for (let t = 0; t <= spanMs; t += step) out.push(t);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------

  _renderCards(visible) {
    if (visible.length === 0) {
      this._elList.innerHTML = this._emptyState();
      return;
    }
    const now = Date.now();
    let html = "";
    for (const s of visible) html += this._renderCardHtml(s, now);
    this._elList.innerHTML = html;
  }

  _emptyState() {
    return `
      <div class="sp-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <div class="sp-empty-title">No Spark sessions yet</div>
        <div class="sp-empty-sub">Sessions will appear here as your FabricLiveTable workload runs.</div>
      </div>`;
  }

  _renderCardHtml(s, now) {
    const elapsed = (s.disposed && s.disposedAt ? s.disposedAt : now) - s.startedAt;
    const live = s.status === "running";
    const selected = s.id === this._selectedId ? " selected" : "";
    const expanded = this._expanded.has(s.id) ? " expanded" : "";
    const failedTxf = s.transforms.find((t) => t.terminalState === "Failed");

    const warmBadge = s.warm
      ? `<span class="sp-warm-badge" data-tt="Warm reuse (${this._fmtDuration(s.createdDurationMs || 0)})">● Warm</span>`
      : s.createdDurationMs >= 100
        ? `<span class="sp-warm-badge cold" data-tt="Cold start (${this._fmtDuration(s.createdDurationMs)})">Cold</span>`
        : "";

    const lcPct = live ? Math.min(95, (elapsed / Math.max(elapsed, 60000)) * 100) : 100;
    const markers = s.transforms.map((t) => {
      const at = ((t.submittedAt - s.startedAt) / Math.max(elapsed, 1)) * 100;
      const cls = t.terminalState === "Failed" ? " error" : "";
      return `<div class="sp-lc-marker${cls}" style="left:${Math.max(0, Math.min(100, at)).toFixed(2)}%"></div>`;
    }).join("");

    let gtsHtml = "";
    for (const [gtsId, repls] of s.gtsRepls.entries()) {
      const color = this._hashColor(gtsId);
      gtsHtml += `<div class="sp-gts-chip" data-tt="GTS ${this._esc(gtsId)} · ${repls.size} REPL${repls.size === 1 ? "" : "s"}">
        <span class="sp-gts-dot" style="background:${color}"></span>
        <span>${this._esc(this._shortId(gtsId, 10))}</span>
        <span class="sp-gts-count">${repls.size}</span>
      </div>`;
    }

    let txfHtml = "";
    for (const t of s.transforms) txfHtml += this._renderTransformRowHtml(s, t, now);

    let errorChip = "";
    if (failedTxf && failedTxf.error) {
      errorChip = `
        <div class="sp-error-chip" data-action="open-error" data-sid="${this._esc(s.id)}" data-tid="${this._esc(failedTxf.id)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          ${failedTxf.error.code ? `<span class="sp-err-code">${this._esc(failedTxf.error.code)}</span>` : ""}
          <span class="sp-err-msg">${this._esc(failedTxf.error.message || "Transform failed")}</span>
        </div>`;
    }

    return `
      <div class="sp-card s-${s.status}${selected}${expanded}" data-sid="${this._esc(s.id)}">
        <div class="sp-card-rail"></div>
        <div class="sp-card-head" data-action="select">
          <div class="sp-status-icon">${this._statusIconSvg(s.status)}</div>
          <div style="flex:1;min-width:0;">
            <div class="sp-session-id">${this._highlight(this._shortId(s.id))}</div>
            <div class="sp-session-meta">
              <span class="sp-artifact">${this._highlight(s.artifactName || "—")}</span>
              <span class="sp-sep">·</span>
              <span>${this._esc(s.workspaceName || "—")}</span>
              <span class="sp-sep">·</span>
              <span>${s.transforms.length} txf${s.transforms.length === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div class="sp-card-head-right">
            ${warmBadge}
            <span class="sp-elapsed${live ? " live" : ""}" data-elapsed="${s.id}">${this._fmtElapsed(elapsed, live)}</span>
            <button class="sp-expand-btn" data-action="toggle-expand" data-sid="${this._esc(s.id)}" title="Toggle transforms">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        </div>
        <div class="sp-lifecycle">
          <div class="sp-lc-fill" style="width:${lcPct.toFixed(2)}%"></div>
          <div class="sp-lc-markers">${markers}</div>
        </div>
        ${gtsHtml ? `<div class="sp-gts-strip">${gtsHtml}</div>` : ""}
        ${errorChip}
        <div class="sp-transform-list">${txfHtml}</div>
      </div>`;
  }

  _renderTransformRowHtml(s, t, now) {
    const selected = (this._selectedId === s.id && this._selectedTxfId === t.id) ? " selected" : "";
    const dur = t.completedAt ? (t.completedAt - t.submittedAt) : (now - t.submittedAt);
    const stateLabel = t.terminalState || t.state || "—";
    const stateCls = this._stateBadgeClass(t);
    const live = !t.terminalState;
    const kind = (t.nodeKind || "").toLowerCase();
    const kindCls = kind.startsWith("py") ? "py" : (kind === "sql" ? "sql" : "");
    const kindLetter = kind.startsWith("py") ? "py" : (kind === "sql" ? "SQ" : "?");
    const rmBadge = t.refreshMode ? `<span class="sp-rm-badge ${this._rmClass(t.refreshMode)}" data-tt="Refresh: ${this._esc(t.refreshMode)}">${this._esc(this._rmShort(t.refreshMode))}</span>` : "";
    const stripHtml = this._stateStripHtml(t);

    return `
      <div class="sp-transform-row${selected}" data-action="select-txf" data-sid="${this._esc(s.id)}" data-tid="${this._esc(t.id)}">
        <div class="sp-t-icon ${kindCls}">${this._esc(kindLetter)}</div>
        <div class="sp-t-name">${rmBadge}${this._highlight(t.name)} <span class="sp-t-id">#${this._esc(this._shortId(t.id, 6))}</span></div>
        <div class="sp-state-strip" data-tt="${this._esc(stateLabel)}">${stripHtml}</div>
        <div class="sp-t-state-label">${live ? `<span class="sp-pulse" style="background:${this._stateColor(t)}"></span>` : ""}<span class="${stateCls}">${this._esc(stateLabel)}</span></div>
        <div class="sp-t-duration">${this._fmtDuration(dur)}</div>
      </div>`;
  }

  _stateStripHtml(t) {
    if (t.terminalState === "Succeeded") return `<div class="sp-seg s-init" style="width:25%"></div><div class="sp-seg s-exec" style="width:50%"></div><div class="sp-seg s-final-ok" style="width:25%"></div>`;
    if (t.terminalState === "Failed") return `<div class="sp-seg s-init" style="width:30%"></div><div class="sp-seg s-final-err" style="width:70%"></div>`;
    if (t.terminalState === "Cancelled") return `<div class="sp-seg s-init" style="width:35%"></div><div class="sp-seg s-final-cancel" style="width:65%"></div>`;
    const st = (t.state || "").toLowerCase();
    if (st.includes("cleanup")) return `<div class="sp-seg s-init" style="width:25%"></div><div class="sp-seg s-exec" style="width:55%"></div><div class="sp-seg s-cleanup" style="width:20%"></div>`;
    if (st.includes("exec") || st.includes("inprogress")) return `<div class="sp-seg s-init" style="width:25%"></div><div class="sp-seg s-exec" style="width:55%"></div>`;
    if (st.includes("init")) return `<div class="sp-seg s-init" style="width:60%"></div>`;
    return `<div class="sp-seg s-init" style="width:30%"></div>`;
  }

  _stateColor(t) {
    if (t.terminalState === "Failed") return "var(--sp-red)";
    if (t.terminalState === "Cancelled") return "var(--sp-grey)";
    if (t.terminalState === "Succeeded") return "var(--sp-green)";
    const st = (t.state || "").toLowerCase();
    if (st.includes("cleanup")) return "var(--sp-teal)";
    if (st.includes("exec") || st.includes("inprogress")) return "var(--sp-purple)";
    return "var(--sp-blue)";
  }

  _stateBadgeClass() { return "sp-mono"; }

  _rmShort(rm) {
    const v = (rm || "").toLowerCase();
    if (v.startsWith("opt")) return "opt";
    if (v.startsWith("full")) return "full";
    if (v.startsWith("inc")) return "inc";
    return v.slice(0, 4) || "—";
  }

  _rmClass(rm) {
    const v = (rm || "").toLowerCase();
    if (v.startsWith("opt")) return "rm-optimal";
    if (v.startsWith("full")) return "rm-full";
    if (v.startsWith("inc")) return "rm-incremental";
    return "";
  }

  // ---------------------------------------------------------------------------
  // List interactions
  // ---------------------------------------------------------------------------

  _onListClick(e) {
    const errChip = e.target.closest('[data-action="open-error"]');
    if (errChip) {
      const sid = errChip.dataset.sid;
      const tid = errChip.dataset.tid;
      this._selectedId = sid;
      this._selectedTxfId = tid;
      this._detailTab = "error";
      this._scheduleRender();
      return;
    }
    const toggleBtn = e.target.closest('[data-action="toggle-expand"]');
    if (toggleBtn) {
      const sid = toggleBtn.dataset.sid;
      if (this._expanded.has(sid)) this._expanded.delete(sid); else this._expanded.add(sid);
      this._scheduleRender();
      return;
    }
    const txfRow = e.target.closest('[data-action="select-txf"]');
    if (txfRow) {
      this._selectedId = txfRow.dataset.sid;
      this._selectedTxfId = txfRow.dataset.tid;
      this._detailTab = "spans";
      this._scheduleRender();
      return;
    }
    const card = e.target.closest(".sp-card");
    if (card) {
      this._openDetail(card.dataset.sid);
    }
  }

  _openDetail(sid) {
    this._selectedId = sid;
    this._selectedTxfId = null;
    this._detailTab = "spans";
    this._expanded.add(sid);
    this._scheduleRender();
  }

  _closeDetail() {
    this._selectedId = null;
    this._selectedTxfId = null;
    this._elContent.classList.remove("has-detail");
    this._elDetail.innerHTML = "";
    this._scheduleRender();
  }

  _onDetailClick(e) {
    if (e.target.closest('[data-action="close-detail"]')) { this._closeDetail(); return; }
    const tab = e.target.closest(".sp-dtab");
    if (tab && tab.dataset.dtab) {
      this._detailTab = tab.dataset.dtab;
      this._renderDetail();
      return;
    }
    const wfRow = e.target.closest('[data-action="select-txf-wf"]');
    if (wfRow) {
      this._selectedTxfId = wfRow.dataset.tid;
      this._renderDetail();
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Detail panel
  // ---------------------------------------------------------------------------

  _renderDetail() {
    const s = this._sessions.get(this._selectedId);
    if (!s) { this._closeDetail(); return; }
    this._elContent.classList.add("has-detail");
    const t = this._selectedTxfId ? s._txfIdx.get(this._selectedTxfId) : (s.transforms[0] || null);

    const now = Date.now();
    const elapsed = (s.disposed && s.disposedAt ? s.disposedAt : now) - s.startedAt;
    const live = s.status === "running";

    const hasError = !!(t && t.error) || !!s.createError;
    const hasOutput = !!(t && t.refreshOutput);

    const tabs = [
      { id: "spans", label: "Spans", count: s.transforms.length },
      { id: "state", label: "State", count: t ? t.polls.length : 0 },
      { id: "polls", label: "Polls", count: t ? t.polls.length : 0 },
      { id: "repls", label: "REPLs", count: this._totalRepls(s) },
      { id: "output", label: "Output", count: hasOutput ? 1 : 0, dim: !hasOutput },
      { id: "error", label: "Error", count: hasError ? 1 : 0, dim: !hasError, dot: hasError },
      { id: "raw", label: "Raw", count: s._sessionRawEvents.length },
    ];

    this._elDetail.innerHTML = `
      <div class="sp-detail-head">
        <div class="sp-detail-head-row">
          <div class="sp-status-icon" style="background:${this._statusColor(s.status)}">${this._statusIconSvg(s.status)}</div>
          <div style="flex:1;min-width:0;">
            <div class="sp-session-id">${this._esc(this._shortId(s.id, 16))}</div>
            <div class="sp-session-meta">${this._esc(s.artifactName || "—")} · ${this._esc(s.workspaceName || "—")}</div>
          </div>
          <span class="sp-elapsed${live ? " live" : ""}">${this._fmtElapsed(elapsed, live)}</span>
          <button class="sp-detail-close" data-action="close-detail" title="Close (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
      <div class="sp-detail-meta">
        ${this._metaCellHtml("Session", this._shortId(s.id, 16), s.id)}
        ${this._metaCellHtml("Iteration", s.iterationId ? this._shortId(s.iterationId, 12) : "—", s.iterationId || "")}
        ${this._metaCellHtml("Artifact", s.artifactName || "—", s.artifactId || "")}
        ${this._metaCellHtml("Workspace", s.workspaceName || "—", s.workspaceId || "")}
      </div>
      <div class="sp-detail-tabs">
        ${tabs.map((tb) => `<button class="sp-dtab${this._detailTab === tb.id ? " active" : ""}${tb.dim ? " dim" : ""}" data-dtab="${tb.id}">
          ${tb.dot ? `<span class="sp-dtab-dot"></span>` : ""}${tb.label}${tb.count > 0 ? `<span class="sp-dtab-count">${tb.count}</span>` : ""}
        </button>`).join("")}
      </div>
      <div class="sp-detail-body" data-role="dbody"></div>
    `;
    this._renderDetailBody(s, t);
  }

  _metaCellHtml(label, value, full) {
    const tt = full ? ` data-tt="${this._esc(full)}"` : "";
    return `<div class="sp-meta-cell"${tt}><div class="sp-meta-label">${label}</div><div class="sp-meta-value">${this._esc(value)}</div></div>`;
  }

  _totalRepls(s) {
    let n = 0;
    for (const r of s.gtsRepls.values()) n += r.size;
    return n;
  }

  _renderDetailBody(s, t) {
    const body = this._elDetail.querySelector('[data-role="dbody"]');
    if (!body) return;
    switch (this._detailTab) {
      case "spans": body.innerHTML = this._renderSpansHtml(s); break;
      case "state": body.innerHTML = this._renderStateMachineHtml(s, t); break;
      case "polls": body.innerHTML = this._renderPollLogHtml(s, t); break;
      case "repls": body.innerHTML = this._renderReplMapHtml(s); break;
      case "output": body.innerHTML = this._renderOutputHtml(s, t); break;
      case "error": body.innerHTML = this._renderErrorHtml(s, t); break;
      case "raw": body.innerHTML = this._renderRawEventsHtml(s); break;
      default: body.innerHTML = "";
    }
  }

  // ---------------------------- Spans / waterfall -----------------------------

  _renderSpansHtml(s) {
    if (s.transforms.length === 0) {
      return `<div class="sp-empty"><div class="sp-empty-title">No transforms yet</div><div class="sp-empty-sub">Waiting for TransformSubmitted…</div></div>`;
    }
    const now = Date.now();
    const start = s.startedAt;
    const end = s.disposed && s.disposedAt ? s.disposedAt : now;
    const span = Math.max(end - start, 1);
    const ticks = this._axisTicks(span);
    const axisHtml = ticks.map((tk) => {
      const pct = (tk / span) * 100;
      return `<div class="sp-tick" style="left:${pct.toFixed(2)}%"></div><div class="sp-tick-label" style="left:${pct.toFixed(2)}%">+${this._fmtDuration(tk)}</div>`;
    }).join("");
    let rows = "";
    for (const t of s.transforms) {
      const s0 = ((t.submittedAt - start) / span) * 100;
      const s1 = (((t.completedAt || now) - start) / span) * 100;
      const w = Math.max(s1 - s0, 0.5);
      const cls = t.terminalState === "Succeeded" ? "terminal-ok" : t.terminalState === "Failed" ? "terminal-err" : t.terminalState === "Cancelled" ? "terminal-cancel" : ((t.state || "").toLowerCase().includes("cleanup") ? "cleanup" : (t.state || "").toLowerCase().includes("exec") ? "exec" : "init");
      const dur = (t.completedAt || now) - t.submittedAt;
      const sel = (this._selectedTxfId === t.id) ? " selected" : "";
      rows += `
        <div class="sp-wf-row${sel}" data-action="select-txf-wf" data-tid="${this._esc(t.id)}">
          <div class="sp-wf-name"><span class="sp-depth">└</span>${this._esc(t.name)}</div>
          <div class="sp-wf-track">
            <div class="sp-wf-span ${cls}" style="left:${s0.toFixed(2)}%;width:${w.toFixed(2)}%" data-tt="${this._esc(t.name)} · ${this._fmtDuration(dur)}">${this._fmtDuration(dur)}</div>
          </div>
        </div>`;
    }
    return `
      <div class="sp-section-h">Waterfall <span class="sp-h-meta">${s.transforms.length} transforms · ${this._fmtDuration(span)} total</span><span class="sp-h-line"></span></div>
      <div class="sp-waterfall">
        <div class="sp-wf-axis">${axisHtml}</div>
        ${rows}
      </div>`;
  }

  // -------------------------- State machine SVG -------------------------------

  _renderStateMachineHtml(s, t) {
    if (!t) return `<div class="sp-empty"><div class="sp-empty-title">No transform selected</div></div>`;
    const nodes = [
      { id: "NotStarted",   x: 30,  y: 60 },
      { id: "Initializing", x: 150, y: 60 },
      { id: "InProgress",   x: 280, y: 60 },
      { id: "CleanUp",      x: 410, y: 60 },
      { id: "Executing",    x: 280, y: 140 },
      { id: "Succeeded",    x: 540, y: 30 },
      { id: "Failed",       x: 540, y: 90 },
      { id: "Cancelled",    x: 540, y: 150 },
    ];
    const edges = [
      ["NotStarted", "Initializing"],
      ["Initializing", "InProgress"],
      ["InProgress", "Executing"],
      ["InProgress", "CleanUp"],
      ["Executing", "CleanUp"],
      ["CleanUp", "Succeeded"],
      ["CleanUp", "Failed"],
      ["CleanUp", "Cancelled"],
    ];
    const visited = new Set();
    for (const p of t.polls) { visited.add(p.previousState); visited.add(p.state); }
    visited.add(t.state);
    if (t.terminalState) visited.add(t.terminalState);
    visited.delete(null);
    visited.delete(undefined);
    const current = t.terminalState || t.state;

    const svgNodes = nodes.map((n) => {
      let cls = "sp-sm-node";
      if (n.id === current) cls += " current";
      else if (visited.has(n.id)) cls += " visited";
      if (n.id === "Succeeded") cls += " terminal-ok";
      if (n.id === "Failed") cls += " terminal-err";
      if (n.id === "Cancelled") cls += " terminal-cancel";
      const w = 96;
      return `<g class="${cls}"><rect x="${n.x}" y="${n.y - 14}" width="${w}" height="28" rx="6"/><text x="${n.x + w / 2}" y="${n.y + 4}" text-anchor="middle">${n.id}</text></g>`;
    }).join("");

    const svgEdges = edges.map(([a, b]) => {
      const na = nodes.find((n) => n.id === a);
      const nb = nodes.find((n) => n.id === b);
      if (!na || !nb) return "";
      const visEdge = visited.has(a) && visited.has(b);
      let cls = "sp-sm-edge";
      if (visEdge) cls += " visited";
      if (b === "Failed") cls += " terminal-err";
      if (b === "Cancelled") cls += " terminal-cancel";
      const x1 = na.x + 96, y1 = na.y;
      const x2 = nb.x, y2 = nb.y;
      const cx = (x1 + x2) / 2;
      return `<path class="${cls}" d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}"/>`;
    }).join("");

    const summary = `
      <div class="sp-sm-summary">
        <strong>${this._esc(t.name)}</strong> · current state: <span class="sp-mono">${this._esc(current || "—")}</span>
        · ${t.polls.length} poll${t.polls.length === 1 ? "" : "s"} · transitions: ${this._distinctTransitions(t)}
      </div>`;

    return `
      <div class="sp-section-h">State machine<span class="sp-h-line"></span></div>
      <div class="sp-state-machine">
        <svg viewBox="0 0 660 200">
          <defs>
            <marker id="sp-sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--text-muted)"/>
            </marker>
          </defs>
          ${svgEdges}
          ${svgNodes}
        </svg>
        ${summary}
      </div>`;
  }

  _distinctTransitions(t) {
    let n = 0;
    for (const p of t.polls) if (p.stateChanged) n++;
    return n;
  }

  // ------------------------------ Poll log ------------------------------------

  _renderPollLogHtml(s, t) {
    if (!t || t.polls.length === 0) {
      return `<div class="sp-empty"><div class="sp-empty-title">No polls recorded</div><div class="sp-empty-sub">Polling activity for this transform will show here.</div></div>`;
    }
    let rows = "";
    let prevAt = t.submittedAt;
    t.polls.forEach((p, i) => {
      const delta = p.at - prevAt;
      prevAt = p.at;
      let cls = "";
      const term = p.state === "Succeeded" || p.state === "Failed" || p.state === "Cancelled";
      if (term) cls = p.state === "Succeeded" ? " terminal-ok" : p.state === "Failed" ? " terminal-err" : " terminal-cancel";
      else if (p.stateChanged) cls = " state-change";
      const note = p.stateChanged
        ? `<span class="sp-mono">${this._esc(p.previousState || "?")}</span><span class="sp-change-arrow">→</span><span class="sp-mono">${this._esc(p.state)}</span>`
        : `${p.retryAfterMs ? `retry in ${this._fmtDuration(p.retryAfterMs)}` : "no change"}`;
      rows += `
        <div class="sp-poll-row${cls}">
          <div class="sp-col-n">#${String(i + 1).padStart(3, "0")}</div>
          <div class="sp-col-t">+${this._fmtDuration(p.at - t.submittedAt)}</div>
          <div class="sp-col-state"><span class="sp-s-dot"></span>${this._esc(p.state)}</div>
          <div class="sp-col-delta">Δ${this._fmtDuration(delta)}</div>
          <div class="sp-col-note">${note}</div>
        </div>`;
    });
    return `
      <div class="sp-section-h">Poll log <span class="sp-h-meta">${t.polls.length} polls · ${this._distinctTransitions(t)} transitions</span><span class="sp-h-line"></span></div>
      <div class="sp-poll-log">
        <div class="sp-poll-head"><div>#</div><div>+Δt</div><div>State</div><div>Δ</div><div>Note</div></div>
        ${rows}
      </div>`;
  }

  // ------------------------------ REPL map ------------------------------------

  _renderReplMapHtml(s) {
    if (s.gtsRepls.size === 0) {
      return `<div class="sp-empty"><div class="sp-empty-title">No REPLs yet</div><div class="sp-empty-sub">REPLs appear once transforms are submitted.</div></div>`;
    }
    let html = `<div class="sp-section-h">GTS sessions &amp; REPLs<span class="sp-h-line"></span></div>`;
    for (const [gtsId, repls] of s.gtsRepls.entries()) {
      const color = this._hashColor(gtsId);
      let replRows = "";
      for (const replId of repls) {
        const txfs = s.transforms.filter((t) => t.replId === replId);
        const txfHtml = txfs.map((t) => {
          const kind = (t.nodeKind || "").toLowerCase();
          const kindCls = kind.startsWith("py") ? "py" : (kind === "sql" ? "sql" : "");
          const kindLetter = kind.startsWith("py") ? "py" : (kind === "sql" ? "SQ" : "?");
          return `<div class="sp-repl-txf">
            <span class="sp-t-icon ${kindCls}">${this._esc(kindLetter)}</span>
            <span class="sp-repl-txf-name">${this._esc(t.name)}</span>
            <span class="sp-repl-txf-state">${this._esc(t.terminalState || t.state || "—")}</span>
          </div>`;
        }).join("");
        const earliest = txfs.length ? Math.min(...txfs.map((t) => t.submittedAt)) : null;
        replRows += `
          <div class="sp-repl-row">
            <div>
              <div class="sp-repl-id"><span class="sp-repl-dot" style="background:${color}"></span>${this._esc(this._shortId(replId, 12))}</div>
              <div class="sp-repl-txf-list">${txfHtml || `<span class="sp-muted">No transforms bound.</span>`}</div>
            </div>
            <div class="sp-repl-stamp">${earliest ? `+${this._fmtDuration(earliest - s.startedAt)}` : ""}</div>
          </div>`;
      }
      html += `
        <div class="sp-repl-group">
          <div class="sp-repl-head">
            <span class="sp-gts-pin" style="background:${color}"></span>
            <span class="sp-gts-id-label">${this._esc(this._shortId(gtsId, 14))}</span>
            <span class="sp-gts-meta-label">GTS session</span>
            <span class="sp-repl-count">${repls.size} REPL${repls.size === 1 ? "" : "s"}</span>
          </div>
          ${replRows}
        </div>`;
    }
    return html;
  }

  // ------------------------------ Output --------------------------------------

  _renderOutputHtml(s, t) {
    const ro = t && t.refreshOutput;
    if (!ro) {
      return `<div class="sp-empty"><div class="sp-empty-title">No refresh output</div><div class="sp-empty-sub">Available once a transform reaches the Succeeded state.</div></div>`;
    }
    const rowsProcessed = ro.totalRowsProcessed ?? 0;
    const rowsDropped = ro.totalRowsDropped ?? 0;
    const violations = ro.totalViolations ?? 0;
    let violationsList = "";
    if (ro.violationsPerConstraint && typeof ro.violationsPerConstraint === "object") {
      const entries = Object.entries(ro.violationsPerConstraint);
      const max = Math.max(1, ...entries.map(([, v]) => Number(v) || 0));
      violationsList = entries.map(([name, v]) => {
        const n = Number(v) || 0;
        const pct = (n / max) * 100;
        return `<div class="sp-violation-row"><span class="sp-vr-name">${this._esc(name)}</span><div class="sp-vr-bar"><div style="width:${pct.toFixed(1)}%"></div></div><span class="sp-vr-count">${n}</span></div>`;
      }).join("");
    }
    return `
      <div class="sp-section-h">Refresh output <span class="sp-h-meta">${this._esc(ro.refreshTimestamp || "")}</span><span class="sp-h-line"></span></div>
      <div class="sp-refresh-output">
        <div class="sp-ro-stats">
          <div class="sp-ro-stat"><div class="sp-ro-label">Rows processed</div><div class="sp-ro-value">${this._fmtNum(rowsProcessed)}</div></div>
          <div class="sp-ro-stat policy"><div class="sp-ro-label">Policy</div><div class="sp-ro-value">${this._esc(ro.refreshPolicy || "—")}</div></div>
          <div class="sp-ro-stat dropped"><div class="sp-ro-label">Dropped</div><div class="sp-ro-value${rowsDropped === 0 ? " zero" : ""}">${this._fmtNum(rowsDropped)}</div></div>
          <div class="sp-ro-stat violations"><div class="sp-ro-label">Violations</div><div class="sp-ro-value${violations === 0 ? " zero" : ""}">${this._fmtNum(violations)}</div></div>
        </div>
        <div class="sp-ro-mlv">
          <div class="sp-kvl">MLV</div><div class="sp-kvv">${this._esc(ro.mlvNamespace || "—")}.${this._esc(ro.mlvName || "—")}</div>
          <div class="sp-kvl">MLV ID</div><div class="sp-kvv dim">${this._esc(ro.mlvId || "—")}</div>
        </div>
        ${ro.outputMessage ? `<div class="sp-ro-msg">${this._esc(ro.outputMessage)}</div>` : ""}
      </div>
      ${violationsList ? `<div class="sp-section-h">Violations per constraint<span class="sp-h-line"></span></div><div class="sp-violation-list">${violationsList}</div>` : ""}`;
  }

  // ------------------------------ Error ---------------------------------------

  _renderErrorHtml(s, t) {
    const err = (t && t.error) || (s.createError ? { message: typeof s.createError === "string" ? s.createError : (s.createError.message || JSON.stringify(s.createError)), code: null, source: "System", stage: "SessionCreate", stackTrace: null, retriable: false } : null);
    if (!err) {
      return `<div class="sp-empty"><div class="sp-empty-title">No errors recorded</div><div class="sp-empty-sub">This session has not reported any failures.</div></div>`;
    }
    const srcCls = (err.source || "").toLowerCase() === "system" ? "system" : "";
    const frames = Array.isArray(err.stackTrace) ? err.stackTrace : [];
    const stackHtml = frames.length ? `
      <div class="sp-section-h">Stack trace <span class="sp-h-meta">${frames.length} frames</span><span class="sp-h-line"></span></div>
      <div class="sp-stack-trace">
        ${frames.map((f, i) => {
          const line = typeof f === "string" ? f : (f.frame || JSON.stringify(f));
          const isUser = /\.scala|\.py|\.sql|FabricLiveTable|MLV/.test(line) && !line.startsWith("at org.apache.spark");
          return `<div class="sp-stack-frame${isUser ? " user" : ""}"><span class="sp-sf-num">#${i}</span><span class="sp-sf-line">${this._esc(line)}</span></div>`;
        }).join("")}
      </div>` : "";
    const suggestions = this._suggestActions(err);
    const suggestionsHtml = suggestions.length ? `
      <div class="sp-section-h">Suggested actions<span class="sp-h-line"></span></div>
      ${suggestions.map((sg, i) => `<div class="sp-suggested"><span class="sp-suggested-bullet">${i + 1}</span><div><div class="sp-suggested-title">${this._esc(sg.title)}</div><div class="sp-suggested-desc">${this._esc(sg.desc)}</div></div></div>`).join("")}` : "";
    return `
      <div class="sp-section-h">Error<span class="sp-h-line"></span></div>
      <div class="sp-error-block">
        <div class="sp-error-block-head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span class="sp-err-title">${this._esc(err.code || "TransformFailed")}</span>
          <span class="sp-err-src ${srcCls}">${this._esc(err.source || "—")}</span>
        </div>
        <div class="sp-error-block-body">${this._esc(err.message || "Unknown error")}</div>
        <div class="sp-error-block-foot">
          ${err.stage ? `<span class="sp-error-stage-tag">${this._esc(err.stage)}</span>` : ""}
          ${err.retriable ? `<span class="sp-tag retriable">Retriable${err.retryAfterMs ? ` (in ${this._fmtDuration(err.retryAfterMs)})` : ""}</span>` : `<span class="sp-tag terminal">Terminal</span>`}
          ${t ? `<span class="sp-tag">${this._esc(t.refreshMode || "—")}</span>` : ""}
        </div>
      </div>
      ${stackHtml}
      ${suggestionsHtml}`;
  }

  _suggestActions(err) {
    const out = [];
    const msg = (err.message || "").toLowerCase();
    const code = (err.code || "").toLowerCase();
    if (err.retriable) out.push({ title: "Retry the transform", desc: "The error is marked retriable. Re-run the transform; a transient resource issue may resolve on the next attempt." });
    if (msg.includes("permission") || msg.includes("access") || code.includes("auth")) out.push({ title: "Check workspace permissions", desc: "Verify the executing identity has access to the artifact and the OneLake path it reads or writes." });
    if (msg.includes("schema") || msg.includes("column") || msg.includes("type")) out.push({ title: "Inspect schema drift", desc: "A column or type mismatch is likely. Compare the source schema against the materialized view definition." });
    if (msg.includes("timeout") || msg.includes("timed out")) out.push({ title: "Review executor sizing", desc: "Increase executor count or memory, or split the transform into smaller stages." });
    if ((err.source || "").toLowerCase() === "user") out.push({ title: "Inspect node logic", desc: "The error originated in user code. Review the node's SQL or PySpark body for the failing operation." });
    if (out.length === 0) out.push({ title: "Open Raw events", desc: "Inspect the raw event stream for this session to correlate the failure with adjacent polls and submissions." });
    return out;
  }

  // ------------------------------ Raw events ----------------------------------

  _renderRawEventsHtml(s) {
    if (!s._sessionRawEvents.length) return `<div class="sp-empty"><div class="sp-empty-title">No raw events</div></div>`;
    const rows = s._sessionRawEvents.slice().reverse().map((ev) => {
      const offset = ev.at - s.startedAt;
      const pretty = this._safeJson(ev.data);
      return `
        <div class="sp-raw-event">
          <div class="sp-raw-event-head">
            <span class="sp-raw-event-time">+${this._fmtDuration(offset)}</span>
            <span class="sp-raw-event-kind" style="color:${this._eventKindColor(ev.kind)}">${this._esc(ev.kind)}</span>
          </div>
          <pre class="sp-raw-event-pre">${this._esc(pretty)}</pre>
        </div>`;
    }).join("");
    return `
      <div class="sp-section-h">Raw events <span class="sp-h-meta">${s._sessionRawEvents.length} total · newest first</span><span class="sp-h-line"></span></div>
      <div class="sp-raw-events">${rows}</div>`;
  }

  _eventKindColor(kind) {
    if (kind === "Created" || kind === "Disposed") return "var(--accent)";
    if (kind === "TransformCompleted") return "var(--sp-green)";
    if (kind === "TransformCancelled") return "var(--sp-grey)";
    if (kind === "TransformPolled") return "var(--sp-blue)";
    if (kind === "TransformSubmitted") return "var(--sp-purple)";
    return "var(--text-dim)";
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  _onKeyDown(e) {
    if (!this._active) return;
    const tag = (e.target && e.target.tagName) || "";
    const inField = tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable;

    if (e.key === "/" && !inField) {
      e.preventDefault();
      this._elSearch.focus();
      this._elSearch.select();
      return;
    }
    if (e.key === "Escape") {
      if (this._selectedId) { this._closeDetail(); e.preventDefault(); }
      return;
    }
    if (inField) return;

    const cards = Array.from(this._elList.querySelectorAll(".sp-card"));
    if (!cards.length) return;
    const ids = cards.map((c) => c.dataset.sid);
    const idx = this._selectedId ? ids.indexOf(this._selectedId) : -1;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(ids.length - 1, idx + 1);
      this._selectedId = ids[next];
      this._selectedTxfId = null;
      this._ensureVisible(cards[next]);
      this._scheduleRender();
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = Math.max(0, idx - 1);
      this._selectedId = ids[prev];
      this._selectedTxfId = null;
      this._ensureVisible(cards[prev]);
      this._scheduleRender();
    } else if (e.key === " ") {
      if (!this._selectedId) return;
      e.preventDefault();
      if (this._expanded.has(this._selectedId)) this._expanded.delete(this._selectedId);
      else this._expanded.add(this._selectedId);
      this._scheduleRender();
    } else if (e.key === "Enter") {
      if (!this._selectedId) return;
      e.preventDefault();
      this._openDetail(this._selectedId);
    }
  }

  _ensureVisible(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pr = this._elList.getBoundingClientRect();
    if (r.top < pr.top) el.scrollIntoView({ block: "nearest" });
    else if (r.bottom > pr.bottom) el.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------------------
  // Tooltip (hover delegated)
  // ---------------------------------------------------------------------------

  _onHoverIn(e) {
    const el = e.target.closest("[data-tt]");
    if (!el) return;
    this._showTooltip(el, el.getAttribute("data-tt"));
  }

  _onHoverOut(e) {
    const el = e.target.closest("[data-tt]");
    if (!el) return;
    this._hideTooltip();
  }

  _showTooltip(target, text) {
    if (!text) return;
    if (!this._tooltipEl) {
      this._tooltipEl = document.createElement("div");
      this._tooltipEl.className = "sp-tooltip";
      document.body.appendChild(this._tooltipEl);
    }
    const r = target.getBoundingClientRect();
    this._tooltipEl.textContent = text;
    this._tooltipEl.classList.add("show");
    const ttW = this._tooltipEl.offsetWidth;
    const ttH = this._tooltipEl.offsetHeight;
    let x = r.left + r.width / 2 - ttW / 2;
    let y = r.top - ttH - 6;
    if (y < 6) y = r.bottom + 6;
    if (x < 6) x = 6;
    if (x + ttW > window.innerWidth - 6) x = window.innerWidth - ttW - 6;
    this._tooltipEl.style.left = `${x}px`;
    this._tooltipEl.style.top = `${y}px`;
  }

  _hideTooltip() {
    if (this._tooltipEl) this._tooltipEl.classList.remove("show");
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  _exportJSON() {
    const payload = {
      exportedAt: new Date().toISOString(),
      sessions: Array.from(this._sessions.values()).map((s) => ({
        id: s.id,
        iterationId: s.iterationId,
        tenantId: s.tenantId,
        workspaceId: s.workspaceId,
        workspaceName: s.workspaceName,
        artifactId: s.artifactId,
        artifactName: s.artifactName,
        status: s.status,
        startedAt: s.startedAt,
        createdDurationMs: s.createdDurationMs,
        warm: s.warm,
        disposed: s.disposed,
        disposedAt: s.disposedAt,
        lifetimeMs: s.lifetimeMs,
        lastState: s.lastState,
        createError: s.createError,
        gtsRepls: Array.from(s.gtsRepls.entries()).map(([g, r]) => ({ gts: g, repls: Array.from(r) })),
        transforms: s.transforms.map((t) => ({
          id: t.id, name: t.name, nodeId: t.nodeId, nodeKind: t.nodeKind, refreshMode: t.refreshMode,
          gts: t.gts, replId: t.replId, state: t.state, terminalState: t.terminalState,
          submittedAt: t.submittedAt, completedAt: t.completedAt,
          submitDurationMs: t.submitDurationMs, completeDurationMs: t.completeDurationMs,
          retriable: t.retriable, retryAfterMs: t.retryAfterMs,
          polls: t.polls, refreshOutput: t.refreshOutput, error: t.error,
        })),
      })),
    };
    this._downloadFile(`spark-sessions-${this._stamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  _exportCSV() {
    const headers = ["sessionId", "iterationId", "artifactName", "workspaceName", "sessionStatus", "warm", "transformId", "transformName", "nodeKind", "refreshMode", "gtsSessionId", "replId", "state", "terminalState", "submittedAt", "completedAt", "durationMs", "pollCount", "errorCode", "errorMessage"];
    const rows = [headers.join(",")];
    for (const s of this._sessions.values()) {
      if (s.transforms.length === 0) {
        rows.push([s.id, s.iterationId, s.artifactName, s.workspaceName, s.status, s.warm, "", "", "", "", "", "", "", "", new Date(s.startedAt).toISOString(), "", "", "", "", ""].map(this._csvCell).join(","));
        continue;
      }
      for (const t of s.transforms) {
        const dur = (t.completedAt || Date.now()) - t.submittedAt;
        rows.push([s.id, s.iterationId, s.artifactName, s.workspaceName, s.status, s.warm, t.id, t.name, t.nodeKind, t.refreshMode, t.gts, t.replId, t.state, t.terminalState, new Date(t.submittedAt).toISOString(), t.completedAt ? new Date(t.completedAt).toISOString() : "", dur, t.polls.length, t.error && t.error.code, t.error && t.error.message].map(this._csvCell).join(","));
      }
    }
    this._downloadFile(`spark-sessions-${this._stamp()}.csv`, rows.join("\n"), "text/csv");
  }

  _csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  _stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  _downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _statusColor(status) {
    if (status === "running") return "var(--sp-blue)";
    if (status === "succeeded") return "var(--sp-green)";
    if (status === "failed") return "var(--sp-red)";
    if (status === "cancelled") return "var(--sp-grey)";
    return "var(--sp-grey)";
  }

  _statusIconSvg(status) {
    if (status === "running") return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;
    if (status === "succeeded") return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
    if (status === "failed") return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    if (status === "cancelled") return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    return "";
  }

  _shortId(id, n) {
    if (!id) return "";
    const s = String(id);
    const len = typeof n === "number" ? n : 8;
    if (s.length <= len + 2) return s;
    return s.slice(0, len) + "…";
  }

  _fmtElapsed(ms, live) {
    if (!Number.isFinite(ms) || ms < 0) return "0s";
    return (live ? "● " : "") + this._fmtDuration(ms);
  }

  _fmtDuration(ms) {
    if (!Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (m < 60) return `${m}m${s ? ` ${s}s` : ""}`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h${mm ? ` ${mm}m` : ""}`;
  }

  _fmtNum(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
    return Number(n).toLocaleString("en-US");
  }

  _esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  _highlight(text) {
    if (!text) return "";
    const esc = this._esc(text);
    if (!this._search) return esc;
    const q = this._escRegex(this._search);
    try {
      return esc.replace(new RegExp(`(${q})`, "ig"), '<span class="sp-hl">$1</span>');
    } catch {
      return esc;
    }
  }

  _escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  _hashColor(id) {
    const palette = ["#a855f7", "#06b6d4", "#0d9488", "#e5940c", "#2d7ff9", "#ec4899", "#10b981", "#6d5cff"];
    let h = 0;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  _safeJson(o) {
    try { return JSON.stringify(o, null, 2); } catch { return String(o); }
  }
}

if (typeof window !== "undefined") window.SparkSessionsTab = SparkSessionsTab;
