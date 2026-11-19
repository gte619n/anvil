/**
 * [C1] Regressions for the findings of the adversarial review of Phase C1. Real store, service,
 * Supervisor and permission hook (the `mcpRig` of test/helpers/mcp.ts); one test launches `/usr/bin/env`
 * for real to show what the wrap would otherwise have run.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { buildMcpServers, wrapStdio } from "../../src/agent/mcp-external";
import { McpHealthTracker } from "../../src/mcp/health";
import { MCP_STORE_FILE } from "../../src/mcp/store";
import { keyProblem, transportProblem } from "../../src/mcp/validate";
import type { Session } from "../../src/session/session";
import { callHook, echoInput, fakeClock, fakeProber, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";

let rig: McpRig;
beforeEach(() => {
  rig = mcpRig();
});
afterEach(() => rig.cleanup());

const hook = (s: Session, tool: string) => callHook(s, rig.broker, tool, { inProcessKeys: [], gate: rig.sup.mcp.gate });
const ENV = { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" };

async function withEcho(): Promise<{ echo: McpIntegration; s: Session }> {
  const echo = rig.sup.mcp.add(echoInput());
  await rig.sup.mcpIntegrationCheck();
  const s = await rig.session();
  rig.sup.setSessionMcpIntegrations(s.id, [echo.id]);
  await settle();
  return { echo, s };
}

describe("C1 review findings", () => {
  test("[C1] review 1: updating an integration denies its parked card, so a late 'always' is neither an allow nor remembered", async () => {
    const { echo, s } = await withEcho();
    const ping = hook(s, "mcp__echo__ping");
    expect(await isPending(ping)).toBe(true);
    const staleId = parked(s).requestId;

    rig.sup.mcpIntegrationUpdate(echo.id, { transport: { type: "stdio", command: "/bin/sh", args: ["-c", "evil"] } });

    expect((await ping).decision).toBe("deny"); // the card was retired by the update
    expect(s.pendingPermissions.size).toBe(0);
    expect(() => rig.sup.resolvePermission(staleId, "allow_always")).toThrow(/no pending permission/);
    expect(s.data.mcpAllowed).toBeUndefined();

    await rig.sup.mcpIntegrationCheck();
    const pong = hook(s, "mcp__echo__pong");
    expect(await isPending(pong)).toBe(true); // the edited integration prompts afresh
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    await pong;
  });

  test("[C1] review 1: the approval is for the definition that was shown — an edit behind an open card denies the call even when the card is answered 'always'", async () => {
    const { echo, s } = await withEcho();
    const ping = hook(s, "mcp__echo__ping");
    expect(await isPending(ping)).toBe(true);

    // Edit the store behind the service's back, so nothing retires the card: only the signature
    // comparison in the permission gate stands between the old answer and the new definition.
    rig.sup.mcp.store.update(echo.id, { transport: { type: "stdio", command: "/bin/sh", args: ["-c", "evil"] } });
    rig.sup.resolvePermission(parked(s).requestId, "allow_always");

    const out = await ping;
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/changed while this call was waiting/);
    expect(s.data.mcpAllowed).toBeUndefined();
  });

  test("[C1] review 1: removing an integration denies its parked card", async () => {
    const { echo, s } = await withEcho();
    const ping = hook(s, "mcp__echo__ping");
    expect(await isPending(ping)).toBe(true);
    rig.sup.mcpIntegrationRemove(echo.id);
    expect((await ping).decision).toBe("deny");
    expect(s.pendingPermissions.size).toBe(0);
  });

  test("[C1] review 2: a failed-at-start hold survives another integration's edit and another session's Tools toggle; its own edit or Check clears it", async () => {
    const prober = fakeProber();
    const tracker = new McpHealthTracker(prober, fakeClock());
    const a: McpIntegration = { id: "mcpi_a", key: "a1", kind: "custom", label: "A", transport: { type: "stdio", command: "a", args: [] }, exclusive: false, enabled: true };
    const b: McpIntegration = { ...a, id: "mcpi_b", key: "b1", label: "B" };
    await tracker.probeAll([a, b], "start");
    tracker.markFailed(a, "it failed to start");
    tracker.markFailed(b, "it failed to start");

    for (const trigger of ["set", "change", "turn", "timer", "connect"] as const) {
      await tracker.probeAll([a, b], trigger);
      expect(tracker.get(a).health).toEqual({ state: "unavailable", reason: "it failed to start" });
      expect(tracker.get(b).health).toEqual({ state: "unavailable", reason: "it failed to start" });
    }
    tracker.forget(a.id); // what the service does when A itself is edited or toggled
    await tracker.probeAll([a, b], "change");
    expect(tracker.get(a).health).toEqual({ state: "ready" });
    expect(tracker.get(b).health).toEqual({ state: "unavailable", reason: "it failed to start" }); // B's hold is its own

    await tracker.probeAll([a, b], "check");
    expect(tracker.get(b).health).toEqual({ state: "ready" });
  });

  test("[C1] review 2: through the service — toggling Tools on another session and adding another integration leave a failed server unavailable", async () => {
    const { echo, s } = await withEcho();
    rig.sup.mcp.gate.onInit(s, [{ name: "echo", status: "failed" }]);
    const health = () => rig.sup.mcp.statuses().find((i) => i.id === echo.id)!.health.state;
    expect(health()).toBe("unavailable");

    const other = await rig.session();
    rig.sup.setSessionMcpIntegrations(other.id, [echo.id]); // "set" probe
    rig.sup.mcp.add(echoInput({ key: "second", label: "Second" })); // "change" probe
    await rig.sup.mcp.probe("set");
    await rig.sup.mcp.probe("change");
    expect(health()).toBe("unavailable");

    await rig.sup.mcpIntegrationCheck();
    expect(health()).toBe("ready");
  });

  test("[C1] review 3: a command env would misread (NAME=value, or an option) is refused by the store, and wrapStdio never emits it", async () => {
    // What the old wrap did with such a command: env takes FOO=bar as an assignment and runs the NEXT word.
    const naive = Bun.spawnSync(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "FOO=bar", "/bin/echo", "INJECTED"]);
    expect(naive.stdout.toString().trim()).toBe("INJECTED");

    expect(transportProblem({ type: "stdio", command: "FOO=bar", args: ["/bin/echo", "INJECTED"] })).toMatch(/must not contain "="/);
    expect(transportProblem({ type: "stdio", command: "-u", args: ["PATH", "x"] })).toMatch(/must not start with "-"/);
    expect(transportProblem({ type: "stdio", command: "/opt/a=b/server", args: [] })).toMatch(/must not contain "="/);
    expect(() => rig.sup.mcp.add(echoInput({ transport: { type: "stdio", command: "FOO=bar", args: ["/bin/echo", "INJECTED"] } }))).toThrow(/must not contain "="/);
    expect(() => rig.sup.mcp.add(echoInput({ transport: { type: "stdio", command: "-S", args: ["/bin/echo x"] } }))).toThrow(/must not start with "-"/);

    expect(() => wrapStdio("FOO=bar", ["/bin/echo", "INJECTED"], ENV)).toThrow();
    expect(() => wrapStdio("-u", ["PATH"], ENV)).toThrow();
    // An ordinary command keeps the same line: the command directly after the three assignments.
    expect(wrapStdio("cmd", ["a=b", "-x"], ENV).args).toEqual(["-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "cmd", "a=b", "-x"]);
  });

  test("[C1] review 3: a hand-edited store with such a command is skipped by name at build time, never launched", async () => {
    const { echo, s } = await withEcho();
    const status = { ...rig.sup.mcp.statuses().find((i) => i.id === echo.id)!, transport: { type: "stdio" as const, command: "FOO=bar", args: ["/bin/echo", "INJECTED"] } };
    const { servers, skipped } = buildMcpServers(s.data, undefined, [status], ENV);
    expect(servers).toEqual({});
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/must not contain "="/);
  });

  test("[C1] review 4: the permission gate itself denies the three MCP resource tools, under every policy including bypass", async () => {
    const { s } = await withEcho();
    for (const autonomy of ["mostly-autonomous", "bypass"] as const) {
      s.data.autonomy = autonomy;
      for (const tool of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]) {
        const out = await hook(s, tool);
        expect(out.decision).toBe("deny");
        expect(out.reason).toMatch(/MCP resources/);
      }
    }
    // …and with no MCP context at all (a hook built the pre-registry way).
    expect((await callHook(s, rig.broker, "ReadMcpResourceTool", undefined)).decision).toBe("deny");
    expect(s.pendingPermissions.size).toBe(0);
  });

  test("[C1] review 5: a key that names an Object.prototype member is refused by the store and never reads as 'already used'", async () => {
    expect(keyProblem("constructor")).toMatch(/not allowed/);
    expect(() => rig.sup.mcp.add(echoInput({ key: "constructor" }))).toThrow(/not allowed/);

    // A hand-edited store row with that key is dropped on load, and a status that names it is skipped
    // for its key — not for colliding with a server that does not exist.
    const { echo, s } = await withEcho();
    const forged = { ...rig.sup.mcp.statuses().find((i) => i.id === echo.id)!, key: "constructor" };
    const { servers, skipped } = buildMcpServers(s.data, undefined, [forged], ENV);
    expect(Object.keys(servers)).toEqual([]);
    expect(skipped[0]!.reason).not.toMatch(/already used/);
    expect(skipped[0]!.reason).toMatch(/not allowed/);
  });

  test("[C1] review 6: an http URL is stored and forwarded in its normalized form", async () => {
    const web = rig.sup.mcp.add(echoInput({ key: "web", label: "Web", transport: { type: "http", url: "  HTTP://LOCALHOST:8123/a/../mcp  " } }));
    expect(web.transport).toEqual({ type: "http", url: "http://localhost:8123/mcp" });
    const onDisk = JSON.parse(readFileSync(join(rig.dir, MCP_STORE_FILE), "utf8")) as { integrations: McpIntegration[] };
    expect(onDisk.integrations.find((i) => i.key === "web")!.transport).toEqual({ type: "http", url: "http://localhost:8123/mcp" });

    // A hand-edited raw string is forwarded as the parsed form that was checked, not as typed.
    const s = await rig.session();
    const status = { ...web, transport: { type: "http" as const, url: "http://127.0.0.1:8123/x/../mcp" }, health: { state: "ready" as const }, checkedAt: 1 };
    s.data.mcpIntegrations = [web.id];
    const { servers } = buildMcpServers(s.data, undefined, [status], ENV);
    expect(servers.web).toEqual({ type: "http", url: "http://127.0.0.1:8123/mcp", alwaysLoad: true });
    writeFileSync(join(rig.dir, "touch"), ""); // keep the state dir non-empty until cleanup
  });
});
