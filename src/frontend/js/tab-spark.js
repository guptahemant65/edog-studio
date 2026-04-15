/**
 * SparkSessionsTab — Real-time Spark session monitoring.
 *
 * Topic: spark (via SignalR SubscribeToTopic streaming)
 * Event shape: { sessionTrackingId, event, tenantId, workspaceId,
 *                artifactId, iterationId, workspaceName, artifactName, tokenType }
 *
 * Architecture:
 *   - Cards per session, grouped Active / History
 *   - Swimlane timeline visualization
 *   - Detail panel with command inspection
 *   - Filter pills (All / Active / Disposed / Errored)
 *   - Export (JSON / CSV)
 *   - Keyboard: Arrow Up/Down navigate, Enter expand, Escape close
 *
 * Pattern: constructor(containerEl, signalr) → activate() / deactivate()
 * Mock reference: f04-mock-04-spark-sessions.html
 */
class SparkSessionsTab {
  constructor(containerEl, signalr) {
    this._container = containerEl;
    this._signalr = signalr;

    /** @type {Map<string, SparkSession>} sessionTrackingId → session state */
    this._sessions = new Map();

    this._filter = 'all';
    this._selectedId = null;
    this._expandedIds = new Set();
    this._active = false;
    this._elapsedTimers = [];
    this._maxSessions = 200;

    // DOM cache — populated in _buildDOM()
    this._dom = {};
    this._tooltipEl = null;

    this._boundOnEvent = (envelope) => this._onEvent(envelope);
    this._boundKeyDown = (e) => this._onKeyDown(e);

    this._buildDOM();
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  activate() {
    this._active = true;
    if (this._signalr) {
      this._signalr.on('spark', this._boundOnEvent);
      this._signalr.subscribeTopic('spark');
    }
    document.addEventListener('keydown', this._boundKeyDown);
    document.addEventListener('click', this._onDocClick);
    this._render();
  }

  deactivate() {
    this._active = false;
    if (this._signalr) {
      this._signalr.off('spark', this._boundOnEvent);
      this._signalr.unsubscribeTopic('spark');
    }
    document.removeEventListener('keydown', this._boundKeyDown);
    document.removeEventListener('click', this._onDocClick);
    this._stopElapsedTimers();
  }

  // ── Event handling ─────────────────────────────────────────────

  _onEvent(envelope) {
    const data = envelope && envelope.data ? envelope.data : envelope;
    if (!data || !data.sessionTrackingId) return;

    if (this._sessions.size > this._maxSessions) {
      this._pruneOldestDisposed();
    }

    const id = data.sessionTrackingId;
    let session = this._sessions.get(id);

    if (!session) {
      session = this._createSession(id, data);
      this._sessions.set(id, session);
    }

    this._applyEvent(session, data);

    if (this._active) {
      this._render();
    }
  }

  _createSession(id, data) {
    return {
      id: id,
      status: 'created',
      event: data.event || 'Created',
      tenantId: data.tenantId || '',
      workspaceId: data.workspaceId || '',
      artifactId: data.artifactId || '',
      iterationId: data.iterationId || '',
      workspaceName: data.workspaceName || '',
      artifactName: data.artifactName || '',
      tokenType: data.tokenType || '',
      createdAt: Date.now(),
      elapsed: 0,
      commands: [],
      errorMsg: '',
      reused: false,
      reusedFrom: '',
      lived: '',
      idleDuration: ''
    };
  }

  _applyEvent(session, data) {
    const evt = (data.event || '').toLowerCase();
    session.event = data.event || session.event;

    if (data.workspaceName) session.workspaceName = data.workspaceName;
    if (data.artifactName) session.artifactName = data.artifactName;
    if (data.iterationId) session.iterationId = data.iterationId;
    if (data.tokenType) session.tokenType = data.tokenType;

    switch (evt) {
      case 'created':
        session.status = 'created';
        session.createdAt = Date.now();
        break;
      case 'active':
      case 'activated':
        session.status = 'active';
        break;
      case 'disposed':
        session.status = 'disposed';
        session.lived = this._fmtElapsed(session.elapsed);
        break;
      case 'timeout':
      case 'timedout':
        session.status = 'timeout';
        session.idleDuration = data.idleDuration || this._fmtElapsed(session.elapsed);
        break;
      case 'error':
      case 'failed':
        session.status = 'error';
        session.errorMsg = data.errorMessage || data.error || 'Unknown error';
        break;
      case 'reused':
        session.reused = true;
        session.reusedFrom = data.reusedFrom || data.previousArtifactName || '';
        session.status = 'active';
        break;
      case 'commandstarted':
        session.commands.push({
          idx: session.commands.length + 1,
          type: data.commandType || 'SQL',
          code: data.code || data.commandText || '',
          status: 'running',
          duration: 0,
          retries: 0,
          startedAt: Date.now()
        });
        break;
      case 'commandcompleted':
        this._updateCommand(session, data, 'done');
        break;
      case 'commandfailed':
        this._updateCommand(session, data, 'failed');
        break;
      default:
        break;
    }
  }

  _updateCommand(session, data, status) {
    const cmd = session.commands.find(c => c.status === 'running');
    if (cmd) {
      cmd.status = status;
      if (data.durationMs) cmd.duration = data.durationMs / 1000;
      if (data.retries) cmd.retries = data.retries;
      if (data.error) cmd.error = data.error;
    }
  }

  _pruneOldestDisposed() {
    const disposed = [];
    for (const [id, s] of this._sessions) {
      if (s.status === 'disposed' || s.status === 'timeout') disposed.push(id);
    }
    disposed.sort((a, b) => {
      const sa = this._sessions.get(a);
      const sb = this._sessions.get(b);
      return sa.createdAt - sb.createdAt;
    });
    while (disposed.length > 0 && this._sessions.size > this._maxSessions) {
      this._sessions.delete(disposed.shift());
    }
  }

  // ── DOM construction ───────────────────────────────────────────

  _buildDOM() {
    const el = this._container;
    el.innerHTML = '';

    const root = this._ce('div', 'spark-tab');

    // Tooltip (positioned fixed, body-level)
    this._tooltipEl = this._ce('div', 'spark-tooltip');
    root.appendChild(this._tooltipEl);

    // Toolbar
    const toolbar = this._ce('div', 'spark-toolbar');
    const pills = this._ce('div', 'spark-status-pills');
    const pillDefs = [
      { filter: 'all', label: 'All', activeClass: 'active-all' },
      { filter: 'active', label: 'Active', activeClass: 'active-active' },
      { filter: 'disposed', label: 'Disposed', activeClass: 'active-disposed' },
      { filter: 'errored', label: 'Errored', activeClass: 'active-errored' }
    ];

    this._dom.pills = {};
    pillDefs.forEach(def => {
      const btn = this._ce('button', 'spark-pill');
      btn.dataset.filter = def.filter;
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', def.filter === 'all' ? 'true' : 'false');
      const countSpan = this._ce('span', 'spark-pill-count');
      countSpan.textContent = '0';
      btn.textContent = def.label;
      btn.appendChild(countSpan);
      btn.addEventListener('click', () => this._setFilter(def.filter));
      pills.appendChild(btn);
      this._dom.pills[def.filter] = { el: btn, count: countSpan, activeClass: def.activeClass };
    });
    toolbar.appendChild(pills);

    const sep = this._ce('div', 'spark-toolbar-sep');
    toolbar.appendChild(sep);

    this._dom.sessionCount = this._ce('span', 'spark-session-count');
    this._dom.sessionCount.textContent = '0 sessions';
    toolbar.appendChild(this._dom.sessionCount);

    const toolbarRight = this._ce('div', 'spark-toolbar-right');
    const exportWrap = this._ce('div');
    exportWrap.style.position = 'relative';

    const exportBtn = this._ce('button', 'spark-export-btn');
    exportBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Export \u25BE';
    exportBtn.setAttribute('aria-label', 'Export sessions');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._dom.exportDropdown.classList.toggle('open');
    });

    this._dom.exportDropdown = this._ce('div', 'spark-export-dropdown');
    const jsonBtn = this._ce('button');
    jsonBtn.textContent = 'Export as JSON';
    jsonBtn.addEventListener('click', () => this._exportJSON());
    const csvBtn = this._ce('button');
    csvBtn.textContent = 'Export as CSV';
    csvBtn.addEventListener('click', () => this._exportCSV());
    this._dom.exportDropdown.appendChild(jsonBtn);
    this._dom.exportDropdown.appendChild(csvBtn);

    exportWrap.appendChild(exportBtn);
    exportWrap.appendChild(this._dom.exportDropdown);
    toolbarRight.appendChild(exportWrap);
    toolbar.appendChild(toolbarRight);
    root.appendChild(toolbar);

    // Content area
    const content = this._ce('div', 'spark-content');

    // Swimlane
    this._dom.swimlaneArea = this._ce('div', 'spark-swimlane-area');
    const swimLabel = this._ce('div', 'spark-swimlane-label');
    swimLabel.textContent = 'Session Timeline';
    this._dom.swimlane = this._ce('div', 'spark-swimlane');
    this._dom.swimlaneArea.appendChild(swimLabel);
    this._dom.swimlaneArea.appendChild(this._dom.swimlane);
    content.appendChild(this._dom.swimlaneArea);

    // Empty state
    this._dom.emptyState = this._ce('div', 'spark-empty');
    this._dom.emptyState.innerHTML = `
      <div class="spark-empty-icon">
        <div class="spark-empty-orbit"></div>
        <div class="spark-empty-orbit"></div>
        <div class="spark-empty-core">
          <svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
        </div>
      </div>
      <div class="spark-empty-title">No Spark sessions active</div>
      <div class="spark-empty-hint">Sessions will appear when FLT creates notebook execution contexts. Deploy to a lakehouse to start.</div>
    `;
    content.appendChild(this._dom.emptyState);

    // Cards container
    this._dom.cards = this._ce('div', 'spark-cards');
    content.appendChild(this._dom.cards);

    // Detail panel
    this._dom.detail = this._ce('div', 'spark-detail');
    this._dom.detail.setAttribute('role', 'complementary');
    this._dom.detail.setAttribute('aria-label', 'Session detail');

    const resizeHandle = this._ce('div', 'spark-detail-resize');
    this._dom.detail.appendChild(resizeHandle);
    this._bindResize(resizeHandle, content);

    const detailHeader = this._ce('div', 'spark-detail-header');
    this._dom.detailTitle = this._ce('div', 'spark-detail-title');
    this._dom.detailStatus = this._ce('span', 'spark-status-badge');
    const detailActions = this._ce('div', 'spark-detail-actions');

    const viewLogsBtn = this._ce('button', 'view-logs');
    viewLogsBtn.textContent = 'View in Logs';
    viewLogsBtn.addEventListener('click', () => this._viewInLogs());

    const copyIdBtn = this._ce('button');
    copyIdBtn.textContent = 'Copy Session ID';
    copyIdBtn.addEventListener('click', () => this._copySessionId());

    detailActions.appendChild(viewLogsBtn);
    detailActions.appendChild(copyIdBtn);

    const closeBtn = this._ce('button', 'spark-detail-close');
    closeBtn.setAttribute('aria-label', 'Close detail panel');
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    closeBtn.addEventListener('click', () => this._closeDetail());

    detailHeader.appendChild(this._dom.detailTitle);
    detailHeader.appendChild(this._dom.detailStatus);
    detailHeader.appendChild(detailActions);
    detailHeader.appendChild(closeBtn);
    this._dom.detail.appendChild(detailHeader);

    this._dom.detailBody = this._ce('div', 'spark-detail-body');
    this._dom.detail.appendChild(this._dom.detailBody);

    content.appendChild(this._dom.detail);
    root.appendChild(content);
    el.appendChild(root);

    // Close dropdown on outside click — registered in activate(), removed in deactivate()
    this._onDocClick = (e) => {
      if (!this._active) return;
      if (this._dom.exportDropdown &&
          !e.target.closest('.spark-export-btn') &&
          !e.target.closest('.spark-export-dropdown')) {
        this._dom.exportDropdown.classList.remove('open');
      }
    };
  }

  // ── Rendering ──────────────────────────────────────────────────

  _render() {
    const sessions = this._getFilteredSessions();
    this._updateCounts();
    this._stopElapsedTimers();

    if (sessions.length === 0) {
      this._dom.emptyState.classList.remove('hidden');
      this._dom.cards.innerHTML = '';
      this._dom.swimlaneArea.style.display = 'none';
      return;
    }

    this._dom.emptyState.classList.add('hidden');
    this._dom.swimlaneArea.style.display = '';
    this._renderCards(sessions);
    this._renderSwimlane(sessions);
    this._startElapsedTimers(sessions);
  }

  _renderCards(sessions) {
    const frag = document.createDocumentFragment();
    const activeSessions = sessions.filter(s => s.status === 'active' || s.status === 'created');
    const historySessions = sessions.filter(s => s.status !== 'active' && s.status !== 'created');

    if (activeSessions.length > 0) {
      const header = this._ce('div', 'spark-section-header');
      header.innerHTML = '<span class="spark-section-dot active"></span> Active <span class="spark-section-count">(' + activeSessions.length + ')</span>';
      frag.appendChild(header);
      activeSessions.forEach((s, i) => frag.appendChild(this._buildCard(s, i * 60)));
    }

    if (historySessions.length > 0) {
      const header = this._ce('div', 'spark-section-header');
      header.innerHTML = '<span class="spark-section-dot history"></span> History <span class="spark-section-count">(' + historySessions.length + ')</span>';
      frag.appendChild(header);
      historySessions.forEach((s, i) => frag.appendChild(this._buildCard(s, (activeSessions.length + i) * 60)));
    }

    this._dom.cards.innerHTML = '';
    this._dom.cards.appendChild(frag);
  }

  _buildCard(session, delay) {
    const s = session;
    const isActive = s.status === 'active' || s.status === 'created';
    const isExpanded = this._expandedIds.has(s.id);

    const card = this._ce('div', 'spark-card status-' + s.status);
    if (this._selectedId === s.id) card.classList.add('selected');
    if (isExpanded) card.classList.add('expanded');
    card.dataset.sessionId = s.id;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', 'Session ' + s.id + ', status ' + s.status);

    if (delay > 0) {
      card.style.animationDelay = delay + 'ms';
      card.classList.add('entering');
    }

    // Header row
    const hdr = this._ce('div', 'spark-card-header');
    const idSpan = this._ce('span', 'spark-card-session-id');
    idSpan.textContent = s.id;
    hdr.appendChild(idSpan);

    if (s.reused) {
      const reuseBadge = this._ce('span', 'spark-reused-badge');
      reuseBadge.textContent = '\u21BB Reused';
      hdr.appendChild(reuseBadge);
    }

    hdr.appendChild(this._buildStatusBadge(s.status));

    const elapsed = this._ce('span', 'spark-card-elapsed');
    elapsed.textContent = this._fmtElapsed(s.elapsed);
    elapsed.dataset.sessionId = s.id;
    if (isActive) elapsed.classList.add('counting');
    hdr.appendChild(elapsed);
    card.appendChild(hdr);

    // Meta row
    const meta = this._ce('div', 'spark-card-meta');
    if (s.artifactName) {
      const tag = this._ce('span', 'spark-meta-tag');
      tag.textContent = 'MLV: ' + s.artifactName;
      meta.appendChild(tag);
    }
    if (s.reused && s.reusedFrom) {
      const rTag = this._ce('span', 'spark-meta-tag');
      rTag.textContent = 'from: ' + s.reusedFrom;
      rTag.style.color = 'var(--comp-onelake)';
      meta.appendChild(rTag);
    }
    if (s.commands.length > 0) {
      meta.appendChild(this._buildProgressDots(s));
    }
    card.appendChild(meta);

    // Lifecycle bar
    card.appendChild(this._buildLifecycleBar(s));

    // Command list (active or expanded)
    if (isActive || isExpanded) {
      card.appendChild(this._buildCommandList(s));
    }

    // Waterfall (expanded only)
    if (isExpanded) {
      card.appendChild(this._buildWaterfall(s));
    }

    // Error summary
    if (s.status === 'error' && s.errorMsg) {
      const errDiv = this._ce('div', 'spark-card-error');
      errDiv.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
      const errText = document.createTextNode(s.errorMsg);
      errDiv.appendChild(errText);
      card.appendChild(errDiv);
    }

    // Lived/idle text
    if (s.status === 'disposed' && s.lived) {
      const lived = this._ce('div', 'spark-card-lived');
      lived.textContent = 'Lived ' + s.lived;
      card.appendChild(lived);
    }
    if (s.status === 'timeout' && s.idleDuration) {
      const idle = this._ce('div', 'spark-card-lived');
      idle.textContent = 'Idle ' + s.idleDuration + ' before timeout';
      card.appendChild(idle);
    }

    // Click handlers
    card.addEventListener('click', (e) => {
      if (e.target.closest('.spark-cmd-row')) return;
      this._toggleExpand(s.id);
    });

    return card;
  }

  _buildStatusBadge(status) {
    const badge = this._ce('span', 'spark-status-badge ' + status);
    switch (status) {
      case 'created':
        badge.textContent = 'Created';
        break;
      case 'active':
        const dot = this._ce('span', 'spark-pulse-dot');
        badge.appendChild(dot);
        badge.appendChild(document.createTextNode(' Active'));
        break;
      case 'disposed':
        badge.textContent = 'Disposed';
        break;
      case 'timeout':
        badge.textContent = 'Timed Out \u26A0';
        break;
      case 'error':
        badge.textContent = 'Error \u2715';
        break;
      default:
        badge.textContent = status;
    }
    return badge;
  }

  _buildProgressDots(session) {
    const wrap = this._ce('span', 'spark-progress-dots');
    const cmds = session.commands;
    cmds.forEach(c => {
      const d = this._ce('span', 'spark-progress-dot');
      if (c.status === 'done') d.classList.add('done');
      else if (c.status === 'running') d.classList.add('running');
      wrap.appendChild(d);
    });

    const running = cmds.find(c => c.status === 'running');
    const doneCount = cmds.filter(c => c.status === 'done').length;
    const total = cmds.length;
    const label = running
      ? ' Cell ' + running.idx + ' of ' + total
      : (session.status === 'disposed'
        ? ' ' + total + '/' + total + ' cells completed'
        : ' ' + doneCount + '/' + total + ' cells');
    wrap.appendChild(document.createTextNode(label));
    return wrap;
  }

  _buildLifecycleBar(session) {
    const bar = this._ce('div', 'spark-lifecycle-bar');
    const s = session;
    const total = Math.max(s.commands.length, 1);
    const done = s.commands.filter(c => c.status === 'done').length;

    switch (s.status) {
      case 'created': {
        const seg = this._ce('div', 'spark-lifecycle-seg creating');
        seg.style.width = '5%';
        bar.appendChild(seg);
        break;
      }
      case 'active': {
        const pct = Math.min(((done + 0.5) / total) * 100, 95);
        const seg = this._ce('div', 'spark-lifecycle-seg fill animating');
        seg.style.width = pct + '%';
        bar.appendChild(seg);
        break;
      }
      case 'disposed': {
        const seg = this._ce('div', 'spark-lifecycle-seg active');
        seg.style.width = '100%';
        bar.appendChild(seg);
        break;
      }
      case 'timeout': {
        const s1 = this._ce('div', 'spark-lifecycle-seg active');
        s1.style.width = '40%';
        const s2 = this._ce('div', 'spark-lifecycle-seg idle');
        s2.style.width = '30%';
        const s3 = this._ce('div', 'spark-lifecycle-seg timeout');
        s3.style.width = '30%';
        bar.appendChild(s1);
        bar.appendChild(s2);
        bar.appendChild(s3);
        break;
      }
      case 'error': {
        const donePct = (done / total) * 100;
        const s1 = this._ce('div', 'spark-lifecycle-seg active');
        s1.style.width = donePct + '%';
        const s2 = this._ce('div', 'spark-lifecycle-seg error');
        s2.style.width = (100 - donePct) + '%';
        bar.appendChild(s1);
        bar.appendChild(s2);
        break;
      }
    }

    if (s.reused && s.commands.length > 0) {
      const boundary = s.commands.findIndex(c => c.status === 'running' || c.status === 'pending');
      if (boundary > 0) {
        const markerPct = (boundary / s.commands.length) * 100;
        const marker = this._ce('div', 'spark-lifecycle-reuse');
        marker.style.left = markerPct + '%';
        bar.appendChild(marker);
      }
    }

    return bar;
  }

  _buildCommandList(session) {
    const list = this._ce('div', 'spark-command-list');
    session.commands.forEach(c => {
      const row = this._ce('div', 'spark-cmd-row');
      row.setAttribute('tabindex', '0');
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', 'Command ' + c.idx + ', ' + c.type + ', ' + c.status);
      row.dataset.sessionId = session.id;
      row.dataset.cmdIdx = c.idx;

      const idx = this._ce('span', 'spark-cmd-index');
      idx.textContent = c.idx;
      row.appendChild(idx);

      const type = this._ce('span', 'spark-cmd-type ' + (c.type === 'SQL' ? 'sql' : 'py'));
      type.textContent = c.type === 'PySpark' ? 'Py' : c.type;
      row.appendChild(type);

      const snippet = this._ce('span', 'spark-cmd-snippet');
      snippet.textContent = (c.code || '').split('\n')[0].substring(0, 60);
      row.appendChild(snippet);

      row.appendChild(this._buildCmdStatus(c));

      const dur = this._ce('span', 'spark-cmd-duration');
      dur.textContent = this._fmtDuration(c.duration);
      row.appendChild(dur);

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showCommandDetail(session, c.idx);
      });

      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          this._showCommandDetail(session, c.idx);
        }
      });

      list.appendChild(row);
    });
    return list;
  }

  _buildCmdStatus(cmd) {
    const wrap = this._ce('span', 'spark-cmd-status');
    switch (cmd.status) {
      case 'done':
        wrap.classList.add('done');
        wrap.textContent = '\u2713';
        break;
      case 'running':
        wrap.classList.add('running');
        const spinner = this._ce('span', 'spark-cmd-spinner');
        wrap.appendChild(spinner);
        break;
      case 'pending':
        wrap.classList.add('pending');
        wrap.textContent = '\u25CB';
        break;
      case 'failed':
        wrap.classList.add('failed');
        wrap.textContent = '\u2715';
        break;
      case 'timeout':
        wrap.style.color = 'var(--level-warning)';
        wrap.textContent = '\u26A0';
        break;
      default:
        wrap.textContent = cmd.status;
    }
    return wrap;
  }

  _buildWaterfall(session) {
    const wrap = this._ce('div', 'spark-waterfall');
    const maxDur = Math.max(...session.commands.map(c => c.duration), 0.1);

    session.commands.forEach(c => {
      const row = this._ce('div', 'spark-waterfall-row');
      const label = this._ce('span', 'spark-waterfall-label');
      label.textContent = (c.type === 'PySpark' ? 'Py' : c.type) + ' #' + c.idx;
      row.appendChild(label);

      const track = this._ce('div', 'spark-waterfall-track');
      const fill = this._ce('div', 'spark-waterfall-fill');
      const pct = Math.max((c.duration / maxDur) * 100, 3);
      fill.style.width = pct + '%';

      if (c.status === 'done') fill.classList.add('done');
      else if (c.status === 'running') fill.classList.add('running');
      else if (c.status === 'failed') fill.classList.add('failed');
      else fill.classList.add('pending');

      track.appendChild(fill);
      row.appendChild(track);

      const time = this._ce('span', 'spark-waterfall-time');
      time.textContent = this._fmtDuration(c.duration);
      row.appendChild(time);

      wrap.appendChild(row);
    });

    return wrap;
  }

  // ── Swimlane ───────────────────────────────────────────────────

  _renderSwimlane(sessions) {
    const sl = this._dom.swimlane;
    sl.innerHTML = '';
    if (!sessions.length) {
      this._dom.swimlaneArea.style.display = 'none';
      return;
    }

    let minT = Infinity;
    let maxT = -Infinity;
    sessions.forEach(s => {
      const start = s.createdAt;
      const end = start + (s.elapsed * 1000);
      if (start < minT) minT = start;
      if (end > maxT) maxT = end;
    });

    const range = maxT - minT || 1;
    const pad = range * 0.05;
    const totalRange = range + pad * 2;
    const startBase = minT - pad;

    const statusColors = {
      active: 'var(--status-succeeded)',
      created: 'var(--comp-controller)',
      disposed: 'var(--text-muted)',
      timeout: 'var(--level-warning)',
      error: 'var(--status-failed)'
    };

    sessions.forEach((s, i) => {
      const start = s.createdAt;
      const end = start + (s.elapsed * 1000);
      const left = ((start - startBase) / totalRange * 100);
      const width = ((end - start) / totalRange * 100);
      const top = 2 + i * 8;

      const row = this._ce('div', 'spark-swimlane-row');
      row.style.cssText = 'left:' + left + '%;width:' + Math.max(width, 1) + '%;top:' + top + 'px;background:' + (statusColors[s.status] || 'var(--accent)') + ';opacity:0.7;';

      const label = this._ce('span', 'spark-swimlane-row-label');
      label.textContent = s.id.length > 7 ? s.id.slice(-7) : s.id;
      row.appendChild(label);

      if (s.reused) {
        const boundary = s.commands.findIndex(c => c.status === 'running' || c.status === 'pending');
        if (boundary > 0 && s.commands.length > 0) {
          const bPct = (boundary / s.commands.length) * 100;
          const marker = this._ce('div', 'spark-swimlane-reuse-marker');
          marker.style.left = bPct + '%';
          row.appendChild(marker);
        }
      }

      row.addEventListener('mouseenter', (e) => {
        this._showTooltip(
          s.id + ' \u2014 ' + s.status + ' \u2014 ' + this._fmtElapsed(s.elapsed),
          e.clientX, e.clientY
        );
      });
      row.addEventListener('mouseleave', () => this._hideTooltip());
      row.addEventListener('click', () => this._selectSession(s.id));
      sl.appendChild(row);
    });

    // Axis labels
    const axis = this._ce('div', 'spark-swimlane-axis');
    for (let i = 0; i <= 4; i++) {
      const sp = this._ce('span');
      const t = new Date(startBase + (totalRange / 4) * i);
      sp.textContent = t.toTimeString().split(' ')[0];
      axis.appendChild(sp);
    }
    sl.appendChild(axis);
  }

  // ── Detail panel ───────────────────────────────────────────────

  _showSessionDetail(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return;

    this._dom.detailTitle.textContent = s.id;
    const badge = this._buildStatusBadge(s.status);
    this._dom.detailStatus.replaceWith(badge);
    this._dom.detailStatus = badge;

    const statusText = s.status === 'timeout' ? 'Timed Out' : (s.status.charAt(0).toUpperCase() + s.status.slice(1));

    let html = '<div class="spark-detail-meta">';
    const fields = [
      ['Status', statusText],
      ['Created', new Date(s.createdAt).toLocaleTimeString()],
      ['Elapsed', this._fmtElapsed(s.elapsed)],
      ['Artifact', s.artifactName || '\u2014'],
      ['Workspace', s.workspaceName || '\u2014'],
      ['Token Type', s.tokenType || '\u2014'],
      ['Reused', s.reused ? 'Yes (from ' + s.reusedFrom + ')' : 'No'],
      ['Commands', s.commands.filter(c => c.status === 'done').length + ' / ' + s.commands.length]
    ];
    fields.forEach(([label, value]) => {
      html += '<div class="spark-detail-meta-item"><div class="label">' + this._esc(label) + '</div><div class="value">' + this._esc(value) + '</div></div>';
    });
    html += '</div>';

    if (s.commands.length > 0) {
      html += '<div class="spark-detail-section-title">Commands</div>';
      html += '<table class="spark-cmd-table"><thead><tr><th>#</th><th>Type</th><th>Code</th><th>Status</th><th>Duration</th><th>Retries</th></tr></thead><tbody>';
      s.commands.forEach(c => {
        const snippet = (c.code || '').split('\n')[0].substring(0, 50);
        const statusSymbol = { done: '\u2713 Done', running: '\u25CF Running', pending: '\u25CB Pending', failed: '\u2715 Failed', timeout: '\u26A0 Timeout' }[c.status] || c.status;
        html += '<tr data-detail-cmd="' + c.idx + '"><td style="font-family:var(--font-mono)">' + c.idx + '</td>' +
          '<td><span class="spark-cmd-type ' + (c.type === 'SQL' ? 'sql' : 'py') + '">' + (c.type === 'PySpark' ? 'Py' : c.type) + '</span></td>' +
          '<td style="font-family:var(--font-mono);font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + this._esc(snippet) + '</td>' +
          '<td>' + statusSymbol + '</td>' +
          '<td style="font-family:var(--font-mono)">' + this._fmtDuration(c.duration) + '</td>' +
          '<td style="font-family:var(--font-mono)">' + (c.retries || 0) + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    this._dom.detailBody.innerHTML = html;

    // Bind command row clicks in detail
    this._dom.detailBody.querySelectorAll('tr[data-detail-cmd]').forEach(tr => {
      tr.addEventListener('click', () => {
        const idx = parseInt(tr.dataset.detailCmd, 10);
        this._showCommandDetail(s, idx);
      });
    });

    this._dom.detail.classList.add('open');
  }

  _showCommandDetail(session, cmdIdx) {
    const cmd = session.commands.find(c => c.idx === cmdIdx);
    if (!cmd) return;

    this._dom.detailTitle.textContent = session.id + ' \u203A Cell #' + cmd.idx;
    const badge = this._ce('span', 'spark-cmd-type ' + (cmd.type === 'SQL' ? 'sql' : 'py'));
    badge.textContent = cmd.type;
    badge.style.fontSize = '11px';
    this._dom.detailStatus.replaceWith(badge);
    this._dom.detailStatus = badge;

    let html = '<div class="spark-detail-meta">';
    const fields = [
      ['Cell', '#' + cmd.idx + ' of ' + session.commands.length],
      ['Type', cmd.type],
      ['Status', cmd.status],
      ['Duration', this._fmtDuration(cmd.duration)],
      ['Retries', String(cmd.retries || 0)],
      ['Session', session.id]
    ];
    fields.forEach(([label, value]) => {
      html += '<div class="spark-detail-meta-item"><div class="label">' + this._esc(label) + '</div><div class="value">' + this._esc(value) + '</div></div>';
    });
    html += '</div>';

    html += '<div class="spark-detail-section-title">Code</div>';
    html += '<div class="spark-code-block">' + this._highlight(cmd.code || '', cmd.type) + '</div>';

    if (cmd.error) {
      html += '<div class="spark-detail-section-title">Error</div>';
      html += '<div class="spark-code-block" style="border-color:rgba(229,69,59,0.3);color:var(--status-failed)">' + this._esc(cmd.error) + '</div>';
    }

    html += '<div style="margin-top:12px"><button class="spark-copy-code-btn" style="padding:6px 14px;border-radius:var(--radius-md);font-size:11px;font-weight:500;border:1px solid var(--border);cursor:pointer;background:none;color:var(--text-dim);font-family:var(--font-body);transition:all 160ms cubic-bezier(0.4,0,0.2,1)">Copy Code</button></div>';

    this._dom.detailBody.innerHTML = html;

    const copyBtn = this._dom.detailBody.querySelector('.spark-copy-code-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(cmd.code || '').then(() => this._toast('Code copied to clipboard'));
      });
    }

    this._dom.detail.classList.add('open');
  }

  _closeDetail() {
    this._dom.detail.classList.remove('open');
    this._dom.detail.style.height = '';
  }

  _viewInLogs() {
    if (this._selectedId && window.edogApp && window.edogApp.runtimeView) {
      this._toast('Switching to Logs tab filtered by session');
      window.edogApp.runtimeView.switchTab('logs');
    } else {
      this._toast('Switching to Logs tab filtered by session time range');
    }
  }

  _copySessionId() {
    const id = this._dom.detailTitle.textContent.split(' ')[0];
    navigator.clipboard.writeText(id).then(() => this._toast('Session ID copied'));
  }

  // ── Resize handle ──────────────────────────────────────────────

  _bindResize(handle, contentEl) {
    let isResizing = false;

    const onMove = (e) => {
      if (!isResizing) return;
      const contentRect = contentEl.getBoundingClientRect();
      const newHeight = contentRect.bottom - e.clientY;
      this._dom.detail.style.height = Math.max(120, Math.min(newHeight, contentRect.height * 0.7)) + 'px';
    };

    const onUp = () => {
      isResizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Filters ────────────────────────────────────────────────────

  _setFilter(filter) {
    this._filter = filter;
    for (const [key, pill] of Object.entries(this._dom.pills)) {
      pill.el.className = 'spark-pill';
      pill.el.setAttribute('aria-checked', 'false');
      if (key === filter) {
        pill.el.classList.add(pill.activeClass);
        pill.el.setAttribute('aria-checked', 'true');
      }
    }
    this._render();
  }

  _getFilteredSessions() {
    const all = Array.from(this._sessions.values());
    switch (this._filter) {
      case 'active':
        return all.filter(s => s.status === 'active' || s.status === 'created');
      case 'disposed':
        return all.filter(s => s.status === 'disposed');
      case 'errored':
        return all.filter(s => s.status === 'error' || s.status === 'timeout');
      default:
        return all;
    }
  }

  _updateCounts() {
    const all = Array.from(this._sessions.values());
    const counts = {
      all: all.length,
      active: all.filter(s => s.status === 'active' || s.status === 'created').length,
      disposed: all.filter(s => s.status === 'disposed').length,
      errored: all.filter(s => s.status === 'error' || s.status === 'timeout').length
    };

    for (const [key, pill] of Object.entries(this._dom.pills)) {
      pill.count.textContent = counts[key];
    }

    const filtered = this._getFilteredSessions();
    this._dom.sessionCount.textContent = filtered.length + ' session' + (filtered.length !== 1 ? 's' : '');
  }

  // ── Elapsed timers ─────────────────────────────────────────────

  _startElapsedTimers(sessions) {
    const activeSessions = sessions.filter(s => s.status === 'active');
    activeSessions.forEach(s => {
      // Store start reference for drift-free elapsed calculation
      if (!s._timerBase) {
        s._timerBase = Date.now();
        s._elapsedAtBase = s.elapsed;
      }
      const timer = setInterval(() => {
        s.elapsed = s._elapsedAtBase + (Date.now() - s._timerBase) / 1000;
        const runningCmd = s.commands.find(c => c.status === 'running');
        if (runningCmd && runningCmd.startedAt) {
          runningCmd.duration = (Date.now() - runningCmd.startedAt) / 1000;
        }
        const el = this._dom.cards.querySelector('.spark-card-elapsed[data-session-id="' + s.id + '"]');
        if (el) el.textContent = this._fmtElapsed(s.elapsed);
      }, 100);
      this._elapsedTimers.push(timer);
    });
  }

  _stopElapsedTimers() {
    this._elapsedTimers.forEach(id => clearInterval(id));
    this._elapsedTimers = [];
  }

  // ── Interaction ────────────────────────────────────────────────

  _toggleExpand(sessionId) {
    if (this._expandedIds.has(sessionId)) {
      this._expandedIds.delete(sessionId);
    } else {
      this._expandedIds.add(sessionId);
    }
    this._selectedId = sessionId;
    this._render();
    this._showSessionDetail(sessionId);
  }

  _selectSession(sessionId) {
    this._selectedId = sessionId;
    this._render();
    this._showSessionDetail(sessionId);
  }

  _onKeyDown(e) {
    if (!this._active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Arrow Up/Down for session navigation
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cards = Array.from(this._dom.cards.querySelectorAll('.spark-card'));
      if (!cards.length) return;
      let idx = cards.findIndex(c => c.dataset.sessionId === this._selectedId);
      if (e.key === 'ArrowDown') idx = Math.min(idx + 1, cards.length - 1);
      else idx = Math.max(idx - 1, 0);
      if (idx < 0) idx = 0;
      const sid = cards[idx].dataset.sessionId;
      this._selectedId = sid;
      cards.forEach(c => c.classList.toggle('selected', c.dataset.sessionId === sid));
      cards[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      cards[idx].focus();
      this._showSessionDetail(sid);
    }

    // Enter to expand
    if (e.key === 'Enter' && this._selectedId) {
      e.preventDefault();
      this._toggleExpand(this._selectedId);
    }

    // Escape to close detail
    if (e.key === 'Escape') {
      if (this._dom.exportDropdown.classList.contains('open')) {
        this._dom.exportDropdown.classList.remove('open');
        return;
      }
      if (this._dom.detail.classList.contains('open')) {
        this._closeDetail();
        return;
      }
    }

    // Ctrl+E export
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      this._dom.exportDropdown.classList.toggle('open');
    }
  }

  // ── Export ──────────────────────────────────────────────────────

  _exportJSON() {
    const data = JSON.stringify(Array.from(this._sessions.values()), null, 2);
    this._downloadBlob(data, 'application/json', 'spark-sessions.json');
    this._toast('Exported as JSON');
    this._dom.exportDropdown.classList.remove('open');
  }

  _exportCSV() {
    let csv = 'Session ID,Status,Artifact,Elapsed,Commands,Errors\n';
    for (const s of this._sessions.values()) {
      csv += this._csvSafe(s.id) + ',' + s.status + ',' + this._csvSafe(s.artifactName) + ',' +
        this._fmtElapsed(s.elapsed) + ',' + s.commands.length + ',' + this._csvSafe(s.errorMsg) + '\n';
    }
    this._downloadBlob(csv, 'text/csv', 'spark-sessions.csv');
    this._toast('Exported as CSV');
    this._dom.exportDropdown.classList.remove('open');
  }

  _downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Tooltip ────────────────────────────────────────────────────

  _showTooltip(text, x, y) {
    if (!this._tooltipEl) return;
    this._tooltipEl.textContent = text;
    this._tooltipEl.style.left = (x + 12) + 'px';
    this._tooltipEl.style.top = (y - 8) + 'px';
    this._tooltipEl.classList.add('visible');
  }

  _hideTooltip() {
    if (this._tooltipEl) this._tooltipEl.classList.remove('visible');
  }

  // ── Toast (uses global if available) ───────────────────────────

  _toast(msg) {
    if (window.edogToast) {
      window.edogToast(msg);
      return;
    }
    // Fallback: find global toast element
    const el = document.getElementById('toast');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 2500);
    }
  }

  // ── Syntax highlighting ────────────────────────────────────────

  _highlight(code, type) {
    let h = this._esc(code);
    // Strings
    h = h.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '<span class="str">$&</span>');
    // Comments
    h = h.replace(/(--[^\n]*|#[^\n]*)/g, '<span class="cmt">$&</span>');
    // Numbers
    h = h.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');

    if (type === 'SQL') {
      const kws = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'CREATE', 'TABLE', 'AS',
        'GROUP', 'BY', 'ORDER', 'JOIN', 'LEFT', 'ON', 'AND', 'OR', 'NOT', 'NULL',
        'IF', 'EXISTS', 'DROP', 'MERGE', 'USING', 'WHEN', 'MATCHED', 'THEN', 'UPDATE',
        'SET', 'REPLACE', 'VIEW', 'SUM', 'COUNT', 'AVG', 'DISTINCT', 'HAVING',
        'OPTIMIZE', 'ZORDER', 'COMPUTE', 'STATISTICS', 'FOR', 'ALL', 'COLUMNS',
        'ANALYZE', 'OVERWRITE', 'MODE', 'CURRENT_TIMESTAMP'];
      kws.forEach(k => {
        h = h.replace(new RegExp('\\b(' + k + ')\\b', 'gi'), '<span class="kw">$1</span>');
      });
    } else {
      const kws = ['import', 'from', 'def', 'class', 'if', 'else', 'elif', 'return',
        'for', 'in', 'as', 'with', 'print', 'spark', 'col', 'when', 'otherwise',
        'True', 'False', 'None'];
      kws.forEach(k => {
        h = h.replace(new RegExp('\\b(' + k + ')\\b', 'g'), '<span class="kw">$1</span>');
      });
      h = h.replace(/(\w+)\(/g, '<span class="fn">$1</span>(');
    }
    return h;
  }

  // ── Utilities ──────────────────────────────────────────────────

  _ce(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  _esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _csvSafe(str) {
    if (!str) return '';
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  _fmtElapsed(seconds) {
    const s = seconds || 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + 'm ' + String(sec).padStart(2, '0') + 's';
  }

  _fmtDuration(d) {
    if (!d || d === 0) return '\u2014';
    return d < 1 ? (d * 1000).toFixed(0) + 'ms' : d.toFixed(1) + 's';
  }
}
