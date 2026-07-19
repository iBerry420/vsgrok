import WebSocket from 'ws';
import { EventEmitter } from 'events';

export type BridgeEvent = {
  type: string;
  [key: string]: unknown;
};

export type HistoryMessage = { role: string; content: string };

export type PromptPayload = {
  prompt: string;
  session_id: string;
  model?: string;
  history?: HistoryMessage[];
  notes?: string[];
  /** Resume an existing Grok Build session (--resume). */
  resume?: boolean;
};

/**
 * WebSocket client for the VSGrok / GrokifyOS bridge protocol.
 */
export class BridgeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private token = '';
  private baseUrl = '';
  private _connected = false;
  private streamingSessionId: string | null = null;

  get connected(): boolean {
    return this._connected;
  }

  connect(wsBaseUrl: string, token: string): void {
    this.token = token;
    this.baseUrl = wsBaseUrl.replace(/\/?$/, '/');
    this.intentionalClose = true;
    this.clearReconnect();
    if (this.ws) {
      try {
        this.ws.close(1000, 'reconnect');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.intentionalClose = false;

    const url = `${this.baseUrl}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this._connected = true;
      this.emit('state', true, null);
      if (this.streamingSessionId) {
        this.sendRaw({ type: 'reconnect', session_id: this.streamingSessionId });
      }
    });

    ws.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const evt = JSON.parse(text) as BridgeEvent;
        this.emit('event', evt);
      } catch {
        /* ignore malformed */
      }
    });

    ws.on('close', () => {
      this._connected = false;
      this.ws = null;
      if (!this.intentionalClose) {
        this.emit('state', false, 'closed');
        this.scheduleReconnect();
      } else {
        this.emit('state', false, null);
      }
    });

    ws.on('error', (err) => {
      if (this.intentionalClose) return;
      this.emit('state', false, err.message || 'error');
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.streamingSessionId = null;
    if (this.ws) {
      try {
        this.ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this._connected = false;
    this.emit('state', false, null);
  }

  setStreamingSession(sessionId: string | null): void {
    this.streamingSessionId = sessionId;
  }

  sendPrompt(payload: PromptPayload): boolean {
    return this.sendRaw(payload);
  }

  reconnect(sessionId: string): boolean {
    return this.sendRaw({ type: 'reconnect', session_id: sessionId });
  }

  /** Ask bridge to kill the running agent for this session. */
  stop(sessionId: string): boolean {
    return this.sendRaw({ type: 'stop', session_id: sessionId });
  }

  updateToken(token: string): void {
    this.token = token;
  }

  private sendRaw(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    if (!this.baseUrl || !this.token) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalClose) {
        this.connect(this.baseUrl, this.token);
      }
    }, 2000);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
