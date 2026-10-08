import { wsUrl } from './config';

type Handler = (data: any) => void;

/** One reconnecting WebSocket for realtime events and call signaling. */
class Socket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private retry = 0;
  private retryTimer: number | undefined;
  private handlers = new Map<string, Set<Handler>>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private binaryHandler: ((data: ArrayBuffer) => void) | null = null;
  private heartbeat: number | undefined;
  private lastSeen = 0;
  connected = false;

  constructor() {
    const wake = () => {
      if (this.token && !this.ws) this.open();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
  }

  connect(token: string) {
    this.token = token;
    this.retry = 0;
    this.open();
  }

  disconnect() {
    this.token = null;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
  }

  send(type: string, data?: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type, data }));
    return true;
  }

  /** Binary frames carry relayed call media. */
  sendBinary(data: ArrayBuffer | Uint8Array<ArrayBuffer>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    // Don't pile up media behind a slow uplink; dropping a chunk is cheaper.
    if (this.ws.bufferedAmount > 2_000_000) return false;
    this.ws.send(data);
    return true;
  }

  onBinary(handler: ((data: ArrayBuffer) => void) | null) {
    this.binaryHandler = handler;
  }

  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  onStatus(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private open() {
    if (!this.token) return;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    const ws = new WebSocket(wsUrl(this.token));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastSeen = Date.now();
      this.setConnected(true);
      // Mobile networks can kill a connection without closing it; ping and
      // reconnect if nothing comes back, instead of waiting minutes.
      clearInterval(this.heartbeat);
      this.heartbeat = window.setInterval(() => {
        if (this.ws !== ws) return clearInterval(this.heartbeat);
        if (Date.now() - this.lastSeen > 30_000) {
          ws.onclose?.(new CloseEvent('close'));
          ws.close();
          return;
        }
        this.send('ping');
      }, 10_000);
    };
    ws.onmessage = (e) => {
      this.lastSeen = Date.now();
      if (e.data instanceof ArrayBuffer) {
        this.binaryHandler?.(e.data);
        return;
      }
      let msg: { type: string; data: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handlers.get(msg.type)?.forEach((h) => {
        try {
          h(msg.data);
        } catch (err) {
          console.error(`socket handler ${msg.type}`, err);
        }
      });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.heartbeat);
      this.ws = null;
      this.setConnected(false);
      if (!this.token) return;
      const delay = Math.min(1000 * 2 ** this.retry, 15000);
      this.retry++;
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    this.statusHandlers.forEach((h) => h(v));
  }
}

export const socket = new Socket();
