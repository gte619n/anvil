/**
 * [C4] Functional scenario for the throwaway test daemon (agent-cad-and-browser §5 Phase C4
 * Acceptance, read with §4.14 item 33). A real Supervisor with the browser feature on, the real
 * per-session proxies, the real permission hook and the real gate; the only fake is the RUNNER: the
 * web build is recorded, and the "daemon" is a small loopback HTTP server inside this process, so the
 * proxy has something real to reach (test/helpers/testdaemon.ts). Nothing here builds a bundle, starts
 * a daemon or a browser, or touches port 7701 — the "live daemon" is a fixture on another loopback port.
 *
 * test/real/browser-c4.test.ts repeats the acceptance bullets with the worktree's real daemon.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PROTOCOL_VERSION, type McpIntegration } from "@protocol";
import { QuestionBroker, makeCanUseTool } from "../../src/agent/questions";
import { TEST_DAEMON_TOOL_IDS, TEST_MCP_SERVER_NAME, testDaemonTools } from "../../src/agent/testdaemon-tools";
import { TEST_DAEMON_ENV_KEYS, TEST_DAEMON_HOME_PREFIX, TEST_DAEMON_TTL_MS } from "../../src/browser/testdaemon";
import type { Session } from "../../src/session/session";
import { startFixtureSite, type FixtureSite } from "../fixtures/browser/fixture-site";
import { addBrowser, browserHook, browserOf, browserRig, browserSession, feedResult, pageResult } from "../helpers/browser";
import { callHook, isPending, parked, settle, type McpRig } from "../helpers/mcp";
import { FAKE_BUN, capturedTimers, fakeAnvilCheckout, fakeRunner, fakeTestDaemonSeams, proxyGet, type CapturedTimers, type FakeRunner } from "../helpers/testdaemon";

let rig: McpRig;
let integration: McpIntegration;
let runner: FakeRunner;
let timers: CapturedTimers;
let worktree: string;
let live: FixtureSite; // stands in for the LIVE daemon: a loopback server no session may reach
const cleanup: string[] = [];

const daemons = () => browserOf(rig).testDaemons;
const proxyPort = (s: Session): number => browserOf(rig).proxies.get(s.id)!.port;
const tools = (s: Session) => testDaemonTools(daemons(), s);
const callTool = async (s: Session, name: "start_test_daemon" | "stop_test_daemon"): Promise<{ text: string; isError: boolean }> => {
  const out = (await tools(s).find((t) => t.name === name)!.handler({}, {} as never)) as { content: { text: string }[]; isError?: boolean };
  return { text: out.content[0]!.text, isError: out.isError === true };
};
/** Start through the tool, as the model would, and return the URL it was given. */
const start = async (s: Session): Promise<string> => {
  const out = await callTool(s, "start_test_daemon");
  if (out.isError) throw new Error(out.text);
  return (JSON.parse(out.text.split("\n")[0]!) as { url: string }).url;
};
const lastStart = () => runner.starts[runner.starts.length - 1]!;
const IN_PROCESS = { inProcessKeys: ["anvil_human", TEST_MCP_SERVER_NAME] };

beforeEach(async () => {
  runner = fakeRunner();
  timers = capturedTimers();
  rig = browserRig({ browser: { testDaemon: fakeTestDaemonSeams(runner, timers) } });
  integration = await addBrowser(rig);
  worktree = fakeAnvilCheckout();
  live = startFixtureSite();
  cleanup.push(worktree);
});

afterEach(async () => {
  live.stop();
  await rig.cleanup();
  for (const s of runner.starts) {
    s.proc.killGroup();
    cleanup.push(s.opts.env.HOME!);
  }
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Acceptance: what is started", () => {
  test("[C4] Acceptance: the started process's environment is exactly the listed variables plus PATH and TMPDIR, with ANVIL_HOST=127.0.0.1 and HOME a new temporary folder, and nothing of the daemon's own environment is inherited", async () => {
    // Things a careless spawn would leak. They are in THIS process's environment while it starts.
    const planted = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-must-not-leak", OPENROUTER_API_KEY: "sk-or-must-not-leak", ANVIL_FEATURES: "browser", ANVIL_PORT: "1", ANVIL_STATE_DIR: "/must/not/leak" };
    const before = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    try {
      const s = await browserSession(rig, integration, { cwd: worktree });
      const url = await start(s);
      const st = lastStart();
      const env = st.opts.env;
      const home = env.HOME!;
      const port = Number(new URL(url).port);

      expect(Object.keys(env).sort()).toEqual([...TEST_DAEMON_ENV_KEYS].sort()); // exactly the list
      expect(env).toEqual({
        PATH: `${dirname(FAKE_BUN)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TMPDIR: join(home, "tmp"),
        HOME: home,
        ANVIL_HOST: "127.0.0.1",
        ANVIL_PORT: String(port),
        ANVIL_STATE_DIR: join(home, "state"),
        ANVIL_CLONES_DIR: join(home, "repos"),
        ANVIL_WEB_DIR: join(home, "web", "dist"),
        ANVIL_BASE_URL: `http://127.0.0.1:${port}`,
        ANVIL_LAPO_DISABLE: "1",
      });
      expect(JSON.stringify([st.command, st.args, st.opts])).not.toMatch(/must-not-leak|must\/not\/leak/);
      expect(JSON.stringify(runner.builds)).not.toMatch(/must-not-leak|must\/not\/leak/);
      expect([st.command, st.args, st.opts.cwd]).toEqual([FAKE_BUN, ["run", "src/main.ts"], join(worktree, "anvild")]);

      // HOME: new, temporary, made for this start — not this process's home, not the daemon's state dir.
      expect(basename(home).startsWith(TEST_DAEMON_HOME_PREFIX)).toBe(true);
      expect(dirname(home)).toBe(realpathSync(tmpdir()));
      expect(existsSync(join(home, "tmp"))).toBe(true);
      expect(home).not.toBe(process.env.HOME);
      expect(home.startsWith(rig.dir)).toBe(false);
      // The bundle was built from the worktree INTO that home: the worktree is not the output.
      expect(runner.builds.map((b) => [b.args, b.opts.cwd, b.opts.env.ANVIL_BUILD_OUT])).toEqual([[["run", "web/build.ts"], join(worktree, "anvild"), join(home, "web")]]);
      expect(Object.keys(runner.builds[0]!.opts.env).sort()).toEqual(["ANVIL_BUILD_OUT", "HOME", "PATH", "TMPDIR"]);
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).not.toBe(7701);
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("[C4] Acceptance: it is told to listen on loopback only — ANVIL_HOST and its base URL are 127.0.0.1, and the port is one this daemon registered for the session before anything listened on it", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree });
    const url = await start(s);
    const env = lastStart().opts.env;
    expect(env.ANVIL_HOST).toBe("127.0.0.1"); // the default would bind the tailnet address (config.ts)
    expect(new URL(env.ANVIL_BASE_URL!).hostname).toBe("127.0.0.1");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    // (That the real daemon then refuses its tailnet address is asserted in test/real/browser-c4.test.ts.)
    expect(browserOf(rig).proxies.get(s.id)!.allowedLoopbackPorts()).toEqual([Number(env.ANVIL_PORT)]);
  });

  test("[C4] a session whose repo is not Anvil is refused with a clear message, and nothing is built, started or opened", async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4-notanvil-")));
    cleanup.push(other);
    const s = await browserSession(rig, integration, { cwd: other });
    const out = await callTool(s, "start_test_daemon");
    expect(out).toEqual({ isError: true, text: expect.stringMatching(/only works in a checkout of Anvil itself \(this session's worktree has no anvild\/src\/main\.ts\)/) });
    expect([runner.builds.length, runner.starts.length]).toEqual([0, 0]);
    expect(browserOf(rig).proxies.get(s.id)!.allowedLoopbackPorts()).toEqual([]);
  });

  test("[C4] one test daemon per session: a second start_test_daemon returns the same URL and starts nothing", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree });
    const url = await start(s);
    const again = await callTool(s, "start_test_daemon");
    expect(JSON.parse(again.text.split("\n")[0]!)).toEqual({ url });
    expect(again.text).toContain("already running");
    expect([runner.builds.length, runner.starts.length]).toEqual([1, 1]);
  });
});

describe("Acceptance: who can reach it", () => {
  test("[C4] Acceptance: its port is reachable through the proxy from that session only — a second session's browser is refused on that port, before and after the second session starts a test daemon of its own", async () => {
    const a = await browserSession(rig, integration, { cwd: worktree });
    const b = await browserSession(rig, integration, { cwd: worktree });
    const url = await start(a);

    const mine = await proxyGet(proxyPort(a), `${url}/`);
    expect(mine.status).toBe(200);
    expect(mine.body).toContain("hello from the stand-in");
    const theirs = await proxyGet(proxyPort(b), `${url}/`);
    expect(theirs.status).toBe(403);
    expect(theirs.body).toMatch(/Blocked by Anvil: 127\.0\.0\.1 is a loopback address/);
    expect(lastStart().requests.filter((p) => p === "/")).toHaveLength(1); // the refused request never arrived

    // b's own test daemon opens b's port for b — and still not a's, nor b's for a.
    const urlB = await start(b);
    expect(urlB).not.toBe(url);
    expect((await proxyGet(proxyPort(b), `${urlB}/`)).status).toBe(200);
    expect((await proxyGet(proxyPort(b), `${url}/`)).status).toBe(403);
    expect((await proxyGet(proxyPort(a), `${urlB}/`)).status).toBe(403);
    expect((await proxyGet(proxyPort(a), `${url}/`)).status).toBe(200);
    // localhost for the same port is the same loopback address: reachable for its owner only.
    expect((await proxyGet(proxyPort(b), `http://[::1]:${new URL(url).port}/`)).status).toBe(403);
  });

  test("[C4] Acceptance: the live daemon's port stays refused for both sessions — a loopback server that is not the test daemon is never reachable, and this daemon's own port cannot be registered at all", async () => {
    const a = await browserSession(rig, integration, { cwd: worktree });
    const b = await browserSession(rig, integration, { cwd: worktree });
    const url = await start(a);
    expect(live.port).not.toBe(Number(new URL(url).port));

    for (const s of [a, b]) {
      const r = await proxyGet(proxyPort(s), live.url("/"));
      expect([s.id === a.id ? "a" : "b", r.status]).toEqual([s.id === a.id ? "a" : "b", 403]);
      expect(r.body).toMatch(/Blocked by Anvil/);
    }
    expect(live.requests).toEqual([]); // the stand-in for the live daemon was never contacted

    // The daemon's own listening port: registration is refused, so no exemption can ever exist for it.
    browserOf(rig).setFleet({ selfServerId: "srv_self", members: () => [], pairedHubId: () => null, selfUrl: async () => undefined, selfPort: live.port });
    expect(browserOf(rig).registerTestDaemon(a.id, live.port)).toEqual({ ok: false, reason: "that is this daemon's own port" });
    expect(browserOf(rig).allowLoopbackPort(a.id, live.port)).toBe(false);
    expect((await proxyGet(proxyPort(a), live.url("/"))).status).toBe(403);
    // …and a port that was never registered cannot be opened by number.
    expect(browserOf(rig).allowLoopbackPort(b.id, Number(new URL(url).port))).toBe(false);
    expect(live.requests).toEqual([]);
  });
});

describe("Acceptance: how it ends", () => {
  test("[C4] Acceptance: the process and its temporary home are gone after the turn ends, the port is closed in the proxy again, and a connection that was open to it is dropped", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree });
    const url = await start(s);
    const st = lastStart();
    const home = st.opts.env.HOME!;
    const port = Number(new URL(url).port);

    // A tunnel held open through the proxy (how the UI's WebSocket travels).
    const tunnel = connect({ host: "127.0.0.1", port: proxyPort(s) });
    const established = new Promise<string>((res) => tunnel.once("data", (b) => res(b.toString())));
    tunnel.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    expect(await established).toMatch(/^HTTP\/1\.1 200/);
    const closed = new Promise<void>((res) => tunnel.once("close", () => res()));

    rig.sup.mcp.gate.onTurnEnd(s); // exactly what the driver calls when the turn's result arrives

    expect(st.proc.killed).toBe(true); // its process group was killed
    expect(existsSync(home)).toBe(false); // its temporary home is deleted
    expect(daemons().origin(s.id)).toBeUndefined();
    expect(browserOf(rig).proxies.get(s.id)!.allowedLoopbackPorts()).toEqual([]);
    await closed; // the open tunnel was destroyed with the exemption
    expect((await proxyGet(proxyPort(s), `${url}/`)).status).toBe(403);
    expect(timers.timers.every((t) => t.cleared)).toBe(true);

    // The next turn can start a new one: a new home, a new process.
    const url2 = await start(s);
    expect(lastStart().opts.env.HOME).not.toBe(home);
    expect((await proxyGet(proxyPort(s), `${url2}/`)).status).toBe(200);
    // A turn that dies (the consume loop exits) ends it too.
    rig.sup.mcp.gate.onConsumeExit(s);
    expect(lastStart().proc.killed).toBe(true);
    expect(existsSync(lastStart().opts.env.HOME!)).toBe(false);
  });

  test("[C4] Acceptance (§7): a test daemon that outlives everything else is killed by the 15-minute timer — process gone, home deleted, port closed, and the session is told", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree });
    const url = await start(s);
    const st = lastStart();
    expect(timers.timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([TEST_DAEMON_TTL_MS]);
    expect(TEST_DAEMON_TTL_MS).toBe(15 * 60_000);

    expect(timers.fire()).toBe(1); // fifteen minutes pass on the fake clock
    expect(st.proc.killed).toBe(true);
    expect(existsSync(st.opts.env.HOME!)).toBe(false);
    expect((await proxyGet(proxyPort(s), `${url}/`)).status).toBe(403);
    expect(daemons().count()).toBe(0);
    expect(JSON.stringify(rig.sup.resume(s.id))).toContain("its 15 minutes are up");
  });

  test("[C4] it is also stopped by stop_test_daemon, when the session is reset, when it is deleted, when the browser is switched off for it, and when the daemon shuts down", async () => {
    const ended = (i: number): boolean[] => [runner.starts[i]!.proc.killed, existsSync(runner.starts[i]!.opts.env.HOME!)];
    const s1 = await browserSession(rig, integration, { cwd: worktree });
    await start(s1);
    expect(await callTool(s1, "stop_test_daemon")).toEqual({ text: "The test daemon was stopped and its temporary home deleted.", isError: false });
    expect(ended(0)).toEqual([true, false]);
    expect((await callTool(s1, "stop_test_daemon")).text).toBe("This session has no test daemon running.");

    await start(s1);
    await rig.sup.reset(s1.id);
    expect(ended(1)).toEqual([true, false]);

    const s2 = await browserSession(rig, integration, { cwd: worktree });
    await start(s2);
    await rig.sup.kill(s2.id);
    expect(ended(2)).toEqual([true, false]);

    const s3 = await browserSession(rig, integration, { cwd: worktree });
    await start(s3);
    rig.sup.setSessionMcpIntegrations(s3.id, []);
    expect(ended(3)).toEqual([true, false]);

    const s4 = await browserSession(rig, integration, { cwd: worktree });
    const s5 = await browserSession(rig, integration, { cwd: worktree });
    await start(s4);
    await start(s5);
    expect(daemons().count()).toBe(2);
    await rig.sup.shutdown();
    expect([ended(4), ended(5)]).toEqual([[true, false], [true, false]]);
    expect(daemons().count()).toBe(0);
  });
});

describe("the gate", () => {
  test("[C4] browser_evaluate is allowed on the session's test-daemon origin and denied elsewhere — through the real permission hook, under bypass too — and denied again the moment the daemon stops", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    const evaluate = () => browserHook(rig, s, "browser_evaluate", { function: "() => document.title" });
    expect((await evaluate()).decision).toBe("deny"); // no test daemon, no page

    const url = await start(s);
    expect((await evaluate()).decision).toBe("deny"); // running, but the page is not on it yet
    expect((await browserHook(rig, s, "browser_navigate", { url: `${url}/` })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", pageResult(`${url}/`, "Anvil"), { url: `${url}/` });
    expect(await evaluate()).toMatchObject({ decision: "allow", reason: expect.stringMatching(/own test daemon/) });

    // Elsewhere: an allowed public site, and a loopback page that is not the test daemon.
    browserOf(rig).gate.state(s.id).once.add("example.com");
    feedResult(rig, s, "browser_navigate", pageResult("https://example.com/"));
    expect(await evaluate()).toMatchObject({ decision: "deny", reason: expect.stringMatching(/only allowed on this session's own throwaway test daemon/) });
    browserOf(rig).gate.state(s.id).once.add("127.0.0.1");
    feedResult(rig, s, "browser_navigate", pageResult(live.url("/")));
    expect((await evaluate()).decision).toBe("deny");
    // browser_run_code_unsafe is never allowed, on the test daemon or anywhere.
    feedResult(rig, s, "browser_navigate", pageResult(`${url}/`));
    expect((await browserHook(rig, s, "browser_run_code_unsafe", { code: "async (page) => 1" })).decision).toBe("deny");
    expect((await evaluate()).decision).toBe("allow");

    // Another session standing on the same address has no test daemon of its own.
    rig.sup.mcp.gate.onTurnEnd(s);
    expect((await evaluate()).decision).toBe("deny"); // the turn ended: the daemon is gone, and so is the exemption
    expect(browserOf(rig).gate.state(s.id).closing?.reason).toMatch(/test daemon was stopped/);
  });

  test("[C4] the test-daemon origin is the session's own: navigating to it asks nobody under prompt-all, a page on it is not held, and it is never treated as a logged-in site even when 127.0.0.1 is on the owner's list", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "prompt-all" });
    const url = await start(s);
    browserOf(rig).loggedIn.add("127.0.0.1", "owner"); // locked, as every new logged-in site is
    expect(browserOf(rig).loggedIn.isLocked("127.0.0.1")).toBe(true);

    const nav = await browserHook(rig, s, "browser_navigate", { url: `${url}/` });
    expect(nav).toMatchObject({ decision: "allow", reason: expect.stringMatching(/own test daemon/) });
    expect(s.pendingPermissions.size).toBe(0); // no site card, no hard-stop card
    feedResult(rig, s, "browser_navigate", pageResult(`${url}/`, "Anvil"), { url: `${url}/` });
    expect(browserOf(rig).gate.state(s.id).hold).toBeUndefined();
    for (const [tool, input] of [["browser_click", { target: "e1", element: "Settings" }], ["browser_type", { target: "e2", text: "hello" }], ["browser_press_key", { key: "Enter" }]] as const) {
      expect([tool, (await browserHook(rig, s, tool, input)).decision]).toEqual([tool, "allow"]);
      feedResult(rig, s, tool, pageResult(`${url}/`, "Anvil"), input);
    }
    expect(s.pendingPermissions.size).toBe(0);
    // It was never written to the fleet's allowed-sites list, and no approval was recorded.
    expect(browserOf(rig).sites.isAllowed("127.0.0.1")).toBe(false);
    expect(browserOf(rig).gate.state(s.id).once.size).toBe(0);

    // Any OTHER loopback page is the listed, locked site: a click there is a hard stop.
    const other = browserHook(rig, s, "browser_navigate", { url: live.url("/") });
    expect(await isPending(other)).toBe(true);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    expect((await other).decision).toBe("deny");
  });
});

describe("permission and availability", () => {
  test("[C4] start_test_daemon follows the session's autonomy policy as a mutating tool: prompt-all and allowlist park a card (Deny refuses it), mostly-autonomous and bypass run it; it is not in allowedTools, so the canUseTool backstop denies it", async () => {
    const id = TEST_DAEMON_TOOL_IDS[0]!;
    for (const autonomy of ["prompt-all", "allowlist"] as const) {
      const s = await browserSession(rig, integration, { cwd: worktree, autonomy });
      const asked = callHook(s, rig.broker, id, { ...IN_PROCESS, gate: rig.sup.mcp.gate }, {});
      expect([autonomy, await isPending(asked)]).toEqual([autonomy, true]);
      expect(parked(s).tool).toBe(id);
      rig.sup.resolvePermission(parked(s).requestId, "deny");
      expect((await asked).decision).toBe("deny");
      rig.sup.mcp.gate.onTurnEnd(s);
    }
    for (const autonomy of ["mostly-autonomous", "bypass"] as const) {
      const s = await browserSession(rig, integration, { cwd: worktree, autonomy });
      expect([autonomy, (await callHook(s, rig.broker, id, { ...IN_PROCESS, gate: rig.sup.mcp.gate }, {})).decision]).toEqual([autonomy, "allow"]);
    }
    // An unattended (builder) session is NOT refused by a rule of this tool's own: the policy decides.
    const builder = await rig.session({ cwd: worktree, workUnitRole: "builder", workUnitId: "wu_1" } as never);
    expect((await callHook(builder, rig.broker, id, { ...IN_PROCESS, gate: rig.sup.mcp.gate }, {})).decision).toBe("allow");
    expect(runner.starts).toEqual([]); // a permission decision starts nothing

    // Fail closed: the ids are not auto-allowed, so a call that reaches canUseTool is denied.
    const s = await browserSession(rig, integration, { cwd: worktree });
    (rig.sup as unknown as { agentEnv: () => Record<string, string> }).agentEnv = () => ({}); // no Claude token in tests: the env is stubbed
    const driver = (rig.sup as unknown as { ensureDriver(id: string): { mcpServers?: Record<string, { type?: string }>; extraAllowedTools?: string[] } }).ensureDriver(s.id);
    expect(driver.mcpServers?.[TEST_MCP_SERVER_NAME]?.type).toBe("sdk");
    for (const toolId of TEST_DAEMON_TOOL_IDS) expect(driver.extraAllowedTools ?? []).not.toContain(toolId);
    const canUseTool = makeCanUseTool(s, new QuestionBroker(), driver.extraAllowedTools);
    const opts = { signal: new AbortController().signal, toolUseID: "tu_1" } as never;
    for (const toolId of TEST_DAEMON_TOOL_IDS) expect(((await canUseTool(toolId, {}, opts)) as { behavior: string }).behavior).toBe("deny");
  });

  test("[C4] only an ordinary session with the browser switched on gets the anvil_test server: a plain session, the concierge and a team lead do not, and with the browser feature off nothing of it exists", async () => {
    const driverOf = (r: McpRig, s: Session) => ((r.sup as unknown as { agentEnv: () => Record<string, string> }).agentEnv = () => ({}), r.sup as unknown as { ensureDriver(id: string): { mcpServers?: Record<string, unknown>; systemPrompt(): { append?: string } } }).ensureDriver(s.id);
    const withBrowser = await browserSession(rig, integration, { cwd: worktree });
    expect(Object.keys(driverOf(rig, withBrowser).mcpServers ?? {}).sort()).toEqual(["anvil_human", "anvil_test", "browser"]);
    expect(driverOf(rig, withBrowser).systemPrompt().append).toContain("mcp__anvil_test__start_test_daemon");

    const plain = await rig.session({ cwd: worktree });
    expect(driverOf(rig, plain).mcpServers).toBeUndefined();
    expect(driverOf(rig, plain).systemPrompt().append ?? "").not.toContain("start_test_daemon");
    const lead = await rig.session({ cwd: worktree, teamRole: "lead" } as never);
    expect(Object.keys(driverOf(rig, lead).mcpServers ?? {})).not.toContain(TEST_MCP_SERVER_NAME);
    // Without the proxy of a browser session a start is refused before anything is built.
    expect(await daemons().start(plain)).toEqual({ error: expect.stringMatching(/agent browser is not running for this session/) });
    expect(runner.builds).toEqual([]);

    const off = browserRig({ features: ["mcp-integrations"] });
    try {
      expect(off.sup.mcp.browser).toBeUndefined();
      const s = await off.sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: off.dir });
      expect(driverOf(off, s).mcpServers).toBeUndefined();
    } finally {
      await off.cleanup();
    }
    await settle();
  });
});
