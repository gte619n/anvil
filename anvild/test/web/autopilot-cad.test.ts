/**
 * [B3] The autopilot card's CAD section (agent-cad-and-browser §4.11, §4.14 item 41) — jsdom over the
 * PURE render + command functions: proposed numbers with Approve / Reject (which send exactly the
 * card's sha), approved numbers locked, the "needs approved dimensions" state, the CAD-verified badge
 * and the blocking reason; the plan's "plan" owner card in the chat.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { AutopilotCadInfo, AutopilotPlanInfo } from "../../protocol";

let ap: typeof import("../../web/src/autopilot");
let cards: typeof import("../../web/src/cad-cards");
beforeAll(async () => {
  installDom({ html: `<!doctype html><html><body><div id="conversation"></div></body></html>` });
  ap = await import("../../web/src/autopilot");
  cards = await import("../../web/src/cad-cards");
});
afterAll(() => uninstallDom());

const rows = [
  { label: "Process", new: "fdm-0.4" },
  { label: "Parameters", new: "L = 80 mm, T = 6 mm, W = 50 mm" },
  { label: "Volume (mm³)", new: "L*W*T  (= 24000)" },
];
const plan = (cad?: Partial<AutopilotCadInfo>, more: Partial<AutopilotPlanInfo> = {}): AutopilotPlanInfo =>
  ({
    id: "wu1",
    environmentId: "e1",
    todoistProjectId: "p1",
    title: "Make the plate",
    status: "planned",
    taskCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...(cad ? { cad: { status: "proposed", needsApproval: true, sha: "sha-shown", parts: [{ part: "plate", process: "fdm-0.4", approved: false, rows }], ...cad } as AutopilotCadInfo } : {}),
    ...more,
  }) as AutopilotPlanInfo;
const render = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};

test("[B3] web: proposed numbers render with Approve / Reject and the needs-approved-dimensions state; the buttons send exactly the card's sha", () => {
  const p = plan({ source: "nightly" });
  const el = render(ap.cadSectionHtml(p));
  expect(el.querySelector(".cad-plan")?.getAttribute("data-cad-status")).toBe("proposed");
  expect(el.textContent).toContain("Proposed by the nightly planner — not locked");
  expect(el.querySelector(".cad-needs")?.textContent).toContain("Needs approved dimensions");
  expect(el.querySelector('.cad-plan-part[data-part="plate"]')?.textContent).toContain("L*W*T  (= 24000)");
  const approve = el.querySelector<HTMLElement>('[data-cad-act="approve"]');
  const reject = el.querySelector<HTMLElement>('[data-cad-act="reject"]');
  expect(approve?.dataset.id).toBe("wu1");
  expect(reject).not.toBeNull();
  expect(ap.cadRespondCommand("approve", p)).toEqual({ type: "autopilot.cad.respond", workUnitId: "wu1", approve: true, sha: "sha-shown" });
  expect(ap.cadRespondCommand("reject", p)).toEqual({ type: "autopilot.cad.respond", workUnitId: "wu1", approve: false, sha: "sha-shown" });
  expect(ap.cadRespondCommand("other", p)).toBeUndefined();
  expect(render(ap.cadCardChip(p)).textContent).toContain("Needs approved dimensions");
});

test("[B3] web: approved numbers are locked (no buttons); missing numbers say to plan with Claude; a note is shown", () => {
  const ok = render(ap.cadSectionHtml(plan({ status: "approved", needsApproval: false, parts: [{ part: "plate", process: "fdm-0.4", approved: true, rows }] })));
  expect(ok.textContent).toContain("Approved — locked onto the plan");
  expect(ok.querySelector("[data-cad-act]")).toBeNull();
  expect(ok.querySelector(".cad-needs")).toBeNull();
  expect(ok.querySelector(".cad-part-approved")).not.toBeNull();
  const missing = render(ap.cadSectionHtml(plan({ status: "missing", parts: [], sha: undefined, note: "Ignored proposed dimensions: cad/x bad" })));
  expect(missing.querySelector(".cad-needs")?.textContent).toContain("Plan with Claude");
  expect(missing.querySelector(".cad-note")?.textContent).toContain("Ignored proposed dimensions");
  expect(missing.querySelector("[data-cad-act]")).toBeNull();
  const rejected = render(ap.cadSectionHtml(plan({ status: "rejected" })));
  expect(rejected.querySelector(".cad-needs")?.textContent).toContain("rejected");
  expect(rejected.querySelector('[data-cad-act="approve"]')).not.toBeNull();
  expect(ap.cadSectionHtml(plan())).toBe(""); // a unit with no CAD
  expect(ap.cadCardChip(plan())).toBe("");
});

test("[B3] web: the CAD-verified badge, and the blocking reason on a blocked unit", () => {
  const v = plan({ status: "approved", needsApproval: false, verified: { at: "2026-11-20T10:00:00Z", parts: ["plate"] } }, { status: "building" });
  expect(render(ap.cadSectionHtml(v)).querySelector(".cad-verified")?.textContent).toContain("cad/plate");
  expect(render(ap.cadCardChip(v)).querySelector(".cad-verified-chip")).not.toBeNull();
  const b = plan({ status: "approved", needsApproval: false, blocked: { at: "t", reason: "cad/plate is fail: holes ⌀3.4 count: expected 4, measured 1" } }, { status: "blocked", blockedReason: "CAD: cad/plate is fail" });
  const el = render(ap.cadSectionHtml(b));
  expect(el.querySelector(".cad-blocked")?.textContent).toContain("expected 4, measured 1");
  expect(render(ap.cadCardChip(b)).textContent).toContain("CAD blocked");
});

test("[B3] web: the planner's `plan` card renders its rows with Approve / Deny and no always-allow", () => {
  const sent: any[] = [];
  const c = cards.createCadCards({
    supported: () => true,
    active: () => ({ sessionId: "s1", url: "http://hub" }),
    container: () => document.getElementById("conversation")!,
    respond: (url, requestId, approve) => void sent.push({ url, requestId, approve }),
    open: () => {},
  });
  c.onRequest("http://hub", { v: 4, ts: "t", type: "cad.expectations.request", requestId: "cadx_p", sessionId: "s1", cwd: "/wt", part: "plate", kind: "plan", note: "The builder will be held to exactly these numbers.", rows: rows.map((r) => ({ ...r })) } as any);
  const card = document.querySelector<HTMLElement>('[data-req="cadx_p"]')!;
  expect(card.dataset.cadKind).toBe("plan");
  expect(card.textContent).toContain("Plan's CAD numbers");
  expect(card.textContent).toContain("To lock");
  expect(card.textContent).toContain("L*W*T  (= 24000)");
  const buttons = [...card.querySelectorAll("button")].map((b) => b.textContent);
  expect(buttons).toEqual(["Approve", "Deny"]);
  card.querySelector<HTMLButtonElement>("button.allow")!.click();
  expect(sent).toEqual([{ url: "http://hub", requestId: "cadx_p", approve: true }]);
});
