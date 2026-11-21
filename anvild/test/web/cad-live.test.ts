/**
 * [A3] The live viewer's state logic and the parameters panel (agent-cad-and-browser spec §4.9):
 * Follow / Paused with the "N behind" badge, Reload, Rebuild, the busy line, and the panel's editing,
 * error display and gate strip. jsdom, the real modules, a fake `show` in place of three.js (the
 * real swap is proven in test/golden/live.pw.ts).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let liveMod: typeof import("../../web/src/cad-live");
let paramsMod: typeof import("../../web/src/cad-params");
beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="host"></div></body></html>` });
  liveMod = await import("../../web/src/cad-live");
  paramsMod = await import("../../web/src/cad-params");
});
afterAll(() => uninstallDom());
beforeEach(() => void (document.getElementById("host")!.innerHTML = ""));

const host = () => document.getElementById("host")!;
const tick = () => new Promise((r) => setTimeout(r, 0));
const check = (id: string, expected: number | string, measured: number | string, ok: boolean, hard = true) => ({ id, expected, measured, ok, hard });
const design = (rev: number, more: Record<string, unknown> = {}, gate: Record<string, unknown> = {}) =>
  ({
    v: 4,
    ts: "t",
    type: "cad.design",
    cwd: "/repo",
    part: "plate",
    rev,
    preview: `cad/plate/.cache/preview-${rev}.glb`,
    params: [
      { name: "L", expression: "80 mm", value: 80, unit: "mm" },
      { name: "W", expression: "50 mm", value: 50, unit: "mm" },
    ],
    gate: { state: "pass", checks: [check("volume", 23335.167, 23335.167, true)], warnings: [], staleBuild: false, ...gate },
    busy: false,
    by: "agent",
    ...more,
  }) as any;

function live() {
  const shown: number[] = [];
  const cleared: number[] = [];
  let rebuilds = 0;
  let gate: Promise<void> | undefined;
  let fail: string | undefined;
  const l = liveMod.createCadLive({
    part: "plate",
    show: async (ev) => {
      if (gate) await gate;
      if (fail) throw new Error(fail);
      shown.push(ev.rev);
    },
    clear: (ev) => void cleared.push(ev.rev),
    rebuild: () => void rebuilds++,
  });
  host().append(l.el);
  const q = (name: string) => l.el.querySelector<HTMLElement>(`[data-live="${name}"]`)!;
  return { l, shown, cleared, q, rebuilds: () => rebuilds, hold: (p: Promise<void> | undefined) => (gate = p), failWith: (m: string | undefined) => (fail = m) };
}

test("[A3] Follow is on by default and every new rev is shown; the same rev again (a busy-only event) is not a swap", async () => {
  const x = live();
  expect(x.l.following()).toBe(true);
  expect(x.q("follow").getAttribute("aria-checked")).toBe("true");
  x.l.onDesign(design(1));
  await tick();
  x.l.onDesign(design(1, { busy: true }));
  await tick();
  expect(x.q("busy").hidden).toBe(false);
  expect(x.q("busy").textContent).toBe("working…");
  x.l.onDesign(design(2));
  await tick();
  expect(x.shown).toEqual([1, 2]);
  expect(x.l.shownRev()).toBe(2);
  expect(x.l.behind()).toBe(0);
  expect(x.q("behind").hidden).toBe(true);
  expect(x.q("reload").hidden).toBe(true);
  expect(x.q("busy").hidden).toBe(true);
  // Another part's event is not ours.
  x.l.onDesign(design(9, { part: "bracket" }));
  await tick();
  expect(x.shown).toEqual([1, 2]);
});

test('[A3] Paused keeps the model, the badge counts revisions behind ("1 behind", "2 behind"), and Reload jumps to the newest and stays paused', async () => {
  const x = live();
  x.l.onDesign(design(1));
  await tick();
  x.q("follow").click();
  expect(x.l.following()).toBe(false);
  expect(x.q("follow").textContent).toBe("Paused");
  expect(x.q("follow").getAttribute("aria-checked")).toBe("false");
  expect(x.q("behind").hidden).toBe(true); // paused but up to date: nothing to say

  x.l.onDesign(design(2));
  await tick();
  expect(x.shown).toEqual([1]); // not swapped
  expect(x.q("behind").hidden).toBe(false);
  expect(x.q("behind").textContent).toBe("1 behind");
  expect(x.q("reload").hidden).toBe(false);
  x.l.onDesign(design(3));
  x.l.onDesign(design(3, { busy: true })); // the same rev again does not count twice
  await tick();
  expect(x.q("behind").textContent).toBe("2 behind");
  expect(x.l.behind()).toBe(2);

  x.q("reload").click();
  await tick();
  expect(x.shown).toEqual([1, 3]); // straight to the newest; rev 2 is never fetched
  expect(x.q("behind").hidden).toBe(true);
  expect(x.q("reload").hidden).toBe(true);
  expect(x.l.following()).toBe(false);
  x.l.onDesign(design(4));
  await tick();
  expect(x.q("behind").textContent).toBe("1 behind");
  // Turning Follow back on catches up at once.
  x.q("follow").click();
  await tick();
  expect(x.shown).toEqual([1, 3, 4]);
  expect(x.q("behind").hidden).toBe(true);
});

test("[A3] revisions that arrive while a swap is in flight collapse into one more swap, to the newest", async () => {
  const x = live();
  let open!: () => void;
  x.hold(new Promise<void>((r) => (open = r)));
  x.l.onDesign(design(1));
  x.l.onDesign(design(2));
  x.l.onDesign(design(3));
  x.l.onDesign(design(4));
  await tick();
  expect(x.shown).toEqual([]);
  expect(x.q("busy").hidden).toBe(false); // loading shows as working
  x.hold(undefined);
  open();
  await tick();
  await tick();
  expect(x.shown).toEqual([1, 4]);
  expect(x.l.shownRev()).toBe(4);
});

test("[A3] Rebuild asks for a rebuild; waiting for a slot and a failed load are said in words; an empty design clears the model", async () => {
  const x = live();
  x.q("rebuild").click();
  expect(x.rebuilds()).toBe(1);
  x.l.onDesign(design(1, { busy: true, waiting: true }));
  await tick();
  expect(x.q("busy").textContent).toBe("waiting for a CAD slot");
  expect(liveMod.WAITING_FOR_SLOT).toBe("waiting for a CAD slot");
  x.failWith("Couldn't load preview-2.glb — not found");
  x.l.onDesign(design(2));
  await tick();
  expect(x.q("error").hidden).toBe(false);
  expect(x.q("error").textContent).toContain("not found");
  expect(x.l.shownRev()).toBe(1); // the model on screen is still rev 1
  x.failWith(undefined);
  x.l.onDesign(design(3, { preview: undefined }));
  await tick();
  expect(x.cleared).toEqual([3]);
  expect(x.shown).toEqual([1]);
  expect(x.q("error").hidden).toBe(true);
  x.l.dispose();
  x.l.onDesign(design(4));
  await tick();
  expect(x.shown).toEqual([1]);
  expect(host().children.length).toBe(0);
});

test("[A3] the design store keeps the newest event per server, worktree and part, and tells that part's listeners only", () => {
  const store = liveMod.createCadDesignStore();
  const got: number[] = [];
  const off = store.subscribe("http://hub", "/repo", "plate", (ev) => void got.push(ev.rev));
  store.put("http://hub", design(1));
  store.put("http://hub", design(2, { part: "bracket" }));
  store.put("http://member", design(3));
  store.put("http://hub", design(4, { cwd: "/other" }));
  store.put("http://hub", design(5));
  expect(got).toEqual([1, 5]);
  expect(store.get("http://hub", "/repo", "plate")!.rev).toBe(5);
  expect(store.get("http://member", "/repo", "plate")!.rev).toBe(3);
  expect(store.get("http://hub", "/repo", "nope")).toBeUndefined();
  off();
  store.put("http://hub", design(6));
  expect(got).toEqual([1, 5]);
  store.forget("http://hub");
  expect(store.get("http://hub", "/repo", "plate")).toBeUndefined();
  expect(store.get("http://member", "/repo", "plate")!.rev).toBe(3);
});

function panel(reply: (name: string, expr: string) => Promise<{ ok: boolean; error?: string }> = async () => ({ ok: true })) {
  const sent: [string, string][] = [];
  const p = paramsMod.createCadParams({
    setParam: (name, expression) => {
      sent.push([name, expression]);
      return reply(name, expression);
    },
  });
  host().append(p.el);
  const row = (name: string) => p.el.querySelector<HTMLElement>(`.cad-param[data-param="${name}"]`)!;
  const input = (name: string) => row(name).querySelector("input")!;
  const type = (name: string, value: string) => {
    const i = input(name);
    i.focus();
    i.value = value;
    i.dispatchEvent(new window.Event("input", { bubbles: true }));
    i.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  return { p, sent, row, input, type, gate: () => p.el.querySelector<HTMLElement>('[data-role="gate"]')! };
}

test("[A3] the panel lists the user parameters with expression and value, and the gate strip under it shows state, failing checks and advisories", () => {
  const x = panel();
  x.p.onDesign(design(1));
  expect([...x.p.el.querySelectorAll(".cad-param")].map((r) => (r as HTMLElement).dataset.param)).toEqual(["L", "W"]);
  expect(x.input("L").value).toBe("80 mm");
  expect(x.row("L").querySelector(".cad-param-value")!.textContent).toBe("= 80 mm");
  expect(x.gate().dataset.state).toBe("pass");
  expect(x.gate().textContent).toContain("Gate passed");
  expect(x.gate().querySelector(".cad-gate-checks")).toBeNull();

  x.p.onDesign(
    design(
      2,
      { by: "panel", params: [{ name: "L", expression: "120 mm", value: 120, unit: "mm" }, { name: "W", expression: "L / 2", value: 60, unit: "mm" }, { name: "T", expression: "6 mm", value: 6, unit: "mm", error: "T is unused" }] },
      { state: "fail", checks: [check("volume", 23335.167, 35335.167, false), check("bodies", 1, 1, true), check("wall", "at least 0.8 mm (fdm-0.4)", "0.5 mm", false, false)], warnings: ["Fillet1: Boolean retry"], staleBuild: true },
    ),
  );
  expect([...x.p.el.querySelectorAll(".cad-param")].map((r) => (r as HTMLElement).dataset.param)).toEqual(["L", "W", "T"]);
  expect(x.input("L").value).toBe("120 mm");
  expect(x.input("W").value).toBe("L / 2");
  expect(x.row("W").querySelector(".cad-param-value")!.textContent).toBe("= 60 mm");
  expect(x.row("T").querySelector(".cad-param-error")!.textContent).toBe("T is unused");
  expect(x.gate().dataset.state).toBe("fail");
  expect(x.gate().textContent).toContain("Gate failed");
  expect(x.gate().textContent).toContain("after your change");
  const failing = [...x.gate().querySelectorAll(".cad-check-fail")].map((li) => li.textContent);
  expect(failing).toEqual(["volume expected 23335.167, measured 35335.167"]); // only the hard failures
  expect(x.gate().querySelector(".cad-gate-advisory")!.textContent).toContain("0.5 mm");
  expect(x.gate().querySelector(".cad-gate-advisory")!.textContent).toContain("Boolean retry");
  expect(x.gate().querySelector(".cad-gate-advisory")!.textContent).toContain("different SolidCraft version");
  x.p.onDesign(design(3, { params: [] }));
  expect(x.p.el.querySelectorAll(".cad-param").length).toBe(0);
  expect(x.p.el.querySelector(".cad-params-empty")!.textContent).toBe("No parameters yet.");
});

test("[A3] editing a value sends cad.param.set once; the daemon's event (which arrives before the reply) brings the canonical text", async () => {
  let answer!: (r: { ok: boolean }) => void;
  const x = panel(() => new Promise((r) => (answer = r)));
  x.p.onDesign(design(1));
  x.type("L", " 120 ");
  expect(x.sent).toEqual([["L", "120"]]);
  expect(x.input("L").disabled).toBe(true);
  x.input("L").dispatchEvent(new window.Event("change", { bubbles: true })); // the blur that follows Enter
  expect(x.sent).toHaveLength(1);
  // The daemon broadcasts the new state, THEN answers the command.
  x.p.onDesign(design(2, { by: "panel", params: [{ name: "L", expression: "120 mm", value: 120, unit: "mm" }, { name: "W", expression: "50 mm", value: 50, unit: "mm" }] }));
  expect(x.input("L").value).toBe(" 120 "); // not written over while the edit is on its way
  answer({ ok: true });
  await tick();
  expect(x.input("L").disabled).toBe(false);
  expect(x.input("L").value).toBe("120 mm");
  expect(x.row("L").querySelector<HTMLElement>(".cad-param-error")!.hidden).toBe(true);
  // An unchanged value, and an emptied field, send nothing.
  x.type("L", "120 mm");
  x.type("W", "");
  expect(x.sent).toHaveLength(1);
  expect(x.input("W").value).toBe("50 mm");
});

test("[A3] a bad expression shows the SolidCraft error and leaves the old value; typing again clears the error", async () => {
  const x = panel(async (_n, expr) => (expr === "80 +* mm(" ? { ok: false, error: "expression: unexpected token `*` at 4" } : { ok: true }));
  x.p.onDesign(design(1));
  x.type("L", "80 +* mm(");
  await tick();
  expect(x.sent).toEqual([["L", "80 +* mm("]]);
  const err = x.row("L").querySelector<HTMLElement>(".cad-param-error")!;
  expect(err.hidden).toBe(false);
  expect(err.textContent).toBe("expression: unexpected token `*` at 4");
  expect(err.getAttribute("role")).toBe("alert");
  expect(x.input("L").value).toBe("80 mm"); // the old value is back
  expect(x.input("L").disabled).toBe(false);
  expect(x.row("L").classList.contains("cad-param-bad")).toBe(true);
  // A later event for another reason does not wipe the message the owner has not dealt with.
  x.p.onDesign(design(1, { busy: true }));
  expect(err.hidden).toBe(false);
  x.input("L").value = "9";
  x.input("L").dispatchEvent(new window.Event("input", { bubbles: true }));
  expect(err.hidden).toBe(true);
  expect(x.row("L").classList.contains("cad-param-bad")).toBe(false);
  // The message is text, never markup.
  const y = panel(async () => ({ ok: false, error: "<img src=x onerror=alert(1)>" }));
  y.p.onDesign(design(1));
  y.type("L", "1");
  await tick();
  expect(y.row("L").querySelector(".cad-param-error")!.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(y.p.el.querySelector("img")).toBeNull();
});

test("[A3] an event does not write over a field the owner is typing in", () => {
  const x = panel();
  x.p.onDesign(design(1));
  const i = x.input("W");
  i.focus();
  i.value = "55";
  x.p.onDesign(design(2, { params: [{ name: "L", expression: "90 mm", value: 90, unit: "mm" }, { name: "W", expression: "50 mm", value: 50, unit: "mm" }] }));
  expect(i.value).toBe("55");
  expect(x.input("L").value).toBe("90 mm");
  i.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(i.value).toBe("50 mm");
});
