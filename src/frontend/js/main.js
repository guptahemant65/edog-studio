/**
 * EDOG Studio — Main Application Orchestrator
 */

// ===== UTILITY FUNCTIONS =====

function copyToClipboard(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    btn.textContent = '\u2713';
    setTimeout(() => { 
      btn.classList.remove('copied'); 
      btn.textContent = 'Copy'; 
    }, 1500);
  }).catch(() => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(textArea);
  });
}

// Filter SSR telemetry by correlation ID
function filterSSRByCorrelation(rootActivityId) {
  if (!rootActivityId || !window.edogViewer) return;
  
  // Switch to SSR tab
  window.edogViewer.switchTab('ssr');
  
  const telemetryContainer = document.getElementById('telemetry-container');
  if (!telemetryContainer) return;
  
  // Clear any existing highlights first
  telemetryContainer.querySelectorAll('.telemetry-card').forEach(card => {
    card.classList.remove('ssr-highlight');
  });
  
  // Find and highlight matching SSR cards
  let foundMatch = false;
  telemetryContainer.querySelectorAll('.telemetry-card').forEach(card => {
    const correlationElements = card.querySelectorAll('[data-correlation]');
    correlationElements.forEach(element => {
      const cardCorrelationId = element.dataset.correlation || '';
      if (cardCorrelationId.includes(rootActivityId)) {
        card.classList.add('ssr-highlight');
        if (!foundMatch) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          foundMatch = true;
        }
      }
    });
  });
}

// Filter logs by correlation ID
function filterLogsByCorrelation(correlationId) {
  if (!correlationId || !window.edogViewer || !window.edogViewer.filter) return;
  
  // Switch to logs tab
  window.edogViewer.switchTab('logs');
  
  window.edogViewer.filter.setCorrelationFilter(correlationId);
  
  // Close detail panel
  if (window.edogViewer.detail) {
    window.edogViewer.detail.hide();
  }
}

// JSON syntax highlighting function
function syntaxHighlightJson(json) {
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return '<span class="' + cls + '">' + match + '</span>';
  });
}

// ===== MAIN APPLICATION =====

class EdogLogViewer {
  constructor() {
    this.state = new LogViewerState();
    this.renderer = new Renderer(this.state);
    this.ws = new WebSocketManager();
    this.filter = new FilterManager(this.state, this.renderer);
    this.detail = new DetailPanel();
    this.execSummary = new ExecutionSummary(this.state, this.renderer);
    this.scrollTimeout = null;
    this.raidDebounceTimeout = null;

    // Cockpit modules
    this.apiClient = new FabricApiClient();
    this.topbar = new TopBar();
    this.sidebar = new Sidebar();
    this.workspaceExplorer = new WorkspaceExplorer(this.apiClient);
    this.commandPalette = new CommandPalette(this.sidebar, this.workspaceExplorer);

    // Smart feature modules
    this.autoDetector = new AutoDetector(this.state);
    this.smartContext = new SmartContextBar(this.autoDetector);
    this.errorIntel = new ErrorIntelligence(this.autoDetector);
    this.anomaly = new AnomalyDetector(this.state);
    this.controlPanel = new ControlPanel(
      document.getElementById('control-panel'),
      { autoDetector: this.autoDetector, stateManager: this.state }
    );

    // Wire error-intel jump-to-error
    this.errorIntel.onJumpToError = (errorMsg) => {
      this.filter.setSearch(errorMsg.substring(0, 60));
      this.sidebar.switchView('logs');
    };

    // Chain auto-RAID-populate into live execution detection
    const origOnDetected = this.autoDetector.onExecutionDetected;
    this.autoDetector.onExecutionDetected = (exec, id) => {
      if (origOnDetected) origOnDetected(exec, id);
      if (!this.state.raidFilter) {
        const raidInput = document.getElementById('raid-filter-input');
        if (raidInput) raidInput.value = id;
        this.applyRaidFilter(id);
      }
    };
    
    // Set up WebSocket callbacks
    this.ws.onStatusChange = this.updateConnectionStatus;
    this.ws.onMessage = this.handleWebSocketMessage;
    this.ws.onBatch = this.handleWebSocketBatch;
    this.ws.onSummary = this.handleWebSocketSummary;
  }
  
  init = async () => {
    console.log('Initializing EDOG Studio');
    
    // Make globally accessible
    window.edogViewer = this;

    // Initialize cockpit shell
    await this.apiClient.init();
    this.topbar.init();
    this.sidebar.init();
    this.commandPalette.init();

    // Set phase based on token availability
    const phase = this.apiClient.getPhase();
    this.sidebar.setPhase(phase);

    // Wire sidebar view switching
    this.sidebar.onViewChange = (viewId) => this._onViewChange(viewId);

    // Initialize workspace explorer (default view)
    await this.workspaceExplorer.init();
    
    this.bindEventListeners();
    await this.loadInitialData();
    this.ws.connect();
  }
  
  bindEventListeners = () => {
    // Search input (logs view)
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.filter.setSearch(e.target.value);
      });
    }
    
    // Endpoint filter (W0.2)
    const endpointFilter = document.getElementById('endpoint-filter');
    if (endpointFilter) {
      endpointFilter.addEventListener('change', (e) => {
        this.state.endpointFilter = e.target.value;
        this.filter.applyFilters();
      });
    }

    // Component filter
    const componentFilter = document.getElementById('component-filter');
    if (componentFilter) {
      componentFilter.addEventListener('change', (e) => {
        this.state.componentFilter = e.target.value;
        this.filter.applyFilters();
      });
    }

    // RAID filter (W0.3)
    const raidInput = document.getElementById('raid-filter-input');
    if (raidInput) {
      raidInput.addEventListener('input', (e) => {
        clearTimeout(this.raidDebounceTimeout);
        const val = e.target.value.trim();
        this.updateRaidDropdown(val);
        this.raidDebounceTimeout = setTimeout(() => {
          this.applyRaidFilter(val);
        }, 200);
      });
      raidInput.addEventListener('focus', () => {
        this.updateRaidDropdown(raidInput.value.trim());
        this.showRaidDropdown();
      });
      raidInput.addEventListener('paste', (e) => {
        setTimeout(() => {
          const val = raidInput.value.trim();
          if (/^[0-9a-fA-F-]{36}$/.test(val)) {
            this.applyRaidFilter(val);
          }
        }, 0);
      });
      // Close dropdown when clicking outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.raid-filter-wrapper')) {
          this.hideRaidDropdown();
        }
      });
    }

    // Execution badge clear
    const execBadgeClear = document.getElementById('exec-badge-clear');
    if (execBadgeClear) {
      execBadgeClear.addEventListener('click', () => this.clearRaidFilter());
    }

    // Level buttons
    document.querySelectorAll('.level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const level = btn.dataset.level;
        if (level) this.filter.toggleLevel(level);
      });
    });
    
    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const preset = btn.dataset.preset;
        if (preset) this.filter.applyPreset(preset);
      });
    });
    
    // Time filter buttons
    document.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const range = parseInt(btn.dataset.range);
        this.filter.updateTimeFilter(range);
      });
    });
    
    // Clear button
    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearRaidFilter();
        this.state.endpointFilter = '';
        this.state.componentFilter = '';
        const ef = document.getElementById('endpoint-filter');
        if (ef) ef.value = '';
        const cf = document.getElementById('component-filter');
        if (cf) cf.value = '';
        this.filter.clearAll();
      });
    }
    
    // Export button
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', this.exportLogs);
    }
    
    // Pause button
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', this.togglePause);
    }
    
    // Error navigation button
    const nextErrorBtn = document.getElementById('btn-next-error');
    if (nextErrorBtn) {
      nextErrorBtn.addEventListener('click', () => {
        this.jumpToNextError();
      });
    }
    
    // Theme toggle
    const themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', this.toggleTheme);
    }
    
    // Auto-scroll resume button
    const resumeBtn = document.getElementById('resume-scroll-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', this.resumeAutoScroll);
    }
    
    // Detail panel close button
    const detailClose = document.getElementById('detail-close');
    if (detailClose) {
      detailClose.addEventListener('click', this.detail.hide);
    }
    
    // Correlation badge close
    const correlationClose = document.getElementById('correlation-close');
    if (correlationClose) {
      correlationClose.addEventListener('click', this.filter.clearCorrelationFilter);
    }
    
    // Keyboard shortcuts
    document.addEventListener('keydown', this.handleKeydown);
    
    // Auto-scroll detection is handled by renderer._onScroll
  }
  
  handleKeydown = (e) => {
    // Skip if typing in input field (sidebar handles 1-6 separately)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.code) {
      case 'Escape':
        if (this.detail.isVisible) {
          this.detail.hide();
        } else if (this.state.searchText || this.state.correlationFilter) {
          this.filter.clearAll();
        }
        break;
        
      case 'KeyK':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.commandPalette.toggle();
        }
        break;
        
      case 'KeyL':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.filter.clearAll();
        }
        break;
        
      case 'Space':
        if (!this.detail.isVisible) {
          e.preventDefault();
          this.togglePause();
        }
        break;
    }
  }
  
  handleWebSocketMessage = (type, data) => {
    try {
      if (type === 'log') {
        this.state.addLog(data);
        this.autoDetector.processLog(data);
        this.anomaly.processLog(data);
        this.extractEndpointFromLog(data);
        this.extractComponentFromLog(data);
        this.extractIterationIdFromLog(data);
        this.renderer.scheduleRender();
      } else if (type === 'telemetry') {
        this.state.addTelemetry(data);
        this.autoDetector.processTelemetry(data);
        this.extractEndpointFromTelemetry(data);
        this.extractIterationIdFromTelemetry(data);
        this.renderer.scheduleRender();
      }
    } catch (err) {
      console.error('[ws-message] Failed to process:', type, err);
    }
  }

  // Batch handler: process entire batch, single render at end
  handleWebSocketBatch = (logs, telemetry) => {
    for (const log of logs) {
      try {
        this.state.addLog(log);
        this.autoDetector.processLog(log);
        this.anomaly.processLog(log);
        this.extractEndpointFromLog(log);
        this.extractComponentFromLog(log);
        this.extractIterationIdFromLog(log);
      } catch (err) {
        console.error('[ws-batch] Failed to process log entry:', err);
      }
    }

    for (const evt of telemetry) {
      try {
        this.state.addTelemetry(evt);
        this.autoDetector.processTelemetry(evt);
        this.extractEndpointFromTelemetry(evt);
        this.extractIterationIdFromTelemetry(evt);
      } catch (err) {
        console.error('[ws-batch] Failed to process telemetry entry:', err);
      }
    }

    if (logs.length > 0 || telemetry.length > 0) {
      this.renderer.scheduleRender();
    }
  }

  // Backpressure summary handler
  handleWebSocketSummary = (summary) => {
    if (summary.levels) {
      for (const [level, count] of Object.entries(summary.levels)) {
        const key = level.toLowerCase();
        if (this.state.stats[key] !== undefined) {
          this.state.stats[key] += count;
        }
        this.state.stats.totalLogs += count;
      }
    }

    if (summary.droppedTelemetry) {
      this.state.stats.totalEvents += summary.droppedTelemetry;
    }

    console.warn(
      '[backpressure] ' + summary.dropped + ' entries summarized. ' +
      'Levels: ' + JSON.stringify(summary.levels)
    );

    this.renderer.scheduleRender();
  }
  
  updateConnectionStatus = (status) => {
    const badge = document.getElementById('connection-status');
    if (badge) {
      const labels = { 'connected': '● Connected', 'disconnected': '● Disconnected', 'connecting': '● Connecting', 'reconnecting': '● Reconnecting' };
      badge.textContent = labels[status] || `● ${status}`;
      badge.className = `status-badge ${status}`;
    }
  }
  
  loadInitialData = async () => {
    try {
      // Load logs — batch add directly to state (skip pendingLogs buffer)
      const logsResponse = await fetch('/api/logs');
      if (logsResponse.ok) {
        const logs = await logsResponse.json();
        logs.reverse(); // API returns newest-first; reverse to push oldest-first into RingBuffer
        logs.forEach(log => {
          try {
            this.state.logBuffer.push(log);
            this.state.stats.totalLogs++;
            const level = (log.level || '').toLowerCase();
            if (level && this.state.stats[level] !== undefined) this.state.stats[level]++;
            this.extractEndpointFromLog(log);
            this.extractComponentFromLog(log);
            this.extractIterationIdFromLog(log);
          } catch (err) {
            console.error('[load] Failed to process log entry:', err);
          }
        });
      }
      
      // Load telemetry — batch add directly
      const telemetryResponse = await fetch('/api/telemetry');
      if (telemetryResponse.ok) {
        const events = await telemetryResponse.json();
        events.reverse();
        events.forEach(event => {
          this.state.telemetryBuffer.push(event);
          this.state.stats.totalEvents++;
          const status = (event.activityStatus || '').toLowerCase();
          if (status === 'succeeded') this.state.stats.succeeded++;
          else if (status === 'failed') this.state.stats.failed++;
          this.extractEndpointFromTelemetry(event);
          this.extractIterationIdFromTelemetry(event);
        });
      }
      
      // Override stats with server values
      const statsResponse = await fetch('/api/stats');
      if (statsResponse.ok) {
        const stats = await statsResponse.json();
        Object.assign(this.state.stats, stats);
      }
      
      this.updateEndpointDropdown();
      this.updateComponentDropdown();
      
      // Apply FLT preset (populates excludedComponents from loaded logs, then renders)
      this.filter.applyPreset('flt');
      
      // Auto-populate RAID with latest execution
      if (this.state.recentExecutions.length > 0) {
        const latestId = this.state.recentExecutions[0];
        const raidInput = document.getElementById('raid-filter-input');
        if (raidInput) raidInput.value = latestId;
        this.applyRaidFilter(latestId);
      }
      
      // Deferred smart processing (non-blocking chunks)
      this.deferredSmartProcessing();
      
    } catch (error) {
      console.error('Failed to load initial data:', error);
    }
  }
  
  deferredSmartProcessing = () => {
    const logs = this.state.logs;
    const telemetryArr = [];
    this.state.telemetry.forEach(e => telemetryArr.push(e));
    let logIdx = 0;
    let telIdx = 0;
    const CHUNK = 200;
    
    const processChunk = () => {
      const logEnd = Math.min(logIdx + CHUNK, logs.length);
      for (; logIdx < logEnd; logIdx++) {
        this.autoDetector.processLog(logs[logIdx]);
        this.anomaly.processLog(logs[logIdx]);
      }
      const telEnd = Math.min(telIdx + CHUNK, telemetryArr.length);
      for (; telIdx < telEnd; telIdx++) {
        this.autoDetector.processTelemetry(telemetryArr[telIdx]);
      }
      if (logIdx < logs.length || telIdx < telemetryArr.length) {
        setTimeout(processChunk, 0);
      }
    };
    setTimeout(processChunk, 50);
  }
  
  togglePause = () => {
    this.state.paused = !this.state.paused;
    const btn = document.getElementById('pause-btn');
    if (btn) {
      btn.textContent = this.state.paused ? '\u25B6 Resume' : 'Pause';
      btn.classList.toggle('paused', this.state.paused);
    }
    if (!this.state.paused) {
      this.state.autoScroll = true;
      this.hideResumeButton();
      this.filter.applyFilters();
      this.renderer.scrollToBottom();
    }
  }
  
  toggleTheme = () => {
    const body = document.body;
    const isDark = body.dataset.theme === 'dark';
    if (isDark) {
      delete body.dataset.theme;
      localStorage.setItem('edog-theme', 'light');
    } else {
      body.dataset.theme = 'dark';
      localStorage.setItem('edog-theme', 'dark');
    }
  }
  
  resumeAutoScroll = () => {
    this.state.autoScroll = true;
    this.hideResumeButton();
    
    // Scroll to bottom
    const container = document.getElementById('logs-container');
    if (container) {
      this.renderer.scrollToBottom(container);
    }
  }
  
  showResumeButton = () => {
    const btn = document.getElementById('resume-scroll-btn');
    if (btn) btn.style.display = 'block';
  }
  
  hideResumeButton = () => {
    const btn = document.getElementById('resume-scroll-btn');
    if (btn) btn.style.display = 'none';
  }
  
  // ===== VIEW MANAGEMENT =====
  
  // Compatibility bridge: old switchTab calls route through sidebar
  switchTab = (tabId) => {
    const viewMap = { 'logs': 'logs', 'ssr': 'logs', 'summary': 'dag', 'timeline': 'dag' };
    const viewId = viewMap[tabId] || tabId;
    if (this.sidebar) {
      this.sidebar.switchView(viewId);
    }
  }

  _onViewChange = (viewId) => {
    // Activate/deactivate view-specific modules
    if (viewId === 'dag') {
      this.controlPanel.activate();
    } else {
      this.controlPanel.deactivate();
    }

    if (viewId === 'logs') {
      this.renderer.flush();
    }
  }

  // ===== ENDPOINT FILTER (W0.2) =====

  extractEndpointFromLog = (entry) => {
    if (!entry) return;
    const component = entry.component || '';
    const match = component.match(/-([A-Za-z]+)$/);
    if (match) {
      const endpoint = match[1];
      if (!this.state.knownEndpoints.has(endpoint)) {
        this.state.knownEndpoints.add(endpoint);
        this.updateEndpointDropdown();
      }
    }
  }

  extractEndpointFromTelemetry = (event) => {
    const name = event.activityName || '';
    // Known patterns: RunDag, GetLatestDag, CancelDAG, etc.
    const endpointPatterns = ['RunDag', 'GetLatestDag', 'CancelDAG', 'RunDAG', 'GetDag'];
    for (const pat of endpointPatterns) {
      if (name.includes(pat) && !this.state.knownEndpoints.has(pat)) {
        this.state.knownEndpoints.add(pat);
        this.updateEndpointDropdown();
      }
    }
  }

  updateEndpointDropdown = () => {
    const select = document.getElementById('endpoint-filter');
    if (!select) return;
    const current = select.value;
    // Keep "All Endpoints" as first option
    select.innerHTML = '<option value="">All Endpoints</option>';
    const sorted = Array.from(this.state.knownEndpoints).sort();
    sorted.forEach(ep => {
      const opt = document.createElement('option');
      opt.value = ep;
      opt.textContent = ep;
      select.appendChild(opt);
    });
    select.value = current; // Preserve selection
  }

  extractComponentFromLog = (entry) => {
    if (!entry) return;
    const component = entry.component || '';
    if (!component || component === 'Unknown') return;
    // Normalize: strip trailing endpoint suffix (e.g. "OneLake-GetLatestDag" → "OneLake")
    const base = component.replace(/-[A-Za-z]+$/, '');
    if (base && !this.state.knownComponents.has(base)) {
      this.state.knownComponents.add(base);
      this.updateComponentDropdown();
    }
  }

  updateComponentDropdown = () => {
    const select = document.getElementById('component-filter');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">All Components</option>';
    const sorted = Array.from(this.state.knownComponents).sort();
    sorted.forEach(comp => {
      const opt = document.createElement('option');
      opt.value = comp;
      opt.textContent = comp;
      select.appendChild(opt);
    });
    select.value = current;
  }

  // ===== RAID / ITERATION ID FILTER (W0.3) =====

  extractIterationIdFromLog = (entry) => {
    let id = entry.iterationId || '';
    if (!id) {
      const msg = entry.message || '';
      const match = msg.match(/IterationId[=: ]+([0-9a-fA-F-]{36})/);
      if (match) id = match[1];
    }
    if (!id) return;

    const existing = this.state.knownIterationIds.get(id);
    if (existing) {
      existing.logCount++;
      if (entry.level === 'Error') existing.status = 'Failed';
      // Extract DAG name
      const msg = entry.message || '';
      if (msg.includes('Creating Dag from Catalog') && !existing.dagName) {
        const dagMatch = msg.match(/Creating Dag from Catalog[^"]*"([^"]+)"/i) || msg.match(/Creating Dag from Catalog\s*[:-]?\s*(\S+)/i);
        if (dagMatch) existing.dagName = dagMatch[1];
      }
    } else {
      const info = {
        id,
        firstSeen: entry.timestamp || new Date().toISOString(),
        dagName: '',
        status: entry.level === 'Error' ? 'Failed' : 'Unknown',
        logCount: 1,
        ssrCount: 0
      };
      this.state.knownIterationIds.set(id, info);
      // Update recent executions (keep last 10)
      this.state.recentExecutions = [id, ...this.state.recentExecutions.filter(x => x !== id)].slice(0, 10);
    }
  }

  extractIterationIdFromTelemetry = (event) => {
    const id = (event.attributes && event.attributes.IterationId) || '';
    if (!id) return;

    const existing = this.state.knownIterationIds.get(id);
    if (existing) {
      existing.ssrCount++;
      if (event.activityStatus === 'Failed') existing.status = 'Failed';
      else if (event.activityStatus === 'Succeeded' && existing.status !== 'Failed') existing.status = 'Completed';
    } else {
      this.state.knownIterationIds.set(id, {
        id,
        firstSeen: event.timestamp || new Date().toISOString(),
        dagName: '',
        status: event.activityStatus || 'Unknown',
        logCount: 0,
        ssrCount: 1
      });
      this.state.recentExecutions = [id, ...this.state.recentExecutions.filter(x => x !== id)].slice(0, 10);
    }
  }

  applyRaidFilter = (value) => {
    this.state.raidFilter = value;
    if (value) {
      this.showExecutionBadge(value);
      this.filter.applyFilters();
      this.refreshExecutionSummary();
    } else {
      this.clearRaidFilter();
    }
    this.hideRaidDropdown();
  }

  clearRaidFilter = () => {
    this.state.raidFilter = '';
    const raidInput = document.getElementById('raid-filter-input');
    if (raidInput) raidInput.value = '';
    this.hideExecutionBadge();
    this.execSummary.clearSummary();
    this.filter.applyFilters();
  }

  showExecutionBadge = (id) => {
    const badge = document.getElementById('execution-badge');
    const badgeId = document.getElementById('exec-badge-id');
    const badgeCounts = document.getElementById('exec-badge-counts');
    if (!badge) return;

    const shortId = id.length > 8 ? '…' + id.slice(-8) : id;
    const info = this.state.knownIterationIds.get(id);
    const logCount = info ? info.logCount : '?';
    const ssrCount = info ? info.ssrCount : '?';

    if (badgeId) badgeId.textContent = shortId;
    if (badgeCounts) badgeCounts.textContent = `${logCount} logs, ${ssrCount} SSR`;
    badge.classList.add('visible');
  }

  hideExecutionBadge = () => {
    const badge = document.getElementById('execution-badge');
    if (badge) badge.classList.remove('visible');
  }

  showRaidDropdown = () => {
    const dd = document.getElementById('raid-dropdown');
    if (dd) dd.classList.add('visible');
  }

  hideRaidDropdown = () => {
    const dd = document.getElementById('raid-dropdown');
    if (dd) dd.classList.remove('visible');
  }

  updateRaidDropdown = (filterText) => {
    const list = document.getElementById('raid-dropdown-list');
    if (!list) return;

    const ids = this.state.recentExecutions;
    const filtered = filterText
      ? ids.filter(id => id.toLowerCase().includes(filterText.toLowerCase()))
      : ids;

    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:12px;color:var(--text-dim);text-align:center;font-size:12px">No recent executions</div>';
      this.showRaidDropdown();
      return;
    }

    list.innerHTML = filtered.map(id => {
      const info = this.state.knownIterationIds.get(id) || {};
      const statusDot = { 'Completed': '🟢', 'Succeeded': '🟢', 'Failed': '🔴', 'Running': '🟡' }[info.status] || '⚪';
      const shortId = id.slice(-8);
      const time = info.firstSeen ? this.renderer.formatTime(info.firstSeen) : '';
      const dagName = info.dagName || '';
      return `<div class="raid-item" data-id="${id}">
        <span class="raid-status-dot">${statusDot}</span>
        <span class="raid-item-id">…${shortId}</span>
        ${dagName ? `<span class="raid-item-dag">${dagName}</span>` : ''}
        <span class="raid-item-meta">${time}</span>
      </div>`;
    }).join('');

    // Bind click handlers
    list.querySelectorAll('.raid-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        const raidInput = document.getElementById('raid-filter-input');
        if (raidInput) raidInput.value = id;
        this.applyRaidFilter(id);
      });
    });

    this.showRaidDropdown();
  }

  refreshExecutionSummary = () => {
    if (!this.state.raidFilter) {
      this.execSummary.clearSummary();
      return;
    }
    const data = this.execSummary.compute(this.state.raidFilter);
    if (data) {
      this.execSummary.render(data);
      // Update badge counts
      this.showExecutionBadge(this.state.raidFilter);
    }
  }

  exportLogs = () => {
    const telemetryArr = [];
    this.state.telemetry.forEach(e => telemetryArr.push(e));
    const dataToExport = {
      exportedAt: new Date().toISOString(),
      logs: this.state.filteredLogs.length > 0 ? this.state.filteredLogs : this.state.logs,
      telemetry: telemetryArr,
      stats: this.state.stats,
      filters: {
        searchText: this.state.searchText,
        activeLevels: Array.from(this.state.activeLevels),
        correlationFilter: this.state.correlationFilter
      }
    };
    
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { 
      type: 'application/json' 
    });
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edog-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  jumpToNextError = () => {
    this.sidebar.switchView('logs');
    const container = document.getElementById('logs-container');
    if (!container) return;

    // Walk FilterIndex to find next error after current scroll position
    const fi = this.state.filterIndex;
    const currentTopIdx = Math.floor(container.scrollTop / this.renderer.ROW_HEIGHT);

    for (let i = currentTopIdx + 1; i < fi.length; i++) {
      const seq = fi.seqAt(i);
      if (seq === undefined) continue;
      const entry = this.state.logBuffer.getBySeq(seq);
      if (!entry) continue;
      if ((entry.level || '').toLowerCase() === 'error') {
        container.scrollTop = i * this.renderer.ROW_HEIGHT - container.clientHeight / 2;
        return;
      }
    }
    // Wrap around from top
    for (let i = 0; i <= currentTopIdx && i < fi.length; i++) {
      const seq = fi.seqAt(i);
      if (seq === undefined) continue;
      const entry = this.state.logBuffer.getBySeq(seq);
      if (!entry) continue;
      if ((entry.level || '').toLowerCase() === 'error') {
        container.scrollTop = i * this.renderer.ROW_HEIGHT - container.clientHeight / 2;
        return;
      }
    }
  }
}

// ===== INITIALIZATION =====

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Load theme preference — light is default (no data-theme attribute needed)
  const savedTheme = localStorage.getItem('edog-theme');
  if (savedTheme === 'dark') {
    document.body.dataset.theme = 'dark';
  }
  
  // Start the application
  new EdogLogViewer().init();

  // Initialize mock data rendering — only when ?mock=true is in the URL
  if (typeof MockRenderer !== 'undefined' && new URLSearchParams(window.location.search).get('mock') === 'true') {
    setTimeout(() => {
      const mock = new MockRenderer();
      mock.init();
      // Re-apply mock topbar every 2s to prevent real polling from overwriting
      setInterval(() => mock._renderTopBar(), 2000);
    }, 500);
  }
});
