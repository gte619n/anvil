import { PROTOCOL_VERSION, type ServerEvent } from "../../protocol";

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: "connecting" | "connected" | "disconnected") => void;

/** Auto-reconnecting WebSocket client for the Anvil protocol (arch §6). */
export class AnvilSocket {
  private ws: WebSocket | undefined;
  private backoff = 500;
  private reconnectTimer = 0;
  private closed = false; // set by close() — stops auto-reconnect (server removed from the fleet)

  constructor(
    private readonly url: string,
    private readonly onEvent: EventHandler,
    private readonly onStatus: StatusHandler,
  ) {
    // Reconnect promptly when the device/network comes back, instead of waiting out the backoff.
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.connectNow());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.connectNow();
      });
    }
  }

  connect(): void {
    if (this.closed) return; // removed from the fleet — never reconnect
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.onStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.onStatus("connected");
    };
    ws.onmessage = (ev) => {
      try {
        this.onEvent(JSON.parse(String(ev.data)) as ServerEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      this.onStatus("disconnected");
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  /** Force an immediate reconnect attempt (e.g. user tapped Retry, or the network returned). */
  connectNow(): void {
    if (this.isOpen()) return;
    clearTimeout(this.reconnectTimer);
    this.backoff = 500;
    this.connect();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Permanently close this socket and stop reconnecting (the server was removed from the fleet). */
  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }

  /** Send a client command; the envelope (v, ts) is stamped here. Returns false if not connected. */
  send(cmd: Record<string, unknown> & { type: string }): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: new Date().toISOString(), ...cmd }));
    return true;
  }
}
