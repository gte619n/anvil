/**
 * [C1] MCP integrations registry — functional scenarios (agent-cad-and-browser Phase C1 = the
 * superseded mcp-integrations spec's Phase 1 + Phase 2 Acceptance, with the `echo` stdio fixture).
 *
 * Real store, real service, real Supervisor and real permission hook; a fake clock, a fake prober and
 * fake drivers in the supervisor's map stand in for time, the network and the SDK. Nothing here calls
 * the Claude API or launches a browser.
 */
import { describe, test, expect, afterEach, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type McpIntegration } from "@protocol";
import { AgentDriver } from "../../src/agent/driver";
import { buildMcpServers } from "../../src/agent/mcp-external";
import { makeCanUseTool, QuestionBroker } from "../../src/agent/questions";
import { createServer, type ServerHandle } from "../../src/server/http";
import type { Session } from "../../src/session/session";
import { callHook, driversOf, echoInput, fakeDriver, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";

let rig: McpRig;
beforeEach(() => {
  rig = mcpRig();
});
afterEach(() => rig.cleanup());

const gateCtx = () => ({ inProcessKeys: [] as string[], gate: rig.sup.mcp.gate });
const hook = (s: Session, tool: string) => callHook(s, rig.broker, tool, gateCtx());
const events = () => rig.registry.ofType("mcp.integrations");

/** `echo` registered, probed ready, and switched on for a new ordinary session. */
async function withEcho(over: Parameters<typeof echoInput>[0] = {}, sessionOver: Partial<Session["data"]> = {}): Promise<{ echo: McpIntegration; s: Session }> {
  const echo = rig.sup.mcp.add(echoInput(over));
  await rig.sup.mcpIntegrationCheck();
  const s = await rig.session(sessionOver);
  rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
  await settle();
  return { echo, s };
}

describe("Phase 1 acceptance: daemon core", () => {
  test("[C1] buildMcpServers for an ordinary session with stdio integration `echo`: /usr/bin/env, -i first, {cwd} replaced, no TOKEN|KEY|ANTHROPIC anywhere", async () => {
    const { s } = await withEcho();
    const { servers, skipped } = buildMcpServers(s.data, undefined, rig.sup.mcp.statuses());
    expect(skipped).toEqual([]);
    const echo = servers.echo as { command: string; args: string[] };
    expect(echo.command).toBe("/usr/bin/env");
    expect(echo.args[0]).toBe("-i");
    expect(echo.args.slice(-2)).toEqual(["--root", s.data.cwd]);
    expect(echo.args.join(" ")).not.toContain("{cwd}");
    expect(JSON.stringify(servers)).not.toMatch(/TOKEN|KEY|ANTHROPIC/);
  });

  test("[C1] the same call for a concierge session returns only `anvil`", async () => {
    const { s } = await withEcho();
    const anvil = { type: "sdk", name: "anvil", instance: {} } as never;
    const concierge = { ...s.data, isDefault: true };
    const { servers, skipped } = buildMcpServers(concierge, { anvil }, rig.sup.mcp.statuses());
    expect(Object.keys(servers)).toEqual(["anvil"]);
    expect(skipped).toEqual([]);
  });

  test("[C1] an AgentDriver built with a capturing queryFn passes strictMcpConfig: true, the three resource tools in disallowedTools, and no mcp__echo__ id in allowedTools", async () => {
    const { s } = await withEcho();
    const captured: any[] = [];
    const queryFn = ((args: any) => {
      captured.push(args.options);
      return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {}, setModel: async () => {} };
    }) as never;
    // Exactly what ensureDriver passes for an ordinary session: the registry's server map, no role tools.
    const servers = rig.sup.mcp.serversFor(s, undefined);
    const driver = new AgentDriver(s, { render: (x: string) => ({ source: x, html: x }) } as never, rig.broker, new QuestionBroker(), {}, () => {}, servers, undefined, undefined, queryFn, undefined, undefined, undefined, undefined, undefined, undefined, undefined, rig.sup.mcp.gate);
    driver.prompt("hi");
    await settle(10);
    expect(captured).toHaveLength(1);
    const o = captured[0];
    expect(o.strictMcpConfig).toBe(true);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]));
    expect(Object.keys(o.mcpServers)).toEqual(["echo"]); // the integration IS attached…
    expect((o.allowedTools ?? []).filter((t: string) => t.startsWith("mcp__echo__"))).toEqual([]); // …and never auto-allowed
    expect(JSON.stringify(o.allowedTools ?? [])).not.toContain("echo");
    await driver.stop();
  });

  test("[C1] the hook under mostly-autonomous: mcp__echo__ping parks a request; always lets mcp__echo__pong through; switching echo off denies with no prompt; switching it back on prompts again", async () => {
    const { echo, s } = await withEcho();
    expect(s.data.autonomy).toBe("mostly-autonomous");

    const ping = hook(s, "mcp__echo__ping");
    expect(await isPending(ping)).toBe(true); // parked
    expect(parked(s).tool).toBe("mcp__echo__ping");
    rig.sup.resolvePermission(parked(s).requestId, "allow_always");
    expect((await ping).decision).toBe("allow");

    expect((await hook(s, "mcp__echo__pong")).decision).toBe("allow"); // no prompt
    expect(s.pendingPermissions.size).toBe(0);

    rig.sup.setSessionMcpIntegrations(s.id, []); // switched off for the session
    expect((await hook(s, "mcp__echo__ping")).decision).toBe("deny");
    expect(s.pendingPermissions.size).toBe(0); // …with no prompt

    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]); // back on
    const again = hook(s, "mcp__echo__ping");
    expect(await isPending(again)).toBe(true); // prompts again: the gate reads the live list, not a snapshot
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    expect((await again).decision).toBe("deny");
  });

  test("[C1] the hook denies mcp__other__x", async () => {
    const { s } = await withEcho();
    const out = await hook(s, "mcp__other__x");
    expect(out.decision).toBe("deny");
    expect(s.pendingPermissions.size).toBe(0);
  });

  test("[C1] canUseTool denies mcp__echo__ping", async () => {
    const { s } = await withEcho();
    const out = await makeCanUseTool(s, new QuestionBroker(), undefined)("mcp__echo__ping", {}, { signal: new AbortController().signal } as never);
    expect(out?.behavior).toBe("deny");
  });
});

describe("Phase 2 acceptance: health and lock", () => {
  test("[C1] an http integration whose port is closed reports unavailable and buildMcpServers returns it in skipped; when the probe flips to open exactly one mcp.integrations event is broadcast and the idle driver of a referencing session is dropped", async () => {
    rig.prober.health.set("web", { state: "unavailable", reason: "nothing is listening on port 27182" });
    const web = rig.sup.mcp.add(echoInput({ key: "web", label: "Web", transport: { type: "http", url: "http://127.0.0.1:27182/mcp" } }));
    await rig.sup.mcpIntegrationCheck();
    const s = await rig.session();
    const bystander = await rig.session(); // does not reference it
    rig.sup.setSessionMcpIntegrations(s.id, [web.id]);
    await settle();

    expect(rig.sup.mcpIntegrationsEvent().integrations[0]).toMatchObject({ key: "web", health: { state: "unavailable", reason: "nothing is listening on port 27182" } });
    expect(buildMcpServers(s.data, undefined, rig.sup.mcp.statuses())).toEqual({
      servers: {},
      skipped: [{ id: web.id, label: "Web", reason: "nothing is listening on port 27182" }],
    });

    const mine = fakeDriver();
    const theirs = fakeDriver();
    driversOf(rig.sup).set(s.id, mine).set(bystander.id, theirs);
    const before = events().length;

    rig.prober.health.delete("web"); // the port opens
    rig.clock.advance(60_000);
    rig.registry.clients = 1;
    await rig.sup.mcp.tick();

    expect(events().slice(before)).toHaveLength(1); // exactly one
    expect(events().at(-1)!.integrations[0]!.health).toEqual({ state: "ready" });
    expect(mine.stopped).toBe(true);
    expect(driversOf(rig.sup).has(s.id)).toBe(false); // dropped: the next turn rebuilds with it
    expect(theirs.stopped).toBe(false);
    expect(driversOf(rig.sup).has(bystander.id)).toBe(true);
    expect(Object.keys(buildMcpServers(s.data, undefined, rig.sup.mcp.statuses()).servers)).toEqual(["web"]);

    // Further probes with nothing new: no more events, no more drops.
    const d2 = fakeDriver();
    driversOf(rig.sup).set(s.id, d2);
    await rig.sup.mcp.tick();
    await rig.sup.mcp.probe("turn");
    expect(events().slice(before)).toHaveLength(1);
    expect(d2.stopped).toBe(false);
  });

  test("[C1] a health flip while a referencing session is mid-turn leaves its driver alone and rebuilds it when the turn ends", async () => {
    const { s } = await withEcho();
    s.setStatus("thinking");
    const d = fakeDriver();
    driversOf(rig.sup).set(s.id, d);
    rig.prober.health.set("echo", { state: "unavailable", reason: "command not found: echo-mcp" });
    await rig.sup.mcp.probe("timer");
    expect(d.stopped).toBe(false);
    s.setStatus("idle");
    rig.sup.mcp.gate.onTurnEnd(s);
    await settle(5);
    expect(d.stopped).toBe(true);
  });

  test("[C1] switching `enabled` off in Settings drops the idle drivers of referencing sessions and reports the integration disabled", async () => {
    const { echo, s } = await withEcho();
    const d = fakeDriver();
    driversOf(rig.sup).set(s.id, d);
    rig.sup.mcpIntegrationUpdate(echo.id, { enabled: false });
    expect(d.stopped).toBe(true);
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.health).toEqual({ state: "disabled" });
    expect(buildMcpServers(s.data, undefined, rig.sup.mcp.statuses()).skipped).toEqual([{ id: echo.id, label: "Echo", reason: "switched off in Settings" }]);
  });

  test("[C1] lock: A's approved call acquires; B's call is denied naming A; A's consume loop exits; B's next call succeeds", async () => {
    const { echo, s: a } = await withEcho({ exclusive: true }, { title: "Session A", autonomy: "mostly-autonomous" });
    const b = await rig.session({ title: "Session B", autonomy: "mostly-autonomous" });
    rig.sup.setSessionMcpIntegrations(b.id, [echo.id]);
    b.data.mcpAllowed = [echo.id]; // B needs no prompt, so only the lock can stop it

    const aCall = hook(a, "mcp__echo__ping");
    await isPending(aCall);
    rig.sup.resolvePermission(parked(a).requestId, "allow");
    expect((await aCall).decision).toBe("allow");
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(a.id);
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.heldBy).toBe(a.id);

    const denied = await hook(b, "mcp__echo__ping");
    expect(denied).toEqual({ decision: "deny", reason: "Echo is in use by Session A" });

    rig.sup.mcp.gate.onConsumeExit(a); // A's consume loop exits (turn end, error or stop)
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();
    expect((await hook(b, "mcp__echo__ping")).decision).toBe("allow");
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(b.id);
  });

  test("[C1] lock: with A parked on a prompt and never approved, B succeeds — and A's late approval is then denied", async () => {
    const { echo, s: a } = await withEcho({ exclusive: true }, { title: "Session A" });
    const b = await rig.session({ title: "Session B" });
    rig.sup.setSessionMcpIntegrations(b.id, [echo.id]);
    b.data.mcpAllowed = [echo.id];

    const aCall = hook(a, "mcp__echo__ping");
    expect(await isPending(aCall)).toBe(true);
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined(); // a parked prompt holds nothing

    expect((await hook(b, "mcp__echo__ping")).decision).toBe("allow");
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(b.id);

    rig.sup.resolvePermission(parked(a).requestId, "allow_always"); // too late: B took it meanwhile
    expect(await aCall).toEqual({ decision: "deny", reason: "Echo is in use by Session B" });
    expect(a.data.mcpAllowed).toBeUndefined();
  });

  test("[C1] lock: under bypass, B is still denied while A holds", async () => {
    const { echo, s: a } = await withEcho({ exclusive: true }, { title: "Session A", autonomy: "bypass" });
    const b = await rig.session({ title: "Session B", autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(b.id, [echo.id]);
    expect((await hook(a, "mcp__echo__ping")).decision).toBe("allow"); // bypass: no prompt, lock still taken
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(a.id);
    const out = await hook(b, "mcp__echo__ping");
    expect(out).toEqual({ decision: "deny", reason: "Echo is in use by Session A" });
    expect(b.pendingPermissions.size).toBe(0);
  });

  test("[C1] lock: 10 minutes of fake-clock silence from A releases the lock; a tool.result at minute 9 does not", async () => {
    const { echo, s: a } = await withEcho({ exclusive: true }, { title: "Session A", autonomy: "bypass" });
    const b = await rig.session({ title: "Session B", autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(b.id, [echo.id]);
    const MIN = 60_000;

    await hook(a, "mcp__echo__ping");
    rig.clock.advance(9 * MIN);
    rig.sup.mcp.gate.onToolResult(a, "echo"); // a tool.result from the integration at minute 9
    rig.clock.advance(2 * MIN); // minute 11
    expect((await hook(b, "mcp__echo__ping")).decision).toBe("deny"); // A still holds
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(a.id);

    rig.clock.advance(8 * MIN); // 10 minutes after A's last activity
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();
    expect((await hook(b, "mcp__echo__ping")).decision).toBe("allow");
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(b.id);
  });

  test("[C1] lock: a non-exclusive integration is never locked, and switching an exclusive one off for the holder releases it", async () => {
    const { echo, s: a } = await withEcho({}, { autonomy: "bypass" });
    const b = await rig.session({ autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(b.id, [echo.id]);
    expect((await hook(a, "mcp__echo__ping")).decision).toBe("allow");
    expect((await hook(b, "mcp__echo__ping")).decision).toBe("allow");
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();

    rig.sup.mcpIntegrationUpdate(echo.id, { exclusive: true });
    await settle();
    expect((await hook(a, "mcp__echo__ping")).decision).toBe("allow");
    expect((await hook(b, "mcp__echo__ping")).decision).toBe("deny");
    rig.sup.setSessionMcpIntegrations(a.id, []); // switched off for the holder
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();
    expect((await hook(b, "mcp__echo__ping")).decision).toBe("allow");
  });
});

describe("turn start", () => {
  test("[C1] a turn on a session with integrations probes first, so a flip rebuilds the driver before the prompt reaches it", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder";
    const { s } = await withEcho();
    const stale = fakeDriver();
    driversOf(rig.sup).set(s.id, stale);
    // Stand in for ensureDriver: record when the prompt reaches a driver and what was in the map then.
    const order: string[] = [];
    (rig.sup as unknown as { ensureDriver: (id: string) => { prompt: (t: string) => void } }).ensureDriver = (id) => ({
      prompt: (t) => void order.push(`prompt:${t}:probes=${rig.prober.calls}:staleInMap=${driversOf(rig.sup).get(id) === stale}`),
    });
    rig.prober.health.set("echo", { state: "unavailable", reason: "command not found" }); // it went away since the last probe
    const probesBefore = rig.prober.calls;

    rig.sup.prompt(s.id, "hello");
    expect(order).toEqual([]); // not yet: the probe comes first
    await settle(5);
    expect(order).toEqual([`prompt:hello:probes=${probesBefore + 1}:staleInMap=false`]);
    expect(stale.stopped).toBe(true);

    // A session with no integrations on is not delayed and triggers no probe.
    const plain = await rig.session();
    const n = rig.prober.calls;
    rig.sup.prompt(plain.id, "hi");
    expect(order).toHaveLength(2);
    expect(rig.prober.calls).toBe(n);
  });
});

// ── Over the wire: dispatch + the connect burst ──────────────────────────────────────────────────

describe("dispatch", () => {
  let srv: ServerHandle;
  let off: ServerHandle;
  let dirs: string[];
  const base = { v: PROTOCOL_VERSION, ts: "2026-11-19T00:00:00.000Z" };

  beforeAll(() => {
    dirs = [mkdtempSync(join(tmpdir(), "anvil-mcp-ws-")), mkdtempSync(join(tmpdir(), "anvil-mcp-ws-off-"))];
    srv = createServer({ host: "127.0.0.1", port: 0, stateDir: dirs[0]!, envFile: join(dirs[0]!, "env"), features: ["mcp-integrations"] });
    off = createServer({ host: "127.0.0.1", port: 0, stateDir: dirs[1]!, envFile: join(dirs[1]!, "env") });
  });
  afterAll(() => {
    srv.stop();
    off.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A socket that records every frame; `until` resolves with the first frame matching `pred`. */
  function client(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      frames.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    };
    const opened = new Promise<void>((r) => (ws.onopen = () => r()));
    return {
      frames,
      opened,
      send: (payload: object) => ws.send(JSON.stringify({ ...base, ...payload })),
      until: (pred: (m: any) => boolean, ms = 3000) =>
        new Promise<any>((resolve, reject) => {
          const hit = frames.find(pred);
          if (hit) return resolve(hit);
          const t = setTimeout(() => reject(new Error("timeout waiting for a frame")), ms);
          waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
        }),
      close: () => ws.close(),
    };
  }
  const reply = (cid: string) => (m: any) => m.cid === cid && (m.type === "ack" || m.type === "command.error");

  test("[C1] server.hello advertises mcp-integrations and mcp.integrations arrives on connect; neither on a daemon with the feature off", async () => {
    const on = client(srv.port);
    const hello = await on.until((m) => m.type === "server.hello");
    expect(hello.capabilities).toContain("mcp-integrations");
    const list = await on.until((m) => m.type === "mcp.integrations");
    expect(list.integrations).toEqual([]);
    on.close();

    const plain = client(off.port);
    const hello2 = await plain.until((m) => m.type === "server.hello");
    expect(hello2.capabilities).not.toContain("mcp-integrations");
    plain.send({ type: "mcp.integration.check", cid: "c-off" });
    const err = await plain.until(reply("c-off"));
    expect(err.type).toBe("command.error");
    expect(err.message).toMatch(/not enabled/);
    plain.send({ type: "mcp.integration.add", cid: "c-off2", integration: echoInput() });
    expect((await plain.until(reply("c-off2"))).type).toBe("command.error");
    expect(plain.frames.some((m) => m.type === "mcp.integrations")).toBe(false);
    plain.close();
  });

  test("[C1] add / check / update / remove over the socket: acked, validated, and broadcast to every client", async () => {
    const a = client(srv.port);
    const b = client(srv.port);
    await Promise.all([a.until((m) => m.type === "mcp.integrations"), b.until((m) => m.type === "mcp.integrations")]);

    a.send({ type: "mcp.integration.add", cid: "c1", integration: { ...echoInput(), transport: { type: "stdio", command: "/bin/sh", args: ["-c", "true", "{cwd}"] } } });
    expect((await a.until(reply("c1"))).type).toBe("ack");
    const seen = await b.until((m) => m.type === "mcp.integrations" && m.integrations.length === 1 && m.integrations[0].health.state === "ready");
    const echo = seen.integrations[0];
    expect(echo).toMatchObject({ key: "echo", kind: "custom", label: "Echo", enabled: true, exclusive: false });
    expect(echo.id).toMatch(/^mcpi_/);

    for (const [cid, integration, re] of [
      ["c2", echoInput(), /already used/],
      ["c3", echoInput({ key: "anvil_cad" }), /key must be|reserved/],
      ["c4", echoInput({ key: "web", transport: { type: "http", url: "http://example.com/mcp" } }), /this machine/],
      ["c5", echoInput({ key: "pw", kind: "browser" }), /not available on this server/],
    ] as const) {
      a.send({ type: "mcp.integration.add", cid, integration });
      const r = await a.until(reply(cid));
      expect(r.type).toBe("command.error");
      expect(r.message).toMatch(re);
    }

    a.send({ type: "mcp.integration.check", cid: "c6" });
    expect((await a.until(reply("c6"))).type).toBe("ack");

    a.send({ type: "mcp.integration.update", cid: "c7", id: echo.id, fields: { enabled: false } });
    expect((await a.until(reply("c7"))).type).toBe("ack");
    const disabled = await b.until((m) => m.type === "mcp.integrations" && m.integrations[0]?.health.state === "disabled");
    expect(disabled.integrations[0].enabled).toBe(false);

    a.send({ type: "mcp.integration.remove", cid: "c8", id: echo.id });
    expect((await a.until(reply("c8"))).type).toBe("ack");
    await b.until((m) => m.type === "mcp.integrations" && m.integrations.length === 0 && b.frames.indexOf(m) > b.frames.indexOf(disabled));
    a.send({ type: "mcp.integration.remove", cid: "c9", id: echo.id });
    expect((await a.until(reply("c9"))).message).toMatch(/no such integration/);
    a.close();
    b.close();
  });

  test("[C1] session.set_mcp_integrations from two clients: last write wins, one session.updated per write", async () => {
    const a = client(srv.port);
    const b = client(srv.port);
    await Promise.all([a.opened, b.opened]);
    a.send({ type: "mcp.integration.add", cid: "s1", integration: { ...echoInput(), transport: { type: "stdio", command: "/bin/sh", args: [] } } });
    await a.until(reply("s1"));
    a.send({ type: "mcp.integration.add", cid: "s2", integration: { ...echoInput({ key: "web", label: "Web" }), transport: { type: "stdio", command: "/bin/sh", args: [] } } });
    await a.until(reply("s2"));
    const list = (await a.until((m) => m.type === "mcp.integrations" && m.integrations.length === 2)).integrations;
    const [echo, web] = [list.find((i: any) => i.key === "echo"), list.find((i: any) => i.key === "web")];

    a.send({ type: "session.create", cid: "s3", source: "existing-dir", cwd: dirs[0] });
    const created = await a.until((m) => m.type === "session.created");
    const sid = created.session.id;
    const updates = () => b.frames.filter((m) => m.type === "session.updated" && m.session.id === sid && "mcpIntegrations" in m.session);

    a.send({ type: "session.set_mcp_integrations", cid: "s4", sessionId: sid, ids: [echo.id, echo.id, "mcpi_unknown"] });
    b.send({ type: "session.set_mcp_integrations", cid: "s5", sessionId: sid, ids: [web.id] });
    expect((await a.until(reply("s4"))).type).toBe("ack");
    expect((await b.until(reply("s5"))).type).toBe("ack");
    await b.until((m) => m.type === "session.updated" && m.session.id === sid && m.session.mcpIntegrations?.[0] === web.id);
    expect(updates().map((m) => m.session.mcpIntegrations)).toEqual([[echo.id], [web.id]]); // deduped, unknown dropped; last write wins

    a.send({ type: "session.set_mcp_integrations", cid: "s6", sessionId: "sess_nope", ids: [] });
    expect((await a.until(reply("s6"))).message).toMatch(/no such session/);
    a.close();
    b.close();
  });
});
