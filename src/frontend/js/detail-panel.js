/**
 * EDOG Real-Time Log Viewer - Detail Panel
 */

// ===== DETAIL PANEL =====

class DetailPanel {
  constructor() {
    this.isVisible = false;
  }
  
  show = (entry, type) => {
    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    
    // Populate content based on type
    if (type === 'log') {
      this.showLogDetail(panel, entry);
    } else if (type === 'telemetry') {
      this.showTelemetryDetail(panel, entry);
    }
    
    // Show panel with animation
    panel.classList.add('visible');
    this.isVisible = true;
    
    // Focus close button for accessibility
    const closeBtn = panel.querySelector('#detail-close');
    if (closeBtn) closeBtn.focus();
  }
  
  showLogDetail = (panel, entry) => {
    const title = panel.querySelector('#detail-title');
    const content = panel.querySelector('.detail-content');
    
    if (title) title.textContent = 'Log Entry';
    
    if (content) {
      const customDataJson = JSON.stringify(entry.customData || {}, null, 2);
      const customDataKeys = Object.keys(entry.customData || {});
      const levelLower = (entry.level || '').toLowerCase();
      
      content.innerHTML = `
        <div class="detail-section">
          <h4>Properties</h4>
          <div class="detail-grid">
            <div class="detail-field">
              <label>Time</label>
              <span>${entry.timestamp || 'N/A'}</span>
            </div>
            <div class="detail-field">
              <label>Level</label>
              <span class="level-badge ${levelLower}">${entry.level || 'N/A'}</span>
            </div>
            <div class="detail-field">
              <label>Component</label>
              <span>${this.escapeHtml(entry.component || 'N/A')}</span>
            </div>
            <div class="detail-field">
              <label>Event ID</label>
              <span>${this.escapeHtml(entry.eventId || 'N/A')}</span>
            </div>
          </div>
        </div>
        
        <div class="detail-section">
          <h4>Message <button class="copy-btn" data-copy="message" title="Copy">copy</button></h4>
          <div class="detail-message">${this.escapeHtml(entry.message || 'No message')}</div>
        </div>
        
        <div class="detail-section">
          <h4>Correlation</h4>
          <div class="detail-field" style="flex-direction:row;align-items:center;gap:8px;">
            <label style="min-width:auto">RAID</label>
            <span class="clickable-id" data-id="${this.escapeHtml(entry.rootActivityId || '')}">${this.escapeHtml(entry.rootActivityId || 'N/A')}</span>
            ${entry.rootActivityId ? `<button class="copy-btn" data-copy="activityId">copy</button>` : ''}
            <div class="cross-link" data-action="filterSSR">→ Find in SSR</div>
          </div>
        </div>
        
        ${customDataKeys.length > 0 ? `
        <div class="detail-section">
          <h4>Custom Data (${customDataKeys.length}) <button class="copy-btn" data-copy="customData">copy</button></h4>
          <pre class="json-container">${syntaxHighlightJson(customDataJson)}</pre>
        </div>` : ''}
      `;

      // Bind copy buttons safely via addEventListener (no inline onclick)
      const copyData = {
        message: entry.message || 'No message',
        activityId: entry.rootActivityId || '',
        customData: customDataJson
      };
      content.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
        btn.addEventListener('click', () => {
          copyToClipboard(btn, copyData[btn.dataset.copy]);
        });
      });
      content.querySelector('[data-action="filterSSR"]')?.addEventListener('click', () => {
        filterSSRByCorrelation(entry.rootActivityId || '');
      });
      
      // Add click handlers for correlation IDs
      content.querySelectorAll('.clickable-id').forEach(el => {
        el.addEventListener('click', (e) => {
          const id = e.target.dataset.id;
          if (id && window.edogViewer && window.edogViewer.filter) {
            window.edogViewer.filter.setCorrelationFilter(id);
            this.hide();
          }
        });
      });
    }
  }
  
  showTelemetryDetail = (panel, event) => {
    const title = panel.querySelector('#detail-title');
    const content = panel.querySelector('.detail-content');
    
    if (title) title.textContent = 'Telemetry Event';
    
    if (content) {
      const status = event.activityStatus || 'Unknown';
      const statusClass = status.toLowerCase();
      const icon = this.getStatusIcon(status);
      const attributesJson = JSON.stringify(event.attributes || {}, null, 2);
      const attrCount = Object.keys(event.attributes || {}).length;
      
      content.innerHTML = `
        <div class="detail-section">
          <h4>Activity</h4>
          <div class="detail-grid">
            <div class="detail-field">
              <label>Name</label>
              <span>${this.escapeHtml(event.activityName || 'N/A')}</span>
            </div>
            <div class="detail-field">
              <label>Status</label>
              <span class="status-badge ${statusClass}">${icon} ${status}</span>
            </div>
            <div class="detail-field">
              <label>Duration</label>
              <span>${this.formatDuration(event.durationMs)}</span>
            </div>
            <div class="detail-field">
              <label>Result</label>
              <span>${this.escapeHtml(event.resultCode || 'OK')}</span>
            </div>
          </div>
        </div>
        
        <div class="detail-section">
          <h4>Correlation</h4>
          <div class="detail-grid" style="grid-template-columns: 1fr 1fr;">
            <div class="detail-field" style="flex-direction:row;align-items:center;gap:8px;">
              <label style="min-width:auto">ID</label>
              <span class="clickable-id" data-id="${this.escapeHtml(event.correlationId || '')}">${this.escapeHtml(event.correlationId || 'N/A')}</span>
              ${event.correlationId ? `<button class="copy-btn" data-copy="correlation">copy</button>` : ''}
            </div>
            <div class="detail-field" style="flex-direction:row;align-items:center;gap:8px;">
              <label style="min-width:auto">Time</label>
              <span>${event.timestamp || 'N/A'}</span>
            </div>
          </div>
          <div class="cross-link" data-action="filter-correlation">→ Show related logs</div>
        </div>
        
        ${attrCount > 0 ? `
        <div class="detail-section">
          <h4>Attributes (${attrCount}) <button class="copy-btn" data-copy="attributes">copy</button></h4>
          <pre class="json-container">${syntaxHighlightJson(attributesJson)}</pre>
        </div>` : ''}
      `;

      // Bind copy buttons safely via addEventListener
      content.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const copyType = btn.dataset.copy;
          if (copyType === 'correlation') {
            const text = event.correlationId || '';
            navigator.clipboard.writeText(text).then(() => {
              btn.textContent = '✓';
              setTimeout(() => { btn.textContent = '📋'; }, 1500);
            });
          } else if (copyType === 'attributes') {
            navigator.clipboard.writeText(attributesJson).then(() => {
              btn.textContent = '✓';
              setTimeout(() => { btn.textContent = '📋'; }, 1500);
            });
          }
        });
      });

      // Bind cross-link for filtering
      const crossLink = content.querySelector('[data-action="filter-correlation"]');
      if (crossLink) {
        crossLink.addEventListener('click', () => {
          const rootId = (event.correlationId || '').split('|')[0];
          if (rootId && window.edogViewer && window.edogViewer.filter) {
            window.edogViewer.filter.setCorrelationFilter(rootId);
          }
        });
      }
      
      // Add click handlers for correlation IDs
      content.querySelectorAll('.clickable-id').forEach(el => {
        el.addEventListener('click', (e) => {
          const id = e.target.dataset.id;
          if (id && window.edogViewer && window.edogViewer.filter) {
            // For telemetry, correlation ID might be in format "guid|guid" - use first part
            const rootId = id.split('|')[0];
            window.edogViewer.filter.setCorrelationFilter(rootId);
            this.hide();
          }
        });
      });
    }
  }
  
  hide = () => {
    const panel = document.getElementById('detail-panel');
    if (panel) {
      panel.classList.remove('visible');
    }
    this.isVisible = false;
  }
  
  escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  formatDuration = (ms) => {
    if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.round((ms % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }
  
  getStatusIcon = (status) => {
    const mapping = {
      'succeeded': '✓',
      'failed': '✗',
      'cancelled': '◌',
      'pending': '⋯'
    };
    return mapping[status.toLowerCase()] || '?';
  }
}
