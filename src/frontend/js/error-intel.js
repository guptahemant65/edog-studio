/**
 * ErrorIntelligence — Automatically detects, groups, and surfaces errors.
 * Shows dismissible alert cards when errors are found.
 */
class ErrorIntelligence {
  constructor(autoDetector) {
    this.autoDetector = autoDetector;
    this.alertElement = document.getElementById('error-alert');
    this.dismissed = new Set(); // dismissed error codes
    this.onJumpToError = null; // callback to scroll to error log

    autoDetector.onErrorDetected = (exec, error) => this.handleError(exec, error);
  }

  handleError = (exec, error) => {
    if (this.dismissed.has(error.code)) return;
    this.showAlert(exec, error);
  }

  showAlert = (exec, latestError) => {
    if (!this.alertElement) return;

    const errorCount = exec.errors.length;
    const uniqueCodes = [...new Set(exec.errors.map(e => e.code))];
    const skippedCount = exec.skippedNodes || 0;
    
    let summary = `${errorCount} error${errorCount > 1 ? 's' : ''} detected`;
    if (uniqueCodes.length === 1) {
      summary += ` — ${uniqueCodes[0]}`;
      if (latestError.node) summary += ` in node '${latestError.node}'`;
    } else {
      summary += ` (${uniqueCodes.join(', ')})`;
    }
    if (skippedCount > 0) {
      summary += `. ${skippedCount} downstream node${skippedCount > 1 ? 's' : ''} skipped.`;
    }

    this.alertElement.innerHTML = `
      <span class="error-icon">✕</span>
      <span class="error-summary">${summary}</span>
      <span class="error-action" onclick="window.edogViewer && window.edogViewer.jumpToNextError()">Jump to error →</span>
      <span class="error-dismiss" onclick="this.closest('.error-alert').classList.remove('active')" title="Dismiss">✕</span>
    `;
    this.alertElement.classList.add('active');
  }

  dismiss = (errorCode) => {
    this.dismissed.add(errorCode);
    if (this.alertElement) this.alertElement.classList.remove('active');
  }
}
