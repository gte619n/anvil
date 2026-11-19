/**
 * [C3] Real-tool suite for the agent browser's Phase C3 (agent-cad-and-browser §8.3): downloads into
 * the quarantine from the real result text, and a hard stop on a real page with a real screenshot.
 *
 * Real Chrome and the real pinned `@playwright/mcp@0.0.86` (installed by the daemon's own installer
 * into a temporary state dir), the daemon's real proxy, and a loopback fixture site opened for this
 * session the way Phase C4's test daemon will be. The test speaks MCP to the server over stdio,
 * standing where the Claude CLI would; no Claude API call is made.
 *
 * Headless, always. Logged-in sites only exist in headed mode (the headless fallback refuses them),
 * so the SERVICE here is told a desktop session exists — its gate then applies the headed rules —
 * while the browser that is actually started is the preset's own headless launch line
 * (`buildBrowserLaunch({ mode: "headless" })`: `--isolated --headless`, a throwaway profile), wrapped
 * in `env -i` exactly as the registry wraps it. No headed Chrome is ever started, and "Open agent
 * browser" has a launcher that throws. Nothing here touches the live Anvil daemon, `~/.anvil` or a
 * real Chrome profile.
 *
 * Skipped unless ANVIL_REAL_TOOLS=1. Under it, a machine without Chrome, node or npm FAILS (the first
 * test asserts the integration is ready) rather than skipping.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { defaultMcpChildEnv, wrapStdio } from "../../src/agent/mcp-external";
import { buildBrowserLaunch, presetArgProblems } from "../../src/browser/preset";
import { browserRuntimeCli, browserRuntimeProblem } from "../../src/browser/runtime";
import { browserIntegrationDefaults } from "../../src/browser/service";
import { BROWSER_TOOL_NAMES } from "../../src/browser/tools";
import { quarantinePath } from "../../src/browser/downloads";
import { resolveOnPath } from "../../src/mcp/health";
import type { Session } from "../../src/session/session";
import { PART_STEP, startFixtureSite, type FixtureSite } from "../fixtures/browser/fixture-site";
import { McpStdioClient } from "../fixtures/browser/mcp-stdio-client";
import { callHookFull, isPending, mcpRig, parked, settle, type McpRig } from "../helpers/mcp";
import { REAL } from "../helpers/real-tools";

let rig: McpRig;
let worktree: string;
let site: FixtureSite;
let session: Session;
let integration: McpIntegration;
let client: McpStdioClient | undefined;
let proxyPort = 0;
const SITE = "127.0.0.1"; // the fixture's site, as the gate names it

const ps = (): string[] => Bun.spawnSync(["ps", "-axww", "-o", "command="]).stdout.toString().split("\n");
const browser = () => rig.sup.mcp.browser!;
const hook = (tool: string, input: Record<string, unknown> = {}) => callHookFull(session, rig.broker, `mcp__browser__${tool}`, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
const notices = (): string => JSON.stringify(rig.sup.resume(session.id).flatMap((e: any) => (e.type === "conversation.snapshot" ? e.events : [])).filter((e: any) => e.kind === "assistant"));
const fileCards = (): unknown[] => rig.sup.resume(session.id).flatMap((e: any) => (e.type === "conversation.snapshot" ? e.events : [])).filter((e: any) => e.kind === "file_offer");

/** Call a real tool and hand the raw result (text and image blocks) to the registry, exactly as the driver does. */
async function run(tool: string, input: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; content: unknown[] }> {
  const { reply, text } = await client!.tool(tool, input);
  rig.sup.mcp.gate.onToolResult(session, "browser", { tool, input, content: reply.content, isError: reply.isError === true });
  return { text, isError: reply.isError === true, content: (reply.content ?? []) as unknown[] };
}
/** Click the link whose accessible name is `name` (found in a fresh snapshot). Downloads make the click's own wait time out; that is fine. */
async function clickLink(name: string): Promise<string> {
  const snap = (await run("browser_snapshot")).text;
  const ref = new RegExp(`${name}[^\\n]*\\[ref=([^\\]]+)\\]`).exec(snap)?.[1];
  expect([name, ref !== undefined]).toEqual([name, true]);
  return (await run("browser_click", { element: name, target: ref, ref })).text;
}
/** Keep making harmless calls until some result has carried the "Downloaded file <name>" line. */
async function untilDownloaded(name: string, first: string): Promise<string> {
  let all = first;
  for (let i = 0; i < 20 && !all.includes(`Downloaded file ${name}`); i++) all += `\n${(await run("browser_wait_for", { time: 0.5 })).text}`;
  expect(all).toContain(`Downloaded file ${name}`);
  return all;
}

beforeAll(async () => {
  if (!REAL) return;
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c3-real-wt-")));
  mkdirSync(join(worktree, ".git", "info"), { recursive: true });
  writeFileSync(join(worktree, ".git", "info", "exclude"), "");
  site = startFixtureSite();
  rig = mcpRig({
    features: ["mcp-integrations", "browser"],
    realProber: true,
    browser: {
      // The gate applies the headed rules (logged-in sites exist only there); the browser this suite
      // starts is nevertheless the preset's HEADLESS line — see the file comment.
      desktopProbe: () => ({ desktop: true, reason: "the real suite tells the service a desktop exists; the browser it starts is headless" }),
      sitesIntervalMs: 0,
      agentBrowserLauncher: () => {
        throw new Error("the real suite never opens the owner's Chrome");
      },
    },
  });
  integration = rig.sup.mcp.add(browserIntegrationDefaults());
  await rig.sup.browserRuntimeInstall(); // the daemon's own installer, for real
  await rig.sup.mcpIntegrationCheck();
  session = await rig.session({ cwd: worktree, autonomy: "bypass" });
  rig.sup.setSessionMcpIntegrations(session.id, [integration.id]);
  await settle();
}, 600_000);

afterAll(async () => {
  if (!REAL) return;
  await client?.close();
  site?.stop();
  await rig?.cleanup();
  if (worktree) rmSync(worktree, { recursive: true, force: true });
  if (proxyPort) expect(ps().filter((l) => l.includes(`127.0.0.1:${proxyPort}`))).toEqual([]); // nothing this suite started outlives it
}, 60_000);

describe("real Chrome: downloads and hard stops", () => {
  test.skipIf(!REAL)("[C3] real: Chrome, node and the pinned runtime are present, and the headless launch line through the real proxy starts the server with its 25 tools", async () => {
    expect(rig.sup.mcp.statuses()[0]!.health).toEqual({ state: "ready" }); // not a skip: a machine missing Chrome, node or npm fails here
    expect(browserRuntimeProblem(rig.dir)).toBeUndefined();
    // Resolving the session's transport starts its proxy listener and records how the gate sees it.
    expect(rig.sup.mcp.serversFor(session, undefined)?.browser).toBeDefined();
    proxyPort = browser().proxies.get(session.id)!.port;
    expect(rig.sup.mcp.statuses()[0]!.browser).toMatchObject({ mode: "headed", desktop: true });

    const launch = buildBrowserLaunch({ mode: "headless", proxyPort, worktree, stateDir: rig.dir, sessionId: session.id, nodePath: resolveOnPath("node")!, cliPath: browserRuntimeCli(rig.dir) });
    expect(presetArgProblems(launch, browserRuntimeCli(rig.dir))).toEqual([]);
    expect(launch.args).toContain("--headless");
    expect(launch.args).toContain("--isolated");
    expect(launch.args).not.toContain("--user-data-dir");
    const line = wrapStdio(launch.command, launch.args, defaultMcpChildEnv());
    client = await McpStdioClient.start(line.command, line.args, { cwd: worktree, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-must-not-leak" } });
    expect((await client.request("tools/list")).tools.map((t: { name: string }) => t.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());

    // The fixture is a loopback server: opened for this session the way a registered test daemon is.
    expect(browser().registerTestDaemon(session.id, site.port)).toEqual({ ok: true });
    expect(browser().allowLoopbackPort(session.id, site.port)).toBe(true);
    browser().gate.state(session.id).once.add(SITE);
    expect((await hook("browser_navigate", { url: site.url("/dl") })).decision).toBe("allow");
    expect((await run("browser_navigate", { url: site.url("/dl") })).text).toContain("Page Title: Fixture Downloads");
    // The real Chrome is headless and on a throwaway profile; no headed profile was ever opened.
    const chrome = ps().find((l) => l.includes(`--proxy-server=http://127.0.0.1:${proxyPort}`) && !l.includes("--type="));
    expect(chrome).toBeDefined();
    expect(chrome).toContain("--headless");
    expect(chrome).not.toContain(join(rig.dir, "browser-profile"));
  }, 180_000);

  test.skipIf(!REAL)("[C3] real: a real download of a small part.step lands in the quarantine via the real result text, with no file card", async () => {
    const out = join(worktree, ".anvil-browser");
    const text = await untilDownloaded("part.step", await clickLink("Get part.step"));
    // The real line names the file inside this session's output folder.
    expect(text).toMatch(new RegExp(`- Downloaded file part\\.step to "${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/part\\.step"`));

    expect(readdirSync(join(worktree, ".anvil-downloads"))).toEqual(["part.step"]);
    expect(readFileSync(quarantinePath(worktree, "part.step"), "utf8")).toBe(PART_STEP); // the bytes the fixture served (about 1 KB)
    expect(PART_STEP.length).toBeGreaterThan(900);
    expect(existsSync(join(out, "part.step"))).toBe(false);
    // Playwright's own snapshot and console files were left where they were.
    expect(readdirSync(out).some((f) => /^page-.*\.yml$/.test(f))).toBe(true);
    expect(readdirSync(out).every((f) => /^(page|console)-/.test(f))).toBe(true);
    expect(fileCards()).toEqual([]);
    expect(notices()).toContain("Download `part.step` was put in quarantine at `.anvil-downloads/part.step`");
    // The model is told with its next call (the path it was given no longer exists).
    const next = await hook("browser_snapshot");
    expect(next.additionalContext).toContain('"part.step" was moved to .anvil-downloads/part.step');
    expect(readFileSync(join(worktree, ".git", "info", "exclude"), "utf8")).toContain(".anvil-downloads/");
  }, 180_000);

  test.skipIf(!REAL)("[C3] real: a .dmg download is deleted and reported", async () => {
    await run("browser_navigate", { url: site.url("/dl") });
    await untilDownloaded("tool.dmg", await clickLink("Get tool.dmg"));
    expect(existsSync(join(worktree, ".anvil-browser", "tool.dmg"))).toBe(false);
    expect(readdirSync(join(worktree, ".anvil-downloads"))).toEqual(["part.step"]); // nothing new in the quarantine
    expect(notices()).toContain("Download `tool.dmg` was deleted: .dmg files are not allowed");
    const next = await hook("browser_snapshot");
    expect(next.additionalContext).toContain('"tool.dmg" was DELETED: .dmg files are not allowed');
    expect(fileCards()).toEqual([]);
  }, 180_000);

  test.skipIf(!REAL)("[C3] real: with the fixture's site logged-in and locked, a real browser_click is gated while browser_snapshot is not, and the card carries a non-empty PNG from a real screenshot result; after Unlock the same click goes through to the real server", async () => {
    await run("browser_navigate", { url: site.url("/") });
    rig.sup.browserLoggedInAdd(SITE); // logged-in, locked
    expect(rig.sup.browserLoggedInEvent().sites).toEqual([expect.objectContaining({ site: SITE, unlocked: false })]);

    // A snapshot is not gated — and runs for real.
    expect((await hook("browser_snapshot")).decision).toBe("allow");
    const snap = (await run("browser_snapshot")).text;
    const ref = /Go to page two[^\n]*\[ref=([^\]]+)\]/.exec(snap)?.[1];
    expect(ref).toBeDefined();
    const click = { element: "Go to page two link", target: ref, ref };

    // The click is gated. With no screenshot of the page as it is, it is refused with the instruction…
    const first = await hook("browser_click", click);
    expect(first.decision).toBe("deny");
    expect(first.reason).toMatch(/browser_take_screenshot first/);
    // …the screenshot itself is a read (not gated), taken for real…
    expect((await hook("browser_take_screenshot")).decision).toBe("allow");
    const shot = await run("browser_take_screenshot");
    expect(shot.content.some((b: any) => b.type === "image")).toBe(true);
    // …and now the click parks a hard-stop card, under bypass.
    const gated = hook("browser_click", click);
    expect(await isPending(gated)).toBe(true);
    const card = parked(session) as ReturnType<typeof parked> & { reason?: string; image?: { attachmentId: string; mediaType: string } };
    expect(card.suggestions.map((s) => s.label)).toEqual(["Allow once", `Unlock ${SITE}`, "Deny"]);
    expect(card.reason).toBe(`click on ${SITE}, a logged-in site`);
    // The card's picture is the real screenshot: a PNG of real size, byte for byte what the browser returned.
    const stored = rig.sup.attachmentBytes(session.id, card.image!.attachmentId)!;
    const png = Buffer.from(await Bun.file(stored.path).arrayBuffer());
    expect(stored.mediaType).toBe("image/png");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeGreaterThan(1000);
    const real = (shot.content.find((b: any) => b.type === "image") as { data: string }).data;
    expect(png.equals(Buffer.from(real, "base64"))).toBe(true);
    expect(site.requests.filter((r) => r.path === "/page2")).toEqual([]); // the click has not happened

    // The owner chooses "Unlock 127.0.0.1": the call is allowed and runs on the real server.
    rig.sup.resolvePermission(card.requestId, "allow_always");
    expect((await gated).decision).toBe("allow");
    expect(rig.sup.browserLoggedInEvent().sites).toEqual([expect.objectContaining({ site: SITE, unlocked: true })]);
    const clicked = await run("browser_click", click);
    expect(clicked.text).toContain(`Page URL: ${site.url("/page2")}`);
    expect(site.requests.some((r) => r.path === "/page2")).toBe(true);

    // Unlocked: the next click on that site is not gated at all (no screenshot needed, no card).
    const back = (await run("browser_snapshot")).text;
    const backRef = /Back[^\n]*\[ref=([^\]]+)\]/.exec(back)?.[1];
    const again = await hook("browser_click", { element: "Back link", target: backRef, ref: backRef });
    expect(again.decision).toBe("allow");
    expect(session.pendingPermissions.size).toBe(0);
    expect((await run("browser_click", { element: "Back link", target: backRef, ref: backRef })).text).toContain(`Page URL: ${site.url("/")}`);
    // Locked again in Settings: the next click is gated again.
    rig.sup.browserLoggedInSetUnlocked(SITE, false);
    expect((await hook("browser_click", click)).decision).toBe("deny"); // (no current screenshot → the instruction)
  }, 180_000);
});
