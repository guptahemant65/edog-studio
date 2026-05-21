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

// URL templates use the dev-server proxy path `/api/fabric/...` (NOT `/api/fabric/v1/...`)
// The proxy at scripts/dev-server.py prepends `/v1` to the upstream Fabric path itself,
// so adding `/v1/` here would result in `/v1/v1/...` and universal 404s.
var PIPELINE_STEPS = [
  {
    id: 'create-workspace', index: 0, name: 'Create Workspace',
    method: 'POST', urlTemplate: '/api/fabric/workspaces',
    createsResource: true, resourceType: 'workspace',
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'assign-capacity', index: 1, name: 'Assign Capacity',
    method: 'POST', urlTemplate: '/api/fabric/workspaces/{workspaceId}/assignToCapacity',
    createsResource: false,
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'create-lakehouse', index: 2, name: 'Create Lakehouse',
    method: 'POST', urlTemplate: '/api/fabric/workspaces/{workspaceId}/lakehouses',
    createsResource: true, resourceType: 'lakehouse',
    isLRO: false, timeoutMs: 30000, autoRetries: 4, retryDelayMs: 3000
  },
  {
    id: 'create-notebook', index: 3, name: 'Create Notebook',
    method: 'POST', urlTemplate: '/api/fabric/workspaces/{workspaceId}/notebooks',
    createsResource: true, resourceType: 'notebook',
    isLRO: false, timeoutMs: 30000, autoRetries: 2, retryDelayMs: 1000
  },
  {
    id: 'write-cells', index: 4, name: 'Write Notebook Cells',
    method: 'POST', urlTemplate: '/api/fabric/workspaces/{workspaceId}/items/{notebookId}/updateDefinition?updateMetadata=true',
    createsResource: false,
    isLRO: true, lroType: 'operation',
    timeoutMs: 60000, autoRetries: 2, retryDelayMs: 2000,
    lroConfig: { pollIntervalMs: 2000, maxPollDurationMs: 60000 }
  },
  {
    id: 'execute-notebook', index: 5, name: 'Run Notebook',
    method: 'POST', urlTemplate: '/api/fabric/workspaces/{workspaceId}/items/{notebookId}/jobs/instances?jobType=RunNotebook',
    createsResource: false,
    isLRO: true, lroType: 'jobInstance',
    timeoutMs: 600000, autoRetries: 1, retryDelayMs: 5000,
    lroConfig: { pollIntervalMs: 3000, maxPollDurationMs: 600000 }
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
    // Reads the FLAT state shape produced by createWizardState() in infra-wizard.js.
    // Earlier versions read nested shapes (ws.naming.*, ws.capacity.*, ws.codeGen.*) that
    // are never written anywhere, so every request body came out empty.
    var ws = wizardState || {};
    return {
      workspaceName: ws.workspaceName || '',
      capacityId: ws.capacityId || null,
      lakehouseName: ws.lakehouseName || '',
      notebookName: ws.notebookName || '',
      theme: ws.theme || null,
      schemas: ws.schemas || { dbo: true, bronze: false, silver: false, gold: false },
      nodes: Array.isArray(ws.nodes) ? ws.nodes : [],
      connections: Array.isArray(ws.connections) ? ws.connections : []
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

      // Skip "Assign Capacity" (step 1) if capacityId was already bound
      // at workspace creation (step 0). Re-assigning a capacity that's
      // already set returns an error from the Fabric API.
      if (i === 1 && context.capacityId && this._state.artifacts.workspaceId) {
        this._state.steps[1].status = 'succeeded';
        this._state.steps[1].skipped = true;
        this._state.steps[1].timing = { startedAt: Date.now(), completedAt: Date.now(), elapsedMs: 0 };
        this._log(1, 'info', 'Skipped — capacity bound at workspace creation');
        this._render();
        continue;
      }

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
          // 409 on a resource-creating step — two cases:
          //   1. "AlreadyExists" → resolve existing resource by name, reuse its ID
          //   2. "NotAvailableYet" → name is pending (prior create in flight), retry with longer delay
          if (response.status === 409 && stepDef.createsResource) {
            var conflictBody = null;
            try { conflictBody = await response.text(); } catch (_e) { /* ignore */ }
            var isNotAvailableYet = conflictBody && conflictBody.indexOf('NotAvailableYet') !== -1;

            if (isNotAvailableYet) {
              // Fabric is still provisioning from a prior attempt — back off and retry
              var notAvailDelay = Math.max(5000, stepDef.retryDelayMs * Math.pow(2, attempt + 1));
              this._log(stepIndex, 'warn', 'Name pending provisioning — waiting ' + Math.round(notAvailDelay / 1000) + 's');
              await this._sleep(notAvailDelay);
              attempt++;
              continue;
            }

            // Permanent conflict — try to resolve the existing resource
            var resolved = await this._resolveExistingResource(stepDef, context);
            if (resolved) {
              this._log(stepIndex, 'info', stepDef.resourceType + ' already exists — reusing ' + resolved.id.substring(0, 8) + '...');
              this._handleResponse(stepDef, resolved);
              this._handleStepSuccess(stepIndex, resolved);
              return true;
            }
            // Could not resolve — fall through to throw
            var errMsg = 'HTTP 409' + (conflictBody ? ': ' + conflictBody.substring(0, 200) : '');
            throw new Error(errMsg);
          }
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

  /**
   * On 409 Conflict, look up the existing resource by name and return { id }.
   * This lets the pipeline reuse an already-created workspace/lakehouse/notebook
   * instead of failing.
   */
  async _resolveExistingResource(stepDef, context) {
    try {
      var artifacts = this._state.artifacts;
      var listUrl, targetName;

      switch (stepDef.index) {
        case 0: // workspace
          listUrl = '/api/fabric/workspaces?$top=500';
          targetName = context.workspaceName;
          break;
        case 2: // lakehouse
          if (!artifacts.workspaceId) return null;
          listUrl = '/api/fabric/workspaces/' + encodeURIComponent(artifacts.workspaceId) + '/lakehouses';
          targetName = context.lakehouseName;
          break;
        case 3: // notebook
          if (!artifacts.workspaceId) return null;
          listUrl = '/api/fabric/workspaces/' + encodeURIComponent(artifacts.workspaceId) + '/notebooks';
          targetName = context.notebookName;
          break;
        default:
          return null;
      }

      var resp = await fetch(listUrl, {
        headers: { 'Content-Type': 'application/json' },
        signal: this._abortController.signal
      });
      if (!resp.ok) return null;

      var data = await resp.json();
      var items = data.value || data || [];
      var lower = (targetName || '').toLowerCase();
      for (var i = 0; i < items.length; i++) {
        if ((items[i].displayName || '').toLowerCase() === lower) {
          return { id: items[i].id, displayName: items[i].displayName };
        }
      }
    } catch (_e) { /* resolve is best-effort */ }
    return null;
  }

  _buildRequestBody(stepDef, context, artifacts) {
    switch (stepDef.index) {
      // A Fabric workspace must be bound to a capacity at creation; without one it
      // cannot host or execute any artifacts. We send capacityId in the same call
      // rather than relying on Step 1's async assignToCapacity completing in time.
      // Step 1 still runs as an idempotent safety net.
      case 0: {
        var ws = { displayName: context.workspaceName };
        if (context.capacityId) {
          ws.capacityId = context.capacityId;
        }
        return ws;
      }
      case 1: return { capacityId: context.capacityId };
      // Fabric Lakehouse Create requires `enableSchemas` inside `creationPayload`
      // (top-level enableSchemas is silently ignored, leaving the lakehouse schema-less).
      case 2: return {
        displayName: context.lakehouseName,
        creationPayload: { enableSchemas: true }
      };
      case 3: return { displayName: context.notebookName };
      case 4: {
        if (typeof window.CodeGenerationEngine === 'undefined') {
          return {};
        }
        // Generate cells + payload at execution time. CodeGenerationEngine methods are
        // instance methods (not statics), so we must construct an engine first.
        var engine = new window.CodeGenerationEngine();
        var cells = engine.generateCells(
          context.nodes,
          context.connections,
          context.theme,
          context.schemas
        );
        // Thread lakehouse binding so the notebook knows where to run queries.
        var lhInfo = (artifacts.lakehouseId) ? {
          id: artifacts.lakehouseId,
          name: context.lakehouseName,
          workspaceId: artifacts.workspaceId,
          notebookName: context.notebookName
        } : null;
        return engine.generateNotebookPayload(cells, lhInfo);
      }
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
    // Step 4 (updateDefinition) uses the generic Operations API; Step 5 (RunNotebook)
    // uses the job-instance pattern. They have different polling URLs and status shapes.
    if (stepDef.lroType === 'operation') {
      return await this._handleOperationLRO(stepDef, response);
    }
    return await this._handleJobInstanceLRO(stepDef, response, artifacts);
  }

  async _handleJobInstanceLRO(stepDef, response, artifacts) {
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

    // Poll URL: `/items/{notebookId}/...` (the Fabric Run-On-Demand Item Job pattern).
    // No `/v1/` here — see PIPELINE_STEPS comment for proxy double-prefix gotcha.
    var pollUrl = '/api/fabric/workspaces/' + encodeURIComponent(artifacts.workspaceId) +
      '/items/' + encodeURIComponent(artifacts.notebookId) +
      '/jobs/instances/' + encodeURIComponent(jobInstanceId);

    return await this._pollLRO(pollUrl, stepDef);
  }

  async _handleOperationLRO(stepDef, response) {
    // Generic Fabric LRO via the Operations API. The proxy forwards Location so we
    // can derive the poll URL directly from the 202 response.
    var locationHeader = response.headers.get('Location') || '';
    if (!locationHeader) {
      // No Location → server completed synchronously (or stripped the header). Treat
      // as success rather than failing the whole pipeline.
      this._log(stepDef.index, 'info', 'No Location header — treating as synchronous completion');
      return { success: true, data: null };
    }

    var pollPath = this._locationToProxyPath(locationHeader);
    if (!pollPath) {
      return { success: false, error: 'Could not parse Location header: ' + locationHeader, data: null };
    }

    this._log(stepDef.index, 'info', 'Polling operation at ' + pollPath);
    return await this._pollOperation(pollPath, stepDef);
  }

  _locationToProxyPath(absoluteOrRelativeUrl) {
    // Map an upstream Fabric Location URL onto the dev-server proxy.
    //   https://api.fabric.microsoft.com/v1/operations/abc → /api/fabric/operations/abc
    //   https://biazure-…/v1/workspaces/.../jobs/instances/xyz → /api/fabric/workspaces/.../jobs/instances/xyz
    //   /v1/operations/abc (already relative)                 → /api/fabric/operations/abc
    // We strip the leading `/v1/` because dev-server's _map_path prepends `/v1` to
    // anything we hand it — leaving `/v1/` here would produce `/v1/v1/...` again.
    try {
      var path;
      if (absoluteOrRelativeUrl.indexOf('://') !== -1) {
        var u = new URL(absoluteOrRelativeUrl);
        path = u.pathname + (u.search || '');
      } else {
        path = absoluteOrRelativeUrl;
      }
      if (path.indexOf('/v1/') === 0) {
        path = path.substring(3);
      }
      if (path.charAt(0) !== '/') {
        path = '/' + path;
      }
      return '/api/fabric' + path;
    } catch (_e) {
      return null;
    }
  }

  async _pollOperation(pollPath, stepDef) {
    var config = stepDef.lroConfig || {};
    var pollInterval = config.pollIntervalMs || 2000;
    var maxDuration = config.maxPollDurationMs || 60000;
    var startTime = Date.now();

    while (true) {
      if (this._destroyed) {
        return { success: false, error: 'Destroyed during poll', data: null };
      }

      await this._sleep(pollInterval);
      var elapsed = Date.now() - startTime;

      if (elapsed > maxDuration) {
        this._log(stepDef.index, 'error', 'Operation timed out after ' + this._formatElapsed(elapsed));
        return { success: false, error: 'Operation timed out after ' + this._formatElapsed(maxDuration), data: null };
      }

      this._log(stepDef.index, 'info', 'Polling operation (' + this._formatElapsed(elapsed) + ')...');

      try {
        var response = await fetch(pollPath, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: this._abortController.signal
        });

        if (!response.ok) {
          this._log(stepDef.index, 'warn', 'Operation poll returned HTTP ' + response.status);
          continue;
        }

        var data = await response.json();
        var status = (data.status || '').toLowerCase();

        if (status === 'succeeded') {
          this._log(stepDef.index, 'info', 'Operation succeeded');
          return { success: true, data: data };
        }

        if (status === 'failed') {
          var failMsg = (data.error && data.error.message) || data.failureReason || 'Operation failed';
          this._log(stepDef.index, 'error', failMsg);
          return { success: false, error: failMsg, data: data };
        }

        // Still NotStarted / Running — keep polling.
      } catch (err) {
        if (err.name === 'AbortError') {
          return { success: false, error: 'Aborted', data: null };
        }
        this._log(stepDef.index, 'warn', 'Operation poll error: ' + err.message);
      }
    }
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

        // Log status + timing from Fabric on each poll
        var statusLabel = data.status || 'Unknown';
        var startTime = data.startTimeUtc ? new Date(data.startTimeUtc).toLocaleTimeString() : null;
        var statusMsg = 'Status: ' + statusLabel;
        if (startTime) statusMsg += ' (started ' + startTime + ')';
        this._log(stepDef.index, 'info', statusMsg);

        if (status === 'completed') {
          this._state.artifacts.notebookRunStatus = 'Completed';
          var duration = (data.startTimeUtc && data.endTimeUtc)
            ? this._formatElapsed(new Date(data.endTimeUtc) - new Date(data.startTimeUtc))
            : '';
          this._log(stepDef.index, 'info', 'Notebook execution completed' + (duration ? ' in ' + duration : ''));
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
        url = '/api/fabric/workspaces/' + encodeURIComponent(wid) +
          '/notebooks/' + encodeURIComponent(resource.id);
        break;
      case 'lakehouse':
        url = '/api/fabric/workspaces/' + encodeURIComponent(wid) +
          '/lakehouses/' + encodeURIComponent(resource.id);
        break;
      case 'workspace':
        url = '/api/fabric/workspaces/' + encodeURIComponent(resource.id);
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
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '0.0s';
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
     UI RENDERING (Phantom infra-deploy-v1 mock)
     ═════════════════════════════════════════════════════════════════ */

  _createElement() {
    var el = document.createElement('div');
    // NOTE: Do NOT stamp `iw-page` here. The wizard already wraps this in a
    // `.iw-page` container (`#iw-page-4`). Adding `iw-page` to this nested
    // root inherits `opacity:0; position:absolute; pointer-events:none` from
    // the base `.iw-page` rule and never receives `.active`, leaving the
    // deploy page invisible. Same trap as DagCanvasPage.
    el.className = 'iw-execution-page iw-deploy';
    this._el = el;
    this._render();
  }

  /* ─── Top-level render ─────────────────────────────────────────── */

  _render() {
    if (this._destroyed || !this._el) return;
    var s = this._state;
    var view = this._computeDeployView(s);

    var html = '';
    html += this._renderProgressBar(view);
    html += this._renderHead(view);
    html += this._renderPipeline(s);
    html += this._renderBottomSection(s, view);
    html += this._renderActions(s, view);

    this._el.innerHTML = html;
    this._bindRenderEvents();
  }

  /* ─── View model ───────────────────────────────────────────────── */

  _computeDeployView(s) {
    var totalSteps = s.steps.length;
    var doneCount = 0;
    var firstRunningIdx = -1;
    var firstFailedIdx = -1;
    var skippedCount = 0;

    for (var i = 0; i < s.steps.length; i++) {
      var st = s.steps[i];
      if (st.status === 'succeeded') doneCount++;
      if (st.skipped) skippedCount++;
      if (firstRunningIdx === -1 && (st.status === 'running' || st.status === 'retrying')) {
        firstRunningIdx = i;
      }
      if (firstFailedIdx === -1 && st.status === 'failed') {
        firstFailedIdx = i;
      }
    }

    var status = s.status;
    var pct = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0;
    if (status === 'failed' || status === 'rollback_failed') {
      // freeze progress at the failed step
      pct = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0;
    }
    if (status === 'succeeded') pct = 100;

    var headClass = '';
    var titleText = 'Provisioning your environment';
    var eyebrowText = 'Executing \u00B7 ' + totalSteps + ' steps';
    var currentText = '';

    var activeIdx = firstRunningIdx >= 0 ? firstRunningIdx : (firstFailedIdx >= 0 ? firstFailedIdx : -1);
    if (activeIdx >= 0) {
      currentText = s.steps[activeIdx].name + '\u2026';
    } else if (status === 'succeeded') {
      currentText = 'All resources provisioned';
    } else if (status === 'rolling_back') {
      currentText = 'Rolling back created resources\u2026';
    } else if (status === 'rolled_back') {
      currentText = 'All created resources removed';
    }

    var timerClass = '';
    if (status === 'succeeded') {
      headClass = 'iw-deploy-head--success';
      eyebrowText = 'Succeeded \u00B7 ' + totalSteps + ' steps complete';
      titleText = 'Environment ready';
      timerClass = 'iw-deploy-timer--done';
    } else if (status === 'failed') {
      headClass = 'iw-deploy-head--fail';
      eyebrowText = 'Failed \u00B7 step ' + ((firstFailedIdx + 1) || '?') + ' of ' + totalSteps;
      titleText = 'Provisioning failed';
      timerClass = 'iw-deploy-timer--fail';
    } else if (status === 'rolling_back') {
      headClass = 'iw-deploy-head--warn';
      eyebrowText = 'Rolling back \u00B7 cleaning up resources';
      titleText = 'Rolling back';
      timerClass = 'iw-deploy-timer--warn';
    } else if (status === 'rolled_back') {
      headClass = 'iw-deploy-head--warn';
      eyebrowText = 'Rolled back \u00B7 environment removed';
      titleText = 'Rollback complete';
      timerClass = 'iw-deploy-timer--warn';
    } else if (status === 'rollback_failed') {
      headClass = 'iw-deploy-head--fail';
      eyebrowText = 'Rollback failed \u00B7 manual cleanup required';
      titleText = 'Rollback failed';
      timerClass = 'iw-deploy-timer--fail';
    }

    return {
      status: status,
      pct: pct,
      doneCount: doneCount,
      totalSteps: totalSteps,
      skippedCount: skippedCount,
      firstRunningIdx: firstRunningIdx,
      firstFailedIdx: firstFailedIdx,
      headClass: headClass,
      eyebrowText: eyebrowText,
      titleText: titleText,
      currentText: currentText,
      timerClass: timerClass
    };
  }

  /* ─── Progress bar ─────────────────────────────────────────────── */

  _renderProgressBar(view) {
    var fillCls = '';
    if (view.status === 'succeeded') fillCls = ' iw-progress-fill--ok';
    else if (view.status === 'failed' || view.status === 'rollback_failed') fillCls = ' iw-progress-fill--fail';
    else if (view.status === 'rolling_back' || view.status === 'rolled_back') fillCls = ' iw-progress-fill--warn';
    return '<div class="iw-progress-bar"><div class="iw-progress-fill' + fillCls +
      '" style="width:' + view.pct + '%"></div></div>';
  }

  /* ─── Deploy head ──────────────────────────────────────────────── */

  _renderHead(view) {
    var html = '<div class="iw-deploy-head ' + view.headClass + '">';
    html += '<div class="iw-deploy-head-left">';
    html += '<div class="iw-deploy-eyebrow"><span class="iw-deploy-eyebrow-dot"></span>' +
      this._escape(view.eyebrowText) + '</div>';
    html += '<div class="iw-deploy-title">' + this._escape(view.titleText) + '</div>';
    if (view.currentText) {
      var liveDot = (view.status === 'executing' || view.status === 'rolling_back')
        ? '<span class="iw-deploy-live-dot"></span>'
        : '';
      html += '<div class="iw-deploy-current">' + liveDot +
        '<span>' + this._escape(view.currentText) + '</span></div>';
    }
    html += '</div>';
    html += '<div class="iw-deploy-head-right">';
    html += '<div class="iw-deploy-timer ' + view.timerClass + '">' +
      this._escape(this._formatElapsed(this._state.timing.elapsedMs)) + '</div>';
    html += '<div class="iw-deploy-timer-label">elapsed</div>';
    var counterCurrent = view.doneCount;
    if (view.firstRunningIdx >= 0) counterCurrent = view.firstRunningIdx;
    var counterHtml;
    if (view.status === 'succeeded') {
      counterHtml = '<strong>' + view.totalSteps + '</strong> / ' + view.totalSteps + ' steps';
    } else if (view.status === 'failed' || view.status === 'rollback_failed') {
      counterHtml = '<strong>' + view.doneCount + '</strong> / ' + view.totalSteps + ' steps';
    } else {
      counterHtml = '<strong>' + counterCurrent + '</strong> / ' + view.totalSteps + ' steps';
    }
    html += '<div class="iw-deploy-step-counter">' + counterHtml + '</div>';
    html += '</div></div>';
    return html;
  }

  /* ─── Pipeline list ────────────────────────────────────────────── */

  _renderPipeline(s) {
    var html = '<div class="iw-pipeline">';
    for (var i = 0; i < s.steps.length; i++) {
      html += this._renderStep(s.steps[i]);
    }
    html += '</div>';
    return html;
  }

  _renderStep(step) {
    var statusCls = step.skipped ? 'skipped' : step.status;
    var openCls = step.isExpanded ? ' iw-pipe-step--open' : '';
    var html = '<div class="iw-pipe-step iw-pipe-step--' + statusCls + openCls +
      '" data-step-index="' + step.index + '">';

    html += '<div class="iw-pipe-row" data-action="toggle-step" data-step-index="' + step.index + '">';
    html += '<div class="iw-pipe-icon iw-pipe-icon--' + statusCls + '">' +
      this._renderStepIcon(step.skipped ? 'skipped' : step.status) + '</div>';
    html += '<div class="iw-pipe-info">';
    var nameSuffix = step.retryCount > 0 ? ' <span class="iw-pipe-retry">\u21BA retry ' + step.retryCount + '</span>' : '';
    html += '<div class="iw-pipe-name">' + this._escape(step.name) + nameSuffix + '</div>';
    html += '<div class="iw-pipe-sub">' + this._escape(this._stepSubText(step)) + '</div>';
    html += '</div>';
    html += '<div class="iw-pipe-time">';
    if (step.status !== 'pending' && !step.skipped) {
      html += this._escape(this._formatElapsed(step.timing.elapsedMs));
    } else if (step.skipped) {
      html += 'skipped';
    } else {
      html += '\u2014';
    }
    html += '</div>';
    html += '<button class="iw-pipe-expand" data-action="toggle-step" data-step-index="' + step.index + '" aria-label="Toggle logs">' +
      (step.isExpanded ? '\u25BE' : '\u25B8') + '</button>';
    html += '</div>';

    if (step.isExpanded) {
      html += '<div class="iw-pipe-detail">';
      html += '<div class="iw-pipe-detail-logs" data-log-index="' + step.index + '">';
      if (step.logs.length === 0) {
        html += '<div class="iw-log-line iw-log-line--debug">No log entries yet.</div>';
      } else {
        for (var j = 0; j < step.logs.length; j++) {
          html += this._renderLogEntry(step.logs[j]);
        }
      }
      html += '</div>';
      if (step.error) {
        html += '<div class="iw-pipe-step-error">' + this._escape(step.error) + '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  _stepSubText(step) {
    if (step.skipped) return 'Skipped \u00B7 capacity already bound at workspace creation';
    switch (step.status) {
      case 'pending': return 'Waiting for previous steps to complete';
      case 'running': return 'In progress\u2026';
      case 'retrying': return 'Retrying request\u2026';
      case 'succeeded': return 'Completed successfully';
      case 'failed': return step.error || 'Request failed';
      default: return '';
    }
  }

  _renderStepIcon(status) {
    if (status === 'running' || status === 'retrying') {
      return '<span class="iw-spinner" aria-hidden="true"></span>';
    }
    if (status === 'succeeded') {
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    }
    if (status === 'failed') {
      return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    }
    if (status === 'skipped') {
      return '<span aria-hidden="true">\u2212</span>';
    }
    return '<span aria-hidden="true">\u25CB</span>';
  }

  _renderLogEntry(entry) {
    var ts = new Date(entry.timestamp);
    var timeStr = ts.toLocaleTimeString('en-US', { hour12: false });
    var msg = this._escape(entry.message);
    return '<div class="iw-log-line iw-log-line--' + entry.level + '">' +
      '<span class="iw-log-ts">' + timeStr + '</span>' +
      '<span class="iw-log-lvl">' + entry.level + '</span>' +
      '<span class="iw-log-msg">' + msg + '</span></div>';
  }

  _renderStepLogs(stepIndex) {
    if (this._destroyed || !this._el) return;
    var step = this._state.steps[stepIndex];
    if (!step || !step.isExpanded) return;
    var logContainer = this._el.querySelector('.iw-pipe-detail-logs[data-log-index="' + stepIndex + '"]');
    if (!logContainer) return;

    var existing = logContainer.children;
    var existingCount = existing.length;
    // Skip the "No log entries yet." placeholder if it's there
    if (existingCount === 1 && existing[0].classList.contains('iw-log-line--debug') &&
        existing[0].textContent.indexOf('No log entries') === 0) {
      logContainer.innerHTML = '';
      existingCount = 0;
    }
    for (var i = existingCount; i < step.logs.length; i++) {
      var tmp = document.createElement('div');
      tmp.innerHTML = this._renderLogEntry(step.logs[i]);
      logContainer.appendChild(tmp.firstChild);
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  _renderTimers() {
    if (this._destroyed || !this._el) return;
    var headTimer = this._el.querySelector('.iw-deploy-timer');
    if (headTimer) {
      headTimer.textContent = this._formatElapsed(this._state.timing.elapsedMs);
    }
    for (var i = 0; i < this._state.steps.length; i++) {
      var step = this._state.steps[i];
      var stepEl = this._el.querySelector('.iw-pipe-step[data-step-index="' + i + '"] .iw-pipe-time');
      if (stepEl && step.status !== 'pending' && !step.skipped) {
        stepEl.textContent = this._formatElapsed(step.timing.elapsedMs);
      }
    }
  }

  /* ─── Bottom section (success / error / rollback) ──────────────── */

  _renderBottomSection(s, view) {
    if (s.status === 'succeeded') return this._renderSuccessCard(s);
    if (s.status === 'failed') return this._renderErrorPanel(s);
    if (s.status === 'rolling_back') return this._renderRollbackPanel(s, false);
    if (s.status === 'rolled_back') return this._renderRollbackPanel(s, true);
    if (s.status === 'rollback_failed') return this._renderRollbackFailedPanel(s);
    void view;
    return '';
  }

  _renderSuccessCard(s) {
    var a = s.artifacts;
    var html = '<div class="iw-success-card">';
    html += '<div class="iw-success-head">';
    html += '<div class="iw-success-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>';
    html += '<div><div class="iw-success-title">Your Fabric environment is live</div>';
    html += '<div class="iw-success-sub">Provisioned in ' + this._escape(this._formatElapsed(s.timing.elapsedMs)) +
      ' \u00B7 all 6 steps succeeded</div></div></div>';
    html += '<div class="iw-resource-grid">';
    if (a.workspaceId) html += this._resourceCell('Workspace', this._shortId(a.workspaceId));
    if (a.lakehouseId) html += this._resourceCell('Lakehouse', this._shortId(a.lakehouseId));
    if (a.notebookId) html += this._resourceCell('Notebook', this._shortId(a.notebookId));
    if (a.notebookRunStatus) html += this._resourceCell('Run status', String(a.notebookRunStatus));
    html += '</div></div>';
    return html;
  }

  _resourceCell(label, value) {
    return '<div class="iw-resource-cell">' +
      '<div class="iw-resource-label">' + this._escape(label) + '</div>' +
      '<div class="iw-resource-value">' + this._escape(value) + '</div></div>';
  }

  _renderErrorPanel(s) {
    var html = '<div class="iw-error-panel">';
    html += '<div class="iw-error-head">';
    html += '<div class="iw-error-icon">!</div>';
    html += '<div><div class="iw-error-title">Provisioning failed</div>';
    html += '<div class="iw-error-sub">' +
      this._escape(s.error || 'An unexpected error occurred during execution.') +
      '</div></div></div>';

    var manifest = s.rollbackManifest.resources;
    if (manifest && manifest.length > 0) {
      html += '<div class="iw-error-rollback-preview">';
      html += '<div class="iw-error-rollback-title">' + manifest.length +
        ' resource' + (manifest.length === 1 ? '' : 's') + ' created \u2014 available for rollback</div>';
      for (var i = 0; i < manifest.length; i++) {
        html += '<div class="iw-rb-row iw-rb-row--pending">' +
          '<span class="iw-rb-type">' + this._escape(manifest[i].type) + '</span>' +
          '<span class="iw-rb-id">' + this._escape(this._shortId(manifest[i].id)) + '</span>' +
          '<span class="iw-rb-status">awaiting rollback</span></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  _renderRollbackPanel(s, done) {
    var results = s.rollbackManifest.rollbackResults;
    var manifest = s.rollbackManifest.resources;
    var html = '<div class="iw-rollback-panel ' + (done ? 'iw-rollback-panel--done' : '') + '">';
    html += '<div class="iw-rollback-head">';
    html += '<div class="iw-rollback-icon">\u21BA</div>';
    html += '<div><div class="iw-rollback-title">' +
      (done ? 'Rollback complete' : 'Rolling back created resources') + '</div>';
    html += '<div class="iw-rollback-sub">' +
      (done ? 'All resources created during this run have been removed.'
            : 'Deleting resources in reverse creation order. This usually takes a few seconds.') +
      '</div></div></div>';

    html += '<div class="iw-rollback-list">';
    var renderedIds = {};
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      renderedIds[r.id] = true;
      var rowCls = r.status === 'deleted' ? 'iw-rb-row--deleted' :
                   r.status === 'failed'  ? 'iw-rb-row--failed'  :
                   r.status === 'kept'    ? 'iw-rb-row--kept'    : 'iw-rb-row--deleting';
      var statusText = r.status === 'deleted' ? 'deleted' :
                       r.status === 'failed'  ? 'failed: ' + (r.error || '') :
                       r.status === 'kept'    ? 'kept' : 'deleting\u2026';
      html += '<div class="iw-rb-row ' + rowCls + '">' +
        '<span class="iw-rb-type">' + this._escape(r.type) + '</span>' +
        '<span class="iw-rb-id">' + this._escape(this._shortId(r.id)) + '</span>' +
        '<span class="iw-rb-status">' + this._escape(statusText) + '</span></div>';
    }
    for (var k = 0; k < manifest.length; k++) {
      if (renderedIds[manifest[k].id]) continue;
      html += '<div class="iw-rb-row iw-rb-row--pending">' +
        '<span class="iw-rb-type">' + this._escape(manifest[k].type) + '</span>' +
        '<span class="iw-rb-id">' + this._escape(this._shortId(manifest[k].id)) + '</span>' +
        '<span class="iw-rb-status">queued</span></div>';
    }
    html += '</div></div>';
    return html;
  }

  _renderRollbackFailedPanel(s) {
    var html = '<div class="iw-error-panel iw-error-panel--rollback">';
    html += '<div class="iw-error-head">';
    html += '<div class="iw-error-icon">!</div>';
    html += '<div><div class="iw-error-title">Rollback partially failed</div>';
    html += '<div class="iw-error-sub">' +
      this._escape(s.error || 'Some resources could not be removed automatically.') +
      ' Manual cleanup may be required in the Fabric portal.</div></div></div>';
    var results = s.rollbackManifest.rollbackResults;
    if (results && results.length > 0) {
      html += '<div class="iw-rollback-list">';
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var rowCls = r.status === 'deleted' ? 'iw-rb-row--deleted' : 'iw-rb-row--failed';
        var statusText = r.status === 'deleted' ? 'deleted' : ('failed' + (r.error ? ': ' + r.error : ''));
        html += '<div class="iw-rb-row ' + rowCls + '">' +
          '<span class="iw-rb-type">' + this._escape(r.type) + '</span>' +
          '<span class="iw-rb-id">' + this._escape(this._shortId(r.id)) + '</span>' +
          '<span class="iw-rb-status">' + this._escape(statusText) + '</span></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  /* ─── Action buttons (inline; deploy page has no wizard footer) ─ */

  _renderActions(s, view) {
    var html = '<div class="iw-deploy-actions">';
    if (s.status === 'executing' || s.status === 'idle' || s.status === 'retrying') {
      html += '<button class="iw-btn iw-btn-ghost" data-action="minimize">Minimize</button>';
    } else if (s.status === 'succeeded') {
      var hasWs = !!s.artifacts.workspaceId;
      if (hasWs) {
        html += '<button class="iw-btn iw-btn-ghost" data-action="open-workspace">Open in Fabric \u2197</button>';
      }
      html += '<button class="iw-btn iw-btn-primary" data-action="deploy-flt">Deploy FLT \u2192</button>';
    } else if (s.status === 'failed') {
      html += '<button class="iw-btn iw-btn-ghost" data-action="minimize">Minimize</button>';
      var hasResources = s.rollbackManifest.resources.length > 0 &&
                        !s.rollbackManifest.rollbackAttempted;
      if (hasResources) {
        html += '<button class="iw-btn iw-btn-danger" data-action="rollback">Rollback created resources</button>';
      }
      html += '<button class="iw-btn iw-btn-primary" data-action="retry">Retry from failed step</button>';
    } else if (s.status === 'rolling_back') {
      html += '<button class="iw-btn iw-btn-ghost" disabled>Rolling back\u2026</button>';
    } else if (s.status === 'rolled_back') {
      html += '<button class="iw-btn iw-btn-primary" data-action="restart">Start over</button>';
    } else if (s.status === 'rollback_failed') {
      html += '<button class="iw-btn iw-btn-ghost" data-action="open-portal">Open Fabric portal</button>';
      html += '<button class="iw-btn iw-btn-primary" data-action="restart">Start over</button>';
    }
    html += '</div>';
    void view;
    return html;
  }

  /* ─── Event binding ────────────────────────────────────────────── */

  _bindRenderEvents() {
    var self = this;
    var toggles = this._el.querySelectorAll('[data-action="toggle-step"]');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(e.currentTarget.getAttribute('data-step-index'), 10);
        if (!isNaN(idx)) self._toggleStepExpand(idx);
      });
    }

    var actionMap = {
      'minimize':        function() { if (self._onMinimize) self._onMinimize(); },
      'retry':           function() { self.retryFromFailed(); },
      'rollback':        function() {
        self._abortController = new AbortController();
        self._startRollback();
      },
      'open-workspace':  function() {
        var wsId = self._state.artifacts.workspaceId;
        if (wsId && typeof IW_EVENTS !== 'undefined') {
          self._emit(IW_EVENTS.NAVIGATE_WORKSPACE, { workspaceId: wsId });
        }
      },
      'deploy-flt':      function() {
        if (self._onComplete) self._onComplete(self._state.artifacts);
      },
      'restart':         function() {
        if (self._onMinimize) self._onMinimize();
      },
      'open-portal':     function() {
        window.open('https://app.fabric.microsoft.com/', '_blank');
      }
    };

    Object.keys(actionMap).forEach(function(key) {
      var btn = self._el.querySelector('[data-action="' + key + '"]');
      if (btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          actionMap[key]();
        });
      }
    });
  }

  /* ─── Expand toggle ────────────────────────────────────────────── */

  _toggleStepExpand(stepIndex) {
    if (stepIndex < 0 || stepIndex >= this._state.steps.length) return;
    this._state.steps[stepIndex].isExpanded = !this._state.steps[stepIndex].isExpanded;
    this._render();
  }

  /* ─── Misc helpers ─────────────────────────────────────────────── */

  _shortId(id) {
    if (!id) return '';
    var s = String(id);
    if (s.length <= 14) return s;
    return s.substring(0, 8) + '\u2026' + s.substring(s.length - 4);
  }

  _escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}


/* ═══════════════════════════════════════════════════════════════════
   GLOBAL EXPORT
   ═══════════════════════════════════════════════════════════════════ */

window.ExecutionPipeline = ExecutionPipeline;
