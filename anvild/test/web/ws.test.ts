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
// heartbeat runs on setInterval — captured separately so a test can fire "the next ping" on demand.
let intervals: Array<{ id: number; fn: () => void; delay: number }> = [];
let nextId = 1;
const lastDelay = () => timers.at(-1)?.delay;
const fireTimers = () => {
  const due = timers;
  timers = [];
  for (const t of due) t.fn();
};
const fireIntervals = () => {
  for (const t of intervals) t.fn(); // intervals persist — mimic one tick each
};

let AnvilSocket: typeof import("../../web/src/ws").AnvilSocket;
let origClearTimeout: unknown;
let origClearInterval: unknown;
let origWebSocket: unknown;

beforeAll(async () => {
  installDom();
  // Save the real globals we stub per-test so the rest of the suite (which shares globalThis in this
  // process) isn't left with a fake clearTimeout/WebSocket — that leaks real timers and breaks others.
  origClearTimeout = globalThis.clearTimeout;
  origClearInterval = globalThis.clearInterval;
  origWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  AnvilSocket = (await import("../../web/src/ws")).AnvilSocket;
});
afterAll(() => {
  (globalThis as Record<string, unknown>).clearTimeout = origClearTimeout;
  (globalThis as Record<string, unknown>).clearInterval = origClearInterval;
  (globalThis as Record<string, unknown>).WebSocket = origWebSocket;
  uninstallDom();
});

beforeEach(() => {
  FakeWS.instances = [];
  FakeWS.throwOnce = false;
  timers = [];
  intervals = [];
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
  (globalThis as any).window.setInterval = (fn: () => void, delay: number) => {
    const id = nextId++;
    intervals.push({ id, fn, delay });
    return id;
  };
  (globalThis as any).clearInterval = (id: number) => {
    intervals = intervals.filter((t) => t.id !== id);
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

test("heartbeat: an open socket pings on the interval and swallows the pong", () => {
  const { sock, events } = mk();
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  fireIntervals(); // one heartbeat tick
  const framed = JSON.parse(ws.sent.at(-1)!);
  expect(framed.type).toBe("ping");
  ws.message(JSON.stringify({ type: "pong" })); // reply must not surface as an app event
  expect(events).toEqual([]);
});

test("heartbeat: an unanswered ping force-reconnects the half-open socket", () => {
  const { sock, status } = mk();
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  // Socket goes half-open: readyState stays OPEN but nothing ever comes back. The ping arms the pong
  // deadline; firing it with no intervening frame must tear the socket down and reconnect.
  fireIntervals(); // ping → arms the pong deadline (a setTimeout)
  expect(FakeWS.instances.length).toBe(1);
  fireTimers(); // the pong deadline elapses
  expect(status).toEqual(["connecting", "connected", "disconnected", "connecting"]);
  expect(FakeWS.instances.length).toBe(2); // reconnected immediately, not after a backoff wait
});

test("heartbeat: any inbound frame disarms the pong deadline (a busy socket never trips)", () => {
  const { sock, status } = mk();
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  fireIntervals(); // ping → arms the deadline
  ws.message(JSON.stringify({ type: "budget" })); // unrelated traffic proves liveness
  fireTimers(); // deadline was cleared — firing does nothing
  expect(status).toEqual(["connecting", "connected"]);
  expect(FakeWS.instances.length).toBe(1);
});

test("connectNow on an apparently-open socket sends a liveness ping instead of no-op'ing", () => {
  const { sock } = mk();
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  sock.connectNow(); // e.g. tab refocus / network returned — verify the socket isn't half-open
  expect(JSON.parse(ws.sent.at(-1)!).type).toBe("ping");
});

test("close() stops the heartbeat (no ping after close)", () => {
  const { sock } = mk();
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  sock.close();
  ws.sent = [];
  fireIntervals(); // the interval was cleared — nothing should fire
  expect(ws.sent).toEqual([]);
});

test("[WEB2-10] a throwing onEvent handler is caught and does not freeze the socket", () => {
  // The 3.0.33 incident class: a handler throw (e.g. a quota-full localStorage.setItem deep in event
  // handling) escaping onmessage would kill the callback and freeze all further WS processing. The
  // socket must swallow it, stay OPEN, and keep delivering subsequent frames.
  const status: string[] = [];
  let calls = 0;
  const sock = new AnvilSocket(
    "wss://host/ws",
    () => {
      calls++;
      throw new Error("handler blew up");
    },
    (s) => status.push(s),
  );
  sock.connect();
  const ws = FakeWS.instances[0]!;
  ws.open();
  expect(() => ws.message(JSON.stringify({ type: "assistant.delta" }))).not.toThrow();
  expect(() => ws.message(JSON.stringify({ type: "assistant.message" }))).not.toThrow();
  expect(calls).toBe(2); // both frames reached the handler despite the first throwing
  expect(sock.isOpen()).toBe(true); // socket never torn down
});

test("[WEB2-12] close() removes the window/document reconnect listeners", () => {
  const win = (globalThis as any).window;
  const doc = (globalThis as any).document;
  let winAdds = 0,
    winRemoves = 0,
    docAdds = 0,
    docRemoves = 0;
  const origWinAdd = win.addEventListener.bind(win);
  const origWinRemove = win.removeEventListener.bind(win);
  const origDocAdd = doc.addEventListener.bind(doc);
  const origDocRemove = doc.removeEventListener.bind(doc);
  win.addEventListener = (t: string, h: any, o: any) => {
    if (t === "online") winAdds++;
    return origWinAdd(t, h, o);
  };
  win.removeEventListener = (t: string, h: any, o: any) => {
    if (t === "online") winRemoves++;
    return origWinRemove(t, h, o);
  };
  doc.addEventListener = (t: string, h: any, o: any) => {
    if (t === "visibilitychange") docAdds++;
    return origDocAdd(t, h, o);
  };
  doc.removeEventListener = (t: string, h: any, o: any) => {
    if (t === "visibilitychange") docRemoves++;
    return origDocRemove(t, h, o);
  };
  try {
    const sock = new AnvilSocket("wss://host/ws", () => {}, () => {});
    expect(winAdds).toBe(1);
    expect(docAdds).toBe(1);
    sock.close();
    expect(winRemoves).toBe(1); // the online listener was removed (was leaked before WEB2-12)
    expect(docRemoves).toBe(1); // the visibilitychange listener was removed
    // NB: we assert the add/remove *counts* rather than dispatching `online`, because earlier tests in
    // this shared-process file create sockets they never close — those leaked listeners (the exact bug)
    // would fire on a dispatched event and confound an isolated check. The count is the precise guard.
  } finally {
    win.addEventListener = origWinAdd;
    win.removeEventListener = origWinRemove;
    doc.addEventListener = origDocAdd;
    doc.removeEventListener = origDocRemove;
  }
});
