import { PROTOCOL_VERSION, type ServerEvent } from "../../protocol";

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: "connecting" | "connected" | "disconnected") => void;

/** Auto-reconnecting WebSocket client for the Anvil protocol (arch §6). */
export class AnvilSocket {
  private ws: WebSocket | undefined;
  private backoff = 500;
  private reconnectTimer = 0;
  private closed = false; // set by close() — stops auto-reconnect (server removed from the fleet)
  private heartbeatTimer = 0; // periodic ping while open (§6.4 liveness)
  private pongDeadline = 0; // armed after a ping; any inbound frame clears it, else we force-reconnect

  // Heartbeat cadence + how long we wait for any reply before declaring the socket half-open. Tuned
  // to notice a silently-dropped transport (e.g. a Tailscale tunnel bounce) within ~HEARTBEAT+GRACE
  // rather than never — the browser leaves readyState === OPEN on a half-open socket, so without this
  // an outbox write hangs on "Syncing…" until a real network transition finally fires `onclose`.
  private static readonly HEARTBEAT_MS = 15000;
  private static readonly PONG_GRACE_MS = 10000;

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
    // `new WebSocket()` can throw SYNCHRONOUSLY — e.g. a ws:// URL on an https page (mixed content)
    // raises SecurityError. This runs from top-level module init (one socket per fleet server), so an
    // uncaught throw here aborts the rest of main.ts and leaves the whole app dead (see memory:
    // web-early-init-decl-order-crash). Treat a construction failure exactly like a dropped
    // connection: mark disconnected and retry on the backoff — never let one bad server kill the app.
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.onStatus("disconnected");
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.startHeartbeat();
      this.onStatus("connected");
    };
    ws.onmessage = (ev) => {
      // Any inbound frame proves the transport is alive — clear the pending pong deadline before
      // parsing so even an unrelated event (not just our `pong`) counts as a heartbeat.
      clearTimeout(this.pongDeadline);
      let event: ServerEvent;
      try {
        event = JSON.parse(String(ev.data)) as ServerEvent;
      } catch {
        return; // ignore malformed frame
      }
      if ((event as { type?: string }).type === "pong") return; // heartbeat ack — not an app event
      this.onEvent(event);
    };
    ws.onclose = () => {
      this.stopHeartbeat();
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
    // A socket that *claims* to be open may be half-open — the very case that returning to the
    // foreground / regaining the network is a hint for. Don't trust readyState: send a ping and let
    // the pong deadline force a reconnect if the transport is actually dead, instead of no-op'ing.
    if (this.isOpen()) {
      this.ping();
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.backoff = 500;
    this.connect();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Start the heartbeat loop; a fresh interval pings on cadence until the socket closes. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.ping(), AnvilSocket.HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.pongDeadline);
    this.heartbeatTimer = 0;
    this.pongDeadline = 0;
  }

  /** Send a heartbeat ping and arm the deadline; any inbound frame (onmessage) disarms it. */
  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: new Date().toISOString(), type: "ping" }));
    } catch {
      this.forceReconnect(); // send threw on a dying socket — reconnect now
      return;
    }
    clearTimeout(this.pongDeadline);
    this.pongDeadline = window.setTimeout(() => this.forceReconnect(), AnvilSocket.PONG_GRACE_MS);
  }

  /**
   * Tear down a half-open socket and reconnect immediately. Calling `close()` on a dead socket may
   * not fire `onclose` promptly (the browser waits out the closing handshake), so we detach handlers
   * and drop the reference ourselves, then reconnect — this is what surfaces "disconnected" and lets
   * the app drain its outbox instead of trusting a socket that's stuck OPEN.
   */
  private forceReconnect(): void {
    if (this.closed) return;
    const dead = this.ws;
    this.stopHeartbeat();
    this.ws = undefined;
    if (dead) {
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      try {
        dead.close();
      } catch {
        /* already closing */
      }
    }
    this.onStatus("disconnected");
    clearTimeout(this.reconnectTimer);
    this.backoff = 500;
    this.connect();
  }

  /** Permanently close this socket and stop reconnecting (the server was removed from the fleet). */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
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
