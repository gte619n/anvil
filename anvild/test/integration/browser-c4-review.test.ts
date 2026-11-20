/**
 * The fixes for the C4 review (decision log: C3 fixes and C4 vetoed). Real Supervisor, real gate, real
 * permission hook and real per-session proxies; the browser's traffic is reported to the service
 * exactly as the proxy reports it (`onSessionDecision`), and the test daemon is the fake runner's
 * in-process stand-in. Nothing here starts a browser or a daemon.
 * test/real/browser-c4-review.test.ts repeats items 1–3 against real Chrome.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { TRAFFIC_LOST_SITE } from "../../src/browser/gate";
import type { Session } from "../../src/session/session";
import { addBrowser, browserHook, browserOf, browserRig, browserSession, feedResult, pageResult } from "../helpers/browser";
import { callHook, isPending, parked, type McpRig } from "../helpers/mcp";
import { capturedTimers, fakeAnvilCheckout, fakeRunner, fakeTestDaemonSeams, type FakeRunner } from "../helpers/testdaemon";

let rig: McpRig;
let integration: McpIntegration;
let runner: FakeRunner;
let worktree: string;
const dirs: string[] = [];

beforeEach(async () => {
  runner = fakeRunner();
  rig = browserRig({ browser: { testDaemon: fakeTestDaemonSeams(runner, capturedTimers()) } });
  integration = await addBrowser(rig);
  worktree = fakeAnvilCheckout();
  dirs.push(worktree);
});
afterEach(async () => {
  await rig.cleanup();
  for (const s of runner.starts) {
    s.proc.killGroup();
    dirs.push(s.opts.env.HOME!);
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const contact = (s: Session, host: string, port = 443, allowed = true): void => browserOf(rig).proxies.onSessionDecision!(s.id, { kind: "connect", host, port, allowed });
const allow = (s: Session, ...sites: string[]): void => {
  for (const x of sites) browserOf(rig).gate.state(s.id).once.add(x);
};
const shotResult = (s: Session, marker = "inline"): void =>
  rig.sup.mcp.gate.onToolResult(s, "browser", { tool: "browser_take_screenshot", input: {}, content: [{ type: "text", text: "### Result\nTook a screenshot" }, { type: "image", data: Buffer.from(`\x89PNG\r\n\x1a\n${marker}`).toString("base64"), mimeType: "image/png" }], isError: false });

/** Start the session's (stand-in) test daemon and land its page, as a navigation result reports it. */
async function onOwnPage(s: Session, path = "/"): Promise<string> {
  const r = await browserOf(rig).testDaemons.start({ id: s.id, data: { cwd: worktree } });
  if ("error" in r) throw new Error(r.error);
  const url = `${r.url}${path}`;
  expect((await browserHook(rig, s, "browser_navigate", { url })).decision).toBe("allow");
  contact(s, "127.0.0.1", Number(new URL(r.url).port)); // its own port: not in the log
  feedResult(rig, s, "browser_navigate", pageResult(url), { url });
  return url;
}

describe("item 1: the session's own test daemon has no exemption from the traffic rules", () => {
  test("[C4] review 1: an own-origin page that moves itself to a locked logged-in site — the next key press, click and script are refused with 'take a snapshot first'; the snapshot then shows the site under its hard stop", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    await onOwnPage(s, "/timer");
    expect(browserOf(rig).gate.state(s.id).unknown).toBeUndefined(); // its own port does not count
    contact(s, "www.bank.test"); // its own timer sends it to the bank
    for (const [tool, input] of [["browser_press_key", { key: "Enter" }], ["browser_click", { target: "#pay" }], ["browser_evaluate", { function: "() => 1" }]] as const) {
      const v = await browserHook(rig, s, tool, input);
      expect([tool, v.decision]).toEqual([tool, "deny"]);
      expect(v.reason).toMatch(/page may have changed by itself.*bank\.test \(a locked logged-in site\).*browser_snapshot/);
    }
    expect((await browserHook(rig, s, "browser_snapshot")).decision).toBe("allow");
    feedResult(rig, s, "browser_snapshot", pageResult("https://www.bank.test/pay"));
    shotResult(s);
    const gated = browserHook(rig, s, "browser_press_key", { key: "Enter" });
    expect(await isPending(gated)).toBe(true);
    expect((parked(s) as { reason?: string }).reason).toMatch(/bank\.test/);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    expect((await gated).decision).toBe("deny");
  });

  test("[C4] review 1: an own-origin page that frames a locked logged-in site — a click is a hard stop naming it and browser_evaluate is refused; the own origin itself still needs no site prompt and a page with no such frame acts freely", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "mostly-autonomous" });
    browserOf(rig).loggedIn.add("bank.test", "owner");
    // No site prompt for the own origin, under the default policy.
    const plain = await onOwnPage(s, "/plain");
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
    expect((await browserHook(rig, s, "browser_evaluate", { function: "() => 1" })).decision).toBe("allow");
    // The page loads a frame from the locked bank (traffic after the navigation, before the result).
    expect((await browserHook(rig, s, "browser_navigate", { url: plain.replace("/plain", "/frame") })).decision).toBe("allow");
    contact(s, "bank.test");
    feedResult(rig, s, "browser_navigate", pageResult(plain.replace("/plain", "/frame")), { url: plain.replace("/plain", "/frame") });
    const click = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(click).toMatchObject({ decision: "deny", reason: expect.stringMatching(/this session's test daemon.*has loaded bank\.test, a logged-in site.*browser_take_screenshot/) });
    const script = await browserHook(rig, s, "browser_evaluate", { function: "() => 1" });
    expect(script).toMatchObject({ decision: "deny", reason: expect.stringMatching(/not allowed on a page that has loaded bank\.test/) });
    shotResult(s);
    const gated = browserHook(rig, s, "browser_click", { target: "e1" });
    expect(await isPending(gated)).toBe(true);
    expect(parked(s).suggestions.map((x) => x.label)).toEqual(["Allow once", "Unlock bank.test", "Deny"]);
    rig.sup.resolvePermission(parked(s).requestId, "deny");
    expect((await gated).decision).toBe("deny");
  });
});

describe("item 2: an overflowing traffic log", () => {
  test("[C3] review C4-2: allowed A frames locked B and then makes 2,100 same-site requests — the next click needs a snapshot, and after it the click is still a hard stop naming that Anvil lost track; a navigation to another page does not clear it, about:blank does", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test", "news.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://shop.test/embed" })).decision).toBe("allow");
    contact(s, "shop.test");
    contact(s, "bank.test"); // the frame
    feedResult(rig, s, "browser_navigate", pageResult("https://shop.test/embed"), { url: "https://shop.test/embed" });
    for (let i = 0; i < 2100; i++) contact(s, "api.shop.test", 80); // same site: on its own harmless
    const first = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(first).toMatchObject({ decision: "deny", reason: expect.stringMatching(/page may have changed by itself.*lost track.*browser_snapshot/) });
    expect((await browserHook(rig, s, "browser_snapshot")).decision).toBe("allow");
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/embed"));
    const second = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(second).toMatchObject({ decision: "deny", reason: expect.stringMatching(/embedded content is unknown.*lost track.*browser_take_screenshot/) });
    shotResult(s);
    const gated = browserHook(rig, s, "browser_click", { target: "e1" });
    expect(await isPending(gated)).toBe(true);
    const card = parked(s);
    expect((card as { reason?: string }).reason).toMatch(/lost track/);
    expect(card.suggestions.map((x) => x.label)).toEqual(["Allow once", "Deny"]); // nothing to unlock
    rig.sup.resolvePermission(card.requestId, "deny");
    expect((await gated).decision).toBe("deny");
    expect(browserOf(rig).loggedIn.isLocked(TRAFFIC_LOST_SITE)).toBe(false);
    // Sticky (fix-round re-review): a new page does NOT clear it — the frame may still be there…
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://news.test/" })).decision).toBe("allow");
    contact(s, "news.test");
    feedResult(rig, s, "browser_navigate", pageResult("https://news.test/"), { url: "https://news.test/" });
    expect(await browserHook(rig, s, "browser_click", { target: "e1" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/embedded content is unknown/) });
    // …only about:blank does.
    expect((await browserHook(rig, s, "browser_navigate", { url: "about:blank" })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", pageResult("about:blank"), { url: "about:blank" });
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://news.test/" })).decision).toBe("allow");
    contact(s, "news.test");
    feedResult(rig, s, "browser_navigate", pageResult("https://news.test/"), { url: "https://news.test/" });
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
  });
});

describe("item 3: the card's picture cannot be chosen by the agent", () => {
  test("[C3] review C4-3: browser_take_screenshot with any filename is denied, without one it is allowed; a file it links — even one written during the call — never becomes the card image, only its inline image does", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "bank.test");
    browserOf(rig).loggedIn.add("bank.test", "owner");
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://bank.test/" })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", pageResult("https://bank.test/"), { url: "https://bank.test/" });
    for (const filename of ["shot.png", "page.jpeg", "sub/x.png", ""]) {
      const v = await browserHook(rig, s, "browser_take_screenshot", { filename });
      expect([filename, v.decision]).toEqual([filename, "deny"]);
      expect(v.reason).toMatch(/may not save to a file/);
    }
    expect((await browserHook(rig, s, "browser_snapshot", { filename: "page.yml" })).decision).toBe("allow"); // other tools keep their filename rules
    expect((await browserHook(rig, s, "browser_take_screenshot", {})).decision).toBe("allow");
    const out = join(worktree, ".anvil-browser");
    mkdirSync(out, { recursive: true });
    const linked = join(out, "page-2026-11-19T10-00-00-000Z.png");
    writeFileSync(linked, "\x89PNG\r\n\x1a\nplanted");
    rig.sup.mcp.gate.onToolResult(s, "browser", { tool: "browser_take_screenshot", input: {}, content: [{ type: "text", text: `### Result\n- [Screenshot of viewport](${linked})` }], isError: false });
    expect(browserOf(rig).screenshot(s.id, true)).toBeUndefined();
    shotResult(s, "inline-real");
    const img = browserOf(rig).screenshot(s.id, true)!;
    expect(readFileSync(rig.sup.attachmentBytes(s.id, img.attachmentId)!.path, "latin1")).toContain("inline-real");
  });

  test("[C3] review C4-3: the agent's Write, Edit, MultiEdit and NotebookEdit are denied inside .anvil-browser/ (also through a link into it); Read there and writes elsewhere are not", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    const out = join(worktree, ".anvil-browser");
    mkdirSync(out, { recursive: true });
    symlinkSync(out, join(worktree, "innocent"));
    const tool = (name: string, input: Record<string, unknown>) => callHook(s, rig.broker, name, { inProcessKeys: [], gate: rig.sup.mcp.gate }, input);
    for (const [name, input] of [
      ["Write", { file_path: join(out, "page-1.png"), content: "x" }],
      ["Write", { file_path: ".anvil-browser/page-2.png", content: "x" }],
      ["Write", { file_path: join(worktree, "innocent", "page-3.png"), content: "x" }],
      ["Edit", { file_path: join(out, "page.yml"), old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: join(out, "page.yml"), edits: [] }],
      ["NotebookEdit", { notebook_path: join(out, "n.ipynb"), new_source: "" }],
    ] as const) {
      const v = await tool(name, input);
      expect([name, input, v.decision]).toEqual([name, input, "deny"]);
      expect(v.reason).toMatch(/\.anvil-browser\/ is written by the agent browser only/);
    }
    expect((await tool("Read", { file_path: join(out, "page.yml") })).decision).toBe("allow");
    expect((await tool("Write", { file_path: join(worktree, "notes.md"), content: "x" })).decision).toBe("allow");
    const other = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c4r-other-")));
    dirs.push(other);
    expect((await tool("Write", { file_path: join(other, "x.txt"), content: "x" })).decision).toBe("allow");
  });
});

describe("item 4: time passing with the page live", () => {
  test("[C3] review C4-4: after browser_wait_for whose result has no page block the next click needs a snapshot; a wait whose result carries the page block does not", async () => {
    const s = await browserSession(rig, integration, { cwd: worktree, autonomy: "bypass" });
    allow(s, "shop.test");
    expect((await browserHook(rig, s, "browser_navigate", { url: "https://shop.test/" })).decision).toBe("allow");
    feedResult(rig, s, "browser_navigate", pageResult("https://shop.test/"), { url: "https://shop.test/" });
    expect((await browserHook(rig, s, "browser_wait_for", { time: 1 })).decision).toBe("allow");
    feedResult(rig, s, "browser_wait_for", "### Result\nWaited for 1", { time: 1 });
    const v = await browserHook(rig, s, "browser_click", { target: "e1" });
    expect(v).toMatchObject({ decision: "deny", reason: expect.stringMatching(/browser_snapshot first/) });
    expect(browserOf(rig).gate.state(s.id).unknown).toBe("wait");
    expect((await browserHook(rig, s, "browser_take_screenshot")).decision).toBe("allow"); // reads still run
    feedResult(rig, s, "browser_snapshot", pageResult("https://shop.test/"));
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
    feedResult(rig, s, "browser_wait_for", `### Result\nWaited for 1\n${pageResult("https://shop.test/")}`, { time: 1 });
    expect((await browserHook(rig, s, "browser_click", { target: "e1" })).decision).toBe("allow");
  });
});
