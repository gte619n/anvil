/** [C1] Health probes (mcp-integrations spec §4.2; agent-cad-and-browser §4.14 item 31). */
import { describe, test, expect } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { McpHealthTracker, defaultMcpProber, resolveOnPath, tcpProbe } from "../../src/mcp/health";
import { tmpDir } from "../helpers";
import { fakeClock, fakeProber } from "../helpers/mcp";

const integ = (over: Partial<McpIntegration> = {}): McpIntegration => ({
  id: "mcpi_1",
  key: "echo",
  kind: "custom",
  label: "Echo",
  transport: { type: "stdio", command: "echo-mcp", args: [] },
  exclusive: false,
  enabled: true,
  ...over,
});

/** A loopback listener on an ephemeral port, and a port that is certainly closed. */
async function listener(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer((sock) => sock.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => srv.close(() => r())) };
}
async function closedPort(): Promise<number> {
  const l = await listener();
  await l.close();
  return l.port;
}

describe("probes", () => {
  test("[C1] tcpProbe: a listening loopback port is open, a closed one is not", async () => {
    const l = await listener();
    try {
      expect(await tcpProbe("127.0.0.1", l.port)).toBe(true);
    } finally {
      await l.close();
    }
    expect(await tcpProbe("127.0.0.1", l.port, 500)).toBe(false);
  });

  test("[C1] an http integration whose port is closed is unavailable, and ready once something listens", async () => {
    const port = await closedPort();
    const i = integ({ transport: { type: "http", url: `http://127.0.0.1:${port}/mcp` } });
    expect(await defaultMcpProber(i)).toEqual({ state: "unavailable", reason: `nothing is listening on port ${port}` });
    const l = await listener();
    try {
      expect(await defaultMcpProber(integ({ transport: { type: "http", url: `http://127.0.0.1:${l.port}/mcp` } }))).toEqual({ state: "ready" });
    } finally {
      await l.close();
    }
  });

  test("[C1] an http integration with a non-loopback URL is unavailable without any connection attempt", async () => {
    const h = await defaultMcpProber(integ({ transport: { type: "http", url: "http://example.com:80/mcp" } }));
    expect(h.state).toBe("unavailable");
    expect((h as { reason: string }).reason).toMatch(/this machine/);
  });

  test("[C1] a stdio integration is ready when its command resolves on PATH — the probe never launches it", async () => {
    const t = tmpDir("anvil-mcp-path-");
    try {
      const bin = join(t.dir, "bin");
      mkdirSync(bin);
      const marker = join(t.dir, "launched");
      // If the probe ever ran this, the marker file would appear.
      writeFileSync(join(bin, "probe-me"), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(bin, "probe-me"), 0o755);
      writeFileSync(join(bin, "not-executable"), "#!/bin/sh\n");
      chmodSync(join(bin, "not-executable"), 0o644);

      expect(resolveOnPath("probe-me", `/nonexistent:${bin}`)).toBe(join(bin, "probe-me"));
      expect(resolveOnPath("not-executable", bin)).toBeUndefined();
      expect(resolveOnPath("no-such-command-xyz", bin)).toBeUndefined();
      expect(resolveOnPath(join(bin, "probe-me"), "")).toBe(join(bin, "probe-me")); // an absolute path is checked as is
      expect(resolveOnPath("bin/probe-me", bin)).toBeUndefined(); // a relative path is never resolved
      expect(await Bun.file(marker).exists()).toBe(false);

      const saved = process.env.PATH;
      process.env.PATH = bin;
      try {
        expect(await defaultMcpProber(integ({ transport: { type: "stdio", command: "probe-me", args: [] } }))).toEqual({ state: "ready" });
        expect(await defaultMcpProber(integ({ transport: { type: "stdio", command: "no-such-command-xyz", args: [] } }))).toEqual({
          state: "unavailable",
          reason: "command not found: no-such-command-xyz",
        });
      } finally {
        process.env.PATH = saved;
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe("McpHealthTracker", () => {
  test("[C1] an integration never probed is unavailable (fail closed)", () => {
    const tracker = new McpHealthTracker(fakeProber(), fakeClock());
    expect(tracker.get(integ())).toEqual({ health: { state: "unavailable", reason: "not checked yet" }, checkedAt: 0 });
  });

  test("[C1] a probe that throws is unavailable with the error text", async () => {
    const prober = fakeProber();
    prober.health.set("echo", new Error("boom"));
    const clock = fakeClock(5000);
    const tracker = new McpHealthTracker(prober, clock);
    expect(await tracker.probeAll([integ()], "check")).toEqual(["mcpi_1"]);
    expect(tracker.get(integ())).toEqual({ health: { state: "unavailable", reason: "health check failed: boom" }, checkedAt: 5000 });
  });

  test("[C1] a disabled integration is `disabled` and is not probed", async () => {
    const prober = fakeProber();
    const tracker = new McpHealthTracker(prober, fakeClock());
    const off = integ({ enabled: false });
    await tracker.probeAll([off], "check");
    expect(prober.calls).toBe(0);
    expect(tracker.get(off).health).toEqual({ state: "disabled" });
    // A previously-ready integration reads disabled the moment it is switched off.
    await tracker.probeAll([integ()], "check");
    expect(tracker.get(integ()).health).toEqual({ state: "ready" });
    expect(tracker.get(off).health).toEqual({ state: "disabled" });
  });

  test("[C1] probeAll returns only the ids whose health changed", async () => {
    const prober = fakeProber();
    const tracker = new McpHealthTracker(prober, fakeClock());
    const a = integ();
    const b = integ({ id: "mcpi_2", key: "web" });
    expect((await tracker.probeAll([a, b], "check")).sort()).toEqual(["mcpi_1", "mcpi_2"]); // first result is a change
    expect(await tracker.probeAll([a, b], "timer")).toEqual([]);
    prober.health.set("web", { state: "unavailable", reason: "nothing is listening on port 9" });
    expect(await tracker.probeAll([a, b], "timer")).toEqual(["mcpi_2"]);
    prober.health.set("web", { state: "unavailable", reason: "a different reason" });
    expect(await tracker.probeAll([a, b], "timer")).toEqual(["mcpi_2"]); // the reason is part of what a client shows
    prober.health.delete("web");
    expect(await tracker.probeAll([a, b], "timer")).toEqual(["mcpi_2"]);
  });

  test("[C1] a server that failed at session init stays unavailable through turn, timer and connect probes, until Check", async () => {
    const prober = fakeProber(); // the PATH probe keeps saying ready — it cannot see a crash on launch
    const tracker = new McpHealthTracker(prober, fakeClock());
    const i = integ();
    await tracker.probeAll([i], "start");
    expect(tracker.get(i).health).toEqual({ state: "ready" });

    expect(tracker.markFailed(i, "it failed to start")).toBe(true);
    expect(tracker.markFailed(i, "it failed to start")).toBe(false); // no second change
    expect(tracker.get(i).health).toEqual({ state: "unavailable", reason: "it failed to start" });

    for (const trigger of ["turn", "timer", "connect"] as const) {
      expect(await tracker.probeAll([i], trigger)).toEqual([]);
      expect(tracker.get(i).health).toEqual({ state: "unavailable", reason: "it failed to start" });
    }
    expect(await tracker.probeAll([i], "check")).toEqual(["mcpi_1"]);
    expect(tracker.get(i).health).toEqual({ state: "ready" });
  });

  test("[C1] an integration that no longer exists is forgotten on the next probe", async () => {
    const tracker = new McpHealthTracker(fakeProber(), fakeClock());
    const i = integ();
    await tracker.probeAll([i], "check");
    await tracker.probeAll([], "check");
    expect(tracker.get(i).health).toEqual({ state: "unavailable", reason: "not checked yet" });
  });
});
