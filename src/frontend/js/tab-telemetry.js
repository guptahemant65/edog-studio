/**
 * TelemetryTab v2 — Real-time SSR + Additional telemetry monitor.
 *
 * Pixel — EDOG Studio Frontend Engineer
 *
 * Visual design ported from docs/design/mocks/f04-mock-02-telemetry-v2.html.
 * DOM layout: metric strip → toolbar → 3-column body (spine | stream | catalog)
 *             with slide-up detail panel.
 *
 * Public surface (preserved for main.js):
 *   new TelemetryTab(containerEl, signalrManager)
 *   activate()
 *   deactivate()
 *   addEvent(data)   — also used in tests
 *
 * Internal contracts:
 *   - Subscribes to 'telemetry' topic in constructor (accumulates while hidden).
 *   - Filters proxy through window.studioState.filters.telemetry via setter/getter.
 *   - New filter keys: channel ('all'|'ssr'|'additional'), window ('1m'|'5m'|'15m'|'all'), iter (string|null).
 *   - Channel fallback: (data.channel || 'ssr').toLowerCase()
 *   - Status map extended: 'completed' → 'succeeded'
 *   - Iteration click: sets iter filter + calls window.edogIterationCorrelator?.setActiveIteration()
 *   - View in Logs: window.studioSetFilter('logs', { raid: iterId })
 *
 * No random data generation in production path.
 * No synthetic data generator. No state matrix dock.
 */
'use strict';

class TelemetryTab {

  /* ── Constants ── */
  static LONG_THRESHOLD_MS = 30_000;
  static MAX_SLIDER_MS     = 5_000;
  static TICK_MS           = 100;
  static DEBOUNCE_MS       = 180;
  static MAX_SPARKLINE     = 16;
  static RENDER_LIMIT      = 500;
  static SPINE_LIMIT       = 12;

  /* Terminal status set — events outside this set do NOT contribute to
   * timing aggregates (p50/p95/sparklines). Specifically excludes
   * 'pending' (whose durationMs is time-to-HTTP-202, not the activity
   * runtime), 'running' (still in flight), and 'unknown' (the empty
   * status that Additional channel mirrors arrive with). See B5 in
   * tests/test_telemetry_correctness.py. */
  static _TERMINAL_STATUSES = new Set(['succeeded', 'completed', 'failed', 'warning', 'cancelled']);

  constructor(containerEl, signalr) {
    this._el      = containerEl;
    this._signalr = signalr;
    this._events  = [];
    this._active  = false;
    this._paused  = false;
    this._maxEvents = 5000;

    /* View state */
    this._selectedId   = null;
    this._kbIndex      = -1;
    this._detailOpen   = false;
    this._exportOpen   = false;
    this._catSort      = 'cnt'; // 'cnt'|'p95'|'err'
    this._jsonFolded   = true;

    /* Filter fallbacks (used by tests that skip studio-state.js) */
    this._filterFallbacks = {
      q: '', status: 'all', dmin: 0, dmax: 0,
      channel: 'all', window: 'all', iter: null,
    };
    this._installFilterProxies();

    /* Internal tracking */
    this._correlationMap = new Map(); // correlationId → index in this._events
    this._eventById      = new Map(); // eventId → activity object (O(1) lookup)
    this._iterMap        = new Map(); // iterationId → iter descriptor
    this._catMap         = new Map(); // activityName → catalog aggregate
    this._sparklines     = new Map(); // activityName → [durationMs,...]
    this._metricHistory  = { events: [], err: [], p95: [] };
    this._tickInterval   = null;
    this._debounceTimer  = null;
    this._renderRAF      = null;
    this._tooltipTarget  = null;

    /* DOM cache — populated by _buildDOM */
    this._dom = {};

    this._buildDOM();
    this._bindEvents();

    /* Subscribe immediately so events accumulate while tab is hidden */
    if (this._signalr) {
      this._signalr.on('telemetry', this._onEvent);
      this._signalr.subscribeTopic('telemetry');
    }
  }

  /* ═══ Filter proxies — route reads/writes through window.studioState ════ */

  _installFilterProxies() {
    const ssGet = (key) => {
      if (window.studioState) {
        const f = window.studioState.get().filters;
        if (f && f.telemetry && Object.prototype.hasOwnProperty.call(f.telemetry, key)) {
          return f.telemetry[key];
        }
      }
      return this._filterFallbacks[key];
    };
    const ssSet = (key, value) => {
      if (window.studioSetFilter) {
        const patch = {}; patch[key] = value;
        window.studioSetFilter('telemetry', patch);
      } else {
        this._filterFallbacks[key] = value;
      }
    };
    const scalar = (prop, key) => {
      Object.defineProperty(this, prop, {
        get: () => ssGet(key),
        set: (v) => ssSet(key, v),
        configurable: true, enumerable: true,
      });
    };
    /* Original keys */
    scalar('_filterText',   'q');
    scalar('_statusFilter', 'status');
    scalar('_durMin',       'dmin');
    scalar('_durMax',       'dmax');
    /* New keys (F04) */
    scalar('_window',        'window');
    scalar('_iter',          'iter');
  }

  /* ═══ Lifecycle ══════════════════════════════════════════════════════════ */

  activate() {
    if (this._active) return;
    this._active = true;
    document.addEventListener('keydown', this._boundKeyDown);
    document.addEventListener('click',   this._boundDocClick);
    this._startTicking();
    this._syncFilterUi();
    this._render();
  }

  deactivate() {
    this._active = false;
    document.removeEventListener('keydown', this._boundKeyDown);
    document.removeEventListener('click',   this._boundDocClick);
    /* Don't unsubscribe from SignalR — events must accumulate while hidden */
    this._stopTicking();
    cancelAnimationFrame(this._renderRAF); this._renderRAF = null;
    clearTimeout(this._debounceTimer);    this._debounceTimer = null;
    if (this._detailOpen) this._closeDetail();
    this._exportOpen = false;
    if (this._dom.exportDD) this._dom.exportDD.classList.remove('open');
    this._kbIndex = -1;
  }

  /* ═══ SignalR handler ════════════════════════════════════════════════════ */

  _onEvent = (envelope) => {
    const data  = envelope.data || envelope;
    const seqId = envelope.sequenceId;
    const ts    = data.timestamp || envelope.timestamp;

    const activity = this._mapEvent(data, seqId, ts);

    /* ── SSR-only stream ──────────────────────────────────────────────────
     * The Additional (+TEL) channel is a TRUE MIRROR of an SSR event: FLT
     * emits both from the same call site with the SAME activityName and the
     * SAME correlationId (NodeExecutor.cs:390 EmitStandardizedServerReporting
     * + :417 EmitTelemetry; DagExecutionHandlerV2 does the same). +TEL carries
     * NO lifecycle status of its own — the backend stamps an empty status and
     * isMirror=true. Rendering it as its own row was the root of three bugs:
     *   1. "so many unknown status" — empty-status mirrors mapped to 'unknown'.
     *   2. duplicate rows — two events, one activity.
     *   3. "older ones get redacted" — both rows wrote _correlationMap[cid],
     *      so the running→terminal merge below updated the WRONG row.
     * Fix: drop +TEL at ingest. Its only unique payload is a handful of
     * retry-metric attributes (rollout validation) — merge those into the SSR
     * twin so nothing is lost. VERIFIED 2026-06-08 against FLT source.
     * DO NOT re-introduce +TEL as stream rows without re-reading NodeExecutor.cs. */
    if (activity.channel === 'additional') {
      this._mergeAdditionalIntoTwin(activity);
      return;
    }

    /* Update existing running activity via correlationId */
    if (activity.correlationId && activity.status !== 'running') {
      const existingIdx = this._correlationMap.get(activity.correlationId);
      if (existingIdx !== undefined && existingIdx < this._events.length) {
        const existing = this._events[existingIdx];
        if (existing.status === 'running') {
          existing.status      = activity.status;
          existing.durationMs  = activity.durationMs;
          existing.resultCode  = activity.resultCode;
          existing.error       = activity.error;
          existing.channel     = existing.channel; // keep original channel
          Object.assign(existing.attributes, activity.attributes);
          this._trackSparkline(existing);
          this._updateIterMap(existing);
          this._updateCatMap(existing);
          if (this._active) this._scheduleRender();
          return;
        }
      }
    }

    /* New event */
    const idx = this._events.length;
    this._events.push(activity);
    this._eventById.set(activity.id, activity);

    if (activity.correlationId) this._correlationMap.set(activity.correlationId, idx);

    /* Evict oldest when over cap */
    while (this._events.length > this._maxEvents) {
      const evicted = this._events.shift();
      this._eventById.delete(evicted.id);
      if (evicted.correlationId) {
        const mapped = this._correlationMap.get(evicted.correlationId);
        if (mapped !== undefined && mapped <= 0) this._correlationMap.delete(evicted.correlationId);
      }
      for (const [k, v] of this._correlationMap) this._correlationMap.set(k, v - 1);
      if (evicted.name) {
        if (!this._events.some(e => e.name === evicted.name)) this._sparklines.delete(evicted.name);
      }
    }

    if (activity.status !== 'running') {
      this._trackSparkline(activity);
      this._updateCatMap(activity);
    }
    this._updateIterMap(activity);

    if (this._active && !this._paused) this._scheduleRender();
  };

  /** Fold a +TEL mirror's unique attributes into its SSR twin, then discard.
   *  Twin matched by correlationId. If the twin hasn't arrived yet (rare — FLT
   *  emits SSR before +TEL synchronously in the same call), the mirror is
   *  dropped; its retry-metrics are non-critical rollout-validation data. */
  _mergeAdditionalIntoTwin(activity) {
    if (!activity.correlationId) return;
    const idx = this._correlationMap.get(activity.correlationId);
    if (idx === undefined || idx >= this._events.length) return;
    const twin = this._events[idx];
    if (!twin) return;
    Object.assign(twin.attributes, activity.attributes);
    if (this._active && !this._paused) this._scheduleRender();
  }

  /** Public — adds an event externally (tests, cross-module calls). */
  addEvent(data) {
    this._onEvent({ data: data, sequenceId: this._events.length, timestamp: new Date().toISOString() });
  }

  /* ═══ Data mapping ═══════════════════════════════════════════════════════ */

  _mapEvent(data, seqId, timestamp) {
    const rawStatus = (data.activityStatus || '').toLowerCase();
    /* Status mapping.
     * 2026-06-07 telemetry-correctness fix: 'completed' is no longer
     * aliased to 'succeeded'. Two reasons:
     *   1. 'Completed' is semantically distinct from 'Succeeded' — a
     *      workflow can complete with failures. Conflating them hides
     *      real outcomes.
     *   2. The Additional channel events used to be stamped 'Completed'
     *      by the backend interceptor (it had no real status to report).
     *      The alias turned those into a green 'succeeded' badge,
     *      reporting still-running RunDag activities as succeeded. The
     *      backend now leaves activityStatus empty + isMirror=true, and the
     *      frontend drops Additional events at ingest entirely (see _onEvent),
     *      so they never reach a badge. SSR carries the real lifecycle.
     */
    const status =
      rawStatus === 'succeeded' ? 'succeeded' :
      rawStatus === 'completed' ? 'completed' :
      rawStatus === 'failed'    || rawStatus === 'failedwithremote' ? 'failed' :
      rawStatus === 'succeededwitherrors' ? 'warning' :
      rawStatus === 'running'   || rawStatus === 'inprogress' || rawStatus === 'pending' ? 'running' :
      rawStatus === 'cancelled' || rawStatus === 'interrupted' ? 'cancelled' :
      'unknown';

    /* Channel: new backend stamps 'ssr'|'additional'. Older SSR events omit it. */
    const channel = (data.channel || 'ssr').toLowerCase();

    const durationMs = typeof data.durationMs === 'number' && data.durationMs >= 0
      ? data.durationMs : 0;

    let error = null;
    if (status === 'failed') {
      error = data.resultCode ? 'System error: ' + data.resultCode : 'Operation failed';
    } else if (status === 'warning') {
      error = data.resultCode ? 'User error: ' + data.resultCode : 'Completed with user-attributed errors';
    }

    const tsMs = timestamp ? new Date(timestamp).getTime() : Date.now();

    return {
      id:            'tel-' + (seqId != null ? seqId : this._events.length),
      seqId:         seqId,
      name:          data.activityName || 'Unknown Activity',
      status:        status,
      channel:       channel,
      isMirror:      !!data.isMirror,
      durationMs:    durationMs,
      resultCode:    data.resultCode  || '',
      correlationId: data.correlationId || '',
      iterationId:   data.iterationId  || this._parseIterationFromCorrelation(data.correlationId),
      eventId:       data.eventId || '',
      attributes:    data.attributes  || {},
      userId:        data.userId || '',
      timestamp:     timestamp || new Date().toISOString(),
      timestampMs:   tsMs,
      startTime:     status === 'running' ? Date.now() : (Date.now() - durationMs),
      error:         error,
    };
  }

  _parseIterationFromCorrelation(correlationId) {
    if (!correlationId) return '';
    const pipeIdx = correlationId.indexOf('|');
    if (pipeIdx > 0 && pipeIdx < correlationId.length - 1) return correlationId.substring(pipeIdx + 1);
    if (correlationId.length >= 73 && correlationId.charAt(36) === '-') return correlationId.substring(37);
    return '';
  }

  _trackSparkline(activity) {
    if (activity.durationMs <= 0) return;
    /* 2026-06-07 telemetry-correctness fix: Pending durationMs is
     * time-to-HTTP-202, not the activity runtime. Sparklines must
     * only show terminal events to avoid lying about latency. */
    const TERMINAL = TelemetryTab._TERMINAL_STATUSES;
    if (!TERMINAL.has(activity.status)) return;
    const key = activity.name;
    if (!this._sparklines.has(key)) this._sparklines.set(key, []);
    const arr = this._sparklines.get(key);
    arr.push(activity.durationMs);
    if (arr.length > TelemetryTab.MAX_SPARKLINE) arr.shift();
  }

  _updateIterMap(activity) {
    const iterId = activity.iterationId;
    if (!iterId) return;
    let iter = this._iterMap.get(iterId);
    if (!iter) {
      iter = { id: iterId, eventIds: [], status: 'running', ssrCount: 0, addCount: 0,
               startedAt: activity.timestampMs || Date.now(), lastEventAt: Date.now() };
      this._iterMap.set(iterId, iter);
    }
    if (!iter.eventIds.includes(activity.id)) {
      iter.eventIds.push(activity.id);
      if (activity.channel === 'ssr') iter.ssrCount++;
      else                            iter.addCount++;
    }
    iter.lastEventAt = Date.now();
    /* Derive status: failed > running > succeeded.
     * 2026-06-07 telemetry-correctness fix: only SSR events are
     * authoritative for lifecycle state. Additional events are
     * fire-and-forget mirrors with no real status — including them
     * here makes the spine report green for iterations that are
     * still running (the Additional mirror used to carry a fake
     * 'Completed'; backend now emits empty status + isMirror=true).
     */
    let hasFailed = false, hasRunning = false;
    for (let i = 0; i < iter.eventIds.length; i++) {
      const ev = this._eventById.get(iter.eventIds[i]);
      if (!ev) continue;
      if (ev.channel !== 'ssr') continue;
      if (ev.status === 'failed')  { hasFailed = true; break; }
      if (ev.status === 'running')   hasRunning = true;
    }
    iter.status = hasFailed ? 'failed' : hasRunning ? 'running' : 'succeeded';
  }

  _updateCatMap(activity) {
    /* Status whitelist for catalog/timing aggregates.
     * 2026-06-07 telemetry-correctness fix: Pending events were
     * polluting p50/p95. RunDag's Pending SSR carries durationMs ~=
     * time-to-HTTP-202 (typically 1.5-3s), NOT the activity runtime.
     * Including Pending in catalog timing made every RunDag look like
     * a sub-2-second op. Only terminal statuses contribute to timing.
     * Additional events with empty status arrive as 'unknown' — also
     * excluded; the SSR mirror is the timing source of truth. */
    const TERMINAL = TelemetryTab._TERMINAL_STATUSES;
    if (!TERMINAL.has(activity.status)) return;
    let agg = this._catMap.get(activity.name);
    if (!agg) {
      agg = { name: activity.name, count: 0, errCount: 0, warnCount: 0,
              durations: [], channels: new Set(), spark: [] };
      this._catMap.set(activity.name, agg);
    }
    agg.count++;
    if (activity.status === 'failed')  agg.errCount++;
    if (activity.status === 'warning') agg.warnCount++;
    if (activity.durationMs > 0) agg.durations.push(activity.durationMs);
    agg.channels.add(activity.channel);
    agg.spark.push(activity.durationMs);
    if (agg.spark.length > 16) agg.spark.shift();
  }

  /* ═══ Filtering ═══════════════════════════════════════════════════════════ */

  _getVisible() {
    const ft   = (this._filterText || '').toLowerCase();
    const sf   = this._statusFilter;
    const dMax = this._durMax;
    const dMin = this._durMin;
    const iterId = this._iter;

    /* Stale iteration filter guard.
     * iterationId is an ephemeral per-DAG-run GUID, but `iter` is persisted
     * to localStorage + URL (studio-state titer). After a new run — or a fresh
     * studio session — the restored value matches NONE of the current events,
     * which would strand the stream on an empty "0 of N" view while the status
     * pills (computed over all events) still read 9. That is the exact failure
     * the user hit: "by default it should show these 9 events, not only after I
     * click an iteration." Same class as the dmax slider strand.
     * Fix: if the selected iteration isn't present in the current event set,
     * treat it as cleared so the default shows ALL events. This is self-healing
     * (re-evaluated every render) — drill-down still works the moment the
     * iteration's events are live. DO NOT remove without making `iter`
     * non-persistent instead. */
    const iterActive = iterId && this._events.some(e => e.iterationId === iterId);

    /* Time-window cutoff — computed once per render */
    const now = Date.now();
    let cutoff = 0;
    const win = this._window;
    if      (win === '1m')  cutoff = now - 60_000;
    else if (win === '5m')  cutoff = now - 300_000;
    else if (win === '15m') cutoff = now - 900_000;

    const result = [];
    for (let i = this._events.length - 1; i >= 0; i--) {
      const a = this._events[i];

      /* Time window */
      if (cutoff > 0 && a.timestampMs < cutoff) continue;

      /* Iteration */
      if (iterActive && a.iterationId !== iterId) continue;

      /* Status */
      if (sf !== 'all' && a.status !== sf) continue;

      /* Text search (name, correlationId, iterationId) */
      if (ft) {
        if (!a.name.toLowerCase().includes(ft) &&
            !(a.correlationId && a.correlationId.toLowerCase().includes(ft)) &&
            !(a.iterationId   && a.iterationId.toLowerCase().includes(ft))) continue;
      }

      /* Duration filter (in ms). The slider's far-right position == "all";
       * a cap at or above MAX_SLIDER_MS means "no upper bound". This also
       * auto-migrates stale persisted dmax values (e.g. a prior default of
       * MAX_SLIDER_MS sitting in studioState) — otherwise every activity
       * longer than the slider max stays hidden behind an "all" label. */
      const durMs = a.status === 'running' ? (now - a.startTime) : a.durationMs;
      const capActive = dMax > 0 && dMax < TelemetryTab.MAX_SLIDER_MS;
      if (capActive && durMs > dMax) continue;
      if (dMin > 0 && durMs < dMin) continue;

      result.push(a);
      if (result.length >= TelemetryTab.RENDER_LIMIT) break;
    }
    return result;
  }

  /* ═══ DOM Building ════════════════════════════════════════════════════════ */

  _buildDOM() {
    const el = this._el;
    el.innerHTML = '';

    /* ── Metric strip (5 cells) ── */
    const strip = this._ce('div', 'tt-metric-strip');
    const mkMetric = (id, label, extra) => {
      const m = this._ce('div', 'tt-metric');
      const lbl = this._ce('div', 'tt-m-label');
      lbl.innerHTML = label + (id === 'events' ? '<span class="tt-m-tick" id="tt-tick1"></span>' : '');
      const val = this._ce('div', 'tt-m-value'); val.id = 'tt-m-' + id;
      val.innerHTML = '\u2014';
      const sub = this._ce('div', 'tt-m-sub'); sub.id = 'tt-msub-' + id;
      const spark = this._ce('svg', 'tt-m-spark');
      spark.id = 'tt-spark-' + id;
      spark.setAttribute('viewBox', '0 0 60 20');
      spark.setAttribute('preserveAspectRatio', 'none');
      m.appendChild(lbl); m.appendChild(val); m.appendChild(sub);
      if (!extra) m.appendChild(spark);
      return m;
    };
    strip.appendChild(mkMetric('events', 'Events / min'));
    strip.appendChild(mkMetric('err',    'Error rate'));
    strip.appendChild(mkMetric('active', 'Active iterations'));
    strip.appendChild(mkMetric('p95',    'p95 duration'));
    strip.appendChild(mkMetric('total',  'Total · since open'));
    el.appendChild(strip);
    this._dom.strip = strip;

    /* ── Toolbar ── */
    const toolbar = this._ce('div', 'tt-toolbar');

    /* Search */
    const search = this._ce('div', 'tt-search');
    const sIco = this._ce('span', 'tt-search-ico'); sIco.textContent = '\u2315';
    const sInput = this._ce('input', '');
    sInput.type = 'text'; sInput.placeholder = 'Filter activity, attribute, or correlation ID\u2026';
    sInput.autocomplete = 'off'; sInput.spellcheck = false;
    const sKbd = this._ce('span', 'tt-search-kbd'); sKbd.textContent = '/';
    search.appendChild(sIco); search.appendChild(sInput); search.appendChild(sKbd);
    toolbar.appendChild(search);
    this._dom.searchInput = sInput;

    /* Status pills */
    const statusPills = this._ce('div', 'tt-pills');
    statusPills.id = 'tt-status-pills';
    [{ st: 'all',       label: 'All',       dot: '' },
     { st: 'running',   label: 'Running',   dot: 'b' },
     { st: 'succeeded', label: 'Succeeded', dot: 'g' },
     { st: 'failed',    label: 'Failed',    dot: 'r' },
     { st: 'warning',   label: 'Warning',   dot: 'a' },
     { st: 'cancelled', label: 'Cancelled', dot: 'x' }].forEach(p => {
      const btn = this._ce('button', 'tt-pill');
      btn.dataset.st = p.st;
      const dotHTML = p.dot ? '<span class="tt-dot ' + p.dot + '"></span>' : '';
      btn.innerHTML = dotHTML + p.label + ' <span class="tt-cnt" id="tt-cntst-' + p.st + '">0</span>';
      statusPills.appendChild(btn);
    });
    toolbar.appendChild(statusPills);
    this._dom.statusPills = statusPills;

    toolbar.appendChild(this._ce('div', 'tt-divider'));

    /* Duration slider (single thumb, max-only, ms) */
    const rng = this._ce('div', 'tt-range');
    const rngLabel = this._ce('span', ''); rngLabel.textContent = 'Duration';
    const rngSlider = this._ce('div', 'tt-range-slider'); rngSlider.id = 'tt-dur-slider';
    rngSlider.innerHTML = '<div class="tt-range-track"><div class="tt-range-fill" id="tt-dur-fill" style="right:0%"></div></div>' +
                          '<div class="tt-range-thumb" id="tt-dur-thumb" style="left:100%"></div>';
    const rngVal = this._ce('span', 'tt-range-val'); rngVal.id = 'tt-dur-val';
    rngVal.textContent = 'all';
    rng.appendChild(rngLabel); rng.appendChild(rngSlider); rng.appendChild(rngVal);
    toolbar.appendChild(rng);
    this._dom.durSlider = rngSlider; this._dom.durVal = rngVal;

    toolbar.appendChild(this._ce('div', 'tt-divider'));

    /* Time window selector */
    const winSel = this._ce('div', 'tt-window-sel');
    ['1m', '5m', '15m', 'all'].forEach(w => {
      const b = this._ce('button', ''); b.dataset.w = w; b.textContent = w;
      winSel.appendChild(b);
    });
    toolbar.appendChild(winSel);
    this._dom.winSel = winSel;

    /* Spacer */
    const spacer = this._ce('div', ''); spacer.style.flex = '1';
    toolbar.appendChild(spacer);

    /* Pause button */
    const pauseBtn = this._ce('button', 'tt-btn');
    pauseBtn.id = 'tt-pause-btn';
    pauseBtn.innerHTML = '<span>\u23F8</span>Pause';
    toolbar.appendChild(pauseBtn);
    this._dom.pauseBtn = pauseBtn;

    /* Export */
    const exportWrap = this._ce('div', 'tt-export-wrap');
    const exportBtn  = this._ce('button', 'tt-btn');
    exportBtn.innerHTML = '<span>\u2193</span>Export';
    const exportDD = this._ce('div', 'tt-export-dd');
    exportDD.innerHTML = '<button data-format="json">Export as JSON</button><button data-format="csv">Export as CSV</button>';
    exportWrap.appendChild(exportBtn); exportWrap.appendChild(exportDD);
    toolbar.appendChild(exportWrap);
    this._dom.exportBtn = exportBtn; this._dom.exportDD = exportDD;

    el.appendChild(toolbar);
    this._dom.toolbar = toolbar;

    /* ── 3-column body ── */
    const body3 = this._ce('div', 'tt-body3');

    /* Left: Iteration Spine */
    const spine = this._ce('aside', 'tt-spine tt-panel');
    const spineH = this._ce('div', 'tt-panel-h');
    spineH.innerHTML = '<span>Iterations \u00B7 Spine</span><span class="tt-hcount" id="tt-iter-count">0</span>';
    const spineBody = this._ce('div', 'tt-panel-body'); spineBody.id = 'tt-spine-body';
    spine.appendChild(spineH); spine.appendChild(spineBody);
    body3.appendChild(spine);
    this._dom.spineBody = spineBody;

    /* Center: Stream */
    const stream = this._ce('section', 'tt-stream');
    const streamTb = this._ce('div', 'tt-stream-toolbar'); streamTb.id = 'tt-stream-toolbar';
    streamTb.innerHTML =
      '<div class="tt-st-left">' +
        '<span class="tt-live-tag"><span class="tt-live-dot"></span><span id="tt-live-label">LIVE</span></span>' +
        '<span class="tt-filter-summary" id="tt-filter-summary">showing <span class="k">0</span> of <span class="k">0</span> events</span>' +
      '</div>' +
      '<div class="tt-st-left">' +
        '<span style="font-size:11px;color:var(--text-muted)">J/K navigate \u00B7 \u23CE open \u00B7 / search \u00B7 Esc close</span>' +
      '</div>';
    const streamList = this._ce('div', 'tt-stream-list'); streamList.id = 'tt-stream-list'; streamList.tabIndex = 0;

    /* Empty state */
    const emptyState = this._ce('div', 'tt-empty'); emptyState.id = 'tt-empty';
    emptyState.innerHTML =
      '<div class="tt-orbit">' +
        '<div class="tt-ring"></div><div class="tt-ring r2"></div>' +
        '<div class="tt-core"></div>' +
        '<div class="tt-sat"></div><div class="tt-sat s2"></div>' +
      '</div>' +
      '<div><h2>Waiting for telemetry events\u2026</h2>' +
      '<p>Activities will appear here the instant FLT emits its first event.</p></div>';
    streamList.appendChild(emptyState);
    stream.appendChild(streamTb); stream.appendChild(streamList);
    body3.appendChild(stream);
    this._dom.streamList  = streamList;
    this._dom.emptyState  = emptyState;
    this._dom.streamTb    = streamTb;

    /* Right: Activity Catalog */
    const catalog = this._ce('aside', 'tt-catalog tt-panel');
    const catH = this._ce('div', 'tt-panel-h');
    catH.innerHTML =
      '<span>Activity Catalog</span>' +
      '<div class="tt-hacts">' +
        '<button class="on" data-sort="cnt">cnt</button>' +
        '<button data-sort="p95">p95</button>' +
        '<button data-sort="err">err</button>' +
      '</div>';
    const catBody = this._ce('div', 'tt-panel-body'); catBody.id = 'tt-catalog-body';
    catalog.appendChild(catH); catalog.appendChild(catBody);
    body3.appendChild(catalog);
    this._dom.catBody = catBody;
    this._dom.catH    = catH;

    /* Detail panel (absolute slide-up inside body3) */
    const detail = this._ce('div', 'tt-detail'); detail.hidden = true;
    detail.innerHTML =
      '<div class="tt-detail-grab" id="tt-detail-grab"></div>' +
      '<div class="tt-detail-h">' +
        '<div class="tt-detail-title">' +
          '<span class="tt-chan ssr" id="tt-d-chan">SSR</span>' +
          '<span class="tt-d-name" id="tt-d-name">\u2013</span>' +
          '<span class="tt-status-pill" id="tt-d-status"><span class="tt-d"></span>\u2013</span>' +
          '<span class="tt-d-iter" id="tt-d-iter">iter:\u2013</span>' +
          '<span class="tt-d-corr" id="tt-d-corr">cid:\u2013</span>' +
        '</div>' +
        '<div class="tt-detail-actions">' +
          '<button class="tt-detail-btn" id="tt-d-copy-cid">Copy correlation</button>' +
          '<button class="tt-detail-btn" id="tt-d-filter-iter">Filter iteration</button>' +
          '<button class="tt-detail-btn" id="tt-d-view-logs">View logs \u2197</button>' +
          '<button class="tt-detail-btn" id="tt-d-open-life">Open in Lifecycle \u2197</button>' +
          '<button class="tt-detail-close" id="tt-d-close" title="Close (Esc)">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6 18 18M18 6 6 18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="tt-detail-body">' +
        '<div class="tt-detail-col">' +
          '<h3>Attributes <span class="tt-pill-cnt" id="tt-d-attr-count">0</span></h3>' +
          '<div class="tt-attr-grid" id="tt-d-attr-grid"></div>' +
          '<h3>Raw payload ' +
            '<button class="tt-detail-btn" id="tt-d-fold-btn" style="float:right;margin-top:-2px">Fold all</button>' +
          '</h3>' +
          '<div class="tt-json-tree" id="tt-d-json"></div>' +
        '</div>' +
        '<div class="tt-detail-col">' +
          '<h3>Iteration timeline <span class="tt-pill-cnt" id="tt-d-tl-count">0</span></h3>' +
          '<div class="tt-timeline" id="tt-d-timeline"></div>' +
          '<h3>Related telemetry <span class="tt-pill-cnt" id="tt-d-rel-tel-count">0</span></h3>' +
          '<div id="tt-d-rel-tel"></div>' +
          '<h3>Related logs <span class="tt-pill-cnt" id="tt-d-rel-log-count">0</span></h3>' +
          '<div id="tt-d-rel-log"></div>' +
        '</div>' +
      '</div>';
    body3.appendChild(detail);
    this._dom.detail = detail;

    el.appendChild(body3);
    this._dom.body3 = body3;

    /* Toast container */
    const toasts = this._ce('div', 'tt-toast-container');
    el.appendChild(toasts);
    this._dom.toasts = toasts;
  }

  /* ═══ Event Binding ═══════════════════════════════════════════════════════ */

  _bindEvents() {
    /* Search */
    this._dom.searchInput.addEventListener('input', (e) => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._filterText = e.target.value.trim();
        this._scheduleRender();
      }, TelemetryTab.DEBOUNCE_MS);
    });

    /* Status pills */
    this._dom.statusPills.addEventListener('click', (e) => {
      const p = e.target.closest('.tt-pill');
      if (!p) return;
      this._statusFilter = p.dataset.st;
      this._updatePillStates();
      this._scheduleRender();
    });

    /* Duration slider */
    this._initSlider();

    /* Time window */
    this._dom.winSel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this._window = b.dataset.w;
      this._dom.winSel.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.w === this._window));
      this._scheduleRender();
    });

    /* Pause/Resume */
    this._dom.pauseBtn.addEventListener('click', () => {
      this._paused = !this._paused;
      this._dom.pauseBtn.classList.toggle('paused', this._paused);
      this._dom.pauseBtn.innerHTML = this._paused
        ? '<span>\u25B6</span>Resume'
        : '<span>\u23F8</span>Pause';
      const tb = this._dom.streamTb;
      if (tb) tb.classList.toggle('paused', this._paused);
      this._showToast(this._paused ? 'Stream paused' : 'Stream resumed', 'info');
    });

    /* Export */
    this._dom.exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleExport();
    });
    this._dom.exportDD.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) this._doExport(btn.dataset.format);
    });

    /* Stream list — card click */
    this._dom.streamList.addEventListener('click', (e) => {
      const card = e.target.closest('.tt-card');
      if (!card) return;
      this._selectCard(card.dataset.id);
    });

    /* Spine — iteration click (delegated) */
    this._dom.spineBody.addEventListener('click', (e) => {
      const iter = e.target.closest('.tt-iter');
      if (!iter) return;
      this._setIterFilter(iter.dataset.iter);
    });

    /* Catalog — row click (delegated) */
    this._dom.catBody.addEventListener('click', (e) => {
      const row = e.target.closest('.tt-cat-row');
      if (!row) return;
      const name = row.dataset.act;
      /* Toggle: click same row again to clear */
      this._filterText = this._filterText === name ? '' : name;
      if (this._dom.searchInput) this._dom.searchInput.value = this._filterText;
      this._scheduleRender();
    });

    /* Catalog sort buttons */
    this._dom.catH.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sort]');
      if (!b) return;
      this._dom.catH.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      this._catSort = b.dataset.sort;
      this._renderCatalog();
    });

    /* Detail panel actions */
    const dById = (id) => document.getElementById(id);
    dById('tt-d-close')       ?.addEventListener('click', () => this._closeDetail());
    dById('tt-d-copy-cid')    ?.addEventListener('click', () => this._copyCorrelation());
    dById('tt-d-filter-iter') ?.addEventListener('click', () => this._filterIteration());
    dById('tt-d-view-logs')   ?.addEventListener('click', () => this._viewInLogs());
    dById('tt-d-open-life')   ?.addEventListener('click', () => this._openInLifecycle());
    dById('tt-d-fold-btn')    ?.addEventListener('click', () => this._toggleJsonFold());
    this._initDetailResize();

    /* Keyboard */
    this._boundKeyDown = (e) => { if (this._active) this._onKeyDown(e); };

    /* Close export on outside click */
    this._boundDocClick = (e) => {
      if (!this._active) return;
      if (this._exportOpen && !e.target.closest('.tt-export-wrap')) {
        this._dom.exportDD.classList.remove('open');
        this._exportOpen = false;
      }
    };
  }

  /* ═══ Rendering ════════════════════════════════════════════════════════════ */

  _scheduleRender() {
    if (this._renderRAF) return;
    this._renderRAF = requestAnimationFrame(() => {
      this._renderRAF = null;
      this._render();
    });
  }

  _render() {
    const visible = this._getVisible();
    this._renderMetrics();
    this._renderSpine();
    this._renderCatalog();
    this._renderStream(visible);
    this._updateCounts(visible);
    this._updatePillStates();
    this._syncWindowSel();
  }

  _renderMetrics() {
    const evs = this._events;
    const now = Date.now();
    const lastMin = evs.filter(e => now - e.timestampMs < 60_000);
    const eventsPerMin = lastMin.length;
    const errInMin  = lastMin.filter(e => e.status === 'failed').length;
    const errRate   = lastMin.length ? (errInMin / lastMin.length * 100) : 0;
    const activeIters = Array.from(this._iterMap.values()).filter(i => i.status === 'running').length;
    const total     = evs.length;
    const durs      = evs.filter(e => e.durationMs > 0 && e.status !== 'running').map(e => e.durationMs);
    const p95       = Math.round(this._quantile(durs, 0.95));
    const p50       = Math.round(this._quantile(durs, 0.50));

    const setV = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const setText = (id, t)  => { const el = document.getElementById(id); if (el) el.textContent = t; };

    setV('tt-m-events',  eventsPerMin + '<span class="tt-m-unit">/min</span>');
    setV('tt-m-err',     errRate.toFixed(1) + '<span class="tt-m-unit">%</span>');
    const errEl = document.getElementById('tt-m-err');
    if (errEl) errEl.style.color = errRate > 5 ? 'var(--status-failed)' : errRate > 2 ? 'var(--status-cancelled)' : '';
    setV('tt-m-active',  String(activeIters));
    setText('tt-msub-active', this._iterMap.size + ' total');
    setV('tt-m-p95',   (durs.length ? p95 : '\u2014') + '<span class="tt-m-unit">ms</span>');
    setText('tt-msub-p95', durs.length ? 'p50 ' + p50 + ' ms' : '\u2014');
    setV('tt-m-total', total.toLocaleString());
    setText('tt-msub-total', total === 1 ? '1 event' : total.toLocaleString() + ' events');

    /* Mini metric sparklines (no sparkline data → skip) */
    this._metricHistory.events.push(eventsPerMin);
    this._metricHistory.err.push(errRate);
    this._metricHistory.p95.push(p95);
    if (this._metricHistory.events.length > 30) this._metricHistory.events.shift();
    if (this._metricHistory.err.length    > 30) this._metricHistory.err.shift();
    if (this._metricHistory.p95.length    > 30) this._metricHistory.p95.shift();
    const spark = (id, vals, color) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = this._miniSparkPath(vals, color);
    };
    spark('tt-spark-events', this._metricHistory.events, 'var(--accent)');
    spark('tt-spark-err',    this._metricHistory.err,    'var(--status-failed)');
    spark('tt-spark-p95',    this._metricHistory.p95,    'var(--level-message)');
  }

  _renderSpine() {
    const host = this._dom.spineBody;
    if (!host) return;
    host.innerHTML = '';
    const countEl = document.getElementById('tt-iter-count');
    if (countEl) countEl.textContent = this._iterMap.size;

    /* Top SPINE_LIMIT iterations sorted by most-recent-event-at */
    const iters = Array.from(this._iterMap.values())
      .sort((a, b) => b.lastEventAt - a.lastEventAt)
      .slice(0, TelemetryTab.SPINE_LIMIT);

    if (iters.length === 0) {
      host.innerHTML = '<div class="tt-spine-empty">No iterations yet \u2014 events grouped by IterationId will appear here.</div>';
      return;
    }

    const curIter = this._iter;
    iters.forEach(it => {
      const total = it.eventIds.length;
      const failCount = it.eventIds.filter(id => {
        const ev = this._eventById.get(id);
        return ev && ev.status === 'failed';
      }).length;
      const failPct = total ? (failCount / total) * 100 : 0;
      const okPct   = 100 - failPct;
      const segs =
        (okPct > 0   ? '<span class="tt-ssr" style="width:' + okPct.toFixed(1) + '%"></span>' : '') +
        (failPct > 0 ? '<span class="tt-fail" style="width:' + failPct.toFixed(1) + '%"></span>' : '');

      const wrap = this._ce('div', 'tt-iter' + (curIter === it.id ? ' sel' : ''));
      wrap.dataset.iter = it.id;
      wrap.innerHTML =
        '<div class="tt-iter-h">' +
          '<span class="tt-iter-id">' + this._esc(it.id.slice(0, 8)) + '</span>' +
          '<span class="tt-iter-status ' + it.status + '"><span class="tt-d"></span>' + it.status + '</span>' +
        '</div>' +
        '<div class="tt-iter-meta"><span>\u2014</span><span>' + total + ' events</span></div>' +
        '<div class="tt-iter-track">' + segs + '</div>' +
        '<div class="tt-iter-events">' +
          '<span>' + total + (total === 1 ? ' event' : ' events') + '</span>' +
          (failCount > 0 ? '<span style="color:var(--status-failed)">\u2715 ' + failCount + '</span>' : '') +
        '</div>';
      host.appendChild(wrap);
    });
  }

  _renderCatalog() {
    const host = this._dom.catBody;
    if (!host) return;
    host.innerHTML = '';

    const rows = Array.from(this._catMap.values());
    const sort = this._catSort;
    rows.sort((a, b) => {
      if (sort === 'p95') return this._quantile(b.durations, 0.95) - this._quantile(a.durations, 0.95);
      if (sort === 'err') return (b.errCount / Math.max(1, b.count)) - (a.errCount / Math.max(1, a.count));
      return b.count - a.count; // default: cnt
    });

    const curQ = this._filterText;
    rows.forEach(r => {
      const p50 = Math.round(this._quantile(r.durations, 0.50));
      const p95 = Math.round(this._quantile(r.durations, 0.95));
      const errPct  = r.count ? (r.errCount  / r.count * 100) : 0;
      const chans = Array.from(r.channels);
      const chanCls = chans.length >= 2 ? 'dual' : (chans[0] || 'ssr');
      const isSel = curQ === r.name;

      const row = this._ce('div', 'tt-cat-row' + (isSel ? ' sel' : ''));
      row.dataset.act = r.name;
      row.innerHTML =
        '<div class="tt-cat-h">' +
          '<div class="tt-cat-name"><span class="tt-chan-mini ' + chanCls + '" title="' + chans.join(' + ') + '"></span>' + this._esc(r.name) + '</div>' +
          '<div class="tt-cat-count">' + r.count + '</div>' +
        '</div>' +
        '<div class="tt-cat-stats">' +
          '<span><span class="k">p50</span> <span class="v">' + (r.durations.length ? p50 + 'ms' : '\u2014') + '</span></span>' +
          '<span><span class="k">p95</span> <span class="v">' + (r.durations.length ? p95 + 'ms' : '\u2014') + '</span></span>' +
          '<span><span class="k">err</span> <span class="v ' + (errPct > 5 ? 'err' : errPct > 2 ? 'warn' : '') + '">' + errPct.toFixed(1) + '%</span></span>' +
        '</div>' +
        '<div class="tt-cat-spark">' + this._sparklineSvg(r.spark) + '</div>';
      host.appendChild(row);
    });
  }

  _renderStream(visible) {
    const list   = this._dom.streamList;
    const empty  = this._dom.emptyState;
    if (!list || !empty) return;

    /* Empty state */
    if (this._events.length === 0) {
      empty.classList.remove('hidden');
      const oldCards = list.querySelectorAll('.tt-card, .tt-section-h, .tt-no-results');
      oldCards.forEach(c => c.remove());
      return;
    }
    empty.classList.add('hidden');

    if (visible.length === 0) {
      const oldCards = list.querySelectorAll('.tt-card, .tt-section-h, .tt-no-results');
      oldCards.forEach(c => c.remove());
      const nr = this._ce('div', 'tt-no-results');
      nr.textContent = 'No events match current filters';
      list.appendChild(nr);
      return;
    }

    const running   = visible.filter(a => a.status === 'running');
    const completed = visible.filter(a => a.status !== 'running');

    let html = '';
    if (running.length > 0) {
      html += '<div class="tt-section-h act"><span>Active</span><span class="tt-sh-count">' + running.length + '</span></div>';
      for (const a of running) html += this._buildStreamCardHTML(a);
    }
    if (completed.length > 0) {
      html += '<div class="tt-section-h"><span>Completed</span><span class="tt-sh-count">' + completed.length + '</span></div>';
      for (const a of completed) html += this._buildStreamCardHTML(a);
    }

    const frag = document.createRange().createContextualFragment(html);
    const toRemove = Array.from(list.children).filter(c => c !== empty);
    toRemove.forEach(c => c.remove());
    list.insertBefore(frag, empty);
  }

  /* Display status resolver.
   * The stream is SSR-only (Additional/+TEL events are dropped at ingest —
   * see _onEvent). Every row therefore carries a real SSR lifecycle status,
   * so the badge is simply that status. No 'mirror' fallback, no twin
   * resolution — those existed only to paper over +TEL rows that no longer
   * enter the stream. */
  _displayStatus(a) {
    return a.status;
  }

  _buildStreamCardHTML(a) {
    const isRunning  = a.status === 'running';
    const isFailed   = a.status === 'failed';
    const isWarning  = a.status === 'warning';
    const isLong     = !isRunning && a.durationMs > TelemetryTab.LONG_THRESHOLD_MS;
    const chanLabel  = a.channel === 'ssr' ? 'SSR' : '+TEL';
    const durMs      = isRunning ? (Date.now() - a.startTime) : a.durationMs;
    const durText    = isRunning ? '\u2026' : this._fmtDurMs(durMs);
    const barPct     = Math.min(100, Math.max(2, durMs / TelemetryTab.MAX_SLIDER_MS * 100));
    const barCls     = isFailed ? 'fail' : isLong ? 'long' : '';
    const relLogs    = this._getRelatedLogsCount(a);
    const relLogsStr = relLogs > 99 ? '99+' : String(relLogs);
    const seqNum     = a.seqId != null ? a.seqId : '';
    const attrCount  = Object.keys(a.attributes).length;
    const isSel      = a.id === this._selectedId;
    const iterShort  = a.iterationId ? a.iterationId.slice(0, 8) : '';
    const failCls    = isFailed ? ' failed' : isWarning ? ' warning' : '';
    const selCls     = isSel ? ' sel' : '';

    return '<div class="tt-card' + failCls + selCls + '" data-id="' + a.id + '" tabindex="0">' +
      '<div class="tt-seq">' + seqNum + '</div>' +
      '<div class="tt-chan ' + a.channel + '">' + chanLabel + '</div>' +
      '<div class="tt-cname">' +
        '<span class="tt-clabel">' + this._highlightText(a.name, this._filterText) + '</span>' +
        (iterShort ? '<span class="tt-iter-ref">iter:' + this._esc(iterShort) + '</span>' : '') +
        '<span class="tt-attr-cnt">' + attrCount + ' attrs</span>' +
      '</div>' +
      '<div><span class="tt-status-pill ' + this._displayStatus(a) + '"><span class="tt-d"></span>' + this._displayStatus(a) + '</span></div>' +
      '<div class="tt-dur-cell">' +
        '<div class="tt-dur-bar ' + barCls + '">' +
          '<span style="width:' + (isRunning ? '30' : barPct) + '%"></span>' +
        '</div>' +
        '<span class="tt-dur-num">' + durText + '</span>' +
      '</div>' +
      '<div class="tt-ts">' + this._fmtTime(a.timestamp) + '<br><span style="color:var(--text-muted)">' + this._fmtAgo(a.timestampMs) + '</span></div>' +
      '<div><span class="tt-logs-pill" title="Related logs">\u25A4 ' + relLogsStr + '</span></div>' +
      '<div class="tt-more">\u22EF</div>' +
    '</div>';
  }

  /* ═══ Counts & Pill States ════════════════════════════════════════════════ */

  _updateCounts(visible) {
    const total    = this._events.length;
    const visCount = visible.length;
    let runCnt = 0, sucCnt = 0, failCnt = 0, warnCnt = 0, cancCnt = 0;
    for (const e of this._events) {
      if (e.status === 'running')   runCnt++;
      else if (e.status === 'succeeded') sucCnt++;
      else if (e.status === 'failed')    failCnt++;
      else if (e.status === 'warning')   warnCnt++;
      else if (e.status === 'cancelled') cancCnt++;
    }
    const setText = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    setText('tt-cntst-all',       total);
    setText('tt-cntst-running',   runCnt);
    setText('tt-cntst-succeeded', sucCnt);
    setText('tt-cntst-failed',    failCnt);
    setText('tt-cntst-warning',   warnCnt);
    setText('tt-cntst-cancelled', cancCnt);

    const sumEl = document.getElementById('tt-filter-summary');
    if (sumEl) sumEl.innerHTML = 'showing <span class="k">' + visCount + '</span> of <span class="k">' + total + '</span> events';
  }

  _updatePillStates() {
    const sf = this._statusFilter;
    if (this._dom.statusPills) {
      this._dom.statusPills.querySelectorAll('.tt-pill').forEach(p =>
        p.classList.toggle('active', p.dataset.st === sf));
    }
  }

  _syncWindowSel() {
    const win = this._window;
    if (this._dom.winSel) {
      this._dom.winSel.querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.w === win));
    }
  }

  _syncFilterUi() {
    try {
      if (this._dom.searchInput && this._filterText) this._dom.searchInput.value = this._filterText;
      this._updatePillStates();
      this._syncWindowSel();
    } catch (_e) { /* never crash activate over UI sync */ }
  }

  /* ═══ Interaction ═════════════════════════════════════════════════════════ */

  _selectCard(id) {
    this._selectedId = id;
    this._dom.streamList.querySelectorAll('.tt-card').forEach(c =>
      c.classList.toggle('sel', c.dataset.id === id));
    const cardEls = Array.from(this._dom.streamList.querySelectorAll('.tt-card'));
    this._kbIndex = cardEls.findIndex(c => c.dataset.id === id);
    const activity = this._eventById.get(id);
    if (activity) this._openDetail(activity);
  }

  /**
   * Set iteration filter + cross-tab correlator.
   * Toggle: clicking same iter clears the filter.
   */
  _setIterFilter(iterId) {
    const current = this._iter;
    const next    = (current === iterId) ? null : iterId;
    this._iter = next;
    if (window.edogIterationCorrelator && typeof window.edogIterationCorrelator.setActiveIteration === 'function') {
      window.edogIterationCorrelator.setActiveIteration(next);
    }
    this._scheduleRender();
  }

  /* ═══ Detail Panel ════════════════════════════════════════════════════════ */

  _openDetail(a) {
    const detail = this._dom.detail;
    detail.hidden = false;
    this._detailOpen = true;

    /* Header */
    const chanEl = document.getElementById('tt-d-chan');
    if (chanEl) { chanEl.className = 'tt-chan ' + a.channel; chanEl.textContent = a.channel === 'ssr' ? 'SSR' : '+TEL'; }
    const nameEl = document.getElementById('tt-d-name');
    if (nameEl) nameEl.textContent = a.name;
    const statEl = document.getElementById('tt-d-status');
    if (statEl) { const ds = this._displayStatus(a); statEl.className = 'tt-status-pill ' + ds; statEl.innerHTML = '<span class="tt-d"></span>' + ds; }
    const iterEl = document.getElementById('tt-d-iter');
    if (iterEl) iterEl.textContent = 'iter:' + (a.iterationId ? a.iterationId.slice(0, 8) : '\u2013');
    const corrEl = document.getElementById('tt-d-corr');
    if (corrEl) corrEl.textContent = 'cid:' + (a.correlationId ? a.correlationId.slice(0, 12) : '\u2013');

    /* Attribute grid */
    const grid = document.getElementById('tt-d-attr-grid');
    const attrCount = document.getElementById('tt-d-attr-count');
    if (grid) {
      grid.innerHTML = '';
      const entries = Object.entries(a.attributes || {});
      if (attrCount) attrCount.textContent = entries.length;
      entries.forEach(([k, v]) => {
        const typ = this._inferAttrType(k, v);
        const keyDiv = this._ce('div', 'k');
        keyDiv.innerHTML = '<span>' + this._esc(k) + '</span><span class="typ">' + typ + '</span>';
        const valDiv = this._ce('div', 'v');
        valDiv.textContent = String(v);
        grid.appendChild(keyDiv);
        grid.appendChild(valDiv);
      });
    }

    /* JSON tree */
    const jsonEl = document.getElementById('tt-d-json');
    if (jsonEl) {
      jsonEl.innerHTML = '';
      jsonEl.appendChild(this._buildJsonNode(a, this._jsonFolded, true));
    }
    const foldBtn = document.getElementById('tt-d-fold-btn');
    if (foldBtn) foldBtn.textContent = this._jsonFolded ? 'Expand all' : 'Fold all';

    /* Related telemetry (same iteration, excl. self) */
    const relTelEl    = document.getElementById('tt-d-rel-tel');
    const relTelCount = document.getElementById('tt-d-rel-tel-count');
    if (relTelEl) {
      const rel = this._events.filter(e => e.iterationId === a.iterationId && e.id !== a.id).slice(0, 10);
      if (relTelCount) relTelCount.textContent = Math.max(0, this._events.filter(e => e.iterationId === a.iterationId).length - 1);
      relTelEl.innerHTML = rel.map(r =>
        '<div class="tt-related-row" data-id="' + r.id + '">' +
          '<span class="tt-chan ' + r.channel + '">' + (r.channel === 'ssr' ? 'SSR' : '+TEL') + '</span>' +
          '<span class="tt-rlvl ' + r.status + '">' + r.status + '</span>' +
          '<span class="tt-rmsg">' + this._esc(r.name) + '</span>' +
          '<span class="tt-rts">' + this._fmtTime(r.timestamp) + '</span>' +
        '</div>'
      ).join('');
      relTelEl.querySelectorAll('.tt-related-row').forEach(row =>
        row.addEventListener('click', () => {
          const ev = this._eventById.get(row.dataset.id);
          if (ev) this._openDetail(ev);
        })
      );
    }

    /* Related logs count */
    const relLogEl    = document.getElementById('tt-d-rel-log');
    const relLogCount = document.getElementById('tt-d-rel-log-count');
    const logCount = this._getRelatedLogsCount(a);
    if (relLogCount) relLogCount.textContent = logCount > 99 ? '99+' : logCount;
    if (relLogEl) {
      if (logCount > 0) {
        relLogEl.innerHTML = '<div class="tt-related-row" style="cursor:default;color:var(--text-muted)">' +
          logCount + ' log entr' + (logCount === 1 ? 'y' : 'ies') + ' linked to this event \u2014 ' +
          '<span style="color:var(--accent);cursor:pointer" id="tt-goto-logs">View in Logs \u2197</span>' +
          '</div>';
        document.getElementById('tt-goto-logs')?.addEventListener('click', () => this._viewInLogs());
      } else {
        relLogEl.innerHTML = '<div class="tt-related-row" style="cursor:default;color:var(--text-muted)">No linked log entries in buffer</div>';
      }
    }

    /* Iteration timeline */
    this._renderIterTimeline(a);
  }

  _renderIterTimeline(curEv) {
    const tlEl    = document.getElementById('tt-d-timeline');
    const tlCount = document.getElementById('tt-d-tl-count');
    if (!tlEl) return;
    const it = curEv.iterationId ? this._iterMap.get(curEv.iterationId) : null;
    if (!it) {
      tlEl.innerHTML = '<span style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px">iteration not in buffer</span>';
      if (tlCount) tlCount.textContent = '0';
      return;
    }
    const events = it.eventIds.map(id => this._eventById.get(id)).filter(Boolean)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    if (tlCount) tlCount.textContent = events.length;
    if (events.length < 2) {
      tlEl.innerHTML = '<span style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px;padding:0 12px">single event in iteration</span>';
      return;
    }
    const t0  = events[0].timestampMs;
    const t1  = events[events.length - 1].timestampMs;
    const span = Math.max(1, t1 - t0);
    let html = '<div class="tt-tl-scale"></div>';
    events.forEach(e => {
      const pct = (e.timestampMs - t0) / span;
      const left = 10 + pct * 280;
      const isCur = e.id === curEv.id;
      html += '<div class="tt-tl-marker ' + e.channel + (isCur ? ' cur' : '') + '" style="left:' + left + 'px" title="' + this._esc(e.name) + ' \u00B7 ' + this._fmtDurMs(e.durationMs) + '"></div>';
    });
    tlEl.innerHTML = html;
  }

  _inferAttrType(k, v) {
    if (typeof v === 'number')  return 'num';
    if (typeof v === 'boolean') return 'bool';
    if (/Id$|id$/i.test(k))     return 'id';
    if (/DurationMs|Duration|TimeoutMs|ElapsedMs/.test(k)) return 'dur';
    if (/Code|Status|Type|Name|Version/.test(k)) return 'code';
    return 'str';
  }

  _buildJsonNode(value, folded, isRoot) {
    const wrap = this._ce('div', 'tt-jt' + (folded ? ' folded' : ''));
    if (value === null || value === undefined) {
      wrap.innerHTML = '<span class="jnull">null</span>'; return wrap;
    }
    if (Array.isArray(value)) {
      const head = this._ce('div');
      head.innerHTML = '<span class="tog">' + (folded ? '\u25B8' : '\u25BE') + '</span><span class="jpunc">[ </span><span style="color:var(--text-muted)">' + value.length + ' items</span><span class="jpunc"> ]</span>';
      wrap.appendChild(head);
      value.slice(0, 50).forEach((v, i) => {
        const child = this._ce('div');
        child.innerHTML = '<span class="jkey">' + i + '</span><span class="jpunc">: </span>';
        child.appendChild(this._formatJsonLeaf(v));
        wrap.appendChild(child);
      });
      this._bindJsonToggle(head, wrap);
      return wrap;
    }
    if (typeof value === 'object') {
      const head = this._ce('div');
      head.innerHTML = '<span class="tog">' + (folded ? '\u25B8' : '\u25BE') + '</span><span class="jpunc">{ </span><span style="color:var(--text-muted)">' + Object.keys(value).length + ' keys</span><span class="jpunc"> }</span>';
      wrap.appendChild(head);
      Object.entries(value).slice(0, 50).forEach(([k, v]) => {
        const child = this._ce('div');
        child.innerHTML = '<span class="jkey">"' + this._esc(k) + '"</span><span class="jpunc">: </span>';
        if (v && typeof v === 'object') child.appendChild(this._buildJsonNode(v, true, false));
        else child.appendChild(this._formatJsonLeaf(v));
        wrap.appendChild(child);
      });
      this._bindJsonToggle(head, wrap);
      return wrap;
    }
    wrap.appendChild(this._formatJsonLeaf(value));
    return wrap;
  }

  _formatJsonLeaf(v) {
    const s = this._ce('span', '');
    if (typeof v === 'string')  { s.className = 'jstr';  s.textContent = '"' + v + '"'; }
    else if (typeof v === 'number')  { s.className = 'jnum';  s.textContent = v; }
    else if (typeof v === 'boolean') { s.className = 'jbool'; s.textContent = String(v); }
    else if (v === null)  { s.className = 'jnull'; s.textContent = 'null'; }
    else { s.textContent = String(v); }
    return s;
  }

  _bindJsonToggle(head, wrap) {
    head.style.cursor = 'pointer';
    head.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('folded');
      const tog = head.querySelector('.tog');
      if (tog) tog.textContent = wrap.classList.contains('folded') ? '\u25B8' : '\u25BE';
    });
  }

  _toggleJsonFold() {
    const tree = document.getElementById('tt-d-json');
    if (!tree) return;
    this._jsonFolded = !this._jsonFolded;
    tree.querySelectorAll('.tt-jt').forEach(n => {
      if (this._jsonFolded) n.classList.add('folded'); else n.classList.remove('folded');
      const tog = n.querySelector(':scope > div > .tog');
      if (tog) tog.textContent = this._jsonFolded ? '\u25B8' : '\u25BE';
    });
    const btn = document.getElementById('tt-d-fold-btn');
    if (btn) btn.textContent = this._jsonFolded ? 'Expand all' : 'Fold all';
  }

  _closeDetail() {
    this._dom.detail.hidden = true;
    this._detailOpen = false;
    this._selectedId = null;
    if (this._dom.streamList) {
      this._dom.streamList.querySelectorAll('.tt-card').forEach(c => c.classList.remove('sel'));
    }
  }

  _viewInLogs() {
    const a = this._events.find(x => x.id === this._selectedId);
    if (!a) return;
    const iterId = a.iterationId || a.correlationId;
    if (window.studioSetFilter) window.studioSetFilter('logs', { raid: iterId });
    if (window.studioState) window.studioState.set({ activeTab: 'logs' });
    this._showToast('Switched to Logs \u2192 iteration filter set');
  }

  _copyCorrelation() {
    const a = this._events.find(x => x.id === this._selectedId);
    if (!a) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(a.correlationId || '')
        .then(() => this._showToast('Copied \u00B7 ' + (a.correlationId || '').slice(0, 12)))
        .catch(() => this._showToast('Copy failed \u2014 check permissions'));
    } else {
      this._showToast('Clipboard unavailable');
    }
  }

  _filterIteration() {
    const a = this._events.find(x => x.id === this._selectedId);
    if (!a || !a.iterationId) return;
    this._setIterFilter(a.iterationId);
    this._showToast('Filtered to iteration ' + a.iterationId.slice(0, 8), 'info');
  }

  _openInLifecycle() {
    this._showToast('Opening Lifecycle Inspector\u2026', 'info');
  }

  _initDetailResize() {
    const grab  = document.getElementById('tt-detail-grab');
    const panel = this._dom.detail;
    if (!grab || !panel) return;
    let startY, startH;
    grab.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY; startH = panel.offsetHeight;
      const onMove = (ev) => {
        const diff = startY - ev.clientY;
        panel.style.height    = Math.max(200, startH + diff) + 'px';
        panel.style.maxHeight = '80%';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  /* ═══ Ticking (running duration + periodic refresh) ══════════════════════ */

  _startTicking() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => this._onTick(), TelemetryTab.TICK_MS);
  }

  _stopTicking() {
    clearInterval(this._tickInterval);
    this._tickInterval = null;
  }

  _onTick() {
    if (!this._active || this._paused) return;
    /* Update durations on running cards in-place (fast DOM patch, no full re-render) */
    const now = Date.now();
    const list = this._dom.streamList;
    if (list) {
      list.querySelectorAll('.tt-card').forEach(card => {
        const id = card.dataset.id;
        const ev = this._eventById.get(id);
        if (!ev || ev.status !== 'running') return;
        const durMs  = now - ev.startTime;
        const numEl  = card.querySelector('.tt-dur-num');
        if (numEl) numEl.textContent = this._fmtDurMs(durMs);
        const barSpan = card.querySelector('.tt-dur-bar span');
        if (barSpan) barSpan.style.width = Math.min(100, durMs / TelemetryTab.MAX_SLIDER_MS * 100) + '%';
      });
    }
  }

  /* ═══ Duration Slider ═════════════════════════════════════════════════════ */

  _initSlider() {
    const slider = document.getElementById('tt-dur-slider');
    const thumb  = document.getElementById('tt-dur-thumb');
    const fill   = document.getElementById('tt-dur-fill');
    const label  = document.getElementById('tt-dur-val');
    if (!slider || !thumb) return;

    let dragging = false;
    const setFromX = (clientX) => {
      const rect = slider.getBoundingClientRect();
      let pct = (clientX - rect.left) / (rect.width || 1);
      pct = Math.max(0, Math.min(1, pct));
      thumb.style.left = (pct * 100).toFixed(1) + '%';
      if (fill) fill.style.right = ((1 - pct) * 100).toFixed(1) + '%';
      const ms = Math.round(100 + pct * (TelemetryTab.MAX_SLIDER_MS - 100));
      const atMax = pct >= 0.999;
      // At the far-right ("all") position the duration filter must be DISABLED,
      // not capped at MAX_SLIDER_MS. _getVisible treats dMax === 0 as "no upper
      // bound"; setting it to MAX_SLIDER_MS here would silently hide every
      // event longer than 5s (i.e. every real DAG/Spark activity) while the
      // label still reads "all" — the "showing 0 of N" bug.
      this._durMax = atMax ? 0 : ms;
      if (label) label.textContent = atMax ? 'all' : ms + 'ms';
      this._scheduleRender();
    };

    thumb.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (dragging) setFromX(e.clientX); });
    document.addEventListener('mouseup',   () => { dragging = false; });
    slider.addEventListener('click', e => setFromX(e.clientX));

    /* Reflect persisted state so the thumb never lies about the active filter.
     * dMax === 0 (or >= MAX) means "all" → thumb hard right. */
    const persisted = this._durMax;
    const pct = (!persisted || persisted >= TelemetryTab.MAX_SLIDER_MS)
      ? 1
      : Math.max(0, Math.min(1, (persisted - 100) / (TelemetryTab.MAX_SLIDER_MS - 100)));
    thumb.style.left = (pct * 100).toFixed(1) + '%';
    if (fill) fill.style.right = ((1 - pct) * 100).toFixed(1) + '%';
    if (label) label.textContent = pct >= 0.999 ? 'all' : Math.round(persisted) + 'ms';
  }

  /* ═══ Export ══════════════════════════════════════════════════════════════ */

  _toggleExport() {
    this._exportOpen = !this._exportOpen;
    this._dom.exportDD.classList.toggle('open', this._exportOpen);
  }

  _doExport(format) {
    const visible = this._getVisible();
    if (format === 'json') {
      const payload = visible.map(a => ({
        name: a.name, status: a.status, channel: a.channel, durationMs: a.durationMs,
        resultCode: a.resultCode, correlationId: a.correlationId,
        iterationId: a.iterationId, attributes: a.attributes,
        userId: a.userId, timestamp: a.timestamp, error: a.error,
      }));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      this._downloadBlob(blob, 'telemetry-export.json');
    } else {
      let csv = 'Name,Status,Channel,Duration(ms),ResultCode,CorrelationId,IterationId,Error\n';
      visible.forEach(a => {
        csv += '"' + (a.name || '').replace(/"/g, '""') + '",' +
               '"' + a.status + '",' + '"' + a.channel + '",' + a.durationMs + ',' +
               '"' + (a.resultCode || '') + '",' + '"' + (a.correlationId || '') + '",' +
               '"' + (a.iterationId || '') + '",' + '"' + (a.error || '').replace(/"/g, '""') + '"\n';
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      this._downloadBlob(blob, 'telemetry-export.csv');
    }
    this._showToast('Exported ' + visible.length + ' events as ' + format.toUpperCase(), 'info');
    this._dom.exportDD.classList.remove('open');
    this._exportOpen = false;
  }

  _downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  /* ═══ Toast ═══════════════════════════════════════════════════════════════ */

  _showToast(msg, kind) {
    const host = this._dom.toasts;
    if (!host) return;
    const t = this._ce('div', 'tt-toast' + (kind ? ' ' + kind : ''));
    t.innerHTML = '<span class="tt-td"></span>' + this._esc(msg);
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 2400);
    setTimeout(() => t.remove(), 2700);
  }

  /* ═══ Keyboard ════════════════════════════════════════════════════════════ */

  _onKeyDown(e) {
    const target = e ? e.target : null;
    const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    if (e.key === '/' && !inInput) {
      e.preventDefault(); this._dom.searchInput?.focus(); return;
    }
    if (e.key === 'Escape') {
      if (this._detailOpen) { this._closeDetail(); return; }
      if (this._exportOpen) { this._dom.exportDD.classList.remove('open'); this._exportOpen = false; return; }
      if (this._iter || (this._filterText && this._filterText.length > 0)) {
        this._iter = null; this._filterText = ''; if (this._dom.searchInput) this._dom.searchInput.value = '';
        this._scheduleRender(); return;
      }
      return;
    }
    if (inInput) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      this._statusFilter = 'all';
      this._iter = null; this._filterText = '';
      if (this._dom.searchInput) this._dom.searchInput.value = '';
      this._scheduleRender(); this._showToast('Filters cleared', 'info'); return;
    }
    const cards = this._dom.streamList ? Array.from(this._dom.streamList.querySelectorAll('.tt-card')) : [];
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (cards.length) { this._kbIndex = Math.min(cards.length - 1, this._kbIndex + 1); this._applyKbSelection(cards); }
      return;
    }
    if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (cards.length) { this._kbIndex = Math.max(0, this._kbIndex - 1); this._applyKbSelection(cards); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const c = cards[this._kbIndex];
      if (c) this._selectCard(c.dataset.id);
      return;
    }
    if (e.key === ' ') { e.preventDefault(); this._dom.pauseBtn?.click(); return; }
    /* Keys 1-6: cycle status pills */
    const statusMap = { '1': 'running', '2': 'succeeded', '3': 'failed', '4': 'warning', '5': 'cancelled', '6': 'all' };
    if (statusMap[e.key]) { this._statusFilter = statusMap[e.key]; this._updatePillStates(); this._scheduleRender(); }
  }

  _applyKbSelection(cards) {
    cards.forEach((c, i) => c.classList.toggle('sel', i === this._kbIndex));
    const c = cards[this._kbIndex];
    if (c) { c.scrollIntoView({ block: 'nearest' }); this._selectedId = c.dataset.id; }
  }

  /* ═══ Utilities ═══════════════════════════════════════════════════════════ */

  _fmtDurMs(ms) {
    if (!ms || ms < 1)     return '0ms';
    if (ms < 1000)         return Math.round(ms) + 'ms';
    if (ms < 10_000)       return (ms / 1000).toFixed(2) + 's';
    if (ms < 60_000)       return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return m + 'm ' + s + 's';
  }

  /* Legacy alias (takes seconds, converts) — kept for compat */
  _fmtDur(sec) { return this._fmtDurMs(sec * 1000); }

  _fmtTime(isoStr) {
    try {
      const d = new Date(isoStr);
      return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
    } catch (_) { return isoStr || '\u2013'; }
  }

  _fmtAgo(tsMs) {
    if (!tsMs) return '';
    const diffMs = Date.now() - tsMs;
    if (diffMs < 1000)  return 'now';
    if (diffMs < 60_000) return Math.round(diffMs / 1000) + 's ago';
    if (diffMs < 3_600_000) return Math.round(diffMs / 60_000) + 'm ago';
    return Math.round(diffMs / 3_600_000) + 'h ago';
  }

  _quantile(arr, q) {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const idx = q * (sorted.length - 1);
    const lo  = Math.floor(idx);
    const hi  = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
  }

  /**
   * Count log entries related to this event.
   * Reads window.edogState.logs (RingBuffer or array).
   * Matches by rootActivityId === event.correlationId OR iterationId === event.iterationId.
   */
  _getRelatedLogsCount(event) {
    const logsState = window.edogState && window.edogState.logs;
    if (!logsState) return 0;
    const entries = Array.isArray(logsState) ? logsState : (logsState._buf || []);
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      if ((event.correlationId && entry.rootActivityId === event.correlationId) ||
          (event.iterationId   && entry.iterationId    === event.iterationId)) {
        count++;
      }
    }
    return Math.min(count, 99);
  }

  _sparklineSvg(values) {
    if (!values || values.length < 2) return '';
    const w = 260, h = 18;
    const max = Math.max.apply(null, values) || 1;
    const step = w / (values.length - 1);
    let bars = '';
    values.forEach((v, i) => {
      const x  = i * step - 1;
      const hh = Math.max(1, (v / max) * (h - 4));
      const y  = h - hh - 1;
      const last = i === values.length - 1;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="2" height="' + hh.toFixed(1) + '" fill="' + (last ? 'var(--accent)' : 'var(--text-muted)') + '" opacity="' + (last ? 1 : 0.5) + '"/>';
    });
    let d = '';
    values.forEach((v, i) => { const x = i * step; const y = h - (v / max) * (h - 4) - 2; d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' '; });
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<line stroke="var(--border-bright)" stroke-width="0.5" stroke-dasharray="1 2" x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '"/>' +
      bars +
      '<path d="' + d + '" stroke="var(--accent)" stroke-width="1.2" fill="none" opacity="0.85"/>' +
    '</svg>';
  }

  _miniSparkPath(values, color) {
    if (!values || values.length < 2) return '';
    const w = 60, h = 20;
    const max = Math.max.apply(null, values) || 1;
    const step = w / (values.length - 1);
    let d = '';
    values.forEach((v, i) => { const x = i * step; const y = h - (v / max) * (h - 3) - 1.5; d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' '; });
    const fill = d + 'L' + w + ',' + h + ' L0,' + h + ' Z';
    return '<path d="' + fill + '" fill="' + color + '" opacity="0.10"/>' +
           '<path d="' + d + '" stroke="' + color + '" stroke-width="1.2" fill="none" opacity="0.8"/>';
  }

  _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _ce(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  _clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  _highlightText(text, query) {
    if (!query) return this._esc(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return this._esc(text);
    return this._esc(text.slice(0, idx)) +
      '<mark>' + this._esc(text.slice(idx, idx + query.length)) + '</mark>' +
      this._esc(text.slice(idx + query.length));
  }
}
