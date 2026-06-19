import { PROTOCOL_VERSION, type ServerEvent } from "../../protocol";

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: "connecting" | "connected" | "disconnected") => void;

/** Auto-reconnecting WebSocket client for the Anvil protocol (arch §6). */
export class AnvilSocket {
  private ws: WebSocket | undefined;
  private backoff = 500;

  constructor(
    private readonly url: string,
    private readonly onEvent: EventHandler,
    private readonly onStatus: StatusHandler,
  ) {}

  connect(): void {
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
      setTimeout(() => this.connect(), this.backoff);
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

  /** Send a client command; the envelope (v, ts) is stamped here. */
  send(cmd: Record<string, unknown> & { type: string }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: new Date().toISOString(), ...cmd }));
  }
}
