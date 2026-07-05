/**
 * [Phase 4] AnvilSocket reconnection/backoff — the auto-reconnecting protocol socket. jsdom has no
 * WebSocket and we don't want real timers, so we stub both: a controllable FakeWS and a captured
 * window.setTimeout. Pins the behavior the audit praised (capped exponential backoff, reset on open,
 * construction-throw survival, no reconnect after close) — previously untested.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

class FakeWS {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWS[] = [];
  static throwOnce = false;
  readyState = FakeWS.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    if (FakeWS.throwOnce) {
      FakeWS.throwOnce = false;
      throw new Error("SecurityError: mixed content");
    }
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }
  // test helpers
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  drop() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  message(data: string) {
    this.onmessage?.({ data });
  }
}

// captured timers so backoff is deterministic
let timers: Array<{ id: number; fn: () => void; delay: number }> = [];
let nextId = 1;
const lastDelay = () => timers.at(-1)?.delay;
const fireTimers = () => {
  const due = timers;
  timers = [];
  for (const t of due) t.fn();
};

let AnvilSocket: typeof import("../../web/src/ws").AnvilSocket;
let origClearTimeout: unknown;
let origWebSocket: unknown;

beforeAll(async () => {
  installDom();
  // Save the real globals we stub per-test so the rest of the suite (which shares globalThis in this
  // process) isn't left with a fake clearTimeout/WebSocket — that leaks real timers and breaks others.
  origClearTimeout = globalThis.clearTimeout;
  origWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  AnvilSocket = (await import("../../web/src/ws")).AnvilSocket;
});
afterAll(() => {
  (globalThis as Record<string, unknown>).clearTimeout = origClearTimeout;
  (globalThis as Record<string, unknown>).WebSocket = origWebSocket;
  uninstallDom();
});

beforeEach(() => {
  FakeWS.instances = [];
  FakeWS.throwOnce = false;
  timers = [];
  nextId = 1;
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS as unknown;
  (globalThis as any).window.setTimeout = (fn: () => void, delay: number) => {
    const id = nextId++;
    timers.push({ id, fn, delay });
    return id;
  };
  (globalThis as any).clearTimeout = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };
});

function mk() {
  const status: string[] = [];
  const events: unknown[] = [];
  const sock = new AnvilSocket("wss://host/ws", (e) => events.push(e), (s) => status.push(s));
  return { sock, status, events };
}

test("connect → connecting, then open → connected + isOpen", () => {
  const { sock, status } = mk();
  sock.connect();
  expect(status).toEqual(["connecting"]);
  expect(FakeWS.instances.length).toBe(1);
  FakeWS.instances[0]!.open();
  expect(status).toEqual(["connecting", "connected"]);
  expect(sock.isOpen()).toBe(true);
});

test("send only works when open, and stamps the envelope", () => {
  const { sock } = mk();
  sock.connect();
  expect(sock.send({ type: "session.list" })).toBe(false); // not open yet
  FakeWS.instances[0]!.open();
  expect(sock.send({ type: "session.list" })).toBe(true);
  const framed = JSON.parse(FakeWS.instances[0]!.sent[0]!);
  expect(framed.type).toBe("session.list");
  expect(framed.v).toBeDefined();
  expect(framed.ts).toBeDefined();
});

test("backoff doubles on repeated drops and resets to 500 on open", () => {
  const { sock } = mk();
  sock.connect();
  FakeWS.instances[0]!.drop();
  expect(lastDelay()).toBe(500); // first retry
  fireTimers(); // reconnect → instance[1]
  FakeWS.instances[1]!.drop();
  expect(lastDelay()).toBe(1000); // doubled
  fireTimers(); // reconnect → instance[2]
  FakeWS.instances[2]!.open(); // success resets backoff
  FakeWS.instances[2]!.drop();
  expect(lastDelay()).toBe(500); // back to the floor
});

test("close() stops auto-reconnect", () => {
  const { sock } = mk();
  sock.connect();
  FakeWS.instances[0]!.open();
  sock.close();
  const countBefore = FakeWS.instances.length;
  FakeWS.instances[0]!.drop(); // a drop after close must not schedule a reconnect
  fireTimers();
  expect(FakeWS.instances.length).toBe(countBefore);
});

test("a synchronous WebSocket construction failure is treated as a dropped connection", () => {
  const { sock, status } = mk();
  FakeWS.throwOnce = true; // next `new WebSocket` throws (e.g. mixed-content SecurityError)
  sock.connect();
  expect(status).toEqual(["connecting", "disconnected"]); // did not throw out of connect()
  expect(lastDelay()).toBe(500); // scheduled a retry
  fireTimers();
  expect(FakeWS.instances.length).toBe(1); // the retry constructed a real socket
});

test("incoming frames are JSON-parsed to onEvent; malformed frames are ignored", () => {
  const { sock, events } = mk();
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  ws.message(JSON.stringify({ type: "budget" }));
  ws.message("{not json");
  expect(events).toEqual([{ type: "budget" }]);
});
