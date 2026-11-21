/**
 * [C4] Real-tool suite for the throwaway test daemon (agent-cad-and-browser §5 Phase C4, §4.14 item 33,
 * §8.3): the daemon's own `start_test_daemon` really builds THIS checkout's web bundle into a new
 * temporary home and really boots THIS checkout's daemon from it, credential-less, on loopback. The
 * real pinned Playwright MCP server drives real headless Chrome (C2's launch line, `--isolated
 * --headless`, wrapped in `env -i`) through the session's real proxy to the test daemon's root page,
 * and a second session's proxy is refused on the same port.
 *
 * The session worktree is a new temp folder whose `anvild` is a symlink to this checkout's `anvild/`,
 * so the browser's output folder and `.git/info/exclude` land in the temp folder, never in the repo.
 * This test process's own HOME is a new temp folder as well, so nothing the daemon under test does can
 * touch the owner's home through either process. The live daemon (7701) is never contacted; no headed
 * browser is started ("Open agent browser" has a launcher that throws).
 *
 * Skipped unless ANVIL_REAL_TOOLS=1. Under it, a missing Chrome, node or npm FAILS.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpIntegration } from "@protocol";
import { defaultMcpChildEnv, wrapStdio } from "../../src/agent/mcp-external";
import { testDaemonTools } from "../../src/agent/testdaemon-tools";
import { buildBrowserLaunch } from "../../src/browser/preset";
import { browserRuntimeCli } from "../../src/browser/runtime";
import { browserIntegrationDefaults } from "../../src/browser/service";
import { TEST_DAEMON_ENV_KEYS, TEST_DAEMON_HOME_PREFIX } from "../../src/browser/testdaemon";
import { resolveOnPath } from "../../src/mcp/health";
import type { Session } from "../../src/session/session";
import { McpStdioClient } from "../fixtures/browser/mcp-stdio-client";
import { callHookFull, mcpRig, settle, type McpRig } from "../helpers/mcp";
import { REAL } from "../helpers/real-tools";
import { proxyGet } from "../helpers/testdaemon";

const ANVILD = resolve(import.meta.dir, "../..");
const REPO = resolve(ANVILD, "..");

let rig: McpRig;
let worktree: string;
let testHome: string;
let savedHome: string | undefined;
let a: Session;
let b: Session;
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let url = "";
let port = 0;
let pid = 0;
let home = "";
let gitStatusBefore = "";
let distMtimeBefore = 0;

const sh = (cmd: string[]): string => Bun.spawnSync(cmd).stdout.toString();
const browser = () => rig.sup.mcp.browser!;
const proxyPort = (s: Session): number => browser().proxies.get(s.id)!.port;
const gitStatus = (): string => sh(["git", "-C", REPO, "status", "--porcelain"]);
const distMtime = (): number => (existsSync(join(ANVILD, "web", "dist", "index.html")) ? statSync(join(ANVILD, "web", "dist", "index.html")).mtimeMs : 0);

/** `ps eww` prints the command followed by the environment it was started with: the variable names. */
function liveEnv(p: number): Record<string, string> {
  const line = sh(["/bin/ps", "eww", "-o", "command=", "-p", String(p)]).trim();
  const env: Record<string, string> = {};
  for (const tok of line.split(" ")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok);
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

/** Open files of a process (`lsof -Fftan`): every row's fd, access mode, type and name. */
function openFiles(p: number): { fd: string; access: string; type: string; name: string }[] {
  const out: { fd: string; access: string; type: string; name: string }[] = [];
  let cur: { fd: string; access: string; type: string; name: string } | undefined;
  for (const line of sh(["/usr/sbin/lsof", "-nP", "-p", String(p), "-F", "fatn"]).split("\n")) {
    const tag = line[0];
    const v = line.slice(1);
    if (tag === "f") out.push((cur = { fd: v, access: "", type: "", name: "" }));
    else if (cur && tag === "a") cur.access = v;
    else if (cur && tag === "t") cur.type = v;
    else if (cur && tag === "n") cur.name = v;
  }
  return out;
}

beforeAll(async () => {
  if (!REAL) return;
  // This process's HOME is a temp folder too (the brief: nothing may reach the owner's home).
  savedHome = process.env.HOME;
  testHome = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4-real-home-")));
  process.env.HOME = testHome;
  gitStatusBefore = gitStatus();
  distMtimeBefore = distMtime();

  worktree = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4-real-wt-")));
  symlinkSync(ANVILD, join(worktree, "anvild"));
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
  writeFileSync(join(worktree, ".git", "info", "exclude"), "");
  rig = mcpRig({
    features: ["mcp-integrations", "browser"],
    realProber: true,
    browser: {
      desktopProbe: () => ({ desktop: false, reason: "the real suite runs headless" }),
      sitesIntervalMs: 0,
      agentBrowserLauncher: () => {
        throw new Error("the real suite never opens the owner's Chrome");
      },
    },
  });
  integration = rig.sup.mcp.add(browserIntegrationDefaults());
  await rig.sup.browserRuntimeInstall();
  await rig.sup.mcpIntegrationCheck();
  a = await rig.session({ cwd: worktree, autonomy: "bypass" });
  b = await rig.session({ cwd: worktree, autonomy: "bypass" });
  for (const s of [a, b]) rig.sup.setSessionMcpIntegrations(s.id, [integration.id]);
  await settle();
  for (const s of [a, b]) expect(rig.sup.mcp.serversFor(s, undefined)?.browser).toBeDefined(); // starts each session's proxy
}, 600_000);

afterAll(async () => {
  if (!REAL) return;
  await client?.close();
  browser()?.testDaemons.stopAll("the real suite is done");
  await rig?.cleanup();
  if (worktree) rmSync(worktree, { recursive: true, force: true });
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
}, 60_000);

describe("the worktree's real daemon, credential-less, through the real proxy", () => {
  test.skipIf(!REAL)("[C4] real: start_test_daemon builds the bundle into the temp home and boots this checkout's daemon; the live process's environment (ps eww) is exactly the listed variables, HOME a new temp folder, and the repo is not written", async () => {
    const tool = testDaemonTools(browser().testDaemons, a).find((t) => t.name === "start_test_daemon")!;
    const out = (await tool.handler({}, {} as never)) as { content: { text: string }[]; isError?: boolean };
    expect(out.isError).toBeUndefined();
    url = (JSON.parse(out.content[0]!.text.split("\n")[0]!) as { url: string }).url;
    port = Number(new URL(url).port);
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).not.toBe(7701);
    const health = (await (await fetch(`${url}/api/health`)).json()) as { ok: boolean; subscriptionAuthOk?: boolean };
    expect(health.ok).toBe(true);
    expect(health.subscriptionAuthOk).toBe(false); // no credentials reached it

    pid = Number(sh(["/usr/sbin/lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).trim().split("\n")[0]);
    expect(pid).toBeGreaterThan(1);
    expect(sh(["/bin/ps", "-o", "command=", "-p", String(pid)])).toContain("src/main.ts");
    const env = liveEnv(pid);
    expect(Object.keys(env).sort()).toEqual([...TEST_DAEMON_ENV_KEYS].sort());
    home = env.HOME!;
    expect(home.split("/").pop()!.startsWith(TEST_DAEMON_HOME_PREFIX)).toBe(true);
    expect(home).not.toBe(testHome);
    expect(home).not.toBe(savedHome);
    expect(env).toMatchObject({ ANVIL_HOST: "127.0.0.1", ANVIL_PORT: String(port), ANVIL_STATE_DIR: join(home, "state"), ANVIL_CLONES_DIR: join(home, "repos"), ANVIL_WEB_DIR: join(home, "web", "dist"), ANVIL_BASE_URL: url, ANVIL_LAPO_DISABLE: "1", TMPDIR: join(home, "tmp") });
    expect(env.PATH!.endsWith(":/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true);
    expect(existsSync(join(home, "web", "dist", "index.html"))).toBe(true); // the bundle went into the temp home…
    expect(distMtime()).toBe(distMtimeBefore); // …not into the checkout's web/dist
    expect(gitStatus()).toBe(gitStatusBefore);
  }, 300_000);

  test.skipIf(!REAL)("[C4] real: it listens on loopback only — lsof shows one listener, on 127.0.0.1 — and a connection to a non-loopback local address on that port is refused", async () => {
    const rows = sh(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).trim().split("\n").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toContain(`127.0.0.1:${port} (LISTEN)`);
    const others = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === "IPv4").map((i) => i!.address);
    console.log(`[C4 real] non-loopback local IPv4 addresses tried: ${others.join(", ") || "(none on this machine)"}`);
    for (const addr of others) {
      const refused = await new Promise<boolean>((done) => {
        const s = connect({ host: addr, port });
        s.setTimeout(3000, () => (s.destroy(), done(true)));
        s.once("connect", () => (s.destroy(), done(false)));
        s.once("error", () => done(true));
      });
      expect([addr, refused]).toEqual([addr, true]);
    }
  }, 60_000);

  test.skipIf(!REAL)("[C4] real: the real headless browser, launched with C2's line through session A's proxy, loads the test daemon's root page; session B's proxy gets 403 on the same port and a loopback fixture standing in for the live daemon is refused for both", async () => {
    const launch = buildBrowserLaunch({ mode: "headless", proxyPort: proxyPort(a), worktree, stateDir: rig.dir, sessionId: a.id, nodePath: resolveOnPath("node")!, cliPath: browserRuntimeCli(rig.dir) });
    expect(launch.args).toContain("--headless");
    expect(launch.args).toContain("--isolated");
    const line = wrapStdio(launch.command, launch.args, defaultMcpChildEnv());
    client = await McpStdioClient.start(line.command, line.args, { cwd: worktree, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-must-not-leak" } });

    const hook = await callHookFull(a, rig.broker, "mcp__browser__browser_navigate", { inProcessKeys: [], gate: rig.sup.mcp.gate }, { url: `${url}/` });
    expect(hook.decision).toBe("allow"); // the session's own test daemon: no site prompt
    const { reply, text } = await client.tool("browser_navigate", { url: `${url}/` });
    rig.sup.mcp.gate.onToolResult(a, "browser", { tool: "browser_navigate", input: { url: `${url}/` }, content: reply.content, isError: reply.isError === true });
    expect(reply.isError).not.toBe(true);
    expect(text).toContain(`Page URL: ${url}/`);
    expect(text).toContain("Page Title: Anvil");
    expect(text).not.toContain("HTTP status: 403");

    // The second session's proxy refuses the same port; the target never answers it.
    const theirs = await proxyGet(proxyPort(b), `${url}/`);
    expect(theirs.status).toBe(403);
    expect(theirs.body).toMatch(/Blocked by Anvil/);
    // A loopback server standing in for the live daemon (never 7701 itself) is refused for both.
    let hits = 0;
    const live = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (hits++, new Response("live daemon stand-in")) });
    try {
      for (const s of [a, b]) expect((await proxyGet(proxyPort(s), `http://127.0.0.1:${live.port}/`)).status).toBe(403);
      expect(hits).toBe(0);
    } finally {
      live.stop(true);
    }
    // Session A's proxy still reaches its own.
    expect((await proxyGet(proxyPort(a), `${url}/api/health`)).status).toBe(200);
  }, 300_000);

  test.skipIf(!REAL)("[C4] real: the child writes only under its own temp home — every file it holds open for writing is inside that home — and its process and temp home are gone after the turn ends", async () => {
    const files = openFiles(pid);
    expect(files.length).toBeGreaterThan(0);
    const writable = files.filter((f) => f.type === "REG" && /[wu]/.test(f.access));
    console.log(`[C4 real] ${files.length} open files; ${writable.length} regular files open for writing: ${writable.map((f) => f.name).join(", ") || "(none)"}`);
    for (const f of writable) expect([f.name, f.name.startsWith(`${home}/`)]).toEqual([f.name, true]);
    // What it did write (its state) is inside its home.
    expect(existsSync(join(home, "state"))).toBe(true);
    // Nothing appeared in this process's (temp) home from the child, and the repo is unchanged.
    expect(readdirSync(testHome).filter((n) => n.startsWith(TEST_DAEMON_HOME_PREFIX))).toEqual([]);
    expect(gitStatus()).toBe(gitStatusBefore);

    rig.sup.mcp.gate.onTurnEnd(a); // what the driver calls when the turn's result arrives
    expect(existsSync(home)).toBe(false);
    expect(browser().proxies.get(a.id)!.allowedLoopbackPorts()).toEqual([]);
    for (let i = 0; i < 50 && sh(["/bin/ps", "-o", "pid=", "-p", String(pid)]).trim(); i++) await Bun.sleep(100);
    expect(sh(["/bin/ps", "-o", "pid=", "-p", String(pid)]).trim()).toBe("");
    expect(sh(["/usr/sbin/lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).trim()).toBe("");
    expect(existsSync(home)).toBe(false); // still gone once the process is (no late write recreated it)
    expect((await proxyGet(proxyPort(a), `${url}/`)).status).toBe(403);
  }, 60_000);
});
