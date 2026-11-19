/**
 * Phase B1 web tests for the Settings → CAD card (web/src/settings-cad.ts): what it shows per
 * machine, the pin, the two manual controls, the "Pin back" warning list, and the two labelled
 * placeholders later phases fill in. The card's `api` is a fake; the DOM is jsdom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { rest } from "../../protocol";
import { installDom, uninstallDom } from "./dom-env";
import { CAD_PIN_CAPABILITY, cadCardHtml, cadTabHtml, mountCadCard, type CadCardApi } from "../../web/src/settings-cad";

const SHA_NEW = "f324ec49fd50b30d6dc18928d84749b8a72a132e4233daf844e422b3c38bc251";
const SHA_OLD = "0633d662f3b410da90616d6c7e412f6d799693164541abea82c8d53802ad1d0a";

const status = (over: Partial<rest.solidcraft.FleetStatusResponse> = {}): rest.solidcraft.FleetStatusResponse => ({
  ok: true,
  active: false,
  pin: { version: "0.44.1", sha256: SHA_NEW, pinnedAt: "2026-11-19T10:00:00.000Z", previous: { version: "0.43.0", sha256: SHA_OLD } },
  members: [
    { serverId: "hub", serverName: "Mac-Mini-M4", isHub: true, state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true },
    { serverId: "m1", serverName: "Mac-Mini-M1", isHub: false, state: "error", version: "0.43.0", source: "app", pinned: "0.44.1", available: false, detail: "zip sha256 is aa, the pin records bb" },
    { serverId: "m2", serverName: "Studio", isHub: false, state: "pending-offline", detail: "unreachable" },
  ],
  ...over,
});

let host: HTMLElement;
beforeAll(() => {
  installDom();
});
afterAll(() => uninstallDom());
beforeEach(() => {
  document.body.innerHTML = `<div id="cad-panel"></div>`;
  host = document.getElementById("cad-panel")!;
});

interface FakeApi extends CadCardApi {
  calls: string[];
  toasts: string[];
  current: rest.solidcraft.FleetStatusResponse;
}
function fakeApi(over: Partial<CadCardApi> = {}, initial = status()): FakeApi {
  const api: FakeApi = {
    calls: [],
    toasts: [],
    current: initial,
    pollMs: 0,
    async fleetStatus(refresh) {
      api.calls.push(`status:${refresh}`);
      return api.current;
    },
    async setPin(version, sha256) {
      api.calls.push(`set:${version}:${sha256 ?? ""}`);
      api.current = status({ pin: { version, sha256: sha256 ?? SHA_NEW, pinnedAt: "2026-11-20T10:00:00.000Z", previous: { version: "0.44.1", sha256: SHA_NEW } } });
      return { ok: true, pin: api.current.pin, members: api.current.members };
    },
    async pinBackPreview() {
      api.calls.push("preview");
      return {
        ok: true,
        current: { version: "0.44.1", sha256: SHA_NEW },
        previous: { version: "0.43.0", sha256: SHA_OLD },
        rewritten: [
          { part: "bracket", version: "0.44.1", environment: "fixtures" },
          { part: "<lid>", version: "0.44.1", serverName: "Mac-Mini-M1" },
        ],
      };
    },
    async pinBack() {
      api.calls.push("back");
      api.current = status({ pin: { version: "0.43.0", sha256: SHA_OLD, pinnedAt: "2026-11-21T10:00:00.000Z", previous: { version: "0.44.1", sha256: SHA_NEW } } });
      return { ok: true, pin: api.current.pin, members: api.current.members, rewritten: [] };
    },
    toast: (m) => void api.toasts.push(m),
    ...over,
  };
  return api;
}
const text = (sel: string): string => host.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const click = (sel: string): void => host.querySelector<HTMLElement>(sel)!.click();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("Settings → CAD card", () => {
  test("[B1] shows each machine's SolidCraft version, source and ready/error state", async () => {
    await mountCadCard(host, fakeApi()).ready;
    const rows = [...host.querySelectorAll<HTMLElement>("tr.cad-machine")];
    expect(rows.map((r) => r.dataset.serverId)).toEqual(["hub", "m1", "m2"]);
    const cells = rows.map((r) => r.textContent!.replace(/\s+/g, " ").trim());
    expect(cells[0]).toContain("Mac-Mini-M4 (hub)");
    expect(cells[0]).toContain("0.44.1 (managed install)");
    expect(cells[0]).toContain("Ready");
    expect(cells[1]).toContain("0.43.0 (SolidCraft.app)");
    expect(cells[1]).toContain("Error");
    expect(cells[1]).toContain("zip sha256 is aa, the pin records bb"); // the error is shown, not just a red dot
    expect(cells[2]).toContain("Offline");
    expect(rows.map((r) => r.dataset.state)).toEqual(["ready", "error", "pending-offline"]);
    // An env override is named as one.
    expect(cadCardHtml({ status: status({ members: [{ serverId: "x", serverName: "X", isHub: false, state: "ready", version: "0.44.1", source: "env" }] }) })).toContain("ANVIL_SOLIDCRAFT_CLI override");
  });

  test("[B1] shows the pin, its sha256 and the previous version; with no pin it says so and Pin back is disabled", async () => {
    await mountCadCard(host, fakeApi()).ready;
    expect(text("#cad-pin-version")).toBe("0.44.1");
    expect(text("#cad-card")).toContain(`sha256 ${SHA_NEW.slice(0, 12)}`);
    expect(text("#cad-pin-previous")).toBe("0.43.0");
    expect(host.querySelector<HTMLButtonElement>("#cad-pin-back")!.disabled).toBe(false);

    document.body.innerHTML = `<div id="cad-panel"></div>`;
    host = document.getElementById("cad-panel")!;
    await mountCadCard(host, fakeApi({}, status({ pin: undefined, members: [] }))).ready;
    expect(text("#cad-pin-version")).toContain("No pin set");
    expect(host.querySelector("#cad-pin-previous")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>("#cad-pin-back")!.disabled).toBe(true);
    expect(text("#cad-machines")).toContain("No machines reported yet");
  });

  test("[B1] 'Set pin to version…' sends the typed version to the hub and repaints with the new pin", async () => {
    const api = fakeApi();
    await mountCadCard(host, api).ready;
    host.querySelector<HTMLInputElement>("#cad-pin-input")!.value = " v0.45.0 ";
    click("#cad-pin-set");
    await flush();
    expect(api.calls).toContain("set:0.45.0:");
    expect(text("#cad-pin-version")).toBe("0.45.0");
    expect(text("#cad-pin-previous")).toBe("0.44.1");
    expect(api.toasts[0]).toContain("0.45.0");
    expect(host.querySelector<HTMLInputElement>("#cad-pin-input")!.value).toBe("");
  });

  test("[B1] an optional sha256 is passed through, and a non-version is refused before any request", async () => {
    const api = fakeApi();
    await mountCadCard(host, api).ready;
    host.querySelector<HTMLInputElement>("#cad-pin-input")!.value = "latest";
    click("#cad-pin-set");
    await flush();
    expect(api.calls.some((c) => c.startsWith("set:"))).toBe(false);
    expect(text("#cad-error")).toContain("version like 0.44.1");
    expect(host.querySelector<HTMLInputElement>("#cad-pin-input")!.value).toBe("latest"); // what was typed is kept

    host.querySelector<HTMLInputElement>("#cad-pin-input")!.value = "0.45.0";
    host.querySelector<HTMLInputElement>("#cad-sha-input")!.value = SHA_OLD.toUpperCase();
    click("#cad-pin-set");
    await flush();
    expect(api.calls).toContain(`set:0.45.0:${SHA_OLD}`);
  });

  test("[B1] a refused pin shows the hub's reason and leaves the pin as it was", async () => {
    const api = fakeApi({
      async setPin() {
        return { ok: false, members: [], error: "SolidCraft 0.45.0 was not pinned: not signed by Developer ID team G5QA5U5X2S", failure: "wrong-team" };
      },
    });
    await mountCadCard(host, api).ready;
    host.querySelector<HTMLInputElement>("#cad-pin-input")!.value = "0.45.0";
    click("#cad-pin-set");
    await flush();
    expect(text("#cad-error")).toContain("not signed by Developer ID team G5QA5U5X2S");
    expect(text("#cad-pin-version")).toBe("0.44.1");
    expect(api.toasts).toEqual([]);
  });

  test("[B1] 'Pin back' first shows the warning list of rewritten designs, and only pins back on confirm", async () => {
    const api = fakeApi();
    await mountCadCard(host, api).ready;
    click("#cad-pin-back");
    await flush();
    expect(api.calls).toContain("preview");
    expect(api.calls).not.toContain("back"); // nothing happened yet
    expect(text("#cad-pinback-warning")).toContain("Pin back to SolidCraft 0.43.0?");
    expect(text("#cad-pinback-warning")).toContain("may not open after pinning back");
    expect(text("#cad-pinback-warning")).toContain("Nothing is rewritten automatically");
    const items = [...host.querySelectorAll("#cad-pinback-list li")].map((li) => li.textContent!.replace(/\s+/g, " ").trim());
    expect(items).toEqual(["bracket · fixtures", "<lid> · Mac-Mini-M1"]);
    expect(host.querySelector("#cad-pinback-list")!.innerHTML).toContain("&lt;lid&gt;"); // names are escaped

    click("#cad-pinback-confirm");
    await flush();
    expect(api.calls).toContain("back");
    expect(text("#cad-pin-version")).toBe("0.43.0");
    expect(host.querySelector("#cad-pinback-warning")).toBeNull();
    expect(api.toasts[0]).toContain("pinned back to 0.43.0");
  });

  test("[B1] cancelling the pin-back warning changes nothing; an empty or incomplete list is stated", async () => {
    const api = fakeApi();
    await mountCadCard(host, api).ready;
    click("#cad-pin-back");
    await flush();
    click("#cad-pinback-cancel");
    expect(host.querySelector("#cad-pinback-warning")).toBeNull();
    expect(api.calls).not.toContain("back");

    const preview: rest.solidcraft.PinBackPreviewResponse = { ok: true, current: { version: "0.44.1", sha256: SHA_NEW }, previous: { version: "0.43.0", sha256: SHA_OLD }, rewritten: [] };
    expect(cadCardHtml({ status: status(), pinBack: preview })).toContain("No designs are recorded as rewritten by SolidCraft 0.44.1");
    expect(cadCardHtml({ status: status(), pinBack: { ...preview, listError: "design store offline" } })).toContain("Treat it as incomplete");
    expect(cadCardHtml({ status: status(), pinBack: { ok: false, rewritten: [], error: "there is no previous pin to go back to" } })).toContain("no previous pin");
  });

  test("[B1] with no design store connected the pin-back warning says the list is not available, never that it is empty", () => {
    const base: rest.solidcraft.PinBackPreviewResponse = { ok: true, current: { version: "0.44.1", sha256: SHA_NEW }, previous: { version: "0.43.0", sha256: SHA_OLD }, rewritten: [] };
    // No provider: unknown.
    host.innerHTML = cadCardHtml({ status: status(), pinBack: { ...base, listUnavailable: true } });
    expect(text("#cad-pinback-unavailable")).toContain("not available yet");
    expect(text("#cad-pinback-unavailable")).toContain("0.44.1");
    expect(text("#cad-pinback-warning")).not.toContain("No designs are recorded");
    expect(host.querySelector("#cad-pinback-none")).toBeNull();
    expect(host.querySelector("#cad-pinback-confirm")).not.toBeNull(); // the owner can still pin back
    // A provider that answered "none": that, and only that, is stated as none.
    host.innerHTML = cadCardHtml({ status: status(), pinBack: base });
    expect(text("#cad-pinback-none")).toContain("No designs are recorded as rewritten by SolidCraft 0.44.1");
    expect(host.querySelector("#cad-pinback-unavailable")).toBeNull();
  });

  test("[B1] the replay-gate and live-process rows are labelled placeholders until a later phase supplies them", async () => {
    const card = mountCadCard(host, fakeApi());
    await card.ready;
    expect(text("#cad-card")).toContain("Last replay gate result");
    expect(text("#cad-card")).toContain("Live CAD processes");
    expect(host.querySelector<HTMLElement>("#cad-replay-gate")!.dataset.placeholder).toBe("B2");
    expect(text("#cad-replay-gate")).toContain("Phase B2");
    expect(host.querySelector<HTMLElement>("#cad-live-processes")!.dataset.placeholder).toBe("track-a");
    expect(text("#cad-live-processes")).toContain("Track A");

    // The seam later phases use: pass the value, the placeholder goes away.
    card.setExtras({ replayGate: "0.45.0 passed on 3 machines", liveProcesses: "2 running on Mac-Mini-M4" });
    expect(text("#cad-replay-gate")).toBe("0.45.0 passed on 3 machines");
    expect(host.querySelector<HTMLElement>("#cad-replay-gate")!.dataset.placeholder).toBeUndefined();
    expect(text("#cad-live-processes")).toBe("2 running on Mac-Mini-M4");
  });

  test("[B1] while a fan-out is active the controls are disabled and the card says so", () => {
    host.innerHTML = cadCardHtml({ status: status({ active: true }) });
    expect(host.querySelector<HTMLButtonElement>("#cad-pin-set")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#cad-pin-back")!.disabled).toBe(true);
    expect(text("#cad-active")).toContain("Applying the pin");
    expect(cadCardHtml({ status: null })).toContain("Loading…");
  });

  test("[B1] the CAD tab exists only when the hub advertises solidcraft-pin", () => {
    expect(CAD_PIN_CAPABILITY).toBe("solidcraft-pin");
    expect(cadTabHtml(false)).toBe("");
    host.innerHTML = cadTabHtml(true);
    const tab = host.querySelector<HTMLElement>("button.stab")!;
    expect(tab.dataset.tab).toBe("cad");
    expect(tab.textContent).toContain("CAD");
    // settings.ts cannot be imported here (it pulls in the whole app), so its use of the two is
    // pinned at the source: the tab is built from the hub's capability, and the panel is emptied
    // without it.
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "settings.ts"), "utf8");
    expect(src).toContain("const cadOn = serverSupports(hub(), CAD_PIN_CAPABILITY);");
    expect(src).toContain("${cadTabHtml(cadOn)}");
    expect(src).toContain('if (!cadOn && settingsTab === "cad") settingsTab = "environments";');
    expect(src).toContain("if (!serverSupports(hub(), CAD_PIN_CAPABILITY)) {");
  });
});
