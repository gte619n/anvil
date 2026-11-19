/**
 * [C1] Web: MCP integrations (mcp-integrations spec §4.7) — Settings → Integrations card, the
 * session Tools chip + menu, and the integration label on permission cards. Everything is hidden
 * unless the server advertises the "mcp-integrations" capability.
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

describe("Settings → Integrations card", () => {
  test("[C1] hidden unless a server advertises the mcp-integrations capability", () => {
    setup([integ()], undefined, ["autopilot", "prompts"]);
    mcp.renderMcpPanel();
    expect(section().hidden).toBe(true);
    expect(panel().innerHTML).toBe("");

    fleet.servers.set(fleet.HUB_URL, hubServer(["mcp-integrations"]));
    mcp.renderMcpPanel();
    expect(section().hidden).toBe(false);
    expect(panel().querySelectorAll(".mcp-row")).toHaveLength(1);
  });

  test("[C1] the card says third-party servers run as the daemon's user", () => {
    setup([]);
    expect(section().textContent).toContain("Third-party servers run as the daemon's user.");
    expect(panel().textContent).toContain("No integrations on this machine yet.");
  });

  test("[C1] one row per integration: label, health dot and reason, in-use-by, an enabled switch, and remove", () => {
    sessions.set("s9", sess({ id: "s9", title: "Fixture bench" }));
    setup([
      integ(),
      integ({ id: "mcpi_web", key: "web", label: "Web <b>tool</b>", transport: { type: "http", url: "http://127.0.0.1:27182/mcp" }, health: { state: "unavailable", reason: "nothing is listening on port 27182" } }),
      integ({ id: "mcpi_off", key: "off", label: "Off one", enabled: false, health: { state: "disabled" } }),
      integ({ id: "mcpi_x", key: "excl", label: "Exclusive", exclusive: true, heldBy: "s9" }),
    ]);
    const rows = [...panel().querySelectorAll<HTMLElement>(".mcp-row")];
    expect(rows.map((r) => r.dataset.mcpId)).toEqual(["mcpi_echo", "mcpi_web", "mcpi_off", "mcpi_x"]);

    const [echo, web, off, excl] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(echo.querySelector("b")!.textContent).toBe("Echo");
    expect(echo.querySelector(".conn-dot")!.classList.contains("connected")).toBe(true);
    expect(echo.querySelector(".mcp-health")!.textContent).toBe("Ready");
    expect(echo.querySelector(".mcp-transport")!.textContent).toBe("echo-mcp --root {cwd}");
    expect(echo.querySelector(".mcp-toggle")!.getAttribute("aria-checked")).toBe("true");
    expect(echo.querySelector(".mcp-remove")).not.toBeNull();
    expect(echo.querySelector(".mcp-held")).toBeNull();

    expect(web.querySelector(".conn-dot")!.classList.contains("disconnected")).toBe(true);
    expect(web.querySelector(".mcp-health")!.textContent).toBe("Unavailable: nothing is listening on port 27182");
    expect(web.querySelector("b")!.innerHTML).toBe("Web &lt;b&gt;tool&lt;/b&gt;"); // labels are escaped
    expect(web.querySelector(".mcp-transport")!.textContent).toBe("http://127.0.0.1:27182/mcp");

    expect(off.querySelector(".mcp-health")!.textContent).toBe("Switched off");
    expect(off.querySelector(".mcp-toggle")!.getAttribute("aria-checked")).toBe("false");
    expect(off.querySelector(".conn-dot")!.className.trim()).toBe("conn-dot");

    expect(excl.querySelector(".mcp-held")!.textContent).toContain("In use by Fixture bench");
    expect(excl.querySelector(".mcp-health")!.textContent).toContain("one session at a time");
  });

  test("[C1] the enabled switch sends mcp.integration.update, Check sends mcp.integration.check, and a refusal is shown", async () => {
    setup([integ()]);
    panel().querySelector<HTMLButtonElement>(".mcp-toggle")!.click();
    await settle();
    expect(sent.at(-1)).toMatchObject({ type: "mcp.integration.update", id: "mcpi_echo", fields: { enabled: false } });
    panel().querySelector<HTMLButtonElement>(".mcp-check")!.click();
    await settle();
    expect(sent.at(-1)).toMatchObject({ type: "mcp.integration.check" });
    nextReply = { type: "command.error", message: "MCP integrations are not enabled on this server" };
    panel().querySelector<HTMLButtonElement>(".mcp-toggle")!.click();
    await settle();
    expect(document.getElementById("toast")!.textContent).toBe("MCP integrations are not enabled on this server");
  });

  test("[C1] remove asks first, names the sessions that use it, and sends mcp.integration.remove only on confirm", async () => {
    sessions.set("s1", sess({ mcpIntegrations: ["mcpi_echo"] }));
    setup([integ()]);
    panel().querySelector<HTMLButtonElement>(".mcp-remove")!.click();
    await settle();
    expect(document.querySelector("#modal-root .modal-box")!.textContent).toContain("switched on in 1 session");
    document.querySelector<HTMLButtonElement>("#cd-cancel")!.click();
    await settle();
    expect(sent.filter((c) => c.type === "mcp.integration.remove")).toEqual([]);

    panel().querySelector<HTMLButtonElement>(".mcp-remove")!.click();
    await settle();
    document.querySelector<HTMLButtonElement>("#cd-ok")!.click();
    await settle();
    expect(sent.at(-1)).toMatchObject({ type: "mcp.integration.remove", id: "mcpi_echo" });
  });

  test("[C1] Add offers Custom, and the Custom form sends mcp.integration.add with the typed command split into command + args", async () => {
    setup([]);
    panel().querySelector<HTMLButtonElement>(".mcp-add")!.click();
    expect(menuItems().map((b) => b.textContent)).toEqual(["terminalCustom"]); // icon ligature + label; the only preset in this phase
    menuItems()[0]!.click();
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    expect($("mcp-dlg-url-row").hidden).toBe(true);

    $<HTMLButtonElement>("mcp-dlg-ok").click();
    await settle();
    expect($("mcp-dlg-status").textContent).toBe("Enter a name.");
    expect(sent).toEqual([]);

    $<HTMLInputElement>("mcp-dlg-label").value = "Echo";
    $<HTMLInputElement>("mcp-dlg-key").value = "Echo_1";
    $<HTMLButtonElement>("mcp-dlg-ok").click();
    await settle();
    expect($("mcp-dlg-status").textContent).toContain("lowercase letter");

    $<HTMLInputElement>("mcp-dlg-key").value = "echo";
    $<HTMLInputElement>("mcp-dlg-cmd").value = `bun "/opt/my tools/echo.mjs" --root {cwd}`;
    $<HTMLInputElement>("mcp-dlg-exclusive").checked = true;
    nextReply = { type: "command.error", message: 'key "echo" is already used by another integration' };
    $<HTMLButtonElement>("mcp-dlg-ok").click();
    await settle();
    expect($("mcp-dlg-status").textContent).toBe('key "echo" is already used by another integration'); // inline; dialog stays open
    expect($<HTMLInputElement>("mcp-dlg-label").value).toBe("Echo");

    nextReply = { type: "ack" };
    $<HTMLButtonElement>("mcp-dlg-ok").click();
    await settle();
    expect(sent.at(-1)).toMatchObject({
      type: "mcp.integration.add",
      integration: { key: "echo", kind: "custom", label: "Echo", exclusive: true, enabled: true, transport: { type: "stdio", command: "bun", args: ["/opt/my tools/echo.mjs", "--root", "{cwd}"] } },
    });
    expect(document.querySelector("#modal-root .modal")).toBeNull();
  });

  test("[C1] the Custom form's URL type takes a loopback http URL only", () => {
    const base = { label: "Web", key: "web", transport: "http" as const, commandLine: "", exclusive: false };
    expect(mcp.parseCustomForm({ ...base, url: "http://127.0.0.1:27182/mcp" })).toEqual({
      ok: true,
      integration: { key: "web", kind: "custom", label: "Web", exclusive: false, enabled: true, transport: { type: "http", url: "http://127.0.0.1:27182/mcp" } },
    });
    for (const url of ["https://127.0.0.1/mcp", "http://example.com/mcp", "http://u:p@localhost/", "nope"]) {
      expect(mcp.parseCustomForm({ ...base, url }).ok).toBe(false);
    }
    expect(mcp.parseCustomForm({ ...base, transport: "stdio", url: "" })).toEqual({ ok: false, error: "Enter the command that starts the server." });
    expect(mcp.splitCommandLine(`a 'b c' "d \\"e\\"" f\\ g ""`)).toEqual(["a", "b c", 'd "e"', "f g", ""]);
  });
});

describe("session Tools control", () => {
  test("[C1] the header chip is hidden without the capability, without integrations, and for a session that is not ordinary", () => {
    const s = sess();
    setup([integ()], s, ["autopilot"]);
    expect(chip().hidden).toBe(true);
    setup([], s);
    expect(chip().hidden).toBe(true);
    for (const over of [{ isDefault: true }, { teamRole: "lead" }, { teamRole: "member", parentId: "p" }, { workUnitRole: "planner", workUnitId: "w" }, { workUnitRole: "builder", workUnitId: "w" }] as Partial<Session>[]) {
      setup([integ()], sess(over));
      expect(chip().hidden).toBe(true);
    }
    setup([integ()], s);
    expect(chip().hidden).toBe(false);
  });

  test("[C1] the header chip shows which integrations are on for the session", () => {
    const list = [integ(), integ({ id: "mcpi_web", key: "web", label: "Web" })];
    setup(list, sess());
    expect(chip().textContent).toBe("extensionTools");
    expect(chip().classList.contains("on")).toBe(false);

    const on = sess({ mcpIntegrations: ["mcpi_web", "mcpi_echo", "mcpi_gone"] });
    sessions.set(on.id, on);
    mcp.updateHeaderTools(on);
    expect(chip().textContent).toBe("extensionEcho, Web");
    expect(chip().classList.contains("on")).toBe(true);
    expect(mcp.toolsChipLabel(on, list)).toBe("Echo, Web");
  });

  test("[C1] the Tools menu lists this machine's integrations with a switch each and sends session.set_mcp_integrations", () => {
    const s = sess({ mcpIntegrations: ["mcpi_echo"] });
    setup([integ(), integ({ id: "mcpi_web", key: "web", label: "Web" })], s);
    mcp.openToolsMenu(chip());
    const items = menuItems();
    expect(items.map((b) => b.textContent)).toEqual(["toggle_onEcho", "toggle_offWeb"]);

    items[1]!.click(); // switch Web on
    expect(sent.at(-1)).toMatchObject({ type: "session.set_mcp_integrations", sessionId: "s1", ids: ["mcpi_echo", "mcpi_web"] });

    mcp.openToolsMenu(chip());
    menuItems()[0]!.click(); // switch Echo off
    expect(sent.at(-1)).toMatchObject({ type: "session.set_mcp_integrations", sessionId: "s1", ids: [] });
  });

  test("[C1] an unavailable integration is shown disabled with its reason and cannot be switched on — but one already on can be switched off", () => {
    const down = integ({ id: "mcpi_web", key: "web", label: "Web", health: { state: "unavailable", reason: "nothing is listening on port 27182" } });
    const off = integ({ id: "mcpi_off", key: "off", label: "Off one", enabled: false, health: { state: "disabled" } });
    const s = sess();
    setup([down, off], s);
    mcp.openToolsMenu(chip());
    const items = menuItems();
    expect(items.map((b) => b.textContent)).toEqual(["blockWeb (unavailable)", "blockOff one (unavailable)"]);
    expect(items[0]!.title).toBe("Unavailable: nothing is listening on port 27182");
    expect(items[1]!.title).toBe("Unavailable: switched off in Settings");
    items[0]!.click();
    expect(sent).toEqual([]); // nothing sent
    expect(document.getElementById("toast")!.textContent).toBe("Web is unavailable: nothing is listening on port 27182");

    const model = mcp.toolsMenuModel(sess({ mcpIntegrations: ["mcpi_web"] }), [down]);
    expect(model).toEqual([{ id: "mcpi_web", label: "Web", on: true, icon: "toggle_on", title: "On, but unavailable: nothing is listening on port 27182. Tap to switch off.", next: [] }]);
  });

  test("[C1] toggling mid-turn says it applies after this turn", () => {
    const s = sess({ status: "thinking" });
    setup([integ()], s);
    mcp.openToolsMenu(chip());
    menuItems()[0]!.click();
    expect(sent.at(-1)).toMatchObject({ type: "session.set_mcp_integrations", ids: ["mcpi_echo"] });
    expect(document.getElementById("toast")!.textContent).toBe("Echo applies after this turn.");
  });
});

describe("permission cards", () => {
  test("[C1] a permission card for an integration tool shows the integration label, not the raw mcp__ name", () => {
    const s = sess({ mcpIntegrations: ["mcpi_echo"] });
    setup([integ()], s);
    expect(mcp.permissionToolName("mcp__echo__ping", "s1")).toBe("Echo · ping");
    dialogs.showPermission("req_1", "mcp__echo__ping", { text: "hi" }, [
      { decision: "allow", label: "Allow once" },
      { decision: "allow_always", label: "Always allow Echo this session" },
      { decision: "deny", label: "Deny" },
    ], mcp.permissionToolName("mcp__echo__ping", "s1"));
    const card = document.querySelector<HTMLElement>('#conversation [data-req="req_1"]')!;
    const name = card.querySelector(".perm-head b")!;
    expect(name.textContent).toBe("Echo · ping");
    expect(card.querySelector(".perm-head")!.textContent).not.toContain("mcp__");
    expect(name.getAttribute("title")).toBe("mcp__echo__ping"); // the raw name stays one hover away
    expect([...card.querySelectorAll(".perm-btn")].map((b) => b.textContent)).toEqual(["Allow once", "Always allow Echo this session", "Deny"]);
  });

  test("[C1] other tools keep their own name on the card: built-ins, the daemon's own servers, and unknown keys", () => {
    setup([integ()], sess());
    expect(mcp.permissionToolName("Bash", "s1")).toBe("Bash");
    expect(mcp.permissionToolName("mcp__anvil_cad__measure", "s1")).toBe("mcp__anvil_cad__measure");
    expect(mcp.permissionToolName("mcp__other__x", "s1")).toBe("mcp__other__x");
    expect(mcp.mcpToolLabel("mcp__echo__browser__x", [integ()])).toBe("Echo · browser__x");
    // A session on a server without the capability gets raw names even if a stale list is cached.
    fleet.servers.set(fleet.HUB_URL, hubServer([]));
    expect(mcp.permissionToolName("mcp__echo__ping", "s1")).toBe("mcp__echo__ping");
    dialogs.showPermission("req_2", "Bash", { command: "ls" }, [{ decision: "allow", label: "Allow once" }]);
    expect(document.querySelector('#conversation [data-req="req_2"] .perm-head b')!.textContent).toBe("Bash");
  });
});
