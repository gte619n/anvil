/**
 * [C5] Web: Settings → Models → "Part sources" — configured / not per source, masked values only,
 * Save (parts.keys.set), Test (parts.test, its result shown) and Clear; hidden without the hub's
 * "part-sources" capability.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { PartSourceStatus } from "../../protocol";

let parts: typeof import("../../web/src/parts");
let fleet: typeof import("../../web/src/fleet");
let dialogs: typeof import("../../web/src/dialogs");
let sent: any[] = [];
let reply: (cmd: any) => any = () => ({ type: "ack" });
const settle = () => new Promise((r) => setTimeout(r, 0));

const SOURCES: PartSourceStatus[] = [
  { id: "digikey", label: "DigiKey", configured: true, fields: [{ name: "DIGIKEY_CLIENT_ID", label: "Client ID", set: true, masked: "••••7890" }, { name: "DIGIKEY_CLIENT_SECRET", label: "Client secret", set: true, masked: "••••GHIJ" }], note: "Limit: 120 calls a minute, 1000 a day." },
  { id: "mouser", label: "Mouser", configured: false, fields: [{ name: "MOUSER_API_KEY", label: "Search API key", set: false }] },
  { id: "traceparts", label: "TraceParts", configured: false, fields: [{ name: "TRACEPARTS_TENANT_UID", label: "Tenant UID", set: true, masked: "••••3e4f" }, { name: "TRACEPARTS_API_KEY", label: "API key", set: false }, { name: "TRACEPARTS_EMAIL", label: "Request email", set: false }], note: "stays off until the tenant UID, the API key AND the email are entered" },
];
const hub = (caps: string[]) => ({ url: fleet.HUB_URL, id: "hub", name: "m4", sock: { isOpen: () => true, send: (c: unknown) => (sent.push(c), true) } as never, status: "connected" as const, capabilities: caps });
const card = (id: string) => document.querySelector<HTMLElement>(`.parts-source[data-source="${id}"]`)!;

beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="modal-root"></div><div id="menu-root"></div><div id="toast"></div><div id="settings"></div></body></html>` });
  fleet = await import("../../web/src/fleet");
  dialogs = await import("../../web/src/dialogs");
  parts = await import("../../web/src/parts");
  parts.initParts({ sendAwait: async (_srv, cmd) => (sent.push(cmd), reply(cmd)) });
});
afterAll(() => {
  fleet.servers.clear();
  parts.serverParts.clear();
  uninstallDom();
});
beforeEach(() => {
  sent = [];
  reply = () => ({ type: "ack" });
  fleet.servers.clear();
  parts.serverParts.clear();
  dialogs.closeModal();
  document.getElementById("settings")!.innerHTML = parts.partsSectionShellHtml();
});

describe("Settings → Models → Part sources", () => {
  test("[C5] web: the Part sources section is hidden without the hub's part-sources capability; with it each source shows Configured / Not configured, its note, and only masked values", () => {
    fleet.servers.set(fleet.HUB_URL, hub(["auth"]));
    parts.onPartSources(fleet.HUB_URL, SOURCES);
    parts.renderPartsPanel();
    expect(document.getElementById("parts-section")!.hidden).toBe(true);
    fleet.servers.set(fleet.HUB_URL, hub(["auth", "part-sources"]));
    parts.refreshParts();
    expect(sent).toEqual([expect.objectContaining({ type: "parts.sources.get" })]);
    expect(document.getElementById("parts-section")!.hidden).toBe(false);
    expect([...document.querySelectorAll<HTMLElement>(".parts-source")].map((c) => [c.dataset.source, c.querySelector(".parts-state")!.textContent])).toEqual([
      ["digikey", "Configured"],
      ["mouser", "Not configured"],
      ["traceparts", "Not configured"],
    ]);
    expect([...card("digikey").querySelectorAll(".parts-masked")].map((e) => e.textContent)).toEqual(["••••7890", "••••GHIJ"]);
    expect(card("traceparts").textContent).toContain("AND the email");
    expect(card("mouser").querySelector<HTMLButtonElement>(".parts-test")!.disabled).toBe(true);
    expect(card("digikey").querySelector<HTMLButtonElement>(".parts-test")!.disabled).toBe(false);
    expect([...card("traceparts").querySelectorAll<HTMLInputElement>("input")].map((i) => [i.dataset.field, i.type])).toEqual([
      ["TRACEPARTS_TENANT_UID", "password"],
      ["TRACEPARTS_API_KEY", "password"],
      ["TRACEPARTS_EMAIL", "email"],
    ]);
  });

  test("[C5] web: Save sends parts.keys.set with only the fields typed in; Test sends parts.test and shows the result; Clear asks first, then sends parts.keys.clear", async () => {
    fleet.servers.set(fleet.HUB_URL, hub(["part-sources"]));
    parts.onPartSources(fleet.HUB_URL, SOURCES);
    const tp = card("traceparts");
    tp.querySelector<HTMLInputElement>('input[data-field="TRACEPARTS_API_KEY"]')!.value = " tp-api-key-ZYXWVUTSRQ ";
    tp.querySelector<HTMLInputElement>('input[data-field="TRACEPARTS_EMAIL"]')!.value = "owner@example.test";
    tp.querySelector<HTMLButtonElement>(".parts-save")!.click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "parts.keys.set", source: "traceparts", values: { TRACEPARTS_API_KEY: "tp-api-key-ZYXWVUTSRQ", TRACEPARTS_EMAIL: "owner@example.test" } })]);

    sent = [];
    reply = (cmd) => ({ type: "parts.test.result", cid: cmd.cid, source: "digikey", ok: true, message: "DigiKey accepted the client ID and secret (a token was issued)." });
    card("digikey").querySelector<HTMLButtonElement>(".parts-test")!.click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "parts.test", source: "digikey" })]);
    expect(card("digikey").querySelector(".parts-test-result")!.textContent).toContain("a token was issued");

    sent = [];
    reply = () => ({ type: "ack" });
    card("digikey").querySelector<HTMLButtonElement>(".parts-clear")!.click();
    await settle();
    expect(sent).toEqual([]); // asks first
    document.querySelector<HTMLButtonElement>("#modal-root .modal-box button.danger, #modal-root .modal-box .primary")!.click();
    await settle();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ type: "parts.keys.clear", source: "digikey" })]);
  });
});
