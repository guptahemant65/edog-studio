/**
 * SmartContextBar — Renders and updates the auto-detected execution context bar.
 * Appears automatically when a DAG execution is detected. No user action needed.
 * 
 * API calls are displayed as data-rich toast cards (not in the context bar).
 */
class SmartContextBar {
  constructor(autoDetector) {
    this.autoDetector = autoDetector;
    this.element = document.getElementById('smart-context-bar');
    this.toastEl = document.getElementById('api-toast');
    this.updateInterval = null;
    this.toastTimeout = null;

    // Wire up auto-detector callbacks — iteration-based executions → context bar
    autoDetector.onExecutionDetected = (exec, id) => this.showExecution(exec, id);
    autoDetector.onExecutionUpdated = (exec, id) => this.updateExecution(exec, id);

    // Wire up auto-detector callbacks — RAID-based API calls → toast card
    autoDetector.onApiCallDetected = (call, id) => this.showApiToast(call, id);
    autoDetector.onApiCallUpdated = (call, id) => this.updateApiToast(call, id);
  }

  // === Iteration-based execution → persistent context bar ===

  showExecution = (exec, iterationId) => {
    if (!this.element) return;
    this.element.classList.add('active');
    this.updateExecution(exec, iterationId);
    if (this.updateInterval) clearInterval(this.updateInterval);
    this.updateInterval = setInterval(() => {
      const elapsed = this.autoDetector.getElapsedTime();
      const elapsedEl = this.element.querySelector('.elapsed');
      if (elapsedEl && elapsed) elapsedEl.textContent = elapsed + 's';
    }, 1000);
  }

  updateExecution = (exec, iterationId) => {
    if (!this.element) return;
    const statusClass = (exec.status || 'unknown').toLowerCase();
    const completedTotal = exec.nodeCount || '?';
    const completed = exec.completedNodes || 0;
    const failed = exec.failedNodes || 0;
    const elapsed = this.autoDetector.getElapsedTime() || '—';
    const shortId = iterationId.substring(0, 8) + '…' + iterationId.substring(iterationId.length - 4);

    this.element.innerHTML = `
      <span class="ctx-type">🔄 Execution</span>
      <span class="dag-status ${statusClass}">● ${exec.status || 'Detected'}</span>
      <span class="dag-name">${exec.dagName || 'DAG Execution'}</span>
      <span class="node-progress">${completed}${failed ? '+' + failed + ' err' : ''} / ${completedTotal} nodes</span>
      <span class="elapsed">${elapsed}s</span>
      ${exec.endpoint ? '<span class="endpoint">' + exec.endpoint + '</span>' : ''}
      <span class="iter-id">${shortId}</span>
      <span class="dismiss" onclick="document.getElementById('smart-context-bar').classList.remove('active')">✕</span>
    `;
    this.element.classList.add('active');
  }

  // === RAID-based API calls → floating toast card ===

  showApiToast = (call, raidId) => {
    if (!this.toastEl) return;
    this._renderToast(call, raidId);
    this.toastEl.classList.add('active');
    // Auto-dismiss after 12 seconds
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => this.hideApiToast(), 12000);
  }

  updateApiToast = (call, raidId) => {
    if (!this.toastEl || !this.toastEl.classList.contains('active')) return;
    this._renderToast(call, raidId);
    // Extend the auto-dismiss timer
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => this.hideApiToast(), 12000);
  }

  _renderToast = (call, raidId) => {
    const statusClass = (call.status || 'unknown').toLowerCase();
    const statusIcon = statusClass === 'succeeded' ? '✓' : statusClass === 'failed' ? '✗' : '●';
    const duration = call.duration ? this._formatDuration(call.duration) : '—';
    const shortRaid = raidId.substring(0, 8) + '…' + raidId.substring(raidId.length - 4);
    const attrs = call.attributes || {};
    // Extract key attributes to display
    const keyAttrs = [];
    if (attrs.WorkspaceId) keyAttrs.push(['Workspace', attrs.WorkspaceId.substring(0, 8) + '…']);
    if (attrs.ArtifactId) keyAttrs.push(['Artifact', attrs.ArtifactId.substring(0, 8) + '…']);
    if (attrs.DagNodesCount) keyAttrs.push(['Nodes', attrs.DagNodesCount]);
    if (attrs.ShowExtendedLineage) keyAttrs.push(['Extended', attrs.ShowExtendedLineage]);
    if (attrs.RefreshMode) keyAttrs.push(['Mode', attrs.RefreshMode]);
    if (attrs.ErrorCode) keyAttrs.push(['Error', attrs.ErrorCode]);
    // Show up to 4 attributes
    const attrCount = Object.keys(attrs).length;
    const extraCount = attrCount - keyAttrs.length;

    this.toastEl.innerHTML = `
      <div class="toast-header">
        <span class="toast-endpoint">${call.endpointName || call.activityName}</span>
        <span class="toast-status ${statusClass}">${statusIcon} ${call.status}</span>
        <span class="toast-duration">${duration}</span>
        <span class="toast-dismiss" onclick="document.getElementById('api-toast').classList.remove('active')">✕</span>
      </div>
      <div class="toast-body">
        <div class="toast-raid">
          <span class="toast-label">RAID</span>
          <span class="toast-value">${shortRaid}</span>
        </div>
        ${call.resultCode && call.resultCode !== 'OK' ? `
        <div class="toast-attr">
          <span class="toast-label">Result</span>
          <span class="toast-value toast-error">${call.resultCode}</span>
        </div>` : ''}
        ${keyAttrs.map(([k, v]) => `
        <div class="toast-attr">
          <span class="toast-label">${k}</span>
          <span class="toast-value">${v}</span>
        </div>`).join('')}
        ${extraCount > 0 ? `<div class="toast-more">+${extraCount} more attributes</div>` : ''}
      </div>
      ${call.eventCount > 1 ? `<div class="toast-footer">${call.eventCount} telemetry events</div>` : ''}
    `;
  }

  hideApiToast = () => {
    if (this.toastEl) this.toastEl.classList.remove('active');
    if (this.toastTimeout) { clearTimeout(this.toastTimeout); this.toastTimeout = null; }
  }

  _formatDuration = (ms) => {
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  hide = () => {
    if (this.element) this.element.classList.remove('active');
    if (this.updateInterval) clearInterval(this.updateInterval);
    this.hideApiToast();
  }
}
