/**
 * [C1] McpIntegrationService (mcp-integrations spec §4.2–§4.5, §7): commands, the session list,
 * change-only broadcast, driver rebuilds, the failed-at-init report. Real store and service on a real
 * Supervisor; fake prober, fake clock, fake drivers in the supervisor's map.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BadCommand } from "../../src/session/errors";
import { MCP_STORE_FILE } from "../../src/mcp/store";
import { callHook, driversOf, echoInput, fakeDriver, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";

let rig: McpRig;
beforeEach(() => {
  rig = mcpRig();
});
afterEach(() => rig.cleanup());

const events = () => rig.registry.ofType("mcp.integrations");
const updatesFor = (id: string) => rig.registry.ofType("session.updated").filter((e) => e.session.id === id);
/** Record the notice lines a session emits (assistant.message markdown blocks). */
function watchNotices(s: { id: string; emit: (b: any) => unknown }): string[] {
  const lines: string[] = [];
  const orig = s.emit.bind(s);
  s.emit = (b: any) => {
    if (b.type === "assistant.message") for (const blk of b.blocks ?? []) if (blk.kind === "markdown") lines.push(blk.rendered.source ?? blk.rendered.html ?? String(blk.rendered));
    return orig(b);
  };
  return lines;
}

describe("feature flag", () => {
  test("[C1] with the feature off every command is refused, nothing is broadcast, and no integration is attached", async () => {
    const off = mcpRig({ features: [] });
    try {
      expect(off.sup.mcp.enabled).toBe(false);
      expect(() => off.sup.mcpIntegrationAdd(echoInput())).toThrow(BadCommand);
      expect(() => off.sup.mcpIntegrationUpdate("x", { enabled: false })).toThrow(/not enabled/);
      expect(() => off.sup.mcpIntegrationRemove("x")).toThrow(/not enabled/);
      await expect(off.sup.mcpIntegrationCheck()).rejects.toThrow(/not enabled/);
      const s = await off.session();
      expect(() => off.sup.setSessionMcpIntegrations(s.id, [])).toThrow(/not enabled/);
      expect(off.sup.mcpIntegrationsEvent().integrations).toEqual([]);
      await off.sup.mcp.probe("check");
      expect(off.prober.calls).toBe(0);
      expect(off.registry.ofType("mcp.integrations")).toEqual([]);
      // A store file left over from when the feature was on attaches nothing.
      writeFileSync(join(off.dir, MCP_STORE_FILE), JSON.stringify({ integrations: [{ id: "mcpi_1", ...echoInput() }] }));
      const again = mcpRig({ features: [], stateDir: off.dir });
      const t = await again.session({ mcpIntegrations: ["mcpi_1"] });
      expect(again.sup.mcp.serversFor(t, undefined)).toBeUndefined();
      again.sup.mcp.stop();
    } finally {
      await off.cleanup();
    }
  });
});

describe("commands", () => {
  test("[C1] add broadcasts the list, then the first probe broadcasts its health once; an unchanged probe broadcasts nothing", async () => {
    const before = events().length;
    const echo = rig.sup.mcp.add(echoInput());
    await settle();
    const got = events().slice(before);
    expect(got).toHaveLength(2);
    expect(got[0]!.integrations).toEqual([{ ...echo, health: { state: "unavailable", reason: "not checked yet" }, checkedAt: 0 }]);
    expect(got[1]!.integrations[0]).toMatchObject({ id: echo.id, health: { state: "ready" }, checkedAt: rig.clock.now });

    rig.clock.advance(60_000);
    await rig.sup.mcp.probe("timer");
    await rig.sup.mcpIntegrationCheck();
    expect(events().slice(before)).toHaveLength(2); // checkedAt moved; nothing a client shows changed
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.checkedAt).toBe(rig.clock.now);
  });

  test("[C1] add surfaces a store refusal as a BadCommand with the reason", () => {
    rig.sup.mcp.add(echoInput());
    expect(() => rig.sup.mcpIntegrationAdd(echoInput())).toThrow(BadCommand);
    expect(() => rig.sup.mcpIntegrationAdd(echoInput({ key: "anvil" }))).toThrow(/reserved/);
    expect(() => rig.sup.mcpIntegrationAdd(echoInput({ key: "web", transport: { type: "http", url: "http://10.1.1.1/" } }))).toThrow(/this machine/);
    expect(() => rig.sup.mcpIntegrationRemove("mcpi_missing")).toThrow(/no such integration/);
    expect(() => rig.sup.mcpIntegrationUpdate("mcpi_missing", { enabled: true })).toThrow(/no such integration/);
  });

  test("[C1] session.set_mcp_integrations dedupes, drops unknown ids, persists, and emits one session.updated per write", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    const web = rig.sup.mcp.add(echoInput({ key: "web", label: "Web" }));
    const s = await rig.session();
    const n = updatesFor(s.id).length;
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id, "mcpi_nope", echo.id, web.id, web.id]);
    expect(s.data.mcpIntegrations).toEqual([echo.id, web.id]);
    expect(updatesFor(s.id)).toHaveLength(n + 1);
    // Two clients toggling at once: last write wins, one update each.
    rig.sup.setSessionMcpIntegrations(s.id, [web.id]);
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    expect(s.data.mcpIntegrations).toEqual([echo.id]);
    expect(updatesFor(s.id)).toHaveLength(n + 3);
    expect(updatesFor(s.id).at(-1)!.session.mcpIntegrations).toEqual([echo.id]);

    // The list survives a daemon restart (a new Supervisor over the same state dir).
    await settle(150); // let the debounced persist land
    const reborn = mcpRig({ stateDir: rig.dir });
    expect(reborn.sup.list().find((x) => x.id === s.id)?.mcpIntegrations).toEqual([echo.id]);
    expect(reborn.sup.mcp.lock.holder(echo.id)).toBeUndefined(); // locks never survive a restart
    reborn.sup.mcp.stop();

    rig.sup.setSessionMcpIntegrations(s.id, []);
    expect(s.data.mcpIntegrations).toBeUndefined();
    expect(() => rig.sup.setSessionMcpIntegrations("sess_missing", [])).toThrow(/no such session/);
    expect(() => rig.sup.setSessionMcpIntegrations(s.id, "echo" as never)).toThrow(/list of integration ids/);
  });

  test("[C1] integrations cannot be switched on for the concierge, a team session or an autopilot session", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    for (const over of [{ isDefault: true }, { teamRole: "lead" }, { teamRole: "member", parentId: "p" }, { workUnitRole: "planner", workUnitId: "w" }, { workUnitRole: "builder", workUnitId: "w" }] as const) {
      const s = await rig.session(over);
      expect(() => rig.sup.setSessionMcpIntegrations(s.id, [echo.id])).toThrow(/ordinary sessions/);
      expect(s.data.mcpIntegrations).toBeUndefined();
    }
  });

  test("[C1] on load, ids that no longer name an integration are dropped from every session, and duplicates collapse", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    const s = await rig.session();
    s.data.mcpIntegrations = [echo.id, "mcpi_gone", echo.id];
    s.data.mcpAllowed = ["mcpi_gone", echo.id];
    const concierge = await rig.session({ isDefault: true });
    concierge.data.mcpIntegrations = [echo.id]; // hand-edited sessions.json
    rig.sup.mcp.sanitizeSessions();
    expect(s.data.mcpIntegrations).toEqual([echo.id]);
    expect(s.data.mcpAllowed).toEqual([echo.id]);
    expect(concierge.data.mcpIntegrations).toBeUndefined();
  });

  test("[C1] removing an integration that sessions reference: off every list, idle drivers dropped, lock released", async () => {
    const echo = rig.sup.mcp.add(echoInput({ exclusive: true }));
    const web = rig.sup.mcp.add(echoInput({ key: "web", label: "Web" }));
    await settle();
    const a = await rig.session({ autonomy: "bypass" });
    const b = await rig.session();
    const c = await rig.session();
    rig.sup.setSessionMcpIntegrations(a.id, [echo.id, web.id]);
    rig.sup.setSessionMcpIntegrations(b.id, [echo.id]);
    rig.sup.setSessionMcpIntegrations(c.id, [web.id]);
    b.data.mcpAllowed = [echo.id];
    expect((await callHook(a, rig.broker, "mcp__echo__ping", { inProcessKeys: [], gate: rig.sup.mcp.gate })).decision).toBe("allow");
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(a.id);
    const [da, db, dc] = [fakeDriver(), fakeDriver(), fakeDriver()];
    driversOf(rig.sup).set(a.id, da).set(b.id, db).set(c.id, dc);

    rig.sup.mcpIntegrationRemove(echo.id);
    expect(a.data.mcpIntegrations).toEqual([web.id]);
    expect(b.data.mcpIntegrations).toBeUndefined();
    expect(b.data.mcpAllowed).toBeUndefined();
    expect(c.data.mcpIntegrations).toEqual([web.id]);
    expect([da.stopped, db.stopped, dc.stopped]).toEqual([true, true, false]); // c never referenced it
    expect(driversOf(rig.sup).has(a.id)).toBe(false);
    expect(driversOf(rig.sup).has(c.id)).toBe(true);
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();
    expect(rig.sup.mcpIntegrationsEvent().integrations.map((i) => i.key)).toEqual(["web"]);
    expect((await callHook(a, rig.broker, "mcp__echo__ping", { inProcessKeys: [], gate: rig.sup.mcp.gate })).decision).toBe("deny");
  });

  test("[C1] removed and re-added under the same key gets a new id, so a stale always-allow does not apply", async () => {
    const first = rig.sup.mcp.add(echoInput());
    const s = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [first.id]);
    const gate = { inProcessKeys: [], gate: rig.sup.mcp.gate };
    const p = callHook(s, rig.broker, "mcp__echo__ping", gate);
    await isPending(p);
    rig.sup.resolvePermission(parked(s).requestId, "allow_always");
    await p;
    expect(s.data.mcpAllowed).toEqual([first.id]);

    rig.sup.mcpIntegrationRemove(first.id);
    const second = rig.sup.mcp.add(echoInput());
    expect(second.id).not.toBe(first.id);
    expect(s.data.mcpAllowed).toBeUndefined();
    expect((await callHook(s, rig.broker, "mcp__echo__ping", gate)).decision).toBe("deny"); // not on for the session at all
    rig.sup.setSessionMcpIntegrations(s.id, [second.id]);
    s.data.mcpAllowed = [first.id]; // even a stale id left behind by hand does not match
    const again = callHook(s, rig.broker, "mcp__echo__ping", gate);
    expect(await isPending(again)).toBe(true);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    await again;
  });

  test("[C1] updating an integration clears its always-allow in every session and rebuilds idle drivers", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    await settle();
    const s = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    s.data.mcpAllowed = [echo.id];
    const d = fakeDriver();
    driversOf(rig.sup).set(s.id, d);
    const n = updatesFor(s.id).length;
    rig.sup.mcpIntegrationUpdate(echo.id, { transport: { type: "stdio", command: "other-server", args: [] } });
    expect(s.data.mcpAllowed).toBeUndefined();
    expect(updatesFor(s.id).length).toBeGreaterThan(n);
    expect(d.stopped).toBe(true);
    expect(s.data.mcpIntegrations).toEqual([echo.id]); // still on; only the approval is gone
  });

  test("[C1] a session reset clears its always-allow list and frees its exclusive locks", async () => {
    const echo = rig.sup.mcp.add(echoInput({ exclusive: true }));
    const s = await rig.session({ autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    s.data.mcpAllowed = [echo.id];
    await callHook(s, rig.broker, "mcp__echo__ping", { inProcessKeys: [], gate: rig.sup.mcp.gate });
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.heldBy).toBe(s.id);
    await rig.sup.reset(s.id);
    expect(s.data.mcpAllowed).toBeUndefined();
    expect(s.data.mcpIntegrations).toEqual([echo.id]); // the list itself is a setting, not an approval
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();
    expect(rig.sup.mcpIntegrationsEvent().integrations[0]!.heldBy).toBeUndefined();
  });

  test("[C1] deleting a session frees its exclusive locks", async () => {
    const echo = rig.sup.mcp.add(echoInput({ exclusive: true }));
    const s = await rig.session({ autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    await callHook(s, rig.broker, "mcp__echo__ping", { inProcessKeys: [], gate: rig.sup.mcp.gate });
    expect(rig.sup.mcp.lock.holder(echo.id)).toBe(s.id);
    await rig.sup.kill(s.id);
    expect(rig.sup.mcp.lock.holder(echo.id)).toBeUndefined();
    await rig.sup.settle();
  });
});

describe("driver rebuilds", () => {
  test("[C1] switching one on for an idle session drops its driver so the next turn rebuilds", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    await settle();
    const s = await rig.session();
    const d = fakeDriver();
    driversOf(rig.sup).set(s.id, d);
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    expect(d.stopped).toBe(true);
    expect(driversOf(rig.sup).has(s.id)).toBe(false);
    expect(rig.sup.mcp.rebuildPending(s.id)).toBe(false);
    // Writing the same list again changes nothing and drops nothing.
    const d2 = fakeDriver();
    driversOf(rig.sup).set(s.id, d2);
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    expect(d2.stopped).toBe(false);
  });

  test("[C1] switched on mid-turn: persisted now, driver left alone, rebuilt when the turn ends", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    await settle();
    const s = await rig.session();
    s.setStatus("thinking");
    const d = fakeDriver();
    driversOf(rig.sup).set(s.id, d);
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    expect(s.data.mcpIntegrations).toEqual([echo.id]);
    expect(d.stopped).toBe(false);
    expect(rig.sup.mcp.rebuildPending(s.id)).toBe(true);

    s.setStatus("idle"); // the driver sets idle, then reports the turn end
    rig.sup.mcp.gate.onTurnEnd(s);
    await settle(5);
    expect(d.stopped).toBe(true);
    expect(driversOf(rig.sup).has(s.id)).toBe(false);
    expect(rig.sup.mcp.rebuildPending(s.id)).toBe(false);
  });

  test("[C1] a turn that dies (consume loop exit) also applies the deferred rebuild", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    await settle();
    const s = await rig.session();
    s.setStatus("running_tool");
    const d = fakeDriver();
    driversOf(rig.sup).set(s.id, d);
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    s.setStatus("idle");
    rig.sup.mcp.gate.onConsumeExit(s);
    await settle(5);
    expect(d.stopped).toBe(true);
  });

  test("[C1] serversFor attaches ready integrations and puts one notice line in the session per skipped one", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    const web = rig.sup.mcp.add(echoInput({ key: "web", label: "Web", transport: { type: "http", url: "http://127.0.0.1:27182/mcp" } }));
    const off = rig.sup.mcp.add(echoInput({ key: "off", label: "Off one", enabled: false }));
    rig.prober.health.set("web", { state: "unavailable", reason: "nothing is listening on port 27182" });
    await rig.sup.mcpIntegrationCheck();
    const s = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id, web.id, off.id]);
    await settle();
    const lines = watchNotices(s);
    const servers = rig.sup.mcp.serversFor(s, undefined)!;
    expect(Object.keys(servers)).toEqual(["echo"]);
    expect((servers.echo as { command: string }).command).toBe("/usr/bin/env");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Web is not available in this turn: nothing is listening on port 27182");
    expect(lines[1]).toContain("Off one is not available in this turn: switched off in Settings");
  });
});

describe("failed at session init (§4.14 item 31)", () => {
  test("[C1] a server the SDK reports failed in the init message is marked unavailable, noticed once in the session, and held until Check", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    const web = rig.sup.mcp.add(echoInput({ key: "web", label: "Web" }));
    await settle();
    const s = await rig.session();
    const other = await rig.session();
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id, web.id]);
    rig.sup.setSessionMcpIntegrations(other.id, [echo.id]);
    await settle();
    const lines = watchNotices(s);
    const idleDriver = fakeDriver();
    driversOf(rig.sup).set(other.id, idleDriver);
    s.setStatus("thinking"); // the init message arrives as this session's turn starts
    const mine = fakeDriver();
    driversOf(rig.sup).set(s.id, mine);
    const before = events().length;

    rig.sup.mcp.gate.onInit(s, [
      { name: "echo", status: "failed" },
      { name: "web", status: "connected" },
      { name: "anvil_cad", status: "failed" }, // not an integration: none of this registry's business
      { name: "ghost", status: "failed" },
    ]);

    const st = rig.sup.mcpIntegrationsEvent().integrations;
    expect(st.find((i) => i.key === "echo")!.health.state).toBe("unavailable");
    expect(st.find((i) => i.key === "web")!.health).toEqual({ state: "ready" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Echo failed to start");
    expect(events().slice(before)).toHaveLength(1);
    expect(idleDriver.stopped).toBe(true); // the other session's idle driver is rebuilt without it
    expect(mine.stopped).toBe(false); // this one is mid-turn: rebuilt at turn end
    expect(rig.sup.mcp.rebuildPending(s.id)).toBe(true);
    expect(rig.sup.mcp.serversFor(other, undefined)).toBeUndefined(); // …and it is left out of the next build

    // The PATH probe still says ready; the automatic probes must not undo the report.
    await rig.sup.mcp.probe("turn");
    rig.registry.clients = 1;
    await rig.sup.mcp.tick();
    expect(rig.sup.mcpIntegrationsEvent().integrations.find((i) => i.key === "echo")!.health.state).toBe("unavailable");
    await rig.sup.mcpIntegrationCheck();
    expect(rig.sup.mcpIntegrationsEvent().integrations.find((i) => i.key === "echo")!.health).toEqual({ state: "ready" });
  });
});

describe("health loop", () => {
  test("[C1] the timer probes only while a client is connected", async () => {
    rig.sup.mcp.add(echoInput());
    await settle();
    const base = rig.prober.calls;
    rig.registry.clients = 0;
    await rig.sup.mcp.tick();
    expect(rig.prober.calls).toBe(base);
    rig.registry.clients = 2;
    await rig.sup.mcp.tick();
    expect(rig.prober.calls).toBe(base + 1);
  });

  test("[C1] concurrent probe requests share one probe", async () => {
    rig.sup.mcp.add(echoInput());
    await settle();
    const base = rig.prober.calls;
    await Promise.all([rig.sup.mcp.probe("turn"), rig.sup.mcp.probe("turn"), rig.sup.mcp.probe("connect")]);
    expect(rig.prober.calls).toBe(base + 1);
  });

  test("[C1] a session with integrations on needs a probe before its turn; one without, or a non-ordinary one, does not", async () => {
    const echo = rig.sup.mcp.add(echoInput());
    const s = await rig.session();
    expect(rig.sup.mcp.needsProbeBeforeTurn(s.data)).toBe(false);
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    expect(rig.sup.mcp.needsProbeBeforeTurn(s.data)).toBe(true);
    expect(rig.sup.mcp.needsProbeBeforeTurn({ ...s.data, isDefault: true })).toBe(false);
  });

  test("[C1] the tick releases a lock whose holder has been silent for 10 minutes and broadcasts the change", async () => {
    const echo = rig.sup.mcp.add(echoInput({ exclusive: true }));
    const s = await rig.session({ autonomy: "bypass" });
    rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
    await settle();
    await callHook(s, rig.broker, "mcp__echo__ping", { inProcessKeys: [], gate: rig.sup.mcp.gate });
    expect(events().at(-1)!.integrations[0]!.heldBy).toBe(s.id);
    rig.clock.advance(10 * 60_000);
    const before = events().length;
    await rig.sup.mcp.tick();
    expect(events()).toHaveLength(before + 1);
    expect(events().at(-1)!.integrations[0]!.heldBy).toBeUndefined();
  });
});
