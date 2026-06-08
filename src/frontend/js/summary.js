/**
 * EDOG Real-Time Log Viewer — Execution Summary (Vertical Drawer)
 *
 * Renders execution analytics into a slide-in right drawer (#exec-drawer):
 *   - Hero status (orb + label + duration + iteration id + dag name)
 *   - Glass metric cards (status, duration, nodes ring, errors, refresh, parallel)
 *   - Node breakdown (vertical cards with status pill + proportional duration bar)
 *   - Errors (red-tinted cards with code/node/count/message)
 *   - Key Moments Timeline (vertical dotted rail with colored dots)
 *
 * Data-extraction (compute / extract*) is preserved verbatim from the previous
 * implementation. Only render() and clearSummary() are reshaped for the drawer.
 */

class ExecutionSummary {
  constructor(state, renderer) {
    this.state = state;
    this.renderer = renderer;
    this._closing = false;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DATA EXTRACTION (unchanged — preserves compute() data logic)
  // ─────────────────────────────────────────────────────────────────────

  compute = (iterationId) => {
    if (!iterationId) return null;
    const idLower = iterationId.toLowerCase();

    // Cluster A (2026-06-07) — back the lifecycle drawer with
    // IterationCorrelator. The previous naive substring filter caught
    // only ~4% of an iteration's logs, which made the Hero / Nodes /
    // Errors / Timeline panels show drastically incomplete data. The
    // correlator chains RAIDs causally so the drawer sees the full
    // iteration. Telemetry events still use substring match against
    // attributes.IterationId / correlationId — that field already
    // carries the iteration ID by construction (TelemetryUtils.cs).
    const corr = (typeof window !== 'undefined') ? window.edogIterationCorrelator : null;
    const useCorrelator = corr
      && corr.activeIteration
      && corr.activeIteration.toLowerCase() === idLower;

    const logs = this.state.logs.filter(l => {
      if (useCorrelator) {
        return corr.matches(l.rootActivityId);
      }
      // Fallback when no correlator (early boot / isolated test): degraded
      // substring match. Same ~4% recall as the legacy behavior — the
      // wired-up path through main.js sets activeIteration first so this
      // branch should not fire in production.
      const lid = (l.iterationId || '').toLowerCase();
      const msg = (l.message || '').toLowerCase();
      const rid = (l.rootActivityId || '').toLowerCase();
      return lid.includes(idLower) || msg.includes(idLower) || rid.includes(idLower);
    });

    /* ssrEvents — telemetry slice for this iteration.
     * 2026-06-07 telemetry-correctness fix: filter by channel===ssr.
     * Additional channel events are fire-and-forget mirrors that used
     * to carry a fake 'Completed' status (backend now emits empty +
     * isMirror=true). Without this filter, runDagEvents downstream
     * captures the Additional mirrors and extractMetrics' TERMINAL
     * detection reports the DAG as Completed while it's still running.
     * The variable name `ssrEvents` was historically accurate but the
     * filter wasn't — now it is. */
    const ssrEvents = this.state.telemetry.filter(e => {
      if ((e.channel || 'ssr') !== 'ssr') return false;
      const eid = ((e.attributes && e.attributes.IterationId) || '').toLowerCase();
      const cid = (e.correlationId || '').toLowerCase();
      return eid.includes(idLower) || cid.includes(idLower);
    });

    // Order matters: errors first so extractMetrics can reflect the real
    // errorCount (guaranteed to match errors.length, killing the prior
    // "Errors: N / see below / [empty section]" bug).
    const errors = this.extractErrors(logs);
    const metrics = this.extractMetrics(logs, ssrEvents, errors);
    const nodes = this.extractNodes(logs, ssrEvents);
    metrics.nodeCount = nodes.length > 0 ? String(nodes.length) : '\u2014';
    const timeline = this.extractTimeline(logs);
    const dagName = this.extractDagName(logs, ssrEvents);

    return { iterationId, metrics, nodes, errors, timeline, dagName, logCount: logs.length, ssrCount: ssrEvents.length };
  }

  // ── extract* — telemetry-first, JSON-aware. Rewrite 2026-06-07.
  // Background:
  //   Live drawer inspection found 7 wiring bugs (status/duration wrong,
  //   "exists" subtitle, errors count vs list mismatch, refresh/parallel
  //   never populated, JSON error bodies dumped as text). The prior
  //   implementation walked logs with brittle string-substring detectives
  //   that missed the structured data sitting in telemetry attributes and
  //   in JSON-shaped error bodies. See tests/test_summary_extract_rewrite.py.
  //
  //   The fix: prefer telemetry attributes when present, parse JSON bodies
  //   when matched, tighten regexes against the live log shapes, and
  //   guarantee errorCount == extractErrors().length (the prior independent
  //   computation was the "Errors: 1 / see below / [empty section]" bug).

  extractMetrics = (logs, ssrEvents, errorsArr) => {
    const result = {
      status: 'Unknown', duration: '\u2014', durationMs: 0, started: '\u2014',
      refreshMode: '\u2014', nodeCount: '\u2014', errorCount: 0, parallelLimit: '\u2014',
    };

    const runDagEvents = ssrEvents.filter(e => (e.activityName || '').toLowerCase().includes('rundag'));

    // RefreshMode / MaxParallelNodes — pull from RunDag SSR attributes.
    // Any RunDag event carries these (set at iteration start, stable).
    for (const e of runDagEvents) {
      const a = e.attributes || {};
      if (result.refreshMode === '\u2014' && a.RefreshMode) result.refreshMode = a.RefreshMode;
      if (result.parallelLimit === '\u2014' && a.MaxParallelNodes) result.parallelLimit = a.MaxParallelNodes;
    }

    // Status + duration — prefer a terminal RunDag event (Completed / Failed
    // / Cancelled / Succeeded) sorted by timestamp desc. If only non-terminal
    // events (Pending / Running) exist, the DAG is in progress: display
    // 'Running' regardless of the SSR's literal status name ('Pending' refers
    // to the controller-accepted-the-request stage, not the actual DAG).
    const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'succeeded']);
    const sorted = runDagEvents.slice().sort((a, b) =>
      String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
    );
    const terminal = sorted.find(e => TERMINAL.has(String(e.activityStatus || '').toLowerCase()));
    const newest = sorted[0];

    if (terminal) {
      result.status = terminal.activityStatus;
      if (terminal.durationMs) {
        result.duration = this.renderer.formatDuration(terminal.durationMs);
        result.durationMs = terminal.durationMs;
      }
    } else if (newest) {
      // Non-terminal: DAG is executing. Surface as 'Running' for clarity.
      // We do NOT show the Pending event's durationMs (it's the time-to-202,
      // not the DAG runtime) — leave duration '—' so the user isn't misled.
      result.status = 'Running';
    }

    // Started — earliest RunDag SSR (Pending fires first). Falls back to
    // earliest log timestamp if no SSR yet.
    if (runDagEvents.length > 0) {
      const earliestSsr = sorted[sorted.length - 1];
      if (earliestSsr && earliestSsr.timestamp) {
        result.started = this.renderer.formatTime(earliestSsr.timestamp);
      }
    }
    if (result.started === '\u2014' && logs.length > 0) {
      result.started = this.renderer.formatTime(logs[0].timestamp);
    }

    // [DAG STATUS] message override — only when no SSR data exists. Keeps
    // the legacy log-driven path alive for the rare case the telemetry
    // stream is empty (early boot, telemetry filter excludes everything).
    if (runDagEvents.length === 0) {
      for (const log of logs) {
        const msg = log.message || '';
        if (!msg.includes('[DAG STATUS]')) continue;
        const lower = msg.toLowerCase();
        if (lower.includes('completed') || lower.includes('finished')) {
          result.status = (lower.includes('error') || lower.includes('fault')) ? 'Failed' : 'Completed';
        } else if ((lower.includes('started') || lower.includes('starting')) && result.status === 'Unknown') {
          result.status = 'Running';
        }
      }
    }

    // Node count — derived from the actual extracted nodes list, not from
    // log substring regex (which used to match "20 index folder(s)").
    // extractNodes is called separately by compute(); we stamp count there.

    // Error count — guaranteed to match extractErrors().length so the
    // drawer's "Errors: N / see below" never lies. errorsArr is the
    // already-computed list (passed in by compute() to avoid recomputing).
    result.errorCount = Array.isArray(errorsArr) ? errorsArr.length : 0;

    return result;
  }

  extractNodes = (logs, ssrEvents) => {
    const nodeMap = new Map();

    // Pass 1 — telemetry attributes. Some NodeExecution SSRs do carry
    // NodeName (added by the v2 telemetry path); use them when present.
    ssrEvents.filter(e => (e.activityName || '').toLowerCase().includes('nodeexecution')).forEach(e => {
      const a = e.attributes || {};
      const nodeName = a.NodeName || a.nodeName;
      if (!nodeName) return; // no name → skip; pass 2 will catch via logs
      nodeMap.set(nodeName, {
        name: nodeName,
        status: e.activityStatus || 'Unknown',
        duration: e.durationMs ? this.renderer.formatDuration(e.durationMs) : '\u2014',
        durationMs: e.durationMs || 0,
        error: e.resultCode && e.resultCode !== 'OK' ? e.resultCode : (a.ErrorSource === 'System' ? 'system' : ''),
      });
    });

    // Pass 2 — log message bracket: '[Artifact: X, Iteration: Y,
    // TransformationId: Z, Node name: <name>]'. This is FLT's canonical
    // per-node log prefix and reliably carries the name when SSR attrs
    // don't.
    const NODE_LINE_RE = /\bNode\s+name:\s*([^\],]+?)\s*[\],]/i;
    for (const log of logs) {
      const m = NODE_LINE_RE.exec(log.message || '');
      if (!m) continue;
      const name = m[1].trim();
      if (!nodeMap.has(name)) {
        nodeMap.set(name, {
          name, status: 'Running', duration: '\u2014', durationMs: 0, error: '',
        });
      }
    }

    // Pass 3 — 'Executed node "X" with final status Y' — terminal updates.
    // Pre-rewrite: regex captured only \w+ → broke on names with dots like
    // 'dbo.data_view'. Allow dots, hyphens, underscores in the name.
    const EXEC_RE = /Executed node\s+['"]?([\w.\-]+)['"]?\s+with final status\s+(\w+)/i;
    const START_RE = /Executing node\s+['"]?([\w.\-]+)['"]?/i;
    for (const log of logs) {
      const msg = log.message || '';
      const em = EXEC_RE.exec(msg);
      if (em) {
        const name = em[1];
        const existing = nodeMap.get(name) || { name, status: 'Unknown', duration: '\u2014', durationMs: 0, error: '' };
        existing.status = em[2];
        nodeMap.set(name, existing);
        continue;
      }
      const sm = START_RE.exec(msg);
      if (sm && !nodeMap.has(sm[1])) {
        nodeMap.set(sm[1], { name: sm[1], status: 'Running', duration: '\u2014', durationMs: 0, error: '' });
      }
    }

    // Pass 4 — [DAG_FAULTED_NODES] entries (skipped due to upstream).
    for (const log of logs) {
      const msg = log.message || '';
      if (!msg.includes('[DAG_FAULTED_NODES]')) continue;
      const fm = msg.match(/\[DAG_FAULTED_NODES\]\s*(.*)/i);
      if (!fm) continue;
      fm[1].split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
        if (!nodeMap.has(name)) {
          nodeMap.set(name, { name, status: 'Skipped', duration: '\u2014', durationMs: 0, error: 'upstream' });
        }
      });
    }

    return Array.from(nodeMap.values());
  }

  extractErrors = (logs) => {
    // Two error shapes coexist in FLT logs:
    //   (a) Legacy: 'MLV_XYZ: free-text message' or '[Bracket] MLV_XYZ ...'
    //   (b) Modern: '{"code":"WebRequestTimeout","subCode":0,"message":"..."}'
    // Both must be picked up so errorCount matches a real entry in the list.
    const errorMap = new Map();
    const CODE_RE = /\b(MLV_\w+|FLT_\w+|SPARK_\w+|ERR_\w+|ERROR_\w+)\b/;

    logs.filter(l => l.level === 'Error').forEach(log => {
      const msg = log.message || '';
      let code = null;
      let message = '';

      // Try JSON shape first.
      if (msg.length > 0 && msg.charAt(0) === '{') {
        try {
          const obj = JSON.parse(msg);
          if (obj && obj.code) {
            code = obj.code;
            message = obj.message || '';
          }
        } catch (_) { /* not JSON, fall through */ }
      }

      // Fall back to legacy code regex if JSON parse didn't find one.
      if (!code) {
        const cm = msg.match(CODE_RE);
        if (cm) {
          code = cm[1];
          // Slice from the code onward so message captures useful tail.
          const tail = msg.substring(msg.indexOf(code) + code.length).trim();
          message = tail.replace(/^[:\s]+/, '').substring(0, 240) || msg.substring(0, 240);
        }
      }

      // Last resort: catch-all so errorCount doesn't undercount Error-level
      // entries that lack any recognizable code (better to surface them than
      // silently drop). Use first 60 chars as the synthetic code.
      if (!code) {
        code = '(uncategorized)';
        message = msg.substring(0, 240);
      }

      const existing = errorMap.get(code) || { code, message, count: 0, node: '' };
      existing.count++;
      // Prefer the latest non-empty message we see (newer is usually richer).
      if (message) existing.message = message;
      // Best-effort node extraction.
      const nm = msg.match(/Node\s+name:\s*([^\],]+?)\s*[\],]/i)
              || msg.match(/[Nn]ode[:\s]+['"]?([\w.\-]+)['"]?/);
      if (nm) existing.node = nm[1].trim();
      errorMap.set(code, existing);
    });

    return Array.from(errorMap.values());
  }

  extractTimeline = (logs) => {
    const events = [];
    for (const log of logs) {
      const msg = log.message || '';
      const time = this.renderer.formatTime(log.timestamp);

      if (msg.includes('[DAG STATUS]')) {
        let type = 'start';
        const lower = msg.toLowerCase();
        if (lower.includes('completed') || lower.includes('finished')) {
          type = (lower.includes('error') || lower.includes('fault')) ? 'end-fail' : 'end-success';
        }
        events.push({ time, text: msg.replace('[DAG STATUS]', '').trim(), type });
        continue;
      }

      const startM = msg.match(/Executing node\s+['"]?([\w.\-]+)['"]?/i);
      if (startM) {
        events.push({ time, text: 'Node ' + startM[1] + ' started', type: 'start' });
        continue;
      }

      const execM = msg.match(/Executed node\s+['"]?([\w.\-]+)['"]?\s+with final status\s+(\w+)/i);
      if (execM) {
        const ok = execM[2].toLowerCase() === 'succeeded' || execM[2].toLowerCase() === 'completed';
        events.push({ time, text: execM[1] + ' ' + execM[2], type: ok ? 'end-success' : 'end-fail' });
        continue;
      }

      if (log.level === 'Error') {
        // JSON-aware: parse {"code":"X","message":"Y"} and surface as 'X: Y'
        // instead of dumping the raw JSON onto the timeline. See live-evidence
        // screenshot 2026-06-07 — pre-fix shipped raw JSON, looked terrible.
        let text = msg.substring(0, 160);
        if (msg.length > 0 && msg.charAt(0) === '{') {
          try {
            const obj = JSON.parse(msg);
            if (obj && obj.code) {
              const m = obj.message ? String(obj.message).substring(0, 140) : '';
              text = m ? (obj.code + ': ' + m) : obj.code;
            }
          } catch (_) { /* keep raw substring */ }
        }
        events.push({ time, text, type: 'error' });
        continue;
      }

      if (msg.includes('[DAG_FAULTED_NODES]')) {
        events.push({ time, text: msg.replace('[DAG_FAULTED_NODES]', 'Skipped nodes:').trim(), type: 'skip' });
      }
    }
    return events.slice(0, 50);
  }

  extractDagName = (logs, ssrEvents) => {
    // Prefer telemetry SSR attributes when present (no live FLT telemetry
    // currently carries DagName but future versions may).
    for (const e of ssrEvents) {
      const n = e.attributes && (e.attributes.DagName || e.attributes.dagName || e.attributes.TableName);
      if (n) return String(n);
    }
    // Fall back to FLT's canonical log shape:
    //   '[LakehouseId = X, DagName = my-dag-guid, IterationId = Y]'
    // The prior regex [Dd]ag(?:Name)?[:\s=]+ matched any "DAG <word>"
    // phrase and captured the next word — Hemant's screenshot shipped
    // "exists" because "DAG exists for this lakehouse" matched. The fix
    // requires the literal word 'DagName' followed by '=' or ':' delim
    // so unrelated 'DAG <noun>' phrases can't sneak through.
    const NAME_RE = /\bDagName\s*[:=]\s*['"]?([\w.\-]+)['"]?/;
    for (const log of logs) {
      const m = NAME_RE.exec(log.message || '');
      if (m) return m[1];
    }
    return '';
  }

  // ─────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────

  render = (data) => {
    if (!data) return;
    const drawer = document.getElementById('exec-drawer');
    const container = document.getElementById('exec-summary-data');
    if (!drawer || !container) return;

    // #B (2026-06-07) — diff-render to stop the blink.
    //
    // The drawer used to do `container.innerHTML = html` on every 1-second
    // refresh, which tore down the whole DOM and rebuilt it. Even when the
    // visual content was identical, the user saw a flash because the browser
    // re-laid-out + re-painted every node.
    //
    // Now we do two paths:
    //   * Full rebuild when no DOM is present yet, OR when the iteration
    //     changed (different `data-iter-id` on the container). Slot-by-slot
    //     binding only makes sense for the SAME iteration's growing data.
    //   * In-place patch for refreshes of the same iteration. Each updatable
    //     element carries a `data-slot="<name>"` attribute and is mutated via
    //     textContent / classList / setAttribute. No element is destroyed
    //     unless its identity (node name, error code, timeline signature)
    //     leaves the data set, which is rare for append-only log streams.
    //
    // The decision is made by comparing data.iterationId against the
    // container's stored iteration id.
    const currentIter = container.getAttribute('data-iter-id');
    const sameIteration = currentIter && currentIter === String(data.iterationId);
    const hasRendered = container.querySelector('[data-slot="status-label"]') !== null;

    if (!sameIteration || !hasRendered) {
      this._fullRebuild(container, data);
      container.setAttribute('data-iter-id', String(data.iterationId));
      this.wireInteractions(container, data);
      this._lastNodeKeys = data.nodes.map(n => n.name);
      this._lastErrorKeys = data.errors.map(e => e.code);
      this._lastTimelineKeys = data.timeline.map((t, i) => t.time + '|' + t.text + '|' + i);
    } else {
      this._patch(container, data);
    }

    // Don't auto-open here — caller (refreshExecutionSummary) decides visibility.
    if (drawer && !drawer.classList.contains('has-data') && !drawer.classList.contains('collapsed')) {
      this.open();
    } else if (drawer && !drawer.classList.contains('has-data')) {
      drawer.classList.add('has-data');
    }
  }

  /**
   * Build the drawer DOM from scratch — single innerHTML assignment.
   * Every updatable element gets `data-slot="<name>"` so `_patch()` can
   * find and mutate it later without rebuilding.
   */
  _fullRebuild = (container, data) => {
    const view = this._computeView(data);
    const html =
      this._headerHtml(data, view) +
      this._metricsHtml(data, view) +
      this._nodesSectionHtml(data, view) +
      this._errorsSectionHtml(data) +
      this._timelineSectionHtml(data, view);
    container.innerHTML = html;
  }

  /**
   * Update the existing drawer DOM in place. Touches only the slots whose
   * value changed. List sections (nodes/errors/timeline) use per-item keys
   * so existing rows are preserved across refreshes — no blink, no layout
   * thrash.
   */
  _patch = (container, data) => {
    const view = this._computeView(data);

    // Hero status — colour vars + orb + label + sub.
    const head = container.querySelector('[data-slot="head"]');
    if (head) {
      head.style.setProperty('--exd-status-color', view.s.color);
      head.style.setProperty('--exd-status-bg', view.s.bg);
      head.style.setProperty('--exd-accent-glow', view.s.bg);
    }
    const hero = container.querySelector('[data-slot="status-hero"]');
    if (hero) {
      hero.className = 'exd-status-hero ' + view.s.cls;
      hero.style.setProperty('--exd-status-color', view.s.color);
      hero.style.setProperty('--exd-status-bg', view.s.bg);
    }
    this._setText(container, 'status-orb', view.s.icon);
    this._setText(container, 'status-label', view.s.label);
    this._setText(container, 'status-dag',
      data.dagName ? data.dagName : (data.logCount + ' logs · ' + data.ssrCount + ' ssr'));
    this._setText(container, 'duration-num', view.dur.num);
    this._setText(container, 'duration-unit', view.dur.unit);

    // Iter id (rarely changes within the same iteration; safe to write).
    const iterShort = data.iterationId.length > 16
      ? data.iterationId.slice(0, 6) + '\u2026' + data.iterationId.slice(-6)
      : data.iterationId;
    this._setText(container, 'iter-val', iterShort);

    // Metric cards.
    const statusBadge = container.querySelector('[data-slot="metric-status-badge"]');
    if (statusBadge) {
      statusBadge.textContent = view.s.icon + ' ' + view.s.label;
      statusBadge.style.background = view.s.bg;
      statusBadge.style.color = view.s.color;
    }
    const statusCard = container.querySelector('[data-slot="metric-status-card"]');
    if (statusCard) {
      statusCard.className = 'exd-metric ' + (
        view.s.cls === 'status-failed' ? 'is-error' :
        view.s.cls === 'status-success' ? 'is-success' :
        view.s.cls === 'status-running' ? 'is-running' : ''
      );
    }
    this._setText(container, 'metric-duration-value', data.metrics.duration);
    this._setText(container, 'metric-duration-sub', 'started ' + data.metrics.started);

    // Ring (Nodes metric)
    const ringFill = container.querySelector('[data-slot="metric-nodes-ring"]');
    if (ringFill) {
      ringFill.style.setProperty('--exd-arc-target', String(view.ringOffset));
      ringFill.style.stroke = view.ringStroke;
    }
    this._setText(container, 'metric-nodes-label', view.ringPct + '%');
    this._setText(container, 'metric-nodes-value',
      view.nodesSucceeded + '/' + (view.nodesTotal || '\u2014'));
    this._setText(container, 'metric-nodes-sub', view.nodesTotal ? 'succeeded' : 'no nodes');

    const errorsCard = container.querySelector('[data-slot="metric-errors-card"]');
    if (errorsCard) {
      errorsCard.className = 'exd-metric ' + (data.metrics.errorCount > 0 ? 'is-error' : 'is-success');
    }
    this._setText(container, 'metric-errors-value', String(data.metrics.errorCount));
    this._setText(container, 'metric-errors-sub',
      data.metrics.errorCount > 0 ? 'see below' : 'clean run');
    this._setText(container, 'metric-refresh-value', data.metrics.refreshMode);
    this._setText(container, 'metric-parallel-value', data.metrics.parallelLimit);

    // Variable-length lists.
    this._patchNodes(container, data.nodes, view.maxDurMs);
    this._patchErrors(container, data.errors);
    this._patchTimeline(container, data.timeline, view.statusKey);
  }

  _setText = (container, slot, value) => {
    const el = container.querySelector('[data-slot="' + slot + '"]');
    if (!el) return;
    const next = String(value == null ? '' : value);
    if (el.textContent !== next) el.textContent = next;
  }

  /**
   * Diff the node list:
   *   * Update rows whose key (node name) still exists
   *   * Append new rows for keys not previously present
   *   * Remove rows whose key disappeared (rare; nodes are append-only in
   *     practice but the safety net is cheap)
   */
  _patchNodes = (container, nodes, maxDurMs) => {
    const section = container.querySelector('[data-slot="nodes-section"]');
    if (!section) return;
    const countEl = container.querySelector('[data-slot="nodes-count"]');
    if (countEl) countEl.textContent = String(nodes.length);

    let listEl = section.querySelector('.exd-nodes');
    const hadList = !!listEl;
    if (nodes.length === 0) {
      if (hadList) {
        listEl.replaceWith(this._renderNodesEmpty());
      } else if (!section.querySelector('.exd-empty-line')) {
        section.appendChild(this._renderNodesEmpty());
      }
      this._lastNodeKeys = [];
      return;
    }
    if (!hadList) {
      // Transitioning from empty → has-content. Replace the empty-line with
      // a fresh list container.
      const empty = section.querySelector('.exd-empty-line');
      const fresh = this._createEl('div', 'exd-nodes');
      if (empty) empty.replaceWith(fresh);
      else section.appendChild(fresh);
      listEl = fresh;
    }

    // Build a map of existing rows by key.
    const existing = new Map();
    for (const child of Array.from(listEl.children)) {
      const key = child.getAttribute('data-key');
      if (key !== null) existing.set(key, child);
    }

    const newKeys = [];
    for (const n of nodes) {
      const key = n.name;
      newKeys.push(key);
      const sc = this._statusClass(n.status);
      const scale = maxDurMs > 0 ? Math.max(0.04, (n.durationMs || 0) / maxDurMs) : 0;
      let row = existing.get(key);
      if (row) {
        // Update in place.
        row.className = 'exd-node ' + sc.cls;
        row.style.setProperty('--exd-bar-scale', scale.toFixed(3));
        const pill = row.querySelector('.exd-pill');
        if (pill) { pill.className = 'exd-pill ' + sc.pill; pill.textContent = sc.label; }
        const durEl = row.querySelector('.exd-node-dur');
        if (durEl) durEl.textContent = n.duration;
        const errSlot = row.querySelector('.exd-node-err');
        if (n.error) {
          if (errSlot) { errSlot.textContent = n.error; }
          else {
            const fresh = this._createEl('div', 'exd-node-err');
            fresh.textContent = n.error;
            row.appendChild(fresh);
          }
        } else if (errSlot) {
          errSlot.remove();
        }
        existing.delete(key);
      } else {
        // New row → build and append.
        row = this._buildNodeRow(n, sc, scale);
        listEl.appendChild(row);
      }
    }
    // Remove stale rows that disappeared from the data.
    for (const stale of existing.values()) stale.remove();

    this._lastNodeKeys = newKeys;
  }

  _patchErrors = (container, errors) => {
    let section = container.querySelector('[data-slot="errors-section"]');
    if (errors.length === 0) {
      if (section) section.remove();
      this._lastErrorKeys = [];
      return;
    }
    if (!section) {
      // Section appeared mid-run. Insert before the Key Moments section so
      // the structural order stays Errors → Timeline.
      section = this._createEl('section', 'exd-section');
      section.setAttribute('data-slot', 'errors-section');
      section.innerHTML =
        '<div class="exd-section-title">Errors <span class="count" data-slot="errors-count">' + errors.length + '</span></div>' +
        '<div class="exd-errors" data-slot="errors-list"></div>';
      const timelineSection = container.querySelector('[data-slot="timeline-section"]');
      if (timelineSection) container.insertBefore(section, timelineSection);
      else container.appendChild(section);
    }
    const countEl = section.querySelector('[data-slot="errors-count"]');
    if (countEl) countEl.textContent = String(errors.length);

    const listEl = section.querySelector('[data-slot="errors-list"]');
    if (!listEl) return;
    const existing = new Map();
    for (const child of Array.from(listEl.children)) {
      const key = child.getAttribute('data-key');
      if (key !== null) existing.set(key, child);
    }
    const newKeys = [];
    for (const e of errors) {
      const key = e.code;
      newKeys.push(key);
      let card = existing.get(key);
      if (card) {
        const countSpan = card.querySelector('.exd-error-count');
        if (countSpan) countSpan.textContent = '\u00d7' + e.count;
        const msgEl = card.querySelector('.exd-error-msg');
        if (msgEl) msgEl.textContent = e.message;
        const nodeEl = card.querySelector('.exd-error-node');
        if (e.node && nodeEl) nodeEl.textContent = e.node;
        existing.delete(key);
      } else {
        card = this._buildErrorCard(e);
        listEl.appendChild(card);
      }
    }
    for (const stale of existing.values()) stale.remove();
    this._lastErrorKeys = newKeys;
  }

  _patchTimeline = (container, events, statusKey) => {
    const section = container.querySelector('[data-slot="timeline-section"]');
    if (!section) return;
    const countEl = container.querySelector('[data-slot="timeline-count"]');
    if (countEl) countEl.textContent = String(events.length);

    let listEl = section.querySelector('.exd-timeline');
    if (events.length === 0) {
      if (listEl) listEl.replaceWith(this._renderTimelineEmpty());
      else if (!section.querySelector('.exd-empty-line')) section.appendChild(this._renderTimelineEmpty());
      this._lastTimelineKeys = [];
      return;
    }
    if (!listEl) {
      const empty = section.querySelector('.exd-empty-line');
      listEl = this._createEl('div', 'exd-timeline');
      if (empty) empty.replaceWith(listEl);
      else section.appendChild(listEl);
    }
    listEl.className = 'exd-timeline' + (statusKey === 'running' ? ' is-flowing' : '');

    // Timeline keys = time|text|index — index disambiguates duplicate text.
    const existing = new Map();
    for (const child of Array.from(listEl.children)) {
      const key = child.getAttribute('data-key');
      if (key !== null) existing.set(key, child);
    }
    const newKeys = [];
    events.forEach((e, i) => {
      const key = e.time + '|' + e.text + '|' + i;
      newKeys.push(key);
      let item = existing.get(key);
      if (item) {
        // Stable. Class may change if type flipped — refresh it.
        item.className = 'exd-tl-item tl-' + e.type;
        existing.delete(key);
      } else {
        item = this._buildTimelineItem(e);
        listEl.appendChild(item);
      }
    });
    for (const stale of existing.values()) stale.remove();
    this._lastTimelineKeys = newKeys;
  }

  // ── View-model + HTML builders (used by both first-paint and patch) ──

  _computeView = (data) => {
    const statusKey = String(data.metrics.status || '').toLowerCase();
    const statusMap = {
      'completed': { cls: 'status-success', icon: '\u25CF', color: 'var(--status-succeeded)', bg: 'rgba(24,160,88,0.12)', label: 'Completed' },
      'succeeded': { cls: 'status-success', icon: '\u25CF', color: 'var(--status-succeeded)', bg: 'rgba(24,160,88,0.12)', label: 'Succeeded' },
      'failed':    { cls: 'status-failed',  icon: '\u2715', color: 'var(--status-failed)',    bg: 'rgba(229,69,59,0.12)', label: 'Failed' },
      'running':   { cls: 'status-running', icon: '\u25D0', color: 'var(--level-warning)',    bg: 'rgba(229,148,12,0.14)', label: 'Running' },
      'cancelled': { cls: 'status-failed',  icon: '\u2298', color: 'var(--level-warning)',    bg: 'rgba(229,148,12,0.12)', label: 'Cancelled' }
    };
    const s = statusMap[statusKey] || { cls: '', icon: '\u25C6', color: 'var(--text-muted)', bg: 'var(--surface-3)', label: data.metrics.status || 'Unknown' };
    const nodesSucceeded = data.nodes.filter(n => /succeeded|completed/i.test(n.status)).length;
    const nodesTotal = data.nodes.length;
    const ringPct = nodesTotal > 0 ? Math.round((nodesSucceeded / nodesTotal) * 100) : 0;
    const ringOffset = 100 - ringPct;
    const ringStroke = (nodesSucceeded === nodesTotal && nodesTotal > 0)
      ? 'var(--status-succeeded)'
      : (nodesSucceeded < nodesTotal ? 'var(--level-warning)' : 'var(--accent)');
    const maxDurMs = Math.max(1, ...data.nodes.map(n => n.durationMs || 0));
    const dur = this.formatDurationParts(data.metrics.durationMs, data.metrics.duration);
    return { s, statusKey, nodesSucceeded, nodesTotal, ringPct, ringOffset, ringStroke, maxDurMs, dur };
  }

  _headerHtml = (data, view) => {
    const iterShort = data.iterationId.length > 16
      ? data.iterationId.slice(0, 6) + '\u2026' + data.iterationId.slice(-6)
      : data.iterationId;
    return `
      <header class="exd-head" data-slot="head" style="--exd-status-color:${view.s.color};--exd-status-bg:${view.s.bg};--exd-accent-glow:${view.s.bg}">
        <div class="exd-head-top">
          <span class="exd-eyebrow">Execution</span>
          <button class="exd-close" id="exd-close-btn" title="Close (Esc)" aria-label="Close drawer">\u2715</button>
        </div>
        <div class="exd-status-hero ${view.s.cls}" data-slot="status-hero" style="--exd-status-color:${view.s.color};--exd-status-bg:${view.s.bg}">
          <div class="exd-status-orb" data-slot="status-orb">${view.s.icon}</div>
          <div class="exd-status-meta">
            <div class="exd-status-label" data-slot="status-label">${this.esc(view.s.label)}</div>
            <div class="exd-status-dag" data-slot="status-dag">${this.esc(data.dagName ? data.dagName : (data.logCount + ' logs \u00b7 ' + data.ssrCount + ' ssr'))}</div>
          </div>
          <div class="exd-duration-big">
            <span class="num" data-slot="duration-num">${this.esc(view.dur.num)}</span>
            <span class="unit" data-slot="duration-unit">${this.esc(view.dur.unit)}</span>
          </div>
        </div>
        <div class="exd-iter" id="exd-iter-copy" title="Click to copy ${this.esc(data.iterationId)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          <span class="iter-val" data-slot="iter-val">${this.esc(iterShort)}</span>
        </div>
      </header>
    `;
  }

  _metricsHtml = (data, view) => {
    const errorsCls = data.metrics.errorCount > 0 ? 'is-error' : 'is-success';
    const statusCardCls = view.s.cls === 'status-failed' ? 'is-error'
      : view.s.cls === 'status-success' ? 'is-success'
      : view.s.cls === 'status-running' ? 'is-running' : '';
    return `
      <section class="exd-section">
        <div class="exd-section-title">Key Metrics</div>
        <div class="exd-metrics">
          <div class="exd-metric ${statusCardCls}" data-slot="metric-status-card">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
              Status
            </div>
            <span class="exd-metric-badge" data-slot="metric-status-badge" style="background:${view.s.bg};color:${view.s.color}">${view.s.icon} ${this.esc(view.s.label)}</span>
          </div>

          <div class="exd-metric">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              Duration
            </div>
            <div class="exd-metric-value" data-slot="metric-duration-value">${this.esc(data.metrics.duration)}</div>
            <div class="exd-metric-sub" data-slot="metric-duration-sub">started ${this.esc(data.metrics.started)}</div>
          </div>

          <div class="exd-metric metric-nodes">
            <div class="exd-ring">
              <svg viewBox="0 0 36 36">
                <circle class="track" cx="18" cy="18" r="15.915" pathLength="100"/>
                <circle class="fill" cx="18" cy="18" r="15.915" pathLength="100"
                        data-slot="metric-nodes-ring"
                        style="--exd-arc-target:${view.ringOffset};stroke:${view.ringStroke}"/>
              </svg>
              <div class="label" data-slot="metric-nodes-label">${view.ringPct}%</div>
            </div>
            <div class="exd-metric-body">
              <div class="exd-metric-head">Nodes</div>
              <div class="exd-metric-value" data-slot="metric-nodes-value">${view.nodesSucceeded}/${view.nodesTotal || '\u2014'}</div>
              <div class="exd-metric-sub" data-slot="metric-nodes-sub">${view.nodesTotal ? 'succeeded' : 'no nodes'}</div>
            </div>
          </div>

          <div class="exd-metric ${errorsCls}" data-slot="metric-errors-card">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5"/><circle cx="12" cy="18" r="0.6" fill="currentColor"/></svg>
              Errors
            </div>
            <div class="exd-metric-value" data-slot="metric-errors-value">${data.metrics.errorCount}</div>
            <div class="exd-metric-sub" data-slot="metric-errors-sub">${data.metrics.errorCount > 0 ? 'see below' : 'clean run'}</div>
          </div>

          <div class="exd-metric">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </div>
            <div class="exd-metric-value" data-slot="metric-refresh-value" style="font-size:14px">${this.esc(data.metrics.refreshMode)}</div>
            <div class="exd-metric-sub">mode</div>
          </div>

          <div class="exd-metric">
            <div class="exd-metric-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="21"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="18" y1="3" x2="18" y2="21"/></svg>
              Parallel
            </div>
            <div class="exd-metric-value" data-slot="metric-parallel-value">${this.esc(data.metrics.parallelLimit)}</div>
            <div class="exd-metric-sub">limit</div>
          </div>
        </div>
      </section>
    `;
  }

  _nodesSectionHtml = (data, view) => {
    return `
      <section class="exd-section" data-slot="nodes-section">
        <div class="exd-section-title">Node Breakdown <span class="count" data-slot="nodes-count">${view.nodesTotal}</span></div>
        ${this.renderNodes(data.nodes, view.maxDurMs)}
      </section>
    `;
  }

  _errorsSectionHtml = (data) => {
    if (data.errors.length === 0) return '';
    return `
      <section class="exd-section" data-slot="errors-section">
        <div class="exd-section-title">Errors <span class="count" data-slot="errors-count">${data.errors.length}</span></div>
        <div class="exd-errors" data-slot="errors-list">${this.renderErrors(data.errors)}</div>
      </section>
    `;
  }

  _timelineSectionHtml = (data, view) => {
    return `
      <section class="exd-section" data-slot="timeline-section">
        <div class="exd-section-title">Key Moments <span class="count" data-slot="timeline-count">${data.timeline.length}</span></div>
        ${this.renderTimeline(data.timeline, view.statusKey)}
      </section>
    `;
  }

  // ── DOM helpers for the patch path ──

  _createEl = (tag, cls) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  _statusClass = (st) => {
    const s = String(st || '').toLowerCase();
    if (s === 'succeeded' || s === 'completed') return { cls: 'is-success', pill: 'pill-success', label: st };
    if (s === 'failed' || s === 'faulted')      return { cls: 'is-failed',  pill: 'pill-failed',  label: st };
    if (s === 'running' || s === 'started')     return { cls: 'is-running', pill: 'pill-running', label: st };
    if (s === 'skipped')                        return { cls: 'is-skipped', pill: 'pill-skipped', label: st };
    return { cls: '', pill: 'pill-unknown', label: st || 'Unknown' };
  }

  _buildNodeRow = (n, sc, scale) => {
    const row = this._createEl('div', 'exd-node ' + sc.cls);
    row.setAttribute('data-key', n.name);
    row.style.setProperty('--exd-bar-scale', scale.toFixed(3));
    const head = this._createEl('div', 'exd-node-head');
    const nameSpan = this._createEl('span', 'exd-node-name');
    nameSpan.title = n.name; nameSpan.textContent = n.name;
    const pill = this._createEl('span', 'exd-pill ' + sc.pill); pill.textContent = sc.label;
    const durEl = this._createEl('span', 'exd-node-dur'); durEl.textContent = n.duration;
    head.appendChild(nameSpan); head.appendChild(pill); head.appendChild(durEl);
    row.appendChild(head);
    const bar = this._createEl('div', 'exd-node-bar');
    bar.appendChild(this._createEl('div', 'fill'));
    row.appendChild(bar);
    if (n.error) {
      const err = this._createEl('div', 'exd-node-err'); err.textContent = n.error;
      row.appendChild(err);
    }
    return row;
  }

  _buildErrorCard = (e) => {
    const card = this._createEl('div', 'exd-error');
    card.setAttribute('data-key', e.code);
    const head = this._createEl('div', 'exd-error-head');
    const codeSpan = this._createEl('span', 'exd-error-code'); codeSpan.textContent = e.code;
    head.appendChild(codeSpan);
    if (e.node) {
      const nodeSpan = this._createEl('span', 'exd-error-node'); nodeSpan.textContent = e.node;
      head.appendChild(nodeSpan);
    }
    const countSpan = this._createEl('span', 'exd-error-count'); countSpan.textContent = '\u00d7' + e.count;
    head.appendChild(countSpan);
    card.appendChild(head);
    const msg = this._createEl('div', 'exd-error-msg'); msg.textContent = e.message;
    card.appendChild(msg);
    return card;
  }

  _buildTimelineItem = (e) => {
    const item = this._createEl('div', 'exd-tl-item tl-' + e.type);
    const time = this._createEl('span', 'exd-tl-time'); time.textContent = e.time;
    const text = this._createEl('span', 'exd-tl-text'); text.textContent = e.text;
    item.appendChild(time); item.appendChild(text);
    return item;
  }

  _renderNodesEmpty = () => {
    const el = this._createEl('div', 'exd-empty-line'); el.textContent = 'No node executions detected';
    return el;
  }
  _renderTimelineEmpty = () => {
    const el = this._createEl('div', 'exd-empty-line'); el.textContent = 'No key moments detected';
    return el;
  }

  renderNodes = (nodes, maxDurMs) => {
    if (nodes.length === 0) {
      return `<div class="exd-empty-line">No node executions detected</div>`;
    }
    const statusClass = (st) => {
      const s = String(st || '').toLowerCase();
      if (s === 'succeeded' || s === 'completed') return { cls: 'is-success', pill: 'pill-success', label: st };
      if (s === 'failed' || s === 'faulted')      return { cls: 'is-failed',  pill: 'pill-failed',  label: st };
      if (s === 'running' || s === 'started')     return { cls: 'is-running', pill: 'pill-running', label: st };
      if (s === 'skipped')                        return { cls: 'is-skipped', pill: 'pill-skipped', label: st };
      return { cls: '', pill: 'pill-unknown', label: st || 'Unknown' };
    };

    const items = nodes.map(n => {
      const sc = statusClass(n.status);
      const scale = maxDurMs > 0 ? Math.max(0.04, (n.durationMs || 0) / maxDurMs) : 0;
      return `
        <div class="exd-node ${sc.cls}" data-key="${this.esc(n.name)}" style="--exd-bar-scale:${scale.toFixed(3)}">
          <div class="exd-node-head">
            <span class="exd-node-name" title="${this.esc(n.name)}">${this.esc(n.name)}</span>
            <span class="exd-pill ${sc.pill}">${this.esc(sc.label)}</span>
            <span class="exd-node-dur">${this.esc(n.duration)}</span>
          </div>
          <div class="exd-node-bar"><div class="fill"></div></div>
          ${n.error ? `<div class="exd-node-err">${this.esc(n.error)}</div>` : ''}
        </div>
      `;
    }).join('');
    return `<div class="exd-nodes">${items}</div>`;
  }

  renderErrors = (errors) => {
    return errors.map(e => `
      <div class="exd-error" data-key="${this.esc(e.code)}">
        <div class="exd-error-head">
          <span class="exd-error-code">${this.esc(e.code)}</span>
          ${e.node ? `<span class="exd-error-node">${this.esc(e.node)}</span>` : ''}
          <span class="exd-error-count">×${e.count}</span>
        </div>
        <div class="exd-error-msg">${this.esc(e.message)}</div>
      </div>
    `).join('');
  }

  renderTimeline = (events, statusKey) => {
    if (events.length === 0) {
      return `<div class="exd-empty-line">No key moments detected</div>`;
    }
    const flowing = statusKey === 'running';
    const items = events.map((e, i) => `
      <div class="exd-tl-item tl-${this.esc(e.type)}" data-key="${this.esc(e.time + '|' + e.text + '|' + i)}">
        <span class="exd-tl-time">${this.esc(e.time)}</span>
        <span class="exd-tl-text">${this.esc(e.text)}</span>
      </div>
    `).join('');
    return `<div class="exd-timeline ${flowing ? 'is-flowing' : ''}">${items}</div>`;
  }

  wireInteractions = (container, data) => {
    // Close button
    const closeBtn = container.querySelector('#exd-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.collapse();
      });
    }
    // Iteration ID copy
    const iter = container.querySelector('#exd-iter-copy');
    if (iter && data && data.iterationId) {
      iter.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(data.iterationId);
          iter.classList.remove('copied');
          void iter.offsetWidth; // restart animation
          iter.classList.add('copied');
        } catch (_) { /* clipboard unavailable */ }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  OPEN / CLOSE
  // ─────────────────────────────────────────────────────────────────────

  open = () => {
    const drawer = document.getElementById('exec-drawer');
    const rtContent = document.getElementById('rt-content');
    if (!drawer) return;
    drawer.classList.remove('closing', 'collapsed');
    drawer.classList.add('open', 'has-data');
    drawer.setAttribute('aria-hidden', 'false');
    if (rtContent) rtContent.classList.add('exec-drawer-open');
  }

  /** Collapse the drawer (hide visually) but keep data intact for re-open. */
  collapse = () => {
    const drawer = document.getElementById('exec-drawer');
    const rtContent = document.getElementById('rt-content');
    if (!drawer || !drawer.classList.contains('open')) return;
    drawer.classList.add('closing');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (rtContent) rtContent.classList.remove('exec-drawer-open');
    setTimeout(() => {
      drawer.classList.remove('closing');
      drawer.classList.add('collapsed');
    }, 240);
  }

  /** Toggle drawer open/collapsed. Only works when data exists. */
  toggle = () => {
    const drawer = document.getElementById('exec-drawer');
    if (!drawer) return;
    if (drawer.classList.contains('open')) {
      this.collapse();
    } else if (drawer.classList.contains('collapsed') || drawer.classList.contains('has-data')) {
      this.open();
    }
  }

  clearSummary = () => {
    const drawer = document.getElementById('exec-drawer');
    const container = document.getElementById('exec-summary-data');
    const rtContent = document.getElementById('rt-content');
    if (!drawer) return;
    if (!drawer.classList.contains('open') && !drawer.classList.contains('collapsed')) return;
    drawer.classList.add('closing');
    drawer.classList.remove('open', 'collapsed');
    drawer.setAttribute('aria-hidden', 'true');
    if (rtContent) rtContent.classList.remove('exec-drawer-open');
    setTimeout(() => {
      drawer.classList.remove('closing', 'has-data');
      if (container) container.innerHTML = '';
    }, 240);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────────────────────────────

  formatDurationParts = (ms, fallback) => {
    if (!ms || ms <= 0) {
      const f = String(fallback || '—');
      return { num: f, unit: '' };
    }
    if (ms < 1000)     return { num: String(Math.round(ms)),                 unit: 'ms' };
    if (ms < 60_000)   return { num: (ms / 1000).toFixed(1),                 unit: 's'  };
    if (ms < 3_600_000) {
      const m = Math.floor(ms / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      return { num: `${m}:${String(s).padStart(2, '0')}`, unit: 'min' };
    }
    return { num: (ms / 3_600_000).toFixed(1), unit: 'h' };
  }

  esc = (text) => {
    const d = document.createElement('div');
    d.textContent = String(text == null ? '' : text);
    return d.innerHTML;
  }
}
