/**
 * EDOG Real-Time Log Viewer - WebSocket Manager
 *
 * Supports batched streaming protocol:
 *   - "batch"   → { type: "batch", logs: [...], telemetry: [...] }
 *   - "summary" → { type: "summary", dropped, levels }
 *   - "log"     → legacy single-log (backward compat)
 *   - "telemetry" → legacy single-telemetry (backward compat)
 */

// ===== WEBSOCKET MANAGER =====

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;
    this.status = 'disconnected';
    this.onStatusChange = null;

    // Legacy single-entry callback
    this.onMessage = null;

    // Batch callback: onBatch(logs[], telemetry[])
    this.onBatch = null;

    // Backpressure summary callback: onSummary({ dropped, droppedLogs, droppedTelemetry, levels })
    this.onSummary = null;

    this.url = 'ws://localhost:5555/ws/logs';
    this._port = 5555;
  }

  /** Set the WebSocket target port (call when FLT starts on a different port). */
  setPort(port) {
    if (port && port !== this._port) {
      this._port = port;
      this.url = 'ws://localhost:' + port + '/ws/logs';
      // Reconnect if currently connected to old port
      if (this.ws && this.ws.readyState <= 1) {
        this.ws.close();
      }
      this.connect();
    }
  }

  connect = () => {
    try {
      this.ws = new WebSocket(this.url);
      this.setStatus('connecting');

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.setStatus('connected');
        this.reconnectDelay = 1000;
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          switch (message.type) {
            case 'batch':
              this._handleBatch(message);
              break;

            case 'summary':
              this._handleSummary(message);
              break;

            case 'log':
            case 'telemetry':
              if (this.onMessage) {
                this.onMessage(message.type, message.data);
              }
              break;

            default:
              console.warn('Unknown WS message type:', message.type);
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.setStatus('disconnected');
      };

    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  _handleBatch = (message) => {
    const logs = message.logs || [];
    const telemetry = message.telemetry || [];

    if (this.onBatch) {
      this.onBatch(logs, telemetry);
      return;
    }

    // Fallback: feed entries one-by-one through legacy callback
    if (this.onMessage) {
      for (const log of logs) {
        this.onMessage('log', log);
      }
      for (const evt of telemetry) {
        this.onMessage('telemetry', evt);
      }
    }
  }

  _handleSummary = (message) => {
    if (this.onSummary) {
      this.onSummary(message);
      return;
    }

    console.warn(
      '[backpressure] Server dropped ' + message.dropped + ' entries. ' +
      'Levels: ' + JSON.stringify(message.levels)
    );
  }

  scheduleReconnect = () => {
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);

    console.log('Reconnecting in ' + delay + 'ms (attempt ' + this.reconnectAttempts + ')');
    this.setStatus('reconnecting');

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  setStatus = (status) => {
    this.status = status;
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  disconnect = () => {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
