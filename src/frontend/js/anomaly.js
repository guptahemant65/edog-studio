/**
 * AnomalyDetector — Watches log patterns for anomalies and surfaces proactive warnings.
 * 
 * Detects: slow polling, retry storms, slow nodes, timeout risks.
 */
class AnomalyDetector {
  constructor(state) {
    this.state = state;
    this.warningElement = document.getElementById('anomaly-warning');
    this.lastPollTime = {};      // requestId -> timestamp
    this.retryCounts = {};       // errorPattern -> count
    this.nodeStartTimes = {};    // nodeName -> timestamp
    this.activeWarnings = [];    // current warnings
    this.dismissed = new Set();
  }

  /**
   * Process each incoming log for anomaly patterns.
   */
  processLog = (entry) => {
    const msg = entry.message || '';
    const ts = new Date(entry.timestamp).getTime();

    // 1. Slow polling detection (>30s between polls)
    const pollMatch = msg.match(/polling.*?RequestId\s+([a-f0-9-]+)/i) || msg.match(/checking status.*?([a-f0-9-]+)/i);
    if (pollMatch) {
      const reqId = pollMatch[1];
      if (this.lastPollTime[reqId]) {
        const gap = ts - this.lastPollTime[reqId];
        if (gap > 30000) {
          this.warn('slow-poll', `Slow polling detected: ${(gap/1000).toFixed(0)}s gap for request ${reqId.substring(0,8)}…`);
        }
      }
      this.lastPollTime[reqId] = ts;
    }

    // 2. Retry storm detection (same error 3+ times in 10s)
    if ((entry.level || '').toLowerCase() === 'error') {
      const errorKey = msg.substring(0, 80); // normalize
      if (!this.retryCounts[errorKey]) this.retryCounts[errorKey] = { count: 0, firstSeen: ts };
      this.retryCounts[errorKey].count++;
      const elapsed = ts - this.retryCounts[errorKey].firstSeen;
      if (this.retryCounts[errorKey].count >= 3 && elapsed < 10000) {
        this.warn('retry-storm', `Retry storm: same error repeated ${this.retryCounts[errorKey].count}× in ${(elapsed/1000).toFixed(0)}s`);
      }
    }

    // 3. Slow node detection (node running > 60s)
    const execNodeMatch = msg.match(/Executing node\s+['""]?(\w+)/i);
    if (execNodeMatch && !msg.includes('Executed')) {
      this.nodeStartTimes[execNodeMatch[1]] = ts;
    }
    const doneNodeMatch = msg.match(/Executed node\s+['""]?(\w+)/i);
    if (doneNodeMatch) {
      const nodeName = doneNodeMatch[1];
      if (this.nodeStartTimes[nodeName]) {
        const duration = ts - this.nodeStartTimes[nodeName];
        if (duration > 60000) {
          this.warn('slow-node', `Slow node: '${nodeName}' took ${(duration/1000).toFixed(0)}s (>60s threshold)`);
        }
        delete this.nodeStartTimes[nodeName];
      }
    }

    // 4. Check for still-running nodes that are taking too long
    for (const [nodeName, startTs] of Object.entries(this.nodeStartTimes)) {
      const running = ts - startTs;
      if (running > 120000) { // >2 min
        this.warn('timeout-risk', `Timeout risk: node '${nodeName}' running for ${(running/1000).toFixed(0)}s`);
      }
    }
  }

  warn = (type, message) => {
    const key = type + ':' + message.substring(0, 50);
    if (this.dismissed.has(key)) return;
    // Deduplicate
    if (this.activeWarnings.some(w => w.key === key)) return;
    this.activeWarnings.push({ key, type, message, timestamp: Date.now() });
    this.render();
  }

  render = () => {
    if (!this.warningElement || this.activeWarnings.length === 0) return;
    const latest = this.activeWarnings[this.activeWarnings.length - 1];
    this.warningElement.innerHTML = `
      <span class="anomaly-icon">⚠</span>
      <span class="anomaly-text">${latest.message}</span>
      ${this.activeWarnings.length > 1 ? '<span class="anomaly-count">+' + (this.activeWarnings.length - 1) + ' more</span>' : ''}
      <span class="anomaly-dismiss" onclick="this.closest('.anomaly-warning').classList.remove('active')">Dismiss</span>
    `;
    this.warningElement.classList.add('active');
  }

  dismissAll = () => {
    this.activeWarnings.forEach(w => this.dismissed.add(w.key));
    this.activeWarnings = [];
    if (this.warningElement) this.warningElement.classList.remove('active');
  }
}
