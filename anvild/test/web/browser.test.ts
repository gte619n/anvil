/**
 * [C2] Web: the agent browser (agent-cad-and-browser Phase C2) — "Browser" on the Add menu, the mode
 * and network-block lines on its row, and the fleet's allowed-sites list with remove buttons in
 * Settings → Integrations. All of it is hidden unless a server advertises the "browser" capability.
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
    sendTo: () => true,
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
  uninstallDom();
});

beforeEach(() => {
  sent = [];
  nextReply = { type: "ack" };
  sessions.clear();
  activeId = null;
  fleet.servers.clear();
  fleet.sessionServer.clear();
  mcp.serverMcp.clear();
  mcp.serverSites.clear();
  dialogs.closeModal();
  dialogs.closeHeaderMenu();
  document.getElementById("menu-root")!.innerHTML = "";
  document.getElementById("conversation")!.innerHTML = "";
  document.getElementById("settings")!.innerHTML = mcp.mcpSectionShellHtml();
  mcp.updateHeaderTools(undefined);
});

/** A hub that advertises the capability, with `list` as its integrations and `s` open on it. */
function setup(list: McpIntegrationStatus[], s?: Session, caps: string[] = ["mcp-integrations"]): void {
  fleet.servers.set(fleet.HUB_URL, hubServer(caps));
  if (s) {
    sessions.set(s.id, s);
    fleet.sessionServer.set(s.id, fleet.HUB_URL);
    activeId = s.id;
  }
  mcp.onMcpIntegrations(fleet.HUB_URL, list);
}
const section = () => document.getElementById("mcp-section")!;
const panel = () => document.getElementById("mcp-panel")!;
const chip = () => document.getElementById("header-tools")!;
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>("#menu-root .header-menu-item")];

const BOTH = ["mcp-integrations", "browser"];
const browserRow = (over: Partial<McpIntegrationStatus> = {}): McpIntegrationStatus =>
  integ({
    id: "mcpi_browser",
    key: "browser",
    kind: "browser",
    label: "Browser",
    transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.86"] },
    exclusive: true,
    browser: { mode: "headed", modeReason: "Headed, with the agent profile: evan is logged in at the screen.", proxy: { state: "ready", sessions: 1 } },
    ...over,
  });
const sitesSection = () => document.getElementById("browser-sites-section")!;
const sitesPanel = () => document.getElementById("browser-sites-panel")!;
const openAddMenu = (): void => {
  mcp.renderMcpPanel();
  panel().querySelector<HTMLButtonElement>(".mcp-add")!.click();
};

describe("Add menu", () => {
  test("[C2] web: Add offers Browser on a machine with the browser capability, and choosing it sends mcp.integration.add for the browser kind", async () => {
    setup([], undefined, BOTH);
    openAddMenu();
    expect(menuItems().map((b) => b.textContent!.trim())).toEqual(["travel_exploreBrowser", "terminalCustom"]);
    menuItems()[0]!.click();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("mcp.integration.add");
    expect(sent[0].integration).toMatchObject({ key: "browser", kind: "browser", exclusive: true, enabled: true });
    expect(sent[0].integration.transport).toEqual({ type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.86"] });
  });

  test("[C2] web: Browser is not offered without the capability, nor when the machine already has a browser integration", () => {
    setup([], undefined, ["mcp-integrations"]);
    openAddMenu();
    expect(menuItems().map((b) => b.textContent!.trim())).toEqual(["terminalCustom"]);
    dialogs.closeHeaderMenu();

    setup([browserRow()], undefined, BOTH);
    openAddMenu();
    expect(menuItems().map((b) => b.textContent!.trim())).toEqual(["terminalCustom"]);
  });
});

describe("the browser's row", () => {
  test("[C2] web: the row shows headed mode and why, and that the network block is ready", () => {
    setup([browserRow()], undefined, BOTH);
    mcp.renderMcpPanel();
    const row = panel().querySelector<HTMLElement>(".mcp-row")!;
    const mode = row.querySelector<HTMLElement>(".mcp-browser-mode")!;
    expect(mode.dataset.mode).toBe("headed");
    expect(mode.textContent).toContain("Headed, with the agent profile: evan is logged in at the screen.");
    const proxy = row.querySelector<HTMLElement>(".mcp-browser-proxy")!;
    expect(proxy.dataset.proxy).toBe("ready");
    expect(proxy.textContent).toContain("Network block ready (1 session)");
    expect(proxy.classList.contains("bad")).toBe(false);
  });

  test("[C2] web: the row shows headless mode with its reason, and a stopped network block as a fault", () => {
    setup(
      [
        browserRow({
          health: { state: "unavailable", reason: "the browser's network block is stopped" },
          browser: { mode: "headless", modeReason: "Headless with a throwaway profile: nobody is logged in at this machine's screen.", proxy: { state: "stopped", reason: "the listener closed", sessions: 0 } },
        }),
      ],
      undefined,
      BOTH,
    );
    mcp.renderMcpPanel();
    const row = panel().querySelector<HTMLElement>(".mcp-row")!;
    expect(row.querySelector<HTMLElement>(".mcp-browser-mode")!.dataset.mode).toBe("headless");
    expect(row.querySelector(".mcp-browser-mode")!.textContent).toContain("nobody is logged in at this machine's screen");
    const proxy = row.querySelector<HTMLElement>(".mcp-browser-proxy")!;
    expect(proxy.dataset.proxy).toBe("stopped");
    expect(proxy.textContent).toContain("Network block stopped: the listener closed. The browser cannot start without it.");
    expect(proxy.classList.contains("bad")).toBe(true);
    expect(row.querySelector(".mcp-health")!.textContent).toContain("Unavailable: the browser's network block is stopped");
  });

  test("[C2] web: a custom integration's row has no browser lines", () => {
    setup([integ()], undefined, BOTH);
    mcp.renderMcpPanel();
    expect(panel().querySelector(".mcp-browser-mode")).toBeNull();
    expect(panel().querySelector(".mcp-browser-proxy")).toBeNull();
  });
});

describe("allowed sites", () => {
  test("[C2] web: the list is hidden without the browser capability and shown with it", () => {
    setup([integ()], undefined, ["mcp-integrations"]);
    mcp.onBrowserSites(fleet.HUB_URL, [{ site: "a.test", addedAt: 1 }]);
    mcp.renderMcpPanel();
    expect(sitesSection().hidden).toBe(true);
    expect(sitesPanel().innerHTML).toBe("");

    fleet.servers.set(fleet.HUB_URL, hubServer(BOTH));
    mcp.renderMcpPanel();
    expect(sitesSection().hidden).toBe(false);
    expect([...sitesPanel().querySelectorAll<HTMLElement>(".browser-site-row")].map((r) => r.dataset.site)).toEqual(["a.test"]);
  });

  test("[C2] web: each site has a remove button that sends browser.site.remove to the hub; a browser.sites event repaints the list", async () => {
    setup([browserRow()], undefined, BOTH);
    mcp.onBrowserSites(fleet.HUB_URL, [
      { site: "a.test", addedAt: 1 },
      { site: "example.com", addedAt: 2 },
    ]);
    mcp.renderMcpPanel();
    const rows = () => [...sitesPanel().querySelectorAll<HTMLElement>(".browser-site-row")];
    expect(rows().map((r) => r.dataset.site)).toEqual(["a.test", "example.com"]);

    rows()[0]!.querySelector<HTMLButtonElement>(".browser-site-remove")!.click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "browser.site.remove", site: "a.test" })]);

    mcp.onBrowserSites(fleet.HUB_URL, [{ site: "example.com", addedAt: 2 }]); // the hub's broadcast
    expect(rows().map((r) => r.dataset.site)).toEqual(["example.com"]);
  });

  test("[C2] web: typing a site and pressing Allow site sends browser.site.add; a refusal is shown and nothing is invented locally", async () => {
    setup([browserRow()], undefined, BOTH);
    mcp.renderMcpPanel();
    expect(sitesPanel().textContent).toContain("No sites yet");
    sitesPanel().querySelector<HTMLInputElement>("#browser-site-input")!.value = " example.com ";
    sitesPanel().querySelector<HTMLButtonElement>("#browser-site-add")!.click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "browser.site.add", site: "example.com" })]);
    expect(sitesPanel().querySelectorAll(".browser-site-row")).toHaveLength(0); // only the daemon's event adds a row

    nextReply = { type: "command.error", message: "enter a site like example.com" };
    sitesPanel().querySelector<HTMLInputElement>("#browser-site-input")!.value = "not a site";
    sitesPanel().querySelector<HTMLButtonElement>("#browser-site-add")!.click();
    await settle();
    expect(document.getElementById("toast")!.textContent).toContain("enter a site like example.com");
  });

  test("[C2] web: changes a member has not yet delivered to the hub are counted", () => {
    setup([browserRow()], undefined, BOTH);
    mcp.onBrowserSites(fleet.HUB_URL, [{ site: "a.test", addedAt: 1 }], 2);
    mcp.renderMcpPanel();
    expect(sitesPanel().querySelector(".browser-sites-pending")!.textContent).toContain("2 changes waiting to reach the hub");
  });
});
