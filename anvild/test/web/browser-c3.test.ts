/**
 * [C3] Web: the agent browser's Phase C3 surfaces — the logged-in sites list with an unlock switch
 * and a remove button per site, the "Open agent browser" button (only on a machine that reports a
 * desktop session), "in use by owner", the hard-stop permission card (reason, page screenshot, three
 * options) and the hand-off card ("I've cleared it"). All of it behind the "browser" capability.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { McpIntegrationStatus, Session } from "../../protocol";

let mcp: typeof import("../../web/src/mcp");
let fleet: typeof import("../../web/src/fleet");
let dialogs: typeof import("../../web/src/dialogs");

const HTML = `<!doctype html><html><body>
  <button id="header-tools" class="header-branch header-tools" hidden></button>
  <div id="modal-root"></div>
  <div id="menu-root"></div>
  <div id="toast"></div>
  <div id="conversation"></div>
  <div id="settings"></div>
</body></html>`;

const sessions = new Map<string, Session>();
let activeId: string | null = null;
/** Every command sent to the hub (the socket's send and the cid-tracked sendAwait). */
let sent: any[] = [];
let nextReply: any = { type: "ack" };

const integ = (over: Partial<McpIntegrationStatus> = {}): McpIntegrationStatus => ({
  id: "mcpi_echo",
  key: "echo",
  kind: "custom",
  label: "Echo",
  transport: { type: "stdio", command: "echo-mcp", args: ["--root", "{cwd}"] },
  exclusive: false,
  enabled: true,
  health: { state: "ready" },
  checkedAt: 1,
  ...over,
});
let sentTo: [string | null, any][] = [];
const sess = (over: Partial<Session> = {}): Session => ({ id: "s1", title: "Bracket work", status: "idle", ...over }) as Session;
const hubServer = (caps: string[]) => ({ url: fleet.HUB_URL, id: "hub", name: "m4", sock: { isOpen: () => true, send: (c: unknown) => (sent.push(c), true) } as never, status: "connected" as const, capabilities: caps });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  installDom({ html: HTML });
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  fleet = await import("../../web/src/fleet");
  dialogs = await import("../../web/src/dialogs");
  mcp = await import("../../web/src/mcp");
  dialogs.initDialogs({
    activeId: () => activeId,
    sessions,
    environments: new Map(),
    selectSession: () => {},
    persistSessions: () => {},
    enqueue: () => {},
    sendAwait: (async () => ({ type: "ack" })) as never,
    HUB_URL: fleet.HUB_URL,
    servers: fleet.servers,
    hub: (() => fleet.servers.get(fleet.HUB_URL)) as never,
    orderedServers: () => [],
    envServer: new Map(),
    serverOfEnv: (() => ({})) as never,
    sessionServer: fleet.sessionServer,
    persistRouting: () => {},
    sendTo: ((id: string | null, cmd: unknown) => (sentTo.push([id, cmd]), true)) as never,
    openSettings: () => {},
    closeSettings: () => {},
    loadTodoistProjects: async () => {},
    todoistProjectOptions: () => "",
    todoistProjectLinks: () => new Map(),
    todoistProjectName: () => undefined,
    conversation: document.getElementById("conversation")!,
    dropSessionHero: () => {},
    hideThinking: () => {},
    showThinking: () => {},
    scrollDown: () => {},
  });
  mcp.initMcp({
    sessions,
    activeId: () => activeId,
    sendAwait: async (_srv, cmd) => {
      sent.push(cmd);
      return nextReply;
    },
  });
});
afterAll(() => {
  fleet.servers.clear();
  fleet.sessionServer.clear();
  mcp.serverMcp.clear();
  mcp.serverLoggedIn.clear();
  uninstallDom();
});

beforeEach(() => {
  sent = [];
  sentTo = [];
  nextReply = { type: "ack" };
  sessions.clear();
  activeId = null;
  fleet.servers.clear();
  fleet.sessionServer.clear();
  mcp.serverMcp.clear();
  mcp.serverSites.clear();
  mcp.serverLoggedIn.clear();
  dialogs.closeModal();
  dialogs.clearCardMaps();
  document.getElementById("conversation")!.innerHTML = "";
  document.getElementById("settings")!.innerHTML = mcp.mcpSectionShellHtml();
});

const BOTH = ["mcp-integrations", "browser"];
function setup(list: McpIntegrationStatus[], caps: string[] = BOTH, s?: Session): void {
  fleet.servers.set(fleet.HUB_URL, hubServer(caps));
  if (s) {
    sessions.set(s.id, s);
    fleet.sessionServer.set(s.id, fleet.HUB_URL);
    activeId = s.id;
  }
  mcp.onMcpIntegrations(fleet.HUB_URL, list);
}
const browserRow = (browser: Partial<NonNullable<McpIntegrationStatus["browser"]>> = {}): McpIntegrationStatus =>
  integ({
    id: "mcpi_browser",
    key: "browser",
    kind: "browser",
    label: "Browser",
    transport: { type: "stdio", command: "node", args: ["@playwright/mcp@0.0.86"] },
    exclusive: true,
    browser: { mode: "headed", modeReason: "Headed, with the agent profile: evan is logged in at the screen.", proxy: { state: "ready", sessions: 0 }, desktop: true, ...browser },
  });
const panel = () => document.getElementById("mcp-panel")!;
const list = () => document.getElementById("browser-loggedin-panel")!;
const convo = () => document.getElementById("conversation")!;
const SITES = [
  { site: "bank.test", source: "owner" as const, unlocked: false, addedAt: 1 },
  { site: "shop.test", source: "login-session" as const, unlocked: true, addedAt: 2 },
];

describe("logged-in sites in Settings → Integrations", () => {
  test("[C3] web: the list is hidden without the browser capability; with it each logged-in site shows its source, a Locked / Unlocked switch and a remove button", () => {
    setup([], ["mcp-integrations"]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, SITES);
    mcp.renderMcpPanel();
    expect(document.getElementById("browser-sites-section")!.hidden).toBe(true);
    expect(list().innerHTML).toBe("");

    setup([browserRow()]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, SITES, 1);
    const rows = [...list().querySelectorAll<HTMLElement>(".browser-loggedin-row")];
    expect(rows.map((r) => r.dataset.site)).toEqual(["bank.test", "shop.test"]);
    const sw = rows.map((r) => r.querySelector<HTMLButtonElement>(".browser-loggedin-unlock")!);
    expect(sw.map((b) => [b.getAttribute("role"), b.getAttribute("aria-checked"), b.textContent!.replace(/toggle_o(n|ff)/, "").trim()])).toEqual([["switch", "false", "Locked"], ["switch", "true", "Unlocked"]]);
    expect(rows[0]!.textContent).toContain("added by hand");
    expect(rows[1]!.textContent).toContain("logged in through Open agent browser");
    expect(rows.every((r) => !!r.querySelector(".browser-loggedin-remove"))).toBe(true);
    expect(list().querySelector(".browser-sites-pending")!.textContent).toContain("1 change waiting to reach the hub");
    // The section says plainly what unlocking means.
    expect(document.getElementById("browser-sites-section")!.textContent).toMatch(/Unlock a site and nothing on it asks, in any session on any machine, checkout and payment pages included/);
  });

  test("[C3] web: switching a site to Unlocked asks first, saying nothing on it will ask — checkout and payment pages included — and sends browser.loggedin.set_unlocked only on confirm; switching back to Locked sends at once", async () => {
    setup([browserRow()]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, SITES);
    const sw = (site: string) => list().querySelector<HTMLButtonElement>(`.browser-loggedin-row[data-site="${site}"] .browser-loggedin-unlock`)!;

    sw("bank.test").click();
    await settle();
    const box = document.querySelector("#modal-root .modal-box")!;
    expect(box.textContent).toContain("Unlock bank.test?");
    expect(box.textContent).toMatch(/Nothing the agent does on bank\.test will ask first — in any session, on any machine, including checkout and payment pages/);
    document.querySelector<HTMLButtonElement>("#cd-cancel")!.click();
    await settle();
    expect(sent).toEqual([]); // cancelled: nothing sent

    sw("bank.test").click();
    await settle();
    document.querySelector<HTMLButtonElement>("#cd-ok")!.click();
    await settle();
    expect(sent.at(-1)).toMatchObject({ type: "browser.loggedin.set_unlocked", site: "bank.test", unlocked: true });
    // Nothing is invented locally: the row changes only when the daemon says so.
    expect(sw("bank.test").getAttribute("aria-checked")).toBe("false");
    mcp.onBrowserLoggedIn(fleet.HUB_URL, [{ ...SITES[0]!, unlocked: true }, SITES[1]!]);
    expect(sw("bank.test").getAttribute("aria-checked")).toBe("true");

    sent = [];
    sw("shop.test").click(); // locking again needs no confirmation: it is the brake
    await settle();
    expect(document.querySelector("#modal-root .modal-box")).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ type: "browser.loggedin.set_unlocked", site: "shop.test", unlocked: false })]);
  });

  test("[C3] web: remove sends browser.loggedin.remove; typing a site and pressing Add logged-in site sends browser.loggedin.add; a refusal is shown", async () => {
    setup([browserRow()]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, SITES);
    list().querySelector<HTMLButtonElement>('.browser-loggedin-row[data-site="shop.test"] .browser-loggedin-remove')!.click();
    await settle();
    expect(sent.at(-1)).toMatchObject({ type: "browser.loggedin.remove", site: "shop.test" });

    const input = list().querySelector<HTMLInputElement>("#browser-loggedin-input")!;
    input.value = "  https://mail.example.com/inbox ";
    nextReply = { type: "command.error", message: "enter a site like example.com" };
    list().querySelector<HTMLButtonElement>("#browser-loggedin-add")!.click();
    await settle();
    expect(sent.at(-1)).toMatchObject({ type: "browser.loggedin.add", site: "https://mail.example.com/inbox" });
    expect(document.getElementById("toast")!.textContent).toContain("enter a site like example.com");
    expect([...list().querySelectorAll<HTMLElement>(".browser-loggedin-row")].map((r) => r.dataset.site)).toEqual(["bank.test", "shop.test"]);
  });

  test("[C3] web review 5: a damaged list is shown as an error with 'Start a new list', which sends browser.loggedin.reset", async () => {
    setup([browserRow()]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, [], 0, "The logged-in sites list on this machine was damaged (bad JSON).");
    const err = list().querySelector<HTMLElement>(".browser-loggedin-error")!;
    expect(err.textContent).toContain("was damaged (bad JSON)");
    err.querySelector<HTMLButtonElement>("#browser-loggedin-reset")!.click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "browser.loggedin.reset" })]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, []);
    expect(list().querySelector(".browser-loggedin-error")).toBeNull();
  });

  test("[C3] web: a site name is shown as text, never as markup", () => {
    setup([browserRow()]);
    mcp.onBrowserLoggedIn(fleet.HUB_URL, [{ site: '<img src=x onerror="alert(1)">', source: "owner", unlocked: false, addedAt: 1 }]);
    expect(list().querySelector("img")).toBeNull();
    expect(list().textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("Open agent browser", () => {
  test("[C3] web: the button is shown only on a machine that reports a desktop session, and pressing it sends browser.open_agent_browser to that machine", async () => {
    setup([browserRow({ desktop: false, mode: "headless", modeReason: "Headless with a throwaway profile: nobody is logged in at this machine's screen." })]);
    expect(panel().querySelector(".mcp-browser-open")).toBeNull();
    setup([browserRow({ desktop: undefined })]); // an older daemon that does not say
    expect(panel().querySelector(".mcp-browser-open")).toBeNull();
    setup([integ()]); // a custom integration's row never has it
    expect(panel().querySelector(".mcp-browser-open")).toBeNull();

    setup([browserRow({ desktop: true })]);
    const open = panel().querySelector<HTMLButtonElement>(".mcp-browser-open")!;
    expect(open.textContent).toContain("Open agent browser");
    open.click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "browser.open_agent_browser" })]);
    expect(document.getElementById("toast")!.textContent).toContain("The agent browser is open on m4");

    // A refusal (a session is using it) is shown as it is.
    nextReply = { type: "command.error", message: "a session is using the agent browser; try again when its turn ends" };
    panel().querySelector<HTMLButtonElement>(".mcp-browser-open")!.click();
    await settle();
    expect(document.getElementById("toast")!.textContent).toContain("a session is using the agent browser");
  });

  test("[C3] web: while the owner has it open the row says In use by owner and the button is gone", () => {
    setup([browserRow({ desktop: true, ownerBrowser: { since: 1_700_000_000_000 } })]);
    const row = panel().querySelector<HTMLElement>(".mcp-row")!;
    expect(row.querySelector(".mcp-browser-owner")!.textContent).toContain("In use by owner");
    expect(row.querySelector(".mcp-browser-open")).toBeNull();
  });
});

describe("the hard-stop card", () => {
  const HARD = [
    { decision: "allow" as const, label: "Allow once" },
    { decision: "allow_always" as const, label: "Unlock bank.test" },
    { decision: "deny" as const, label: "Deny" },
  ];

  test("[C3] web: the card shows the reason, the page screenshot and exactly three options — Allow once, Unlock <site>, Deny — with no always-allow", () => {
    const s = sess();
    setup([browserRow()], BOTH, s);
    const url = mcp.browserCardImageUrl(s.id, { attachmentId: "att_42", mediaType: "image/png" })!;
    expect(url).toContain("/api/sessions/s1/attachments/att_42");
    dialogs.showPermission("perm_1", "mcp__browser__browser_click", { element: "Pay now", target: "e9" }, HARD, mcp.permissionToolName("mcp__browser__browser_click", s.id), { reason: "click on bank.test, a logged-in site", imageUrl: url });

    const card = convo().querySelector<HTMLElement>('.bubble.permission[data-req="perm_1"]')!;
    expect(card.querySelector(".perm-reason")!.textContent).toBe("click on bank.test, a logged-in site");
    const img = card.querySelector<HTMLImageElement>("img.perm-shot")!;
    expect(img.getAttribute("src")).toBe(url);
    expect(img.classList.contains("att-img")).toBe(true); // opens full size like any attachment image
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".perm-btn")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Allow once", "Unlock bank.test", "Deny"]);
    expect(buttons.some((b) => /always allow/i.test(b.textContent!))).toBe(false);
    expect(card.querySelector(".perm-head")!.textContent).toContain("Browser"); // the integration's label, not the raw mcp__ name
  });

  test("[C3] web: each option sends its decision for that request: Unlock <site> sends allow_always, and the card then shows what was chosen", () => {
    const s = sess();
    setup([browserRow()], BOTH, s);
    for (const [i, [label, decision]] of ([["Allow once", "allow"], ["Unlock bank.test", "allow_always"], ["Deny", "deny"]] as const).entries()) {
      dialogs.showPermission(`perm_${i}`, "mcp__browser__browser_click", {}, HARD, "Browser · browser_click", { reason: "click on bank.test, a logged-in site" });
      const card = convo().querySelector<HTMLElement>(`.bubble.permission[data-req="perm_${i}"]`)!;
      [...card.querySelectorAll<HTMLButtonElement>(".perm-btn")].find((b) => b.textContent === label)!.click();
      expect(sentTo.at(-1)).toEqual(["s1", { type: "permission.respond", requestId: `perm_${i}`, decision }]);
      expect(card.classList.contains("resolved")).toBe(true);
      expect(card.querySelector(".perm-done")!.textContent).toContain(label);
    }
  });

  test("[C3] web: an ordinary permission card is unchanged — no reason line, no image — and a reason is shown as text, never as markup", () => {
    setup([], BOTH, sess());
    dialogs.showPermission("perm_a", "Bash", { command: "ls" }, [{ decision: "allow", label: "Allow once" }, { decision: "deny", label: "Deny" }]);
    const plain = convo().querySelector<HTMLElement>('[data-req="perm_a"]')!;
    expect(plain.querySelector(".perm-reason")).toBeNull();
    expect(plain.querySelector("img")).toBeNull();
    dialogs.showPermission("perm_b", "mcp__browser__browser_click", {}, HARD, undefined, { reason: '<b>bold</b><script>alert(1)</script>', imageUrl: 'x" onerror="alert(1)' });
    const card = convo().querySelector<HTMLElement>('[data-req="perm_b"]')!;
    expect(card.querySelector(".perm-reason")!.textContent).toBe("<b>bold</b><script>alert(1)</script>");
    expect(card.querySelector(".perm-reason b")).toBeNull();
    expect(card.querySelector("script")).toBeNull();
    expect(card.querySelector("img")!.getAttribute("onerror")).toBeNull();
    expect(mcp.browserCardImageUrl("s1", undefined)).toBeUndefined();
    expect(mcp.browserCardImageUrl(null, { attachmentId: "a", mediaType: "image/png" })).toBeUndefined();
  });
});

describe("the hand-off card", () => {
  test("[C3] web: a human.request shows the agent's reason and the latest page screenshot with one button, I've cleared it, which sends human.request.respond for that request and retires the card", () => {
    const s = sess();
    setup([browserRow()], BOTH, s);
    const url = mcp.browserCardImageUrl(s.id, { attachmentId: "att_7", mediaType: "image/png" });
    dialogs.showHumanRequest("human_1", "Cloudflare wants a human on shop.test <b>now</b>", url);
    dialogs.showHumanRequest("human_1", "Cloudflare wants a human on shop.test <b>now</b>", url); // re-surfaced on reattach: not stacked
    const cards = convo().querySelectorAll<HTMLElement>(".human-request");
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.querySelector(".q-head")!.textContent).toContain("The agent needs you at the browser");
    expect(card.querySelector(".human-reason")!.textContent).toBe("Cloudflare wants a human on shop.test <b>now</b>");
    expect(card.querySelector(".human-reason b")).toBeNull();
    expect(card.querySelector<HTMLImageElement>("img.perm-shot")!.getAttribute("src")).toBe(url!);
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => b.textContent!.replace("check", "").trim())).toEqual(["I've cleared it"]);

    buttons[0]!.click();
    expect(sentTo).toEqual([["s1", { type: "human.request.respond", requestId: "human_1" }]]);
    expect(card.classList.contains("resolved")).toBe(true);
    expect(card.querySelector(".perm-done")!.textContent).toContain("Cleared");
    expect(card.querySelector("button")).toBeNull();
  });

  test("[C3] web: with no screenshot the card has no image; a card answered on another device is retired by human.resolved", () => {
    setup([browserRow()], BOTH, sess());
    dialogs.showHumanRequest("human_2", "Two-factor code needed");
    const card = convo().querySelector<HTMLElement>('.human-request[data-req="human_2"]')!;
    expect(card.querySelector("img")).toBeNull();
    dialogs.resolveHumanUI("human_2"); // `human.resolved` from the daemon
    expect(card.classList.contains("resolved")).toBe(true);
    expect(card.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    expect(sentTo).toEqual([]);
    dialogs.resolveHumanUI("human_unknown"); // a card this client never showed: nothing happens
  });
});
