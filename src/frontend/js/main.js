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
    this.ws = new SignalRManager();
    this.filter = new FilterManager(this.state, this.renderer);
    this.detail = new DetailPanel();
    this.execSummary = new ExecutionSummary(this.state, this.renderer);
    this.scrollTimeout = null;
    this.raidDebounceTimeout = null;

    // Cockpit modules
    this.apiClient = new FabricApiClient();
    this.topbar = new TopBar();
    this.sidebar = new Sidebar();
    this.runtimeView = new RuntimeView(this.ws);
    this.workspaceExplorer = new WorkspaceExplorer(this.apiClient);
    this.commandPalette = new CommandPalette(this.sidebar, this.workspaceExplorer);

    // Runtime View tab modules
    this.telemetryTab = new TelemetryTab(document.getElementById('rt-tab-telemetry'), this.ws);
    this.sysfilesTab = new SystemFilesTab(document.getElementById('rt-tab-sysfiles'), this.ws);
    this.sparkTab = new SparkSessionsTab(document.getElementById('rt-tab-spark'), this.ws);
    this.nexusTab = new NexusTab(document.getElementById('rt-tab-nexus'), this.ws);
    this.tokensTab = new TokensTab(document.getElementById('rt-tab-tokens'), this.ws);
    this.cachesTab = new CachesTab(document.getElementById('rt-tab-caches'), this.ws);
    this.httpTab = new HttpPipelineTab(document.getElementById('rt-tab-http'), this.ws);
    this.retriesTab = new RetriesTab(document.getElementById('rt-tab-retries'), this.ws);
    this.flagsTab = new FeatureFlagsTab(document.getElementById('rt-tab-flags'), this.ws);
    this.diTab = new DiRegistryTab(document.getElementById('rt-tab-di'), this.ws);
    this.perfTab = new PerfMarkersTab(document.getElementById('rt-tab-perf'), this.ws);
    this.logsEnhancements = new LogsEnhancements({
      logsContainer: document.getElementById('logs-container'),
      breakpointsBar: document.getElementById('breakpoints-bar'),
      bookmarksDrawer: document.getElementById('bookmarks-drawer'),
      state: this.state,
      renderer: this.renderer
    });

    // DAG Studio (lazy-initialized on first view activation)
    this.dagStudio = null;

    // Smart feature modules
    this.autoDetector = new AutoDetector(this.state);
    this.smartContext = new SmartContextBar(this.autoDetector);
    this.errorIntel = new ErrorIntelligence(this.autoDetector);
    this.anomaly = new AnomalyDetector(this.state);
    const cpEl = document.getElementById('control-panel');
    this.controlPanel = cpEl
      ? new ControlPanel(cpEl, { autoDetector: this.autoDetector, stateManager: this.state })
      : null;

    // Wire error-intel jump-to-error
    this.errorIntel.onJumpToError = (errorMsg) => {
      this.filter.setSearch(errorMsg.substring(0, 60));
      this.sidebar.switchView('runtime');
      this.runtimeView.switchTab('logs');
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
    this.runtimeView.init();
    this.commandPalette.init();

    // Register the Logs tab module (existing renderer handles it)
    this.runtimeView.registerTab('logs', {
      activate: () => {
        this.renderer.containerReady = false;

        // If buffer is empty but service is running, fetch logs from REST + ensure SignalR
        const hasLogs = this.state.logBuffer && this.state.logBuffer.length > 0;
        if (!hasLogs && this.ws && this.ws._port && this.ws._port !== 5555) {
          this.loadInitialData().then(() => {
            this.renderer.flush();
            this.renderer.scheduleRender();
          });
        } else {
          this.renderer.flush();
          this.renderer.scheduleRender();
        }

        // Ensure SignalR is connected
        if (this.ws && this.ws.status !== 'connected' && this.ws._port) {
          this.ws.connect();
        }
      },
      deactivate: () => { /* Logs stay in buffer, just stop rendering */ }
    });

    // Register Runtime View tab modules
    this.runtimeView.registerTab('telemetry', this.telemetryTab);
    this.runtimeView.registerTab('sysfiles', this.sysfilesTab);
    this.runtimeView.registerTab('spark', this.sparkTab);
    this.runtimeView.registerTab('nexus', this.nexusTab);
    this.runtimeView.registerTab('tokens', this.tokensTab);
    this.runtimeView.registerTab('caches', this.cachesTab);
    this.runtimeView.registerTab('http', this.httpTab);
    this.runtimeView.registerTab('retries', this.retriesTab);
    this.runtimeView.registerTab('flags', this.flagsTab);
    this.runtimeView.registerTab('di', this.diTab);
    this.runtimeView.registerTab('perf', this.perfTab);

    // Initialize logs enhancements (breakpoints, bookmarks, error clustering)
    if (this.logsEnhancements) this.logsEnhancements.init();

    // Expose globals for deploy phase sync
    window.edogTopBar = this.topbar;
    window.edogSidebar = this.sidebar;
    window.edogWs = this.ws;
    window.edogApp = this;

    // Set phase based on token availability
    const phase = this.apiClient.getPhase();
    this.sidebar.setPhase(phase);
    this.runtimeView.setPhase(phase);

    // Wire sidebar view switching
    this.sidebar.onViewChange = (viewId) => this._onViewChange(viewId);

    // Initialize workspace explorer (default view)
    await this.workspaceExplorer.init();
    
    this.bindEventListeners();
    await this.loadInitialData();

    // Check for active/completed deploy (AFTER workspace explorer DOM exists)
    this._checkDeployResume();

    // Don't auto-connect WebSocket — _checkDeployResume will connect
    // to the right port if FLT is running. Otherwise no WS is needed.
  }

  /** Check for active/completed deploy on page load (refresh recovery). */
  async _checkDeployResume() {
    try {
      const resp = await fetch('/api/studio/status');
      if (!resp.ok) return;
      const state = await resp.json();

      if (state.phase === 'deploying') {
        // Deploy in progress — let workspace explorer handle the resume
        const progressEl = document.getElementById('ws-deploy-progress');
        if (progressEl) {
          progressEl.style.display = 'block';
          const btnEl = document.getElementById('ws-deploy-btn');
          if (btnEl) btnEl.style.display = 'none';

          if (!this.workspaceExplorer._deployFlow) {
            this.workspaceExplorer._deployFlow = new DeployFlow(progressEl);
            this.workspaceExplorer._deployFlow.onUpdate = (s) => {
              if (s.status === 'running') {
                this.topbar.setDeployStatus('connected');
                this.sidebar.setPhase('connected');
                if (this.runtimeView) this.runtimeView.setPhase('connected');
                if (s.fltPort && this.ws) {
                  this.ws.setPort(s.fltPort);
                  if (this.runtimeView) this.runtimeView.setPort(s.fltPort);
                }
                this.loadInitialData();
              } else if (s.status === 'stopped' && s.error) {
                this.topbar.setDeployStatus('failed');
              }
            };
          }
          this.workspaceExplorer._deployFlow.resume(state);
        }
        this.topbar.setDeployStatus('deploying');
      } else if (state.phase === 'running') {
        this.sidebar.setPhase('connected');
        if (this.runtimeView) this.runtimeView.setPhase('connected');
        this.topbar.setDeployStatus('connected');
        if (state.fltPort) {
          this.ws.setPort(state.fltPort);
          if (this.runtimeView) this.runtimeView.setPort(state.fltPort);
        }
        this.loadInitialData();
      } else if (state.phase === 'crashed') {
        this.topbar.setDeployStatus('crashed');
      }
    } catch {
      // Studio status not available — normal in standalone mode
    }
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
    
    // Export button — opens format dropdown
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExportDropdown();
      });
    }
    
    // Pause button
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', this.togglePause);
    }
    
    // F12: Stream badge (LIVE/PAUSED indicator) — click to resume
    const streamBadge = document.getElementById('stream-badge');
    if (streamBadge) {
      streamBadge.addEventListener('click', () => {
        if (this.state.streamMode === 'PAUSED') {
          this.renderer._transitionToLive();
        }
      });
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

      case 'KeyE':
        if (e.ctrlKey && e.shiftKey) {
          e.preventDefault();
          this.toggleExportDropdown();
        }
        break;
        
      case 'Space':
        if (!this.detail.isVisible) {
          e.preventDefault();
          this.togglePause();
        }
        break;

      case 'End':
        if (this.state.streamMode === 'PAUSED') {
          e.preventDefault();
          this.renderer._transitionToLive();
        }
        break;

      case 'ArrowDown':
        if ((e.ctrlKey || e.metaKey) && this.state.streamMode === 'PAUSED') {
          e.preventDefault();
          this.renderer._transitionToLive();
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
    // Wire to RuntimeView connection bar
    if (this.runtimeView) this.runtimeView.setConnectionStatus(status);

    // Phase transition: when SignalR connects, unlock Runtime View
    if (status === 'connected') {
      this.sidebar.setPhase('connected');
      if (this.runtimeView) this.runtimeView.setPhase('connected');
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

      // Force a render so loaded logs appear in the UI
      this.renderer.scheduleRender();
      
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
    if (this.state.streamMode === 'LIVE') {
      this.renderer._transitionToPaused('manual');
    } else if (this.state.pauseReason === 'hover') {
      // Promote hover-pause to manual-pause (don't resume)
      this.state.pauseReason = 'manual';
    } else {
      this.renderer._transitionToLive();
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
    this.renderer._transitionToLive();
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
  
  // Compatibility bridge: old switchTab calls route through sidebar + runtime view
  switchTab = (tabId) => {
    const viewMap = { 'logs': 'runtime', 'ssr': 'runtime', 'summary': 'runtime', 'timeline': 'runtime' };
    const viewId = viewMap[tabId] || tabId;
    if (this.sidebar) {
      this.sidebar.switchView(viewId);
    }
    // If routing to runtime, also switch the inner tab
    if (viewId === 'runtime' && this.runtimeView) {
      const rtTabMap = { 'logs': 'logs', 'ssr': 'telemetry', 'summary': 'logs', 'timeline': 'logs' };
      this.runtimeView.switchTab(rtTabMap[tabId] || 'logs');
    }
  }

  _onViewChange = (viewId) => {
    // Activate/deactivate view-specific modules
    if (viewId === 'runtime') {
      // RuntimeView handles its own tab switching
      this.runtimeView.switchTab(this.runtimeView._activeTab);

      // Sync sidebar sub-tab highlight with runtime's active tab
      if (this.sidebar.setActiveSubTab) {
        this.sidebar.setActiveSubTab(this.runtimeView._activeTab);
      }

      // If current tab is logs, ensure data is loaded
      if (this.runtimeView._activeTab === 'logs') {
        this.renderer.containerReady = false;
        const hasLogs = this.state.logBuffer && this.state.logBuffer.length > 0;
        if (!hasLogs && this.ws && this.ws._port && this.ws._port !== 5555) {
          this.loadInitialData().then(() => {
            this.renderer.flush();
            this.renderer.scheduleRender();
          });
        } else {
          this.renderer.flush();
          this.renderer.scheduleRender();
        }
        if (this.ws && this.ws.status !== 'connected' && this.ws._port) {
          this.ws.connect();
        }
      }
    } else if (viewId === 'dag') {
      if (this.dagStudio) this.dagStudio.activate();
      if (this.controlPanel) this.controlPanel.deactivate();
    } else {
      if (this.dagStudio) this.dagStudio.deactivate();
      if (this.controlPanel) this.controlPanel.deactivate();
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

  // ===== EXPORT MANAGER (C04) =====

  /** Collect entries from FilterIndex (filtered view of RingBuffer). */
  getFilteredEntries = () => {
    const fi = this.state.filterIndex;
    const entries = [];
    for (let i = 0; i < fi.length; i++) {
      const seq = fi.seqAt(i);
      const entry = this.state.logBuffer.getBySeq(seq);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** Toggle the export format dropdown. */
  toggleExportDropdown = () => {
    const existing = document.querySelector('.export-dropdown');
    if (existing) {
      existing.remove();
      return;
    }

    const entries = this.getFilteredEntries();
    if (entries.length === 0) {
      this.showExportToast('No entries match current filters', 'warning');
      return;
    }

    const exportBtn = document.getElementById('export-btn');
    const dropdown = document.createElement('div');
    dropdown.className = 'export-dropdown';

    const formats = [
      { key: 'json', label: 'JSON' },
      { key: 'csv', label: 'CSV' },
      { key: 'txt', label: 'Plain Text' }
    ];
    const lastUsed = sessionStorage.getItem('edog-export-format') || 'json';

    for (const fmt of formats) {
      const btn = document.createElement('button');
      btn.className = 'export-option';
      if (fmt.key === lastUsed) btn.classList.add('last-used');
      btn.dataset.format = fmt.key;
      btn.textContent = fmt.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.remove();
        this.executeExport(entries, fmt.key);
      });
      dropdown.appendChild(btn);
    }

    // Position below export button
    if (exportBtn) {
      exportBtn.parentElement.style.position = 'relative';
      exportBtn.parentElement.appendChild(dropdown);
    } else {
      document.body.appendChild(dropdown);
    }

    // Dismiss on outside click or Escape
    const dismiss = (e) => {
      if (e.type === 'keydown' && e.code !== 'Escape') return;
      const dd = document.querySelector('.export-dropdown');
      if (dd) dd.remove();
      document.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
    // Defer so this click event doesn't immediately dismiss
    requestAnimationFrame(() => {
      document.addEventListener('click', dismiss);
      document.addEventListener('keydown', dismiss);
    });
  }

  /** Run the export pipeline for a chosen format. */
  executeExport = (entries, format) => {
    try {
      sessionStorage.setItem('edog-export-format', format);

      // Size warning
      const avgBytes = { json: 250, csv: 150, txt: 120 };
      const estimated = entries.length * (avgBytes[format] || 200);
      if (estimated > 10 * 1024 * 1024) {
        const sizeMB = (estimated / (1024 * 1024)).toFixed(1);
        if (!confirm(`Export will be approximately ${sizeMB}MB. Continue?`)) return;
      }

      let content;
      switch (format) {
        case 'csv':  content = this.generateCSV(entries);  break;
        case 'txt':  content = this.generateText(entries); break;
        default:     content = this.generateJSON(entries);  break;
      }

      this.downloadExportFile(content, format, entries.length);
      this.showExportToast(entries.length, format);
    } catch (err) {
      console.error('[export] Failed:', err);
      this.showExportToast('Export failed \u2014 check console for details', 'error');
    }
  }

  // --- Format generators ---

  generateJSON = (entries) => {
    const output = {
      exportedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries: entries.map(e => {
        let customData = e.customData || null;
        if (customData !== null) {
          try { JSON.stringify(customData); }
          catch { customData = '[serialization error]'; }
        }
        return {
          timestamp: e.timestamp || '',
          level: e.level || 'INFO',
          component: e.component || '',
          message: e.message || '',
          customData
        };
      })
    };
    return JSON.stringify(output, null, 2);
  }

  generateCSV = (entries) => {
    const csvField = (value) => {
      const s = String(value ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const flattenCustomData = (obj) => {
      if (obj == null) return '';
      if (typeof obj === 'string') return obj;
      try { return JSON.stringify(obj); }
      catch { return '[serialization error]'; }
    };
    const rows = ['timestamp,level,component,message,customData'];
    for (const e of entries) {
      rows.push([
        csvField(e.timestamp || ''),
        csvField(e.level || 'INFO'),
        csvField(e.component || ''),
        csvField(e.message || ''),
        csvField(flattenCustomData(e.customData))
      ].join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  generateText = (entries) => {
    const lines = [];
    for (const e of entries) {
      const ts = e.timestamp || '[no-timestamp]';
      const level = (e.level || 'INFO').toUpperCase().padEnd(7);
      const comp = e.component ? '[' + e.component + '] ' : '';
      lines.push(`[${ts}] ${level} ${comp}${e.message || ''}`);
    }
    return lines.join('\n') + '\n';
  }

  // --- Download + toast helpers ---

  downloadExportFile = (content, format, entryCount) => {
    const mimeTypes = { json: 'application/json', csv: 'text/csv', txt: 'text/plain' };
    const extensions = { json: '.json', csv: '.csv', txt: '.txt' };
    const filename = `edog-logs-${entryCount}-entries${extensions[format] || '.txt'}`;

    const blob = new Blob([content], { type: mimeTypes[format] || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showExportToast = (countOrMessage, formatOrType) => {
    // Remove any existing toast
    const prev = document.querySelector('.export-toast');
    if (prev) prev.remove();

    const formatLabels = { json: 'JSON', csv: 'CSV', txt: 'Plain Text' };
    let message, variant;

    if (typeof countOrMessage === 'number') {
      message = `Exported ${countOrMessage.toLocaleString()} entries as ${formatLabels[formatOrType] || formatOrType}`;
      variant = '';
    } else {
      message = countOrMessage;
      variant = formatOrType || '';
    }

    const toast = document.createElement('div');
    toast.className = 'export-toast';
    if (variant) toast.classList.add(variant);
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));

    setTimeout(() => {
      toast.classList.remove('visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      // Fallback removal if transitionend doesn't fire
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
    }, 3000);
  }

  exportLogs = () => {
    this.toggleExportDropdown();
  }

  jumpToNextError = () => {
    this.sidebar.switchView('runtime');
    this.runtimeView.switchTab('logs');
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
document.addEventListener('DOMContentLoaded', async () => {
  // Load theme preference — light is default (no data-theme attribute needed)
  const savedTheme = localStorage.getItem('edog-theme');
  if (savedTheme === 'dark') {
    document.body.dataset.theme = 'dark';
  }

  // Auth gate: check if we have a valid bearer token
  const onboarding = new OnboardingScreen();
  const forceOnboarding = new URLSearchParams(window.location.search).get('force-onboarding') === 'true';
  const needsAuth = forceOnboarding || await onboarding.isRequired();

  if (needsAuth && !forceOnboarding) {
    // Try silent re-auth with last known user before showing onboarding
    const silentOk = await onboarding.trySilentReauth();
    if (silentOk) {
      startApp();
    } else {
      await onboarding.show(function onAuthComplete(result) {
        startApp();
      });
    }
  } else if (needsAuth) {
    await onboarding.show(function onAuthComplete(result) {
      startApp();
    });
  } else {
    // Already authenticated — go straight to dashboard
    startApp();
  }

  // Initialize mock data rendering — only when ?mock=true is in the URL
  if (typeof MockRenderer !== 'undefined' && new URLSearchParams(window.location.search).get('mock') === 'true') {
    setTimeout(() => {
      const mock = new MockRenderer();
      mock.init();
      setInterval(() => mock._renderTopBar(), 2000);
    }, 500);
  }
});

function startApp() {
  new EdogLogViewer().init();
}
