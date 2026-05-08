/**
 * ExecutionPipeline — Page 5 (index 4) for the Infra Wizard.
 *
 * GitHub Actions–style execution UI with 6 sequential API steps.
 * Client-orchestrated (no SSE). Each step: Pending → Running → Done / Failed.
 * Supports retry-from-failed, rollback, and minimize-to-badge.
 *
 * CSS prefix: .iw-
 * @author Pixel — EDOG Studio hivemind
 */

/* global WizardEventBus, IW_EVENTS */

/* ═══════════════════════════════════════════════════════════════════
   STEP DEFINITIONS
   ═══════════════════════════════════════════════════════════════════ */

var PIPELINE_STEPS = [
  {
    id: 'create-workspace', index: 0, name: 'Create Workspace',
    method: 'POST', urlTemplate: '/api/fabric/v1/workspaces',
    createsResource: true, resourceType: 'workspace',
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'assign-capacity', index: 1, name: 'Assign Capacity',
    method: 'POST', urlTemplate: '/api/fabric/v1/workspaces/{workspaceId}/assignToCapacity',
    createsResource: false,
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'create-lakehouse', index: 2, name: 'Create Lakehouse',
    method: 'POST', urlTemplate: '/api/fabric/v1/workspaces/{workspaceId}/lakehouses',
    createsResource: true, resourceType: 'lakehouse',
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'create-notebook', index: 3, name: 'Create Notebook',
    method: 'POST', urlTemplate: '/api/fabric/v1/workspaces/{workspaceId}/notebooks',
    createsResource: true, resourceType: 'notebook',
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'write-cells', index: 4, name: 'Write Notebook Cells',
    method: 'PUT', urlTemplate: '/api/fabric/v1/workspaces/{workspaceId}/notebooks/{notebookId}/content',
    createsResource: false,
    isLRO: false, timeoutMs: 60000, autoRetries: 2, retryDelayMs: 2000
  },
  {
    id: 'execute-notebook', index: 5, name: 'Run Notebook',
    method: 'POST', urlTemplate: '/api/fabric/v1/workspaces/{workspaceId}/notebooks/{notebookId}/jobs/instances?jobType=RunNotebook',
    createsResource: false,
    isLRO: true, timeoutMs: 300000, autoRetries: 1, retryDelayMs: 5000,
    lroConfig: { pollIntervalMs: 3000, maxPollDurationMs: 300000 }
  }
];


/* ═══════════════════════════════════════════════════════════════════
   STATUS ICONS
   ═══════════════════════════════════════════════════════════════════ */

var STEP_ICONS = {
  pending:   '○',
  running:   '◐',
  succeeded: '●',
  failed:    '✕',
  skipped:   '◌',
  retrying:  '◐'
};


/* ═══════════════════════════════════════════════════════════════════
   EXECUTION PIPELINE
   ═══════════════════════════════════════════════════════════════════ */

class ExecutionPipeline {

  constructor(options) {
    this._eventBus = options.eventBus;
    this._onMinimize = options.onMinimize || null;
    this._onComplete = options.onComplete || null;
    this._onFailed = options.onFailed || null;
    this._el = null;
    this._state = this._createInitialState();
    this._timerInterval = null;
    this._abortController = null;
    this._destroyed = false;
    this._executionContext = null;
    this._createElement();
  }

  /* ─── Page lifecycle ───────────────────────────────────────────── */

  getElement() {
    return this._el;
  }

  activate(wizardState) {
    if (this._destroyed) return;
    this._state = this._createInitialState();
    this._executionContext = this._getExecutionContext(wizardState);
    this._render();
    this._startPipeline(this._executionContext);
  }

  deactivate() {
    this._stopTimer();
  }

  validate() {
    return { valid: true };
  }

  collectState(state) {
    state.execution = {
      status: this._state.status,
      artifacts: this._state.artifacts,
      timing: this._state.timing,
      error: this._state.error
    };
  }

  destroy() {
    this._destroyed = true;
    this._stopTimer();
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
    this._el = null;
    this._eventBus = null;
  }


  /* ─── State management ─────────────────────────────────────────── */

  _createInitialState() {
    var steps = [];
    for (var i = 0; i < PIPELINE_STEPS.length; i++) {
      var def = PIPELINE_STEPS[i];
      steps.push({
        index: def.index,
        id: def.id,
        name: def.name,
        status: 'pending',
        timing: { startedAt: null, completedAt: null, elapsedMs: 0 },
        logs: [],
        isExpanded: false,
        retryCount: 0,
        error: null,
        httpStatus: null,
        skipped: false
      });
    }
    return {
      status: 'idle',
      steps: steps,
      artifacts: {
        workspaceId: null,
        capacityId: null,
        lakehouseId: null,
        notebookId: null,
        jobInstanceId: null,
        notebookRunStatus: null,
        workspaceUrl: null
      },
      rollbackManifest: {
        resources: [],
        rollbackAttempted: false,
        rollbackResults: []
      },
      timing: { startedAt: null, completedAt: null, elapsedMs: 0 },
      activeStepIndex: null,
      retryCount: 0,
      maxRetriesPerStep: 3,
      isMinimized: false,
      error: null
    };
  }

  _setState(updates) {
    for (var key in updates) {
      if (updates.hasOwnProperty(key)) {
        this._state[key] = updates[key];
      }
    }
    if (!this._destroyed) {
      this._render();
    }
  }

  _getExecutionContext(wizardState) {
    var ws = wizardState || {};
    var naming = ws.naming || {};
    var capacity = ws.capacity || {};
    var codeGen = ws.codeGeneration || ws.codeGen || {};
    return {
      workspaceName: naming.workspaceName || naming.workspace || '',
      capacityId: capacity.capacityId || capacity.id || '',
      lakehouseName: naming.lakehouseName || naming.lakehouse || '',
      notebookName: naming.notebookName || naming.notebook || '',
      notebookPayload: codeGen.notebookPayload || null,
      cells: codeGen.cells || null
    };
  }


  /* ─── Execution engine ─────────────────────────────────────────── */

  async _startPipeline(context) {
    if (this._destroyed) return;

    this._abortController = new AbortController();
    this._setState({
      status: 'executing',
      timing: { startedAt: Date.now(), completedAt: null, elapsedMs: 0 }
    });
    this._startTimer();
    this._emit('execution:started', {});

    for (var i = 0; i < PIPELINE_STEPS.length; i++) {
      if (this._destroyed) return;
      if (this._state.status === 'failed') return;

      var success = await this._executeStep(i, context);
      if (!success) {
        this._stopTimer();
        var now = Date.now();
        this._setState({
          status: 'failed',
          timing: {
            startedAt: this._state.timing.startedAt,
            completedAt: now,
            elapsedMs: now - this._state.timing.startedAt
          }
        });
        this._emit('execution:failed', { error: this._state.error });
        if (this._onFailed) {
          this._onFailed(this._state);
        }
        return;
      }
    }

    this._stopTimer();
    var completedAt = Date.now();
    this._setState({
      status: 'succeeded',
      activeStepIndex: null,
      timing: {
        startedAt: this._state.timing.startedAt,
        completedAt: completedAt,
        elapsedMs: completedAt - this._state.timing.startedAt
      }
    });
    this._emit('execution:complete', { artifacts: this._state.artifacts });
    if (this._onComplete) {
      this._onComplete(this._state);
    }
  }

  async _executeStep(stepIndex, context) {
    var stepDef = PIPELINE_STEPS[stepIndex];
    var stepState = this._state.steps[stepIndex];
    var maxRetries = Math.min(stepDef.autoRetries, this._state.maxRetriesPerStep);
    var attempt = 0;

    while (attempt <= maxRetries) {
      if (this._destroyed) return false;

      // Mark step running
      stepState.status = attempt > 0 ? 'retrying' : 'running';
      stepState.timing.startedAt = Date.now();
      stepState.isExpanded = true;
      stepState.retryCount = attempt;
      this._setState({ activeStepIndex: stepIndex });
      this._emit('execution:step', { stepIndex: stepIndex, stepId: stepDef.id, status: stepState.status });

      if (attempt > 0) {
        this._log(stepIndex, 'warn', 'Retry attempt ' + attempt + ' of ' + maxRetries);
      }

      try {
        var url = this._buildRequestUrl(stepDef, this._state.artifacts);
        var body = this._buildRequestBody(stepDef, context, this._state.artifacts);
        this._log(stepIndex, 'info', stepDef.method + ' ' + url);

        var fetchOpts = {
          method: stepDef.method,
          headers: { 'Content-Type': 'application/json' },
          signal: this._abortController.signal
        };
        if (body) {
          fetchOpts.body = JSON.stringify(body);
        }

        var response = await this._fetchWithTimeout(url, fetchOpts, stepDef.timeoutMs);

        if (!response.ok && response.status !== 202) {
          var errBody = null;
          try { errBody = await response.text(); } catch (_e) { /* ignore */ }
          var errMsg = 'HTTP ' + response.status + (errBody ? ': ' + errBody.substring(0, 200) : '');
          throw new Error(errMsg);
        }

        // Handle LRO
        if (stepDef.isLRO && response.status === 202) {
          this._log(stepIndex, 'info', 'Accepted (202) — starting poll');
          var lroResult = await this._handleLRO(stepDef, response, this._state.artifacts);
          if (!lroResult.success) {
            throw new Error(lroResult.error || 'LRO failed');
          }
          this._handleStepSuccess(stepIndex, lroResult.data);
          return true;
        }

        // Standard response
        var data = null;
        var contentType = response.headers.get('Content-Type') || '';
        if (contentType.indexOf('application/json') !== -1) {
          data = await response.json();
        }

        this._handleResponse(stepDef, data);
        this._handleStepSuccess(stepIndex, data);
        return true;

      } catch (err) {
        var isAbort = err.name === 'AbortError';
        var is401 = err.message && err.message.indexOf('HTTP 401') === 0;

        stepState.httpStatus = is401 ? 401 : null;

        if (isAbort) {
          this._log(stepIndex, 'error', 'Aborted');
          this._handleStepFailure(stepIndex, err);
          return false;
        }

        if (is401) {
          this._log(stepIndex, 'error', 'Authentication failed (401) — cannot retry');
          this._handleStepFailure(stepIndex, err);
          return false;
        }

        if (attempt < maxRetries) {
          var delay = stepDef.retryDelayMs * Math.pow(2, attempt);
          this._log(stepIndex, 'warn', 'Failed: ' + err.message + ' — retrying in ' + delay + 'ms');
          await this._sleep(delay);
          attempt++;
          continue;
        }

        this._log(stepIndex, 'error', 'Failed after ' + (attempt + 1) + ' attempts: ' + err.message);
        this._handleStepFailure(stepIndex, err);
        return false;
      }
    }

    return false;
  }

  _buildRequestUrl(stepDef, artifacts) {
    var url = stepDef.urlTemplate;
    if (artifacts.workspaceId) {
      url = url.replace('{workspaceId}', encodeURIComponent(artifacts.workspaceId));
    }
    if (artifacts.notebookId) {
      url = url.replace('{notebookId}', encodeURIComponent(artifacts.notebookId));
    }
    if (artifacts.jobInstanceId) {
      url = url.replace('{jobInstanceId}', encodeURIComponent(artifacts.jobInstanceId));
    }
    return url;
  }

  _buildRequestBody(stepDef, context, artifacts) {
    switch (stepDef.index) {
      case 0: return { displayName: context.workspaceName };
      case 1: return { capacityId: context.capacityId };
      case 2: return { displayName: context.lakehouseName, enableSchemas: true };
      case 3: return { displayName: context.notebookName };
      case 4:
        if (context.notebookPayload) return context.notebookPayload;
        if (typeof window.CodeGenerationEngine !== 'undefined' && context.cells) {
          return window.CodeGenerationEngine.generateNotebookPayload(context.cells);
        }
        return {};
      case 5: return {};
      default: return null;
    }
  }

  _handleResponse(stepDef, data) {
    if (!data) return;
    var artifacts = this._state.artifacts;

    switch (stepDef.index) {
      case 0:
        artifacts.workspaceId = data.id;
        if (data.id) {
          this._addToRollbackManifest('workspace', data.id);
        }
        break;
      case 1:
        // Capacity assignment confirmed
        break;
      case 2:
        artifacts.lakehouseId = data.id;
        if (data.id) {
          this._addToRollbackManifest('lakehouse', data.id);
        }
        break;
      case 3:
        artifacts.notebookId = data.id;
        if (data.id) {
          this._addToRollbackManifest('notebook', data.id);
        }
        break;
      case 4:
        // Write cells — confirmation only
        break;
      case 5:
        if (data.id) {
          artifacts.jobInstanceId = data.id;
        }
        break;
    }
  }

  _addToRollbackManifest(resourceType, resourceId) {
    this._state.rollbackManifest.resources.push({
      type: resourceType,
      id: resourceId,
      createdAt: Date.now()
    });
  }

  async _handleLRO(stepDef, response, artifacts) {
    var jobInstanceId = null;

    // Extract job instance ID from response or Location header
    var locationHeader = response.headers.get('Location') || '';
    try {
      var body = await response.json();
      jobInstanceId = body.id || null;
    } catch (_e) { /* ignore */ }

    if (!jobInstanceId && locationHeader) {
      var parts = locationHeader.split('/');
      jobInstanceId = parts[parts.length - 1];
      // Strip query string if present
      var qIdx = jobInstanceId.indexOf('?');
      if (qIdx !== -1) {
        jobInstanceId = jobInstanceId.substring(0, qIdx);
      }
    }

    if (!jobInstanceId) {
      return { success: false, error: 'Could not extract job instance ID from LRO response', data: null };
    }

    artifacts.jobInstanceId = jobInstanceId;
    this._log(stepDef.index, 'info', 'Job instance: ' + jobInstanceId);

    var pollUrl = '/api/fabric/v1/workspaces/' + encodeURIComponent(artifacts.workspaceId) +
      '/notebooks/' + encodeURIComponent(artifacts.notebookId) +
      '/jobs/instances/' + encodeURIComponent(jobInstanceId);

    return await this._pollLRO(pollUrl, stepDef);
  }

  async _pollLRO(pollUrl, stepDef) {
    var config = stepDef.lroConfig || {};
    var pollInterval = config.pollIntervalMs || 3000;
    var maxDuration = config.maxPollDurationMs || 300000;
    var startTime = Date.now();

    while (true) {
      if (this._destroyed) {
        return { success: false, error: 'Destroyed during poll', data: null };
      }

      await this._sleep(pollInterval);
      var elapsed = Date.now() - startTime;

      if (elapsed > maxDuration) {
        this._log(stepDef.index, 'error', 'LRO timed out after ' + this._formatElapsed(elapsed));
        return { success: false, error: 'Notebook execution timed out after ' + this._formatElapsed(maxDuration), data: null };
      }

      this._log(stepDef.index, 'info', 'Polling (' + this._formatElapsed(elapsed) + ')...');

      try {
        var response = await fetch(pollUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: this._abortController.signal
        });

        if (!response.ok) {
          this._log(stepDef.index, 'warn', 'Poll returned HTTP ' + response.status);
          continue;
        }

        var data = await response.json();
        var status = (data.status || '').toLowerCase();

        if (status === 'completed') {
          this._state.artifacts.notebookRunStatus = 'Completed';
          this._log(stepDef.index, 'info', 'Notebook execution completed');
          return { success: true, data: data };
        }

        if (status === 'failed' || status === 'cancelled') {
          var failMsg = data.failureReason || data.error || ('Notebook run ' + status);
          this._state.artifacts.notebookRunStatus = data.status;
          this._log(stepDef.index, 'error', failMsg);
          return { success: false, error: failMsg, data: data };
        }

        // Still running
      } catch (err) {
        if (err.name === 'AbortError') {
          return { success: false, error: 'Aborted', data: null };
        }
        this._log(stepDef.index, 'warn', 'Poll error: ' + err.message);
      }
    }
  }

  _handleStepSuccess(stepIndex, data) {
    var step = this._state.steps[stepIndex];
    var now = Date.now();
    step.status = 'succeeded';
    step.timing.completedAt = now;
    step.timing.elapsedMs = now - step.timing.startedAt;
    step.isExpanded = false;
    step.error = null;
    this._log(stepIndex, 'info', 'Completed in ' + this._formatElapsed(step.timing.elapsedMs));
    this._emit('execution:step', { stepIndex: stepIndex, stepId: step.id, status: 'succeeded' });
    this._render();
  }

  _handleStepFailure(stepIndex, error) {
    var step = this._state.steps[stepIndex];
    var now = Date.now();
    step.status = 'failed';
    step.timing.completedAt = now;
    step.timing.elapsedMs = now - step.timing.startedAt;
    step.isExpanded = true;
    step.error = error.message || String(error);
    this._state.error = 'Step "' + step.name + '" failed: ' + step.error;
    this._emit('execution:step', { stepIndex: stepIndex, stepId: step.id, status: 'failed' });
    this._render();
  }


  /* ─── Retry & Rollback ─────────────────────────────────────────── */

  async retryFromFailed() {
    if (this._destroyed) return;
    if (this._state.status !== 'failed') return;

    var failedIndex = -1;
    for (var i = 0; i < this._state.steps.length; i++) {
      if (this._state.steps[i].status === 'failed') {
        failedIndex = i;
        break;
      }
    }
    if (failedIndex === -1) return;

    this._state.retryCount++;
    this._state.error = null;
    this._state.status = 'retrying';
    this._state.steps[failedIndex].status = 'pending';
    this._state.steps[failedIndex].error = null;
    this._state.steps[failedIndex].logs = [];
    this._state.timing.completedAt = null;
    this._abortController = new AbortController();
    this._startTimer();
    this._render();

    for (var j = failedIndex; j < PIPELINE_STEPS.length; j++) {
      if (this._destroyed) return;
      if (this._state.status === 'failed') return;

      var success = await this._executeStep(j, this._executionContext);
      if (!success) {
        this._stopTimer();
        var now = Date.now();
        this._setState({
          status: 'failed',
          timing: {
            startedAt: this._state.timing.startedAt,
            completedAt: now,
            elapsedMs: now - this._state.timing.startedAt
          }
        });
        this._emit('execution:failed', { error: this._state.error });
        if (this._onFailed) this._onFailed(this._state);
        return;
      }
    }

    this._stopTimer();
    var completedAt = Date.now();
    this._setState({
      status: 'succeeded',
      activeStepIndex: null,
      timing: {
        startedAt: this._state.timing.startedAt,
        completedAt: completedAt,
        elapsedMs: completedAt - this._state.timing.startedAt
      }
    });
    this._emit('execution:complete', { artifacts: this._state.artifacts });
    if (this._onComplete) this._onComplete(this._state);
  }

  async _startRollback() {
    if (this._destroyed) return;
    if (this._state.rollbackManifest.rollbackAttempted) return;

    this._state.rollbackManifest.rollbackAttempted = true;
    this._setState({ status: 'rolling_back', error: null });

    var resources = this._state.rollbackManifest.resources.slice().reverse();
    var allOk = true;

    for (var i = 0; i < resources.length; i++) {
      var resource = resources[i];
      this._log(0, 'warn', 'Rolling back ' + resource.type + ' (' + resource.id + ')');

      try {
        await this._rollbackResource(resource, this._state.artifacts);
        this._state.rollbackManifest.rollbackResults.push({
          type: resource.type, id: resource.id, status: 'deleted'
        });
        this._log(0, 'info', 'Deleted ' + resource.type);
      } catch (err) {
        allOk = false;
        this._state.rollbackManifest.rollbackResults.push({
          type: resource.type, id: resource.id, status: 'failed', error: err.message
        });
        this._log(0, 'error', 'Failed to delete ' + resource.type + ': ' + err.message);
      }
    }

    this._setState({ status: allOk ? 'rolled_back' : 'rollback_failed' });
    this._render();
  }

  async _rollbackResource(resource, artifacts) {
    var url = '';
    var wid = artifacts.workspaceId;

    switch (resource.type) {
      case 'notebook':
        url = '/api/fabric/v1/workspaces/' + encodeURIComponent(wid) +
          '/notebooks/' + encodeURIComponent(resource.id);
        break;
      case 'lakehouse':
        url = '/api/fabric/v1/workspaces/' + encodeURIComponent(wid) +
          '/lakehouses/' + encodeURIComponent(resource.id);
        break;
      case 'workspace':
        url = '/api/fabric/v1/workspaces/' + encodeURIComponent(resource.id);
        break;
      default:
        throw new Error('Unknown resource type: ' + resource.type);
    }

    var response = await fetch(url, { method: 'DELETE', signal: this._abortController.signal });
    if (!response.ok && response.status !== 404) {
      throw new Error('DELETE failed with HTTP ' + response.status);
    }
  }


  /* ─── Timer ────────────────────────────────────────────────────── */

  _startTimer() {
    this._stopTimer();
    var self = this;
    this._timerInterval = setInterval(function() {
      if (self._destroyed) { self._stopTimer(); return; }

      var now = Date.now();
      if (self._state.timing.startedAt) {
        self._state.timing.elapsedMs = now - self._state.timing.startedAt;
      }

      var activeIdx = self._state.activeStepIndex;
      if (activeIdx !== null && self._state.steps[activeIdx]) {
        var step = self._state.steps[activeIdx];
        if (step.timing.startedAt && !step.timing.completedAt) {
          step.timing.elapsedMs = now - step.timing.startedAt;
        }
      }

      self._renderTimers();
    }, 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  _formatElapsed(ms) {
    if (ms == null || ms < 0) return '0.0s';
    var totalSec = ms / 1000;
    if (totalSec < 60) {
      return totalSec.toFixed(1) + 's';
    }
    var mins = Math.floor(totalSec / 60);
    var secs = Math.floor(totalSec % 60);
    var secStr = secs < 10 ? '0' + secs : '' + secs;
    return mins + 'm ' + secStr + 's';
  }


  /* ─── Logging ──────────────────────────────────────────────────── */

  _log(stepIndex, level, message, data) {
    if (stepIndex < 0 || stepIndex >= this._state.steps.length) return;
    var entry = {
      timestamp: Date.now(),
      level: level,
      message: message,
      data: data || null
    };
    this._state.steps[stepIndex].logs.push(entry);

    // Live-update log area if step is expanded
    if (!this._destroyed && this._state.steps[stepIndex].isExpanded) {
      this._renderStepLogs(stepIndex);
    }
  }


  /* ─── Helpers ──────────────────────────────────────────────────── */

  _emit(event, data) {
    if (this._eventBus && !this._destroyed) {
      this._eventBus.emit(event, data);
    }
  }

  _sleep(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  async _fetchWithTimeout(url, options, timeoutMs) {
    var controller = this._abortController;
    var timeoutId = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
      var response = await fetch(url, options);
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }


  /* ═════════════════════════════════════════════════════════════════
     UI RENDERING
     ═════════════════════════════════════════════════════════════════ */

  _createElement() {
    var el = document.createElement('div');
    el.className = 'iw-page iw-execution-page';

    // Header
    var header = document.createElement('div');
    header.className = 'iw-pipeline-header';

    var title = document.createElement('h3');
    title.className = 'iw-pipeline-title';
    title.textContent = 'Creating Environment';
    header.appendChild(title);

    var timer = document.createElement('span');
    timer.className = 'iw-pipeline-timer';
    timer.textContent = '0.0s';
    header.appendChild(timer);

    el.appendChild(header);

    // Steps container
    var stepsEl = document.createElement('div');
    stepsEl.className = 'iw-pipeline-steps';
    el.appendChild(stepsEl);

    // Summary (hidden until success)
    var summary = document.createElement('div');
    summary.className = 'iw-pipeline-summary';
    summary.hidden = true;
    el.appendChild(summary);

    // Error panel (hidden until failure)
    var errorPanel = document.createElement('div');
    errorPanel.className = 'iw-pipeline-error';
    errorPanel.hidden = true;
    el.appendChild(errorPanel);

    this._el = el;
    this._render();
  }

  _render() {
    if (this._destroyed || !this._el) return;

    var stepsContainer = this._el.querySelector('.iw-pipeline-steps');
    if (!stepsContainer) return;

    // Rebuild steps
    stepsContainer.innerHTML = '';
    for (var i = 0; i < this._state.steps.length; i++) {
      stepsContainer.appendChild(this._renderStep(this._state.steps[i]));
    }

    // Update header title
    var titleEl = this._el.querySelector('.iw-pipeline-title');
    if (titleEl) {
      var titleText = 'Creating Environment';
      if (this._state.status === 'succeeded') titleText = 'Environment Created';
      else if (this._state.status === 'failed') titleText = 'Creation Failed';
      else if (this._state.status === 'rolling_back') titleText = 'Rolling Back';
      else if (this._state.status === 'rolled_back') titleText = 'Rolled Back';
      else if (this._state.status === 'rollback_failed') titleText = 'Rollback Failed';
      else if (this._state.status === 'retrying') titleText = 'Retrying';
      titleEl.textContent = titleText;
    }

    this._renderTimers();
    this._renderSummary();
    this._renderError();
  }

  _renderStep(step) {
    var self = this;
    var wrapper = document.createElement('div');
    wrapper.className = 'iw-step iw-step--' + step.status;
    wrapper.setAttribute('data-step-index', step.index);

    // Row
    var row = document.createElement('div');
    row.className = 'iw-step-row';

    var icon = document.createElement('span');
    icon.className = 'iw-step-icon';
    icon.textContent = this._renderStepIcon(step.status);
    row.appendChild(icon);

    var name = document.createElement('span');
    name.className = 'iw-step-name';
    name.textContent = step.name;
    if (step.retryCount > 0) {
      name.textContent = step.name + ' (retry ' + step.retryCount + ')';
    }
    row.appendChild(name);

    var timer = document.createElement('span');
    timer.className = 'iw-step-timer';
    if (step.status !== 'pending') {
      timer.textContent = this._formatElapsed(step.timing.elapsedMs);
    }
    row.appendChild(timer);

    var toggle = document.createElement('button');
    toggle.className = 'iw-step-toggle';
    toggle.textContent = step.isExpanded ? '▾' : '▸';
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      self._toggleStepExpand(step.index);
    });
    row.appendChild(toggle);

    wrapper.appendChild(row);

    // Detail panel
    var detail = document.createElement('div');
    detail.className = 'iw-step-detail';
    detail.hidden = !step.isExpanded;

    var logs = document.createElement('div');
    logs.className = 'iw-step-logs';
    logs.setAttribute('data-log-index', step.index);

    for (var j = 0; j < step.logs.length; j++) {
      logs.appendChild(this._renderLogEntry(step.logs[j]));
    }

    detail.appendChild(logs);

    if (step.error) {
      var errEl = document.createElement('div');
      errEl.className = 'iw-step-error';
      errEl.textContent = step.error;
      detail.appendChild(errEl);
    }

    wrapper.appendChild(detail);
    return wrapper;
  }

  _renderLogEntry(entry) {
    var line = document.createElement('div');
    line.className = 'iw-log-entry iw-log--' + entry.level;
    var ts = new Date(entry.timestamp);
    var timeStr = ts.toLocaleTimeString();
    line.textContent = '[' + timeStr + '] ' + entry.message;
    return line;
  }

  _renderStepIcon(status) {
    return STEP_ICONS[status] || '○';
  }

  _renderTimers() {
    if (this._destroyed || !this._el) return;

    // Pipeline timer
    var pipelineTimer = this._el.querySelector('.iw-pipeline-timer');
    if (pipelineTimer) {
      pipelineTimer.textContent = this._formatElapsed(this._state.timing.elapsedMs);
    }

    // Per-step timers
    for (var i = 0; i < this._state.steps.length; i++) {
      var step = this._state.steps[i];
      var stepEl = this._el.querySelector('.iw-step[data-step-index="' + i + '"]');
      if (!stepEl) continue;
      var timerEl = stepEl.querySelector('.iw-step-timer');
      if (timerEl && step.status !== 'pending') {
        timerEl.textContent = this._formatElapsed(step.timing.elapsedMs);
      }
    }
  }

  _renderStepLogs(stepIndex) {
    if (this._destroyed || !this._el) return;
    var logContainer = this._el.querySelector('.iw-step-logs[data-log-index="' + stepIndex + '"]');
    if (!logContainer) return;

    var step = this._state.steps[stepIndex];
    var existingCount = logContainer.childElementCount;

    // Only append new entries
    for (var i = existingCount; i < step.logs.length; i++) {
      logContainer.appendChild(this._renderLogEntry(step.logs[i]));
    }

    // Auto-scroll
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  _renderSummary() {
    var summaryEl = this._el.querySelector('.iw-pipeline-summary');
    if (!summaryEl) return;

    if (this._state.status !== 'succeeded') {
      summaryEl.hidden = true;
      return;
    }

    summaryEl.hidden = false;
    summaryEl.innerHTML = '';

    var iconSpan = document.createElement('span');
    iconSpan.className = 'iw-pipeline-summary-icon';
    iconSpan.textContent = '●';
    summaryEl.appendChild(iconSpan);

    var msg = document.createElement('span');
    msg.className = 'iw-pipeline-summary-text';
    msg.textContent = 'Environment created successfully in ' + this._formatElapsed(this._state.timing.elapsedMs);
    summaryEl.appendChild(msg);

    // Details list
    var details = document.createElement('div');
    details.className = 'iw-pipeline-summary-details';
    var artifacts = this._state.artifacts;
    if (artifacts.workspaceId) {
      this._appendDetail(details, 'Workspace', artifacts.workspaceId);
    }
    if (artifacts.lakehouseId) {
      this._appendDetail(details, 'Lakehouse', artifacts.lakehouseId);
    }
    if (artifacts.notebookId) {
      this._appendDetail(details, 'Notebook', artifacts.notebookId);
    }
    summaryEl.appendChild(details);

    // Navigate button
    if (artifacts.workspaceId) {
      var self = this;
      var navBtn = document.createElement('button');
      navBtn.className = 'iw-btn iw-btn-primary iw-exec-navigate-btn';
      navBtn.textContent = 'Open Workspace \u2192';
      navBtn.addEventListener('click', function() {
        self._emit(IW_EVENTS.NAVIGATE_WORKSPACE, { workspaceId: artifacts.workspaceId });
      });
      summaryEl.appendChild(navBtn);
    }
  }

  _appendDetail(container, label, value) {
    var row = document.createElement('div');
    row.className = 'iw-pipeline-summary-row';
    var lbl = document.createElement('span');
    lbl.className = 'iw-pipeline-summary-label';
    lbl.textContent = label + ': ';
    var val = document.createElement('span');
    val.className = 'iw-pipeline-summary-value';
    val.textContent = value;
    row.appendChild(lbl);
    row.appendChild(val);
    container.appendChild(row);
  }

  _renderError() {
    var errorEl = this._el.querySelector('.iw-pipeline-error');
    if (!errorEl) return;

    var showError = this._state.status === 'failed' ||
      this._state.status === 'rollback_failed';

    if (!showError) {
      errorEl.hidden = true;
      return;
    }

    errorEl.hidden = false;
    errorEl.innerHTML = '';

    // Error message
    var msgEl = document.createElement('div');
    msgEl.className = 'iw-pipeline-error-msg';
    msgEl.textContent = this._state.error || 'An unexpected error occurred';
    errorEl.appendChild(msgEl);

    // Rollback results (if any)
    if (this._state.status === 'rollback_failed') {
      var results = this._state.rollbackManifest.rollbackResults;
      if (results.length > 0) {
        var list = document.createElement('div');
        list.className = 'iw-pipeline-rollback-results';
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          var item = document.createElement('div');
          item.className = 'iw-pipeline-rollback-item iw-pipeline-rollback--' + r.status;
          item.textContent = r.type + ' (' + r.id.substring(0, 8) + '...): ' + r.status;
          if (r.error) {
            item.textContent += ' — ' + r.error;
          }
          list.appendChild(item);
        }
        errorEl.appendChild(list);
      }
    }

    // Rolled-back message
    if (this._state.status === 'rolled_back') {
      errorEl.hidden = false;
      errorEl.innerHTML = '';
      var rolledMsg = document.createElement('div');
      rolledMsg.className = 'iw-pipeline-error-msg';
      rolledMsg.textContent = 'All created resources have been rolled back.';
      errorEl.appendChild(rolledMsg);
      return;
    }

    // Action buttons
    var actions = document.createElement('div');
    actions.className = 'iw-pipeline-error-actions';

    var self = this;

    if (this._state.status === 'failed') {
      var retryBtn = document.createElement('button');
      retryBtn.className = 'iw-btn iw-btn-secondary';
      retryBtn.textContent = 'Retry from Failed';
      retryBtn.addEventListener('click', function() {
        self.retryFromFailed();
      });
      actions.appendChild(retryBtn);

      if (this._state.rollbackManifest.resources.length > 0 &&
          !this._state.rollbackManifest.rollbackAttempted) {
        var rollbackBtn = document.createElement('button');
        rollbackBtn.className = 'iw-btn iw-btn-danger';
        rollbackBtn.textContent = 'Rollback';
        rollbackBtn.addEventListener('click', function() {
          self._abortController = new AbortController();
          self._startRollback();
        });
        actions.appendChild(rollbackBtn);
      }
    }

    errorEl.appendChild(actions);
  }

  _toggleStepExpand(stepIndex) {
    if (stepIndex < 0 || stepIndex >= this._state.steps.length) return;
    this._state.steps[stepIndex].isExpanded = !this._state.steps[stepIndex].isExpanded;
    this._render();
  }
}


/* ═══════════════════════════════════════════════════════════════════
   GLOBAL EXPORT
   ═══════════════════════════════════════════════════════════════════ */

window.ExecutionPipeline = ExecutionPipeline;
