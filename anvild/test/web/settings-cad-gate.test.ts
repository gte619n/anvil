/**
 * Phase B2 web tests for the replay-gate part of the Settings → CAD card (web/src/settings-cad.ts):
 * the last evaluation (candidate, when, result, per-machine status, per-part differences, advisory
 * list) and the two manual controls, "Check now" and "Advance anyway". The card's `api` is a fake;
 * the DOM is jsdom.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { rest, SolidcraftEvaluation, SolidcraftReplayPart } from "../../protocol";
import { installDom, uninstallDom } from "./dom-env";
import { cadCardHtml, gateSummary, mountCadCard, type CadCardApi } from "../../web/src/settings-cad";

const SHA = (c: string) => c.repeat(64);
const fleet = (over: Partial<rest.solidcraft.FleetStatusResponse> = {}): rest.solidcraft.FleetStatusResponse => ({
  ok: true,
  active: false,
  pin: { version: "0.44.1", sha256: SHA("a"), pinnedAt: "2026-11-19T10:00:00.000Z", previous: { version: "0.43.0", sha256: SHA("9") } },
  members: [{ serverId: "hub", serverName: "Mac-Mini-M4", isHub: true, state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true }],
  ...over,
});
const part = (name: string, over: Partial<SolidcraftReplayPart> = {}): SolidcraftReplayPart => ({ part: name, environment: "lapo", path: `cad/${name}/design.json`, ref: "origin/main", outcome: "same", ...over });
const BRACKET = part("bracket", { outcome: "differs", differences: [{ field: "volume_mm3", body: "Body1", old: 6000, new: 6006 }], old: { body_count: 1, faces: 6, volume_mm3: 6000 }, new: { body_count: 1, faces: 6, volume_mm3: 6006 } });
const rejected: SolidcraftEvaluation = {
  candidate: { version: "0.45.0", sha256: SHA("b") },
  baseline: "0.44.1",
  startedAt: "2026-11-19T12:00:00.000Z",
  finishedAt: "2026-11-19T12:03:00.000Z",
  result: "rejected",
  detail: "SolidCraft 0.45.0 was rejected: bracket: volume (mm³) 6000 → 6006 (lapo, on Mac-Mini-M1). The pin is unchanged.",
  machines: [
    { serverId: "hub", serverName: "Mac-Mini-M4", isHub: true, state: "pass", holds: false, report: { candidate: "0.45.0", baseline: "0.44.1", hostsDesigns: true, pass: true, parts: [part("plate")], advisory: [part("wip", { worktree: "new lid", ref: undefined, outcome: "differs", differences: [{ field: "faces", body: "Body1", old: 6, new: 8 }] }), part("ok", { worktree: "tidy" })], notes: [] } },
    {
      serverId: "m1",
      serverName: "Mac-Mini-M1",
      isHub: false,
      state: "fail",
      holds: true,
      detail: "bracket: volume (mm³) 6000 → 6006",
      report: { candidate: "0.45.0", baseline: "0.44.1", hostsDesigns: true, pass: false, parts: [BRACKET, part("lid", { outcome: "candidate-error", error: "eval exited 139" }), part("old", { outcome: "baseline-broken", error: "feature Corners failed" }), part("plate")], advisory: [], notes: [] },
    },
    { serverId: "m2", serverName: "Studio", isHub: false, state: "unreachable", holds: true, detail: "unreachable — it hosts (or may host) designs, so the pin holds" },
  ],
};
const gate = (over: Partial<rest.solidcraft.CandidateStatusResponse> = {}): rest.solidcraft.CandidateStatusResponse => ({
  ok: true,
  lastEvaluation: rejected,
  lastCheck: { at: "2026-11-19T12:03:00.000Z", outcome: "rejected", version: "0.45.0", detail: rejected.detail },
  rejected: [{ version: "0.45.0", sha256: SHA("b"), rejectedAt: "2026-11-19T12:03:00.000Z", reason: "bracket: volume (mm³) 6000 → 6006", failures: [{ ...BRACKET, serverName: "Mac-Mini-M1" }] }],
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
const text = (sel: string): string => (host.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (sel: string): void => host.querySelector<HTMLElement>(sel)!.click();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface FakeApi extends CadCardApi {
  calls: string[];
  toasts: string[];
  fleetNow: rest.solidcraft.FleetStatusResponse;
  gateNow: rest.solidcraft.CandidateStatusResponse;
}
function fakeApi(initialGate = gate(), over: Partial<CadCardApi> = {}): FakeApi {
  const api: FakeApi = {
    calls: [],
    toasts: [],
    fleetNow: fleet(),
    gateNow: initialGate,
    pollMs: 0,
    fleetStatus: async () => api.fleetNow,
    setPin: async () => ({ ok: false, members: [] }),
    pinBackPreview: async () => ({ ok: false, rewritten: [] }),
    pinBack: async () => ({ ok: false, members: [], rewritten: [] }),
    async gate() {
      api.calls.push("gate");
      return api.gateNow;
    },
    async checkNow() {
      api.calls.push("check");
      const check = { at: "2026-11-19T16:00:00.000Z", outcome: "none" as const, detail: "No release qualifies: it must be a full release, at least 48 hours old." };
      api.gateNow = { ...api.gateNow, lastCheck: check };
      return { ...api.gateNow, check };
    },
    async advanceAnyway(version) {
      api.calls.push(`advance:${version}`);
      api.fleetNow = fleet({ pin: { version, sha256: SHA("b"), pinnedAt: "2026-11-19T16:05:00.000Z", previous: { version: "0.44.1", sha256: SHA("a") } } });
      api.gateNow = { ...api.gateNow, lastEvaluation: { ...rejected, advancedAnyway: "2026-11-19T16:05:00.000Z" } };
      return { ...api.gateNow, pin: api.fleetNow.pin };
    },
    toast: (m) => void api.toasts.push(m),
    ...over,
  };
  return api;
}

describe("Settings → CAD card: replay gate", () => {
  test("[B2] the last evaluation shows the candidate, when, the result and each machine's status", async () => {
    const card = mountCadCard(host, fakeApi());
    await card.ready;
    expect(text("#cad-replay-gate")).toContain("0.45.0 rejected — pin held");
    expect(host.querySelector<HTMLElement>("#cad-replay-gate")!.dataset.placeholder).toBeUndefined(); // B1's placeholder is filled
    expect(text("#cad-gate-result")).toContain("SolidCraft 0.45.0 against the pinned 0.44.1");
    expect(text("#cad-gate-result")).toContain(new Date(rejected.finishedAt).toLocaleString());
    expect(host.querySelector<HTMLElement>("#cad-gate-result")!.dataset.result).toBe("rejected");
    expect(text("#cad-gate-detail")).toContain("The pin is unchanged");
    const rows = [...host.querySelectorAll<HTMLElement>(".cad-gate-machine")];
    expect(rows.map((r) => [r.dataset.serverId, r.dataset.state, r.dataset.holds ?? "0"])).toEqual([["hub", "pass", "0"], ["m1", "fail", "1"], ["m2", "unreachable", "1"]]);
    expect(rows[0]!.textContent).toContain("Mac-Mini-M4");
    expect(rows[0]!.textContent).toContain("Same on every design");
    expect(rows[1]!.textContent).toContain("Differs");
    expect(rows[1]!.textContent).toContain("4 designs");
    expect(text("#cad-gate-rejected")).toContain("0.45.0");
    expect(text("#cad-gate-check")).toContain("Last check");
  });

  test("[B2] a held evaluation names the unreachable member on the card", () => {
    const held: SolidcraftEvaluation = { ...rejected, result: "held", detail: "SolidCraft 0.45.0 is held: Studio (unreachable). The pin is unchanged; it is evaluated again on the next check.", machines: [rejected.machines[0]!, rejected.machines[2]!] };
    host.innerHTML = cadCardHtml({ status: fleet(), gate: gate({ lastEvaluation: held, rejected: [] }) });
    const row = host.querySelector<HTMLElement>(`.cad-gate-machine[data-state="unreachable"]`)!;
    expect(row.textContent).toContain("Studio");
    expect(row.textContent).toContain("Unreachable");
    expect(row.textContent).toContain("holds the pin");
    expect(text("#cad-gate-detail")).toContain("Studio (unreachable)");
    expect(text("#cad-replay-gate")).toContain("0.45.0 held — not decided");
    expect(host.querySelector("#cad-gate-differences")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>("#cad-advance-anyway")!.disabled).toBe(false);
  });

  test("[B2] per-part differences show the old and new numbers; broken-under-the-pin and advisory designs are listed apart", async () => {
    const card = mountCadCard(host, fakeApi());
    await card.ready;
    const diffs = [...host.querySelectorAll<HTMLElement>("#cad-gate-differences .cad-part")];
    expect(diffs.map((d) => [d.dataset.part, d.dataset.outcome])).toEqual([["bracket", "differs"], ["lid", "candidate-error"]]);
    expect(diffs[0]!.textContent).toContain("volume (mm³) of Body1: 6000 → 6006");
    expect(diffs[0]!.textContent).toContain("lapo · origin/main · Mac-Mini-M1");
    expect(diffs[1]!.textContent).toContain("replays under the pinned build, fails under the candidate: eval exited 139");
    // Already broken under the pin: its own list, marked as ignored.
    expect(text("#cad-gate-broken")).toContain("old");
    expect(text("#cad-gate-broken")).toContain("ignored for the decision");
    expect(text("#cad-gate-differences")).not.toContain("feature Corners failed");
    // Advisory: worktree designs, only those that are not the same, with the count replayed.
    const adv = [...host.querySelectorAll<HTMLElement>("#cad-gate-advisory .cad-part")];
    expect(adv.map((d) => d.dataset.part)).toEqual(["wip"]);
    expect(adv[0]!.textContent).toContain("worktree new lid");
    expect(adv[0]!.textContent).toContain("face count of Body1: 6 → 8");
    expect(text("#cad-gate")).toContain("2 replayed; these never hold the pin");
    expect(text("#cad-gate-differences")).not.toContain("wip");
  });

  test("[B2] 'Check now' asks the hub to check and repaints with what it did", async () => {
    const api = fakeApi();
    const card = mountCadCard(host, api);
    await card.ready;
    click("#cad-check-now");
    await flush();
    expect(api.calls).toContain("check");
    expect(api.toasts).toEqual(["No release qualifies: it must be a full release, at least 48 hours old."]);
    expect(host.querySelector<HTMLElement>("#cad-gate-check")!.dataset.outcome).toBe("none");
    expect(text("#cad-gate-check")).toContain("No release qualifies");
    expect(host.querySelector<HTMLButtonElement>("#cad-check-now")!.disabled).toBe(false);
    // While an evaluation runs the controls are off and the card says the pinned build keeps serving.
    host.innerHTML = cadCardHtml({ status: fleet(), gate: gate({ evaluating: { version: "0.46.0", startedAt: "2026-11-19T16:00:00.000Z" } }) });
    expect(host.querySelector<HTMLButtonElement>("#cad-check-now")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#cad-advance-anyway")!.disabled).toBe(true);
    expect(text("#cad-gate-evaluating")).toContain("Evaluating SolidCraft 0.46.0");
    expect(text("#cad-gate-evaluating")).toContain("pinned build keeps serving");
  });

  test("[B2] 'Advance anyway' shows the differences first, and only advances on confirm", async () => {
    const api = fakeApi();
    const card = mountCadCard(host, api);
    await card.ready;
    expect(text("#cad-advance-anyway")).toContain("Advance anyway to 0.45.0");
    expect(host.querySelector("#cad-advance-warning")).toBeNull();

    click("#cad-advance-anyway");
    expect(api.calls.some((c) => c.startsWith("advance"))).toBe(false); // nothing sent yet
    expect(text("#cad-advance-warning")).toContain("Advance to SolidCraft 0.45.0 anyway?");
    expect(text("#cad-advance-warning")).toContain("The replay gate did not pass this build");
    const shown = [...host.querySelectorAll<HTMLElement>("#cad-advance-differences .cad-part")];
    expect(shown.map((d) => d.dataset.part)).toEqual(["bracket", "lid"]);
    expect(shown[0]!.textContent).toContain("6000 → 6006");

    click("#cad-advance-cancel");
    expect(host.querySelector("#cad-advance-warning")).toBeNull();
    expect(api.calls.some((c) => c.startsWith("advance"))).toBe(false);

    click("#cad-advance-anyway");
    click("#cad-advance-confirm");
    await flush();
    expect(api.calls).toContain("advance:0.45.0");
    expect(text("#cad-pin-version")).toBe("0.45.0");
    expect(text("#cad-gate-result")).toContain("advanced anyway by the owner");
    expect(host.querySelector<HTMLButtonElement>("#cad-advance-anyway")!.disabled).toBe(true); // nothing left to advance
    expect(api.toasts.at(-1)).toContain("advanced to 0.45.0");
  });

  test("[B2] a refused 'Advance anyway' shows the hub's reason and leaves the pin as it was", async () => {
    const api = fakeApi(gate(), { advanceAnyway: async () => ({ ok: false, rejected: [], error: "a SolidCraft pin change is already in progress" }) });
    const card = mountCadCard(host, api);
    await card.ready;
    click("#cad-advance-anyway");
    click("#cad-advance-confirm");
    await flush();
    expect(text("#cad-error")).toContain("already in progress");
    expect(text("#cad-pin-version")).toBe("0.44.1");
  });

  test("[B2] with nothing evaluated yet, after an advance, and against a hub without the gate, the card says what is true", async () => {
    // Nothing evaluated yet.
    host.innerHTML = cadCardHtml({ status: fleet(), gate: { ok: true, rejected: [] } });
    expect(text("#cad-replay-gate")).toBe("No candidate has been evaluated yet.");
    expect(text("#cad-gate-result")).toBe("No candidate has been evaluated yet.");
    expect(host.querySelector<HTMLButtonElement>("#cad-advance-anyway")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("#cad-check-now")!.disabled).toBe(false);
    // A passed evaluation: nothing to advance, the 24-hour limit is stated, an interrupted one is stated.
    const advanced: SolidcraftEvaluation = { ...rejected, result: "advanced", detail: "SolidCraft 0.45.0 replayed every design identically on 2 machines that host designs. The pin advanced from 0.44.1.", machines: [rejected.machines[0]!] };
    const g = gate({ lastEvaluation: advanced, rejected: [], nextAdvanceAllowedAt: "2026-11-20T12:03:00.000Z", interrupted: "The evaluation of SolidCraft 0.46.0 was cut short by a restart." });
    host.innerHTML = cadCardHtml({ status: fleet({ pin: { version: "0.45.0", sha256: SHA("b"), pinnedAt: "2026-11-19T12:03:00.000Z" } }), gate: g });
    expect(gateSummary(g)).toContain("0.45.0 passed — pin advanced");
    expect(host.querySelector<HTMLButtonElement>("#cad-advance-anyway")!.disabled).toBe(true);
    expect(text("#cad-gate-limit")).toContain("at most once in 24 hours");
    expect(text("#cad-gate-interrupted")).toContain("cut short by a restart");
    expect(host.querySelector("#cad-gate-differences")).toBeNull();
    // A hub that does not serve the gate (older build): the row stays a labelled placeholder, no block.
    const old = mountCadCard(host, fakeApi(gate(), { gate: async () => null }));
    await old.ready;
    expect(host.querySelector<HTMLElement>("#cad-replay-gate")!.dataset.placeholder).toBe("B2");
    expect(host.querySelector("#cad-gate")).toBeNull();
  });
});
