/**
 * [A2] The CAD cards in the chat (agent-cad-and-browser spec §4.9): the part card (one per part
 * touched in a turn, updated in place), the expectation-change card and the adopt card. jsdom, the
 * real module, a fake pane.
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
let capability = true;
let active: { sessionId: string; url: string } | undefined;
let sent: { url: string; requestId: string; approve: boolean }[] = [];
let opened: any[] = [];
function cards() {
  return mod.createCadCards({
    supported: () => capability,
    active: () => active,
    container: pane,
    respond: (url, requestId, approve) => void sent.push({ url, requestId, approve }),
    open: (url, ev) => void opened.push({ url, part: ev.part, rev: ev.rev }),
  });
}
beforeEach(() => {
  pane().innerHTML = "";
  capability = true;
  active = { sessionId: "s1", url: HUB };
  sent = [];
  opened = [];
});

const check = (id: string, expected: number | string, measured: number | string, ok: boolean, hard = true) => ({ id, expected, measured, ok, hard });
const design = (more: Record<string, unknown> = {}, gate: Record<string, unknown> = {}) =>
  ({
    v: 4,
    ts: "t",
    type: "cad.design",
    cwd: "/repo",
    part: "plate",
    rev: 1,
    params: [{ name: "L", expression: "80 mm", value: 80, unit: "mm" }],
    gate: { state: "pass", checks: [check("volume", 23335.167, 23335.167, true)], warnings: [], staleBuild: false, ...gate },
    busy: false,
    by: "agent",
    sessionIds: ["s1"],
    ...more,
  }) as any;
const request = (more: Record<string, unknown> = {}) =>
  ({
    v: 4,
    ts: "t",
    type: "cad.expectations.request",
    requestId: "cadx_1",
    sessionId: "s1",
    cwd: "/repo",
    part: "plate",
    kind: "propose",
    reason: "The customer asked for a longer plate.",
    rows: [
      { label: "Bounding box (mm)", old: "L × W × T  (= 6 × 50 × 80)", new: "L × W × T  (= 6 × 50 × 120)" },
      { label: "Bodies", old: "1", new: "1" },
    ],
    ...more,
  }) as any;

test("[A2] the part card shows the name, the gate state, every failing check, advisory lines and warnings, with slots left for the thumbnail and Release", () => {
  const c = cards();
  c.onDesign(
    HUB,
    design({}, {
      state: "fail",
      checks: [
        check("volume", 23335.167, 23737.2209, false),
        check("holes ⌀3.4 count", 4, 1, false),
        check("bbox.max", 80, 80, true),
        check("rules.minWall", "walls at least 1.2 mm", "not measured: SolidCraft cannot measure wall thickness, so check this by eye", true, false),
      ],
      warnings: ["Hole: Boolean retry: the boolean needed a second attempt"],
      staleBuild: true,
    }),
  );
  const card = pane().querySelector(".cad-part") as HTMLElement;
  expect(card).not.toBeNull();
  expect(card.querySelector(".cad-part-name")!.textContent).toBe("plate");
  expect(card.querySelector(".cad-part-state")!.textContent).toBe("Gate failed");
  expect(card.dataset.cadState).toBe("fail");
  const failing = [...card.querySelectorAll(".cad-check-fail")].map((li) => li.textContent);
  expect(failing).toEqual(["volume expected 23335.167, measured 23737.2209", "holes ⌀3.4 count expected 4, measured 1"]); // passing checks are not listed
  expect([...card.querySelectorAll(".cad-check-advisory")].map((li) => li.textContent)).toEqual(["walls at least 1.2 mm — not measured: SolidCraft cannot measure wall thickness, so check this by eye"]);
  const warnings = [...card.querySelectorAll(".cad-check-warning")].map((li) => li.textContent);
  expect(warnings[0]).toContain("Boolean retry");
  expect(warnings[1]).toContain("different SolidCraft version");
  // Slots for later phases exist and are hidden.
  expect((card.querySelector('[data-slot="thumbnail"]') as HTMLElement).hidden).toBe(true);
  expect((card.querySelector('[data-slot="release"]') as HTMLElement).hidden).toBe(true);
  (card.querySelector(".cad-part-open") as HTMLButtonElement).click();
  expect(opened).toEqual([{ url: HUB, part: "plate", rev: 1 }]);
});

test("[A2] there is one card per part per turn, updated in place; a new turn starts a new card", () => {
  const c = cards();
  c.onDesign(HUB, design({ rev: 1 }, { state: "unverified", needsAdoption: "rules", checks: [check("lock.rules", "approved", "changed", false)] }));
  c.onDesign(HUB, design({ rev: 2, busy: true }, { state: "fail", checks: [check("volume", 1, 2, false)] }));
  c.onDesign(HUB, design({ rev: 3 }));
  c.onDesign(HUB, design({ part: "bracket", rev: 1 }));
  let all = [...pane().querySelectorAll(".cad-part")] as HTMLElement[];
  expect(all.map((e) => [e.dataset.cadPart, e.dataset.cadRev, e.dataset.cadState])).toEqual([
    ["plate", "3", "pass"],
    ["bracket", "1", "pass"],
  ]);
  expect(all[0]!.querySelector(".cad-part-state")!.textContent).toBe("Gate passed");
  expect(all[0]!.querySelectorAll(".cad-check-fail")).toHaveLength(0); // the old failures are gone, not appended to
  expect(all[0]!.querySelector(".cad-part-busy")).toBeNull();
  c.newTurn();
  c.onDesign(HUB, design({ rev: 4 }, { state: "fail", checks: [check("bodies", 1, 2, false)] }));
  all = [...pane().querySelectorAll(".cad-part")] as HTMLElement[];
  expect(all.map((e) => [e.dataset.cadPart, e.dataset.cadRev])).toEqual([
    ["plate", "3"],
    ["bracket", "1"],
    ["plate", "4"],
  ]);
  // The unverified state says what the owner is being waited on for.
  c.newTurn();
  c.onDesign(HUB, design({ rev: 5 }, { state: "unverified", needsAdoption: "rules", checks: [] }));
  expect((pane().lastElementChild as HTMLElement).querySelector(".cad-part-note")!.textContent).toContain("adopt the changed cad/rules.json");
});

test("[A2] the cards are hidden without the cad-work capability, and shown only in a session that has the part open", () => {
  capability = false;
  const hidden = cards();
  hidden.onDesign(HUB, design());
  hidden.onRequest(HUB, request());
  expect(pane().children).toHaveLength(0);
  expect(hidden.pendingCount()).toBe(0);

  capability = true;
  const c = cards();
  c.onDesign(HUB, design({ sessionIds: ["another-session"] }));
  c.onDesign("http://member", design()); // the same ids on a different server are not this session
  c.onRequest(HUB, request({ sessionId: "another-session" }));
  expect(pane().children).toHaveLength(0);
  // Switching to that session (the pane is rebuilt) draws its current cards.
  active = { sessionId: "another-session", url: HUB };
  pane().innerHTML = "";
  c.restore();
  expect(pane().querySelectorAll(".cad-part")).toHaveLength(1);
  expect(pane().querySelectorAll(".cad-expect")).toHaveLength(1);
  // …and back: nothing of the other session's is shown.
  active = { sessionId: "s1", url: HUB };
  pane().innerHTML = "";
  c.restore();
  expect(pane().children).toHaveLength(0);
});

test("[A2] the expectation-change card shows old and new side by side and the agent's reason, with Approve and Deny only", () => {
  const c = cards();
  c.onRequest(HUB, request());
  const card = pane().querySelector(".cad-expect") as HTMLElement;
  expect(card.getAttribute("role")).toBe("alert");
  expect(card.dataset.cadKind).toBe("propose");
  expect(card.querySelector(".perm-head")!.textContent).toBe("Change expectations · plate");
  expect(card.querySelector(".cad-expect-reason")!.textContent).toBe("Agent's reason: The customer asked for a longer plate.");
  const rows = [...card.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent));
  expect(rows).toEqual([
    ["", "Now", "Proposed"],
    ["Bounding box (mm)", "L × W × T  (= 6 × 50 × 80)", "L × W × T  (= 6 × 50 × 120)"],
    ["Bodies", "1", "1"],
  ]);
  expect(card.querySelectorAll("tr.cad-row-changed")).toHaveLength(1); // only the row that changes is marked
  const buttons = [...card.querySelectorAll("button")] as HTMLButtonElement[];
  expect(buttons.map((b) => b.textContent)).toEqual(["Approve", "Deny"]); // no "always allow"
  expect(card.textContent!.toLowerCase()).not.toContain("always");
  buttons[1]!.click();
  expect(sent).toEqual([{ url: HUB, requestId: "cadx_1", approve: false }]);
  expect(buttons.every((b) => b.disabled)).toBe(true); // one answer per card
  // The daemon's reply retires exactly this card.
  c.onResolved(HUB, { v: 4, ts: "t", type: "cad.expectations.resolved", requestId: "cadx_1", approved: false } as any);
  expect(card.classList.contains("resolved")).toBe(true);
  expect(card.querySelector(".cad-expect-outcome")!.textContent).toBe("Denied");
  expect(card.querySelectorAll("button")).toHaveLength(0);
  expect(c.pendingCount()).toBe(0);
  // A replay of the same request (socket reopened) does not draw a second card.
  c.onRequest(HUB, request({ requestId: "cadx_2" }));
  c.onRequest(HUB, request({ requestId: "cadx_2", replay: true }));
  expect(pane().querySelectorAll('[data-req="cadx_2"]')).toHaveLength(1);
  (pane().querySelector('[data-req="cadx_2"] button') as HTMLButtonElement).click();
  expect(sent.at(-1)).toEqual({ url: HUB, requestId: "cadx_2", approve: true });
});

test("[A2] the adopt card shows the values or the rules diff, and untrusted text is never parsed as HTML", () => {
  const c = cards();
  c.onRequest(
    HUB,
    request({
      requestId: "cadx_e",
      kind: "adopt-expectations",
      reason: undefined,
      rows: [
        { label: "Process", new: "fdm-0.4" },
        { label: "Volume (mm³)", old: "23335.167", new: '<img src=x onerror="alert(1)">' },
      ],
    }),
  );
  const exp = pane().querySelector('[data-req="cadx_e"]') as HTMLElement;
  expect(exp.querySelector(".perm-head")!.textContent).toBe("Adopt expectations · plate");
  expect([...exp.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["", "Approved", "In the file"]);
  expect(exp.querySelector("img")).toBeNull(); // shown as text
  expect([...exp.querySelectorAll(".cad-row-new")].at(-1)!.textContent).toBe('<img src=x onerror="alert(1)">');
  expect(exp.querySelector(".cad-expect-reason")).toBeNull();

  c.onRequest(
    HUB,
    request({
      requestId: "cadx_r",
      kind: "adopt-rules",
      reason: undefined,
      rows: [{ label: "cad/rules.json", old: "approved earlier", new: "changed" }],
      rulesDiff: [
        { op: " ", line: '  "schema": 1,' },
        { op: "-", line: '  "envelope": [250, 210, 220]' },
        { op: "+", line: '  "envelope": [2500, 2100, 2200]' },
      ],
    }),
  );
  const rules = pane().querySelector('[data-req="cadx_r"]') as HTMLElement;
  expect(rules.querySelector(".perm-head")!.textContent).toBe("Adopt manufacturing rules · plate");
  const diff = rules.querySelector(".cad-expect-diff")!;
  expect(diff.textContent).toBe('    "schema": 1,\n-   "envelope": [250, 210, 220]\n+   "envelope": [2500, 2100, 2200]\n');
  expect(diff.querySelectorAll(".cad-diff-add")).toHaveLength(1);
  expect(diff.querySelectorAll(".cad-diff-del")).toHaveLength(1);
  expect([...rules.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Approve", "Deny"]);
  // A card replaced by a newer one says so.
  c.onResolved(HUB, { v: 4, ts: "t", type: "cad.expectations.resolved", requestId: "cadx_r", approved: false, superseded: true } as any);
  expect(rules.querySelector(".cad-expect-outcome")!.textContent).toBe("Replaced by a newer card");
  c.onResolved(HUB, { v: 4, ts: "t", type: "cad.expectations.resolved", requestId: "cadx_e", approved: true } as any);
  expect(exp.querySelector(".cad-expect-outcome")!.textContent).toBe("Approved");
});

test("[A2] review 10: a part whose numbers the agent set says so and offers Confirm numbers; owner-approved numbers do not", () => {
  const confirmed: any[] = [];
  const c = mod.createCadCards({
    supported: () => capability,
    active: () => active,
    container: pane,
    respond: () => undefined,
    open: () => undefined,
    confirm: (url, ev) => void confirmed.push({ url, part: ev.part, cwd: ev.cwd }),
  });
  c.onDesign(HUB, design({}, { approvedBy: "agent-initial" }));
  const card = pane().querySelector<HTMLElement>(".cad-part")!;
  expect(card.dataset.cadState).toBe("pass"); // an agent's own numbers still pass…
  const note = card.querySelector<HTMLElement>('[data-role="unconfirmed"]')!;
  expect(note.textContent).toBe("Expected numbers were set by the agent and have not been confirmed by you."); // …but it is said whose they are
  const btn = card.querySelector<HTMLButtonElement>(".cad-part-confirm")!;
  expect(btn.textContent).toBe("Confirm numbers");
  btn.click();
  expect(confirmed).toEqual([{ url: HUB, part: "plate", cwd: "/repo" }]);
  expect(btn.disabled).toBe(true);
  // Once the owner approved (the daemon's next cad.design), the note and the button are gone.
  c.onDesign(HUB, design({ rev: 2 }, { approvedBy: "owner" }));
  expect(pane().querySelectorAll(".cad-part")).toHaveLength(1);
  expect(pane().querySelector('[data-role="unconfirmed"]')).toBeNull();
  expect(pane().querySelector(".cad-part-confirm")).toBeNull();
  // No approval in force (unverified): nothing to confirm either.
  c.onDesign(HUB, design({ rev: 3 }, { state: "unverified", needsAdoption: "expectations" }));
  expect(pane().querySelector(".cad-part-confirm")).toBeNull();
});

test("[A2] review 2 and 10: the `initial` and `confirm` cards show the daemon's caution, the numbers with process and status, and Approve / Deny only", () => {
  const c = cards();
  c.onRequest(
    HUB,
    request({
      requestId: "cadx_i",
      kind: "initial",
      reason: undefined,
      note: "this part already has geometry; these numbers were written after it existed",
      rows: [{ label: "Process", new: "fdm-0.4" }, { label: "Status", new: "dimensioned" }, { label: "Volume (mm³)", new: "1000" }],
    }),
  );
  const initial = pane().querySelector<HTMLElement>('.cad-expect[data-req="cadx_i"]')!;
  expect(initial.dataset.cadKind).toBe("initial");
  expect(initial.querySelector(".perm-head")!.textContent).toBe("Set expectations · plate");
  expect(initial.querySelector(".cad-expect-note")!.textContent).toBe("this part already has geometry; these numbers were written after it existed");
  expect([...initial.querySelectorAll(".cad-row-label")].map((e) => e.textContent)).toEqual(["Process", "Status", "Volume (mm³)"]);
  expect([...initial.querySelectorAll(".perm-btn")].map((b) => b.textContent)).toEqual(["Approve", "Deny"]);
  c.onRequest(HUB, request({ requestId: "cadx_c", kind: "confirm", reason: undefined, note: "<b>bold</b>", rows: [{ label: "Process", new: "fdm-0.4" }] }));
  const confirm = pane().querySelector<HTMLElement>('.cad-expect[data-req="cadx_c"]')!;
  expect(confirm.querySelector(".perm-head")!.textContent).toBe("Confirm numbers · plate");
  expect(confirm.querySelector(".cad-expect-note")!.textContent).toBe("<b>bold</b>"); // text, never markup
  expect(confirm.querySelector(".cad-expect-note b")).toBeNull();
  (confirm.querySelector(".perm-btn.allow") as HTMLButtonElement).click();
  expect(sent).toEqual([{ url: HUB, requestId: "cadx_c", approve: true }]);
});
