/**
 * [A4] The part card's Phase A4 pieces and the two new cards (agent-cad-and-browser spec §4.9, §4.7):
 * thumbnail through the preview route (never inline data), Release while passing, the Released badge,
 * the gap with Clear gap, the script size above 5 MB, a concept's advisory picture score; the
 * dimensions card with numeric inputs; the release card. jsdom, the real module, a fake pane.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let mod: typeof import("../../web/src/cad-cards");
beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="conversation"></div></body></html>` });
  mod = await import("../../web/src/cad-cards");
});
afterAll(() => uninstallDom());

const HUB = "http://hub";
const pane = () => document.getElementById("conversation")!;
let sent: any[] = [];
function cards() {
  return mod.createCadCards({
    supported: () => true,
    active: () => ({ sessionId: "s1", url: HUB }),
    container: pane,
    respond: (url, requestId, approve, values) => void sent.push({ type: "respond", url, requestId, approve, values }),
    open: () => undefined,
    release: (url, ev) => void sent.push({ type: "release", url, part: ev.part, cwd: ev.cwd }),
    clearGap: (url, ev) => void sent.push({ type: "clear", url, part: ev.part }),
    fileUrl: (url, ev, path) => `${url}/api/cad/preview?cwd=${encodeURIComponent(ev.cwd)}&path=${encodeURIComponent(path)}`,
  });
}
beforeEach(() => {
  pane().innerHTML = "";
  sent = [];
});
const design = (more: Record<string, unknown> = {}, gate: Record<string, unknown> = {}) =>
  ({
    v: 4, ts: "t", type: "cad.design", cwd: "/repo", part: "plate", rev: 3, params: [], busy: false, by: "agent", sessionIds: ["s1"],
    gate: { state: "pass", checks: [], warnings: [], staleBuild: false, approvedBy: "owner", ...gate },
    ...more,
  }) as any;
const card = () => pane().querySelector<HTMLElement>(".cad-part")!;

test("[A4] the part card shows the thumbnail from the preview route, Release while passing (sending cad.release.request), and the Released badge only when the event says the pack verified", () => {
  const c = cards();
  c.onDesign(HUB, design({ thumbnail: "cad/plate/.cache/thumb-3.png" }));
  const img = card().querySelector<HTMLImageElement>('[data-slot="thumbnail"] img')!;
  expect(card().querySelector<HTMLElement>('[data-slot="thumbnail"]')!.hidden).toBe(false);
  expect(img.getAttribute("src")).toBe("http://hub/api/cad/preview?cwd=%2Frepo&path=cad%2Fplate%2F.cache%2Fthumb-3.png");
  expect(img.getAttribute("src")).not.toContain("data:");
  const slot = card().querySelector<HTMLElement>('[data-slot="release"]')!;
  expect(slot.hidden).toBe(false);
  slot.querySelector<HTMLButtonElement>("button")!.click();
  expect(sent).toEqual([{ type: "release", url: HUB, part: "plate", cwd: "/repo" }]);
  expect(card().querySelector('[data-role="released"]')).toBeNull();
  c.onDesign(HUB, design({ released: { path: "cad/plate/release/plate-abcdef0", scriptSha: "abcdef0123", at: "t" } }));
  expect(card().querySelector('[data-role="released"]')!.textContent).toBe("Released");
  // Not passing: no Release button.
  for (const state of ["fail", "unverified", "concept", "gap"]) {
    c.onDesign(HUB, design({}, { state }));
    expect(card().querySelector<HTMLElement>('[data-slot="release"]')!.hidden).toBe(true);
  }
  // No thumbnail in the event: the slot stays hidden.
  c.onDesign(HUB, design());
  expect(card().querySelector<HTMLElement>('[data-slot="thumbnail"]')!.hidden).toBe(true);
});

test("[A4] a gap is shown with its text and a Clear gap button (sending cad.gap.clear); the script size shows only above 5 MB; a concept's picture score is an advisory line", () => {
  const c = cards();
  c.onDesign(HUB, design({ scriptBytes: 6 * 1024 * 1024 }, { state: "gap", gap: { feature: "thread", detail: "no <b>thread</b> feature", at: "t" } }));
  const gap = card().querySelector<HTMLElement>('[data-role="gap"]')!;
  expect(gap.textContent).toBe("Blocked: thread — no <b>thread</b> feature"); // text, not HTML
  expect(gap.querySelector("b b")).toBeNull();
  card().querySelector<HTMLButtonElement>(".cad-part-clear-gap")!.click();
  expect(sent).toEqual([{ type: "clear", url: HUB, part: "plate" }]);
  expect(card().querySelector('[data-role="script-size"]')!.textContent).toContain("6 MB");
  c.onDesign(HUB, design({ scriptBytes: 5 * 1024 * 1024 }));
  expect(card().querySelector('[data-role="script-size"]')).toBeNull();
  expect(card().querySelector(".cad-part-clear-gap")).toBeNull();
  c.onDesign(HUB, design({}, { state: "concept", checks: [{ id: "picture.overlap", expected: "advisory: the model's outline against the picture", measured: "93.1% overlap with photos/knob.png", ok: true, hard: false }] }));
  expect(card().querySelector(".cad-part-advisory")!.textContent).toContain("93.1% overlap with photos/knob.png");
});

test("[A4] the dimensions card has a numeric input per dimension, prefilled with the proposal; Submit sends the owner's typed numbers, a non-number is caught before sending, Deny sends a denial", () => {
  const c = cards();
  const req = { v: 4, ts: "t", type: "cad.expectations.request", requestId: "cadx_d", sessionId: "s1", cwd: "/repo", part: "bracket", kind: "dimensions", note: "Type the real dimensions.", rows: [], dimensions: [{ name: "L", value: 60, unit: "mm", note: "overall length" }, { name: "W", value: 20, unit: "mm" }] } as any;
  c.onRequest(HUB, req);
  const el = pane().querySelector<HTMLElement>('[data-req="cadx_d"]')!;
  const inputs = [...el.querySelectorAll<HTMLInputElement>("input.cad-dim-input")];
  expect(inputs.map((i) => [i.name, i.type, i.value])).toEqual([["L", "number", "60"], ["W", "number", "20"]]);
  expect(el.textContent).toContain("overall length");
  expect(el.querySelector("form")).not.toBeNull();
  inputs[0]!.value = "";
  el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(sent).toEqual([]);
  expect(el.querySelector<HTMLElement>('[data-role="error"]')!.hidden).toBe(false);
  inputs[0]!.value = "95";
  el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(sent).toEqual([{ type: "respond", url: HUB, requestId: "cadx_d", approve: true, values: { L: 95, W: 20 } }]);
  c.onResolved(HUB, { type: "cad.expectations.resolved", requestId: "cadx_d", approved: true } as any);
  expect(inputs.every((i) => i.disabled)).toBe(true);
  // Deny on a second card.
  c.onRequest(HUB, { ...req, requestId: "cadx_e" });
  pane().querySelector<HTMLElement>('[data-req="cadx_e"] .perm-btn.deny')!.click();
  expect(sent.at(-1)).toEqual({ type: "respond", url: HUB, requestId: "cadx_e", approve: false, values: undefined });
});

test("[A4] the release card shows expected and measured numbers and says prominently when the numbers are the agent's; Approve / Deny only", () => {
  const c = cards();
  c.onRequest(HUB, {
    v: 4, ts: "t", type: "cad.expectations.request", requestId: "cadx_r", sessionId: "s1", cwd: "/repo", part: "plate", kind: "release",
    note: "The expected numbers were set by the agent and you have not confirmed them. Approving this release also confirms them as yours.",
    rows: [{ label: "volume", old: "23335.167", new: "23335.167" }, { label: "Script", new: "abcdef012345 · 12 KB" }],
  } as any);
  const el = pane().querySelector<HTMLElement>('[data-req="cadx_r"]')!;
  expect(el.querySelector(".perm-head")!.textContent).toContain("Release part");
  expect([...el.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["", "Expected", "Measured"]);
  expect(el.querySelector('[data-role="note"]')!.className).toContain("cad-expect-note-strong");
  expect([...el.querySelectorAll(".perm-btns button")].map((b) => b.textContent)).toEqual(["Approve", "Deny"]);
  el.querySelector<HTMLButtonElement>(".perm-btn.allow")!.click();
  expect(sent).toEqual([{ type: "respond", url: HUB, requestId: "cadx_r", approve: true, values: undefined }]);
});
