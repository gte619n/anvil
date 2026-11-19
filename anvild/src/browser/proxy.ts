/**
 * The agent browser's only route out: a loopback forward proxy run by the daemon
 * (agent-cad-and-browser §4.12 "Network block", §4.14 item 23).
 *
 * It is a BLOCK list, not an allow list, so page subresources never prompt. For every request —
 * plain HTTP and CONNECT (which is also how Chrome sends WebSockets through an HTTP proxy) — it:
 *
 *   1. resolves the hostname ITSELF (Chrome sends names unresolved);
 *   2. checks EVERY resolved address, and the name, against the block list;
 *   3. connects to the address it checked. There is no second resolution, so a name that answers
 *      with a public address first and a private one next (DNS rebinding) gains nothing.
 *
 * A refusal is `HTTP/1.1 403` with a short body, and the target is never contacted.
 *
 * Which session a connection belongs to: there is ONE LISTENER PER BROWSER SESSION. The preset
 * creates it when it resolves that session's launch line (`BrowserProxyManager.ensure`) and puts its
 * port in `--proxy-server`, so every connection arriving on a listener belongs to that session.
 * `allowLoopbackPort(sessionId, port)` therefore opens one loopback port for one session only (Phase
 * C4's throwaway test daemon). A listener lives until its session is reset, deleted or archived, or
 * the service stops; it is reused across driver rebuilds so a rebuild never races a teardown.
 *
 * Fail closed: the launch line always names a proxy port. If the listener is gone, Chrome has no
 * route at all; and the preset refuses to build a launch line when a listener cannot be created.
 */
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { hostname as osHostname, networkInterfaces } from "node:os";

// ── Address classification ──────────────────────────────────────────────────────────────────────

/** Parse an IPv4 dotted quad into 4 bytes. */
function v4Bytes(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => n >= 0 && n <= 255) ? out : undefined;
}

/** Parse an IPv6 address (zone id dropped, `::` expanded, dotted tail accepted) into 16 bytes. */
function v6Bytes(input: string): number[] | undefined {
  let ip = input.split("%")[0]!;
  if (isIP(ip) !== 6) return undefined;
  const tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  if (ip.slice(lastColon + 1).includes(".")) {
    const v4 = v4Bytes(ip.slice(lastColon + 1));
    if (!v4) return undefined;
    tail.push(...v4);
    ip = `${ip.slice(0, lastColon + 1)}0:0`; // placeholder groups, overwritten below
  }
  const [head, rest] = ip.split("::") as [string, string | undefined];
  const groups = (s: string): number[] => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const a = groups(head);
  const b = rest === undefined ? [] : groups(rest);
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0) return undefined;
  const all = [...a, ...new Array<number>(fill).fill(0), ...b];
  if (all.length !== 8 || all.some((g) => !(g >= 0 && g <= 0xffff))) return undefined;
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function v4BlockReason(b: readonly number[]): string | undefined {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 0) return "the unspecified address (0.0.0.0/8)";
  if (a === 127) return "a loopback address";
  if (a === 10) return "a private address (10.0.0.0/8)";
  if (a === 172 && c >= 16 && c <= 31) return "a private address (172.16.0.0/12)";
  if (a === 192 && c === 168) return "a private address (192.168.0.0/16)";
  if (a === 169 && c === 254) return "a link-local address";
  if (a === 100 && c >= 64 && c <= 127) return "a tailnet / carrier-NAT address (100.64.0.0/10)";
  if (a >= 224) return "a multicast or reserved address";
  return undefined;
}

/**
 * Why the browser may not connect to `ip`, or undefined when it may. Covers loopback (127/8, ::1),
 * RFC 1918, link-local (169.254/16, fe80::/10), carrier NAT / tailnet 100.64/10, unique-local
 * fc00::/7 (which contains Tailscale's fd7a:115c:a1e0::/48), the unspecified addresses, multicast,
 * and any IPv6 form that embeds one of those IPv4 addresses (v4-mapped, v4-compatible, NAT64). An
 * address that cannot be parsed is blocked.
 */
export function blockedAddressReason(ip: string): string | undefined {
  const v4 = isIP(ip) === 4 ? v4Bytes(ip) : undefined;
  if (v4) return v4BlockReason(v4);
  const b = v6Bytes(ip);
  if (!b) return "an address that could not be read";
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 16)) return "the unspecified address (::)";
  if (zeros(0, 15) && b[15] === 1) return "a loopback address";
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4BlockReason(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(0, 12)) return v4BlockReason(b.slice(12)) ?? "an IPv4-compatible address"; // ::a.b.c.d (deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return v4BlockReason(b.slice(12)); // NAT64
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "a link-local address";
  if ((b[0]! & 0xfe) === 0xfc) return "a unique-local address (fc00::/7, which includes the tailnet)";
  if (b[0] === 0xff) return "a multicast address";
  return undefined;
}

export function isLoopbackAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Bytes(ip)?.[0] === 127;
  const b = v6Bytes(ip);
  if (!b) return false;
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;
  return b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff && b[12] === 127;
}

/** Canonical text of an address for comparing two spellings of it. */
function canonical(ip: string): string {
  if (isIP(ip) === 4) return ip;
  const b = v6Bytes(ip);
  if (!b) return ip.toLowerCase();
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12).join("."); // v4-mapped → the v4
  return b.map((x) => x.toString(16).padStart(2, "0")).join("");
}

const cleanHost = (h: string): string => h.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

// ── The vetting step ────────────────────────────────────────────────────────────────────────────

/** Resolve a hostname to every address it has. Injectable so tests can script the answers. */
export type ProxyResolver = (hostname: string) => Promise<string[]>;

export const systemResolver: ProxyResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface ProxyPolicy {
  resolve: ProxyResolver;
  /** Fleet member hostnames and addresses (hub and members), refused whatever they resolve to. */
  fleetHosts: () => readonly string[];
  /** This daemon's own hostnames and addresses. */
  selfHosts: () => readonly string[];
  /** Loopback ports this proxy's session may reach (Phase C4's throwaway test daemon). */
  allowedLoopbackPorts: ReadonlySet<number>;
}

/** `addresses` is every address the name resolved to — all of them checked — in the order to try. */
export type ProxyVerdict = { ok: true; address: string; addresses: string[] } | { ok: false; reason: string; resolved?: string[] };

/** This machine's own names and interface addresses. */
export function ownHosts(): string[] {
  const out = new Set<string>([cleanHost(osHostname())]);
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.add(a.address.split("%")[0]!);
  return [...out].filter(Boolean);
}

/**
 * Decide one connection: resolve `host`, check the name and every address, and return the checked
 * addresses to connect to (the first, then the next if it does not answer). Never throws.
 */
export async function vetTarget(host: string, port: number, policy: ProxyPolicy): Promise<ProxyVerdict> {
  const name = cleanHost(host);
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "not a valid host and port" };
  const literal = isIP(name) !== 0;
  const named = new Set([...policy.fleetHosts(), ...policy.selfHosts()].map(cleanHost));
  const namedAddrs = new Set([...named].filter((h) => isIP(h) !== 0).map(canonical));

  let addresses: string[];
  if (literal) addresses = [name];
  else {
    try {
      addresses = await policy.resolve(name);
    } catch (e) {
      return { ok: false, reason: `could not resolve ${name}: ${e instanceof Error ? e.message : String(e)}` };
    }
    addresses = addresses.map((a) => a.split("%")[0]!);
    if (!addresses.length || addresses.some((a) => isIP(a) === 0)) return { ok: false, reason: `could not resolve ${name}`, resolved: addresses };
  }

  // The one exemption: a loopback port opened for this session, and only when every address is loopback.
  const exempt = policy.allowedLoopbackPorts.has(port) && addresses.every(isLoopbackAddress);
  if (!exempt) {
    if (name === "localhost" || name.endsWith(".localhost")) return { ok: false, reason: `${name} is this machine`, resolved: addresses };
    if (!literal && named.has(name)) return { ok: false, reason: `${name} is a machine in the fleet`, resolved: addresses };
    for (const a of addresses) {
      const why = blockedAddressReason(a);
      if (why) return { ok: false, reason: `${literal ? name : `${name} resolves to ${a},`} ${literal ? "is " : ""}${why}`.replace("  ", " "), resolved: addresses };
      if (namedAddrs.has(canonical(a))) return { ok: false, reason: `${a} is an address of a machine in the fleet`, resolved: addresses };
    }
  }
  return { ok: true, address: addresses[0]!, addresses };
}

// ── One listener ────────────────────────────────────────────────────────────────────────────────

export interface ProxyDecision {
  kind: "http" | "connect";
  host: string;
  port: number;
  allowed: boolean;
  /** The address connected to (allowed) — always one of the addresses that were checked. */
  address?: string;
  reason?: string;
}

export interface BrowserProxyOptions {
  resolve?: ProxyResolver;
  fleetHosts?: () => readonly string[];
  selfHosts?: () => readonly string[];
  /** Called once per request with what was decided (tests, and a debug log). */
  onDecision?: (d: ProxyDecision) => void;
  /** The daemon's own listening port. It can never be opened as a loopback exemption. */
  selfPort?: () => number | undefined;
  /** Test seam: open the TCP connection to a checked address (default `net.connect`). Lets a test
   *  see exactly which address is dialled and stand a local server in for a public one. */
  dial?: (address: string, port: number) => Socket;
}

const MAX_HEAD_BYTES = 64 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;

function refuse(sock: Socket, status: number, text: string, body: string): void {
  if (sock.destroyed) return;
  const payload = `${body}\n`;
  sock.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
}

/** Split `host:port` / `[v6]:port` (a CONNECT target, or a URL authority). */
function splitHostPort(target: string, defaultPort?: number): { host: string; port: number } | undefined {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) ?? /^([^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return undefined;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port === undefined ? undefined : { host: m[1]!, port };
}

export class BrowserProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly ports = new Set<number>();
  /** Open connections to loopback addresses, by port — destroyed when the port's exemption goes. */
  private readonly loopbackTunnels = new Map<number, Set<Socket>>();
  private boundPort = 0;
  /** Why the listener is no longer running, when it stopped by itself. */
  failure: string | undefined;

  constructor(private readonly opts: BrowserProxyOptions = {}) {
    this.server = createServer((sock) => this.accept(sock));
    this.server.on("error", (e) => {
      this.failure = e.message;
    });
    this.server.on("close", () => {
      this.failure ??= "the listener closed";
    });
  }

  /** Bind 127.0.0.1 on a random port. Synchronous for an IP literal, so the port is known at once.
   *  @throws when the socket cannot be bound. */
  listen(): number {
    this.server.listen(0, "127.0.0.1");
    const addr = this.server.address();
    if (!addr || typeof addr === "string" || !addr.port) throw new Error(this.failure ?? "could not open a loopback port for the browser proxy");
    this.boundPort = addr.port;
    this.failure = undefined;
    return this.boundPort;
  }

  get port(): number {
    return this.boundPort;
  }
  get listening(): boolean {
    return this.server.listening && !this.failure;
  }

  /** Open one loopback port. Never the daemon's own port, and never this listener's. */
  allowLoopbackPort(port: number): boolean {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    if (port === this.opts.selfPort?.() || port === this.boundPort) return false;
    this.ports.add(port);
    return true;
  }
  /** Close it again, and drop every connection that is open to it. */
  revokeLoopbackPort(port: number): void {
    this.ports.delete(port);
    for (const s of this.loopbackTunnels.get(port) ?? []) s.destroy();
    this.loopbackTunnels.delete(port);
  }
  allowedLoopbackPorts(): number[] {
    return [...this.ports];
  }

  /** Stop listening and drop every open connection. */
  close(): void {
    this.failure ??= "stopped";
    try {
      this.server.close();
    } catch {
      /* already closed */
    }
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  private policy(): ProxyPolicy {
    return {
      resolve: this.opts.resolve ?? systemResolver,
      fleetHosts: this.opts.fleetHosts ?? (() => []),
      selfHosts: this.opts.selfHosts ?? ownHosts,
      allowedLoopbackPorts: this.ports,
    };
  }

  private accept(client: Socket): void {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEAD_BYTES) {
          clearTimeout(timer);
          refuse(client, 431, "Request Header Fields Too Large", "Blocked by Anvil: request head too large.");
        }
        return;
      }
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      void this.handle(client, buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4)).catch(() => client.destroy());
    };
    client.on("data", onData);
  }

  private async handle(client: Socket, head: string, rest: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!m) return refuse(client, 400, "Bad Request", "Blocked by Anvil: not a proxy request.");
    const [, method, target] = m as unknown as [string, string, string];
    const isConnect = method === "CONNECT";

    let host: string;
    let port: number;
    let path = "";
    if (isConnect) {
      const hp = splitHostPort(target);
      if (!hp) return refuse(client, 400, "Bad Request", "Blocked by Anvil: bad CONNECT target.");
      ({ host, port } = hp);
    } else {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        return refuse(client, 400, "Bad Request", "Blocked by Anvil: a proxy request needs a full http:// URL.");
      }
      if (u.protocol !== "http:") return refuse(client, 400, "Bad Request", "Blocked by Anvil: only http:// URLs are forwarded directly.");
      host = u.hostname;
      port = u.port ? Number(u.port) : 80;
      path = `${u.pathname}${u.search}`;
    }

    host = cleanHost(host); // `[::1]` → `::1`
    const verdict = await vetTarget(host, port, this.policy());
    const kind = isConnect ? "connect" : "http";
    if (!verdict.ok) {
      this.opts.onDecision?.({ kind, host, port, allowed: false, reason: verdict.reason });
      return refuse(client, 403, "Forbidden", `Blocked by Anvil: ${verdict.reason}. The agent browser cannot reach private, local or fleet addresses.`);
    }
    if (client.destroyed) return;

    // Connect to an address that was checked — never to the name. A name with several addresses
    // (all checked) is tried in order until one answers.
    const upstream = await this.connectFirst(verdict.addresses, port);
    if (!upstream) {
      this.opts.onDecision?.({ kind, host, port, allowed: true, address: verdict.address, reason: "could not connect" });
      return refuse(client, 502, "Bad Gateway", `Anvil proxy: could not connect to ${host}:${port}.`);
    }
    this.opts.onDecision?.({ kind, host, port, allowed: true, address: upstream.address });
    const up = upstream.socket;
    if (client.destroyed) return void up.destroy();
    if (isLoopbackAddress(upstream.address)) {
      // Only reachable through an exemption: remember the pair so revoking the port cuts it.
      let set = this.loopbackTunnels.get(port);
      if (!set) this.loopbackTunnels.set(port, (set = new Set()));
      const tunnels = set;
      for (const s of [up, client]) {
        tunnels.add(s);
        s.once("close", () => tunnels.delete(s));
      }
    }
    up.on("close", () => {
      this.sockets.delete(up);
      client.end();
    });
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    if (isConnect) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } else {
      // One request per client connection: origin-form request line, hop-by-hop proxy headers
      // dropped, and `Connection: close` so the browser opens a new (re-vetted) connection for the
      // next request instead of reusing this socket for another host.
      const headers = lines.slice(1).filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive)\s*:/i.test(l));
      up.write(`${method} ${path || "/"} HTTP/1.1\r\n${[...headers, "Connection: close"].join("\r\n")}\r\n\r\n`);
    }
    if (rest.length) up.write(rest);
    client.pipe(up);
    up.pipe(client);
    client.resume();
  }

  /** Open a TCP connection to the first of `addresses` that accepts one. */
  private async connectFirst(addresses: readonly string[], port: number): Promise<{ socket: Socket; address: string } | undefined> {
    for (const address of addresses) {
      const socket = await new Promise<Socket | undefined>((done) => {
        const s = this.opts.dial ? this.opts.dial(address, port) : connect({ host: address, port });
        this.sockets.add(s);
        const fail = (): void => {
          this.sockets.delete(s);
          s.destroy();
          done(undefined);
        };
        s.setTimeout(CONNECT_TIMEOUT_MS, fail);
        s.once("error", fail);
        s.once("connect", () => {
          s.setTimeout(0);
          s.off("error", fail);
          done(s);
        });
      });
      if (socket) return { socket, address };
    }
    return undefined;
  }
}

// ── One listener per browser session ────────────────────────────────────────────────────────────

export type ProxyFactory = (opts: BrowserProxyOptions) => BrowserProxy;

export class BrowserProxyManager {
  private readonly bySession = new Map<string, BrowserProxy>();
  /** Loopback ports the test-daemon launcher registered, per session (Phase C4). Only these can be opened. */
  private readonly registered = new Map<string, Set<number>>();
  /** Told about every decision, with the session whose browser asked. */
  onSessionDecision: ((sessionId: string, d: ProxyDecision) => void) | undefined;
  private stopped: string | undefined;
  private lastFailure: string | undefined;

  constructor(
    private readonly opts: BrowserProxyOptions = {},
    private readonly factory: ProxyFactory = (o) => new BrowserProxy(o),
  ) {}

  /**
   * The session's listener, created on first use and re-created if it died. `{ error }` when no
   * listener can run — the caller must then NOT start a browser.
   */
  ensure(sessionId: string): { port: number } | { error: string } {
    if (this.stopped) return { error: this.stopped };
    const existing = this.bySession.get(sessionId);
    if (existing?.listening) return { port: existing.port };
    const carried = existing?.allowedLoopbackPorts() ?? [];
    existing?.close();
    this.bySession.delete(sessionId);
    try {
      const proxy = this.factory({
        ...this.opts,
        onDecision: (d) => {
          this.opts.onDecision?.(d);
          this.onSessionDecision?.(sessionId, d);
        },
      });
      const port = proxy.listen();
      for (const p of carried) proxy.allowLoopbackPort(p);
      this.bySession.set(sessionId, proxy);
      this.lastFailure = undefined;
      return { port };
    } catch (e) {
      this.lastFailure = e instanceof Error ? e.message : String(e);
      return { error: `the browser's network block could not start: ${this.lastFailure}` };
    }
  }

  get(sessionId: string): BrowserProxy | undefined {
    return this.bySession.get(sessionId);
  }

  /** Whether `sessionId` has a listener that is accepting connections right now. */
  running(sessionId: string): boolean {
    return !this.stopped && (this.bySession.get(sessionId)?.listening ?? false);
  }

  /**
   * Phase C4: let this session's browser reach one loopback port (its own throwaway test daemon).
   * Returns false when the session has no running listener (nothing was opened).
   */
  allowLoopbackPort(sessionId: string, port: number): boolean {
    const p = this.bySession.get(sessionId);
    if (!p?.listening) return false;
    // Only a port the test-daemon launcher registered for THIS session — never a bare number.
    if (!this.registered.get(sessionId)?.has(port)) return false;
    return p.allowLoopbackPort(port);
  }

  /**
   * Phase C4's launcher registers the port of the throwaway daemon it just started for `sessionId`.
   * Only a registered port can be opened with `allowLoopbackPort`. Refused: the daemon's own
   * listening port, a privileged or invalid port, a browser proxy's own port, and a port another
   * session registered.
   */
  registerTestDaemon(sessionId: string, port: number): { ok: true } | { ok: false; reason: string } {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, reason: "not a port a test daemon can listen on" };
    if (port === this.opts.selfPort?.()) return { ok: false, reason: "that is this daemon's own port" };
    for (const p of this.bySession.values()) if (p.port === port) return { ok: false, reason: "that is a browser proxy's port" };
    for (const [other, ports] of this.registered) if (other !== sessionId && ports.has(port)) return { ok: false, reason: "that port belongs to another session's test daemon" };
    let set = this.registered.get(sessionId);
    if (!set) this.registered.set(sessionId, (set = new Set()));
    set.add(port);
    return { ok: true };
  }

  /** Close that port again — its open connections are dropped — and forget its registration. With
   *  no `port`, every exemption and registration the session has. */
  revoke(sessionId: string, port?: number): void {
    const p = this.bySession.get(sessionId);
    const reg = this.registered.get(sessionId);
    for (const open of port === undefined ? [...new Set([...(p?.allowedLoopbackPorts() ?? []), ...(reg ?? [])])] : [port]) {
      p?.revokeLoopbackPort(open);
      reg?.delete(open);
    }
    if (reg && !reg.size) this.registered.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    this.bySession.get(sessionId)?.close();
    this.bySession.delete(sessionId);
    this.registered.delete(sessionId);
  }

  /** Stop everything. Until `restart()`, `ensure` refuses, so no browser can be started. */
  stop(reason = "the browser's network block is stopped"): void {
    this.stopped = reason;
    for (const p of this.bySession.values()) p.close();
    this.bySession.clear();
  }
  restart(): void {
    this.stopped = undefined;
  }

  /**
   * Whether a listener can run: not stopped, every live session's listener still accepting, and a
   * new loopback port can be bound. Drops listeners that died, so the next `ensure` replaces them.
   */
  state(): { state: "ready" | "stopped"; reason?: string; sessions: number } {
    if (this.stopped) return { state: "stopped", reason: this.stopped, sessions: 0 };
    for (const [id, p] of this.bySession) {
      if (p.listening) continue;
      const reason = `the browser's network block stopped unexpectedly (${p.failure ?? "unknown"})`;
      return { state: "stopped", reason: `${reason} [session ${id}]`, sessions: this.bySession.size - 1 };
    }
    if (this.lastFailure) return { state: "stopped", reason: `the browser's network block could not start: ${this.lastFailure}`, sessions: this.bySession.size };
    return { state: "ready", sessions: this.bySession.size };
  }

  /** Operator-driven recovery (Check): forget dead listeners and prove a port can be bound. */
  recheck(): void {
    for (const [id, p] of [...this.bySession]) if (!p.listening) this.closeSession(id);
    if (this.stopped) return;
    try {
      const probe = this.factory({ ...this.opts, onDecision: undefined });
      probe.listen();
      probe.close();
      this.lastFailure = undefined;
    } catch (e) {
      this.lastFailure = e instanceof Error ? e.message : String(e);
    }
  }
}
