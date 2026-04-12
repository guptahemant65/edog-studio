/**
 * EDOG Real-Time Log Viewer — SignalR Manager (ADR-006)
 *
 * Drop-in replacement for WebSocketManager. Uses SignalR with MessagePack
 * protocol for real-time streaming from EdogPlaygroundHub.
 *
 * Protocol:
 *   - connection.on('LogEntry', entry)       → individual log entry
 *   - connection.on('TelemetryEvent', event) → individual telemetry event
 *   - hub.invoke('Subscribe', topic)         → join topic group
 *   - hub.invoke('Unsubscribe', topic)       → leave topic group
 */

// ===== SIGNALR MANAGER =====

class SignalRManager {
  constructor() {
    this.connection = null;
    this.status = 'disconnected';
    this.onStatusChange = null;

    // Individual entry callback: onMessage(type, data)
    this.onMessage = null;

    // Batch callback (for compatibility): onBatch(logs[], telemetry[])
    this.onBatch = null;

    // Summary callback (for compatibility): onSummary({ dropped, levels })
    this.onSummary = null;

    this._port = 5555;
    this._closing = false;
    this._subscribedTopics = new Set(['log']);
    this._reconnectTimer = null;
  }

  /** Set the SignalR target port (call when FLT starts on a different port). */
  setPort(port) {
    if (port && port !== this._port) {
      this._port = port;
      if (this.connection) {
        this.disconnect();
      }
      this.connect();
    }
  }

  connect = () => {
    this._closing = false;

    try {
      const hubUrl = 'http://localhost:' + this._port + '/hub/playground';

      const builder = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl)
        .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 30000]);

      // Use MessagePack if the protocol is available, otherwise fall back to JSON
      if (typeof signalR.protocols !== 'undefined' &&
          signalR.protocols.msgpack &&
          signalR.protocols.msgpack.MessagePackHubProtocol) {
        builder.withHubProtocol(new signalR.protocols.msgpack.MessagePackHubProtocol());
      }

      this.connection = builder.build();
      this.setStatus('connecting');

      // Wire up server-to-client handlers
      this.connection.on('LogEntry', (entry) => {
        if (this.onMessage) {
          this.onMessage('log', entry);
        }
      });

      this.connection.on('TelemetryEvent', (event) => {
        if (this.onMessage) {
          this.onMessage('telemetry', event);
        }
      });

      // Reconnection lifecycle
      this.connection.onreconnecting(() => {
        console.log('SignalR reconnecting...');
        this.setStatus('reconnecting');
      });

      this.connection.onreconnected(() => {
        console.log('SignalR reconnected');
        this.setStatus('connected');
        this._resubscribeAll();
      });

      this.connection.onclose(() => {
        console.log('SignalR connection closed');
        if (!this._closing) {
          this.setStatus('disconnected');
        }
      });

      // Start the connection
      this.connection.start()
        .then(() => {
          console.log('SignalR connected to ' + hubUrl);
          this.setStatus('connected');
          // Hub auto-subscribes to 'log' on connect. Re-subscribe any extras.
          for (const topic of this._subscribedTopics) {
            if (topic !== 'log') {
              this.connection.invoke('Subscribe', topic).catch(() => {});
            }
          }
        })
        .catch((err) => {
          console.error('SignalR connection failed:', err);
          this.setStatus('disconnected');
        });

    } catch (error) {
      console.error('Failed to create SignalR connection:', error);
      this.setStatus('disconnected');
    }
  }

  /** Subscribe to a topic group on the hub. */
  subscribe = (topic) => {
    if (!topic) return;
    const t = topic.toLowerCase();
    this._subscribedTopics.add(t);
    if (this.connection && this.connection.state === signalR.HubConnectionState.Connected) {
      this.connection.invoke('Subscribe', t).catch((err) => {
        console.error('Subscribe failed:', err);
      });
    }
  }

  /** Unsubscribe from a topic group on the hub. */
  unsubscribe = (topic) => {
    if (!topic) return;
    const t = topic.toLowerCase();
    this._subscribedTopics.delete(t);
    if (this.connection && this.connection.state === signalR.HubConnectionState.Connected) {
      this.connection.invoke('Unsubscribe', t).catch((err) => {
        console.error('Unsubscribe failed:', err);
      });
    }
  }

  /** Re-subscribe to all tracked topics after a reconnect. */
  _resubscribeAll = () => {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    for (const topic of this._subscribedTopics) {
      this.connection.invoke('Subscribe', topic).catch(() => {});
    }
  }

  setStatus = (status) => {
    this.status = status;
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  disconnect = () => {
    this._closing = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.connection) {
      this.connection.stop().catch(() => {});
      this.connection = null;
    }
    this.setStatus('disconnected');
  }
}
