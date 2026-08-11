/**
 * [WEB2-2 / WEB2-16] Guard tests for the sidebar's keyed-diff + rAF-coalesced renders (sidebar.ts).
 * Pins the two performance contracts the improvement program v2 asks for:
 *   - an unrelated `status`-driven re-render leaves other <li> node identities (and their children)
 *     unchanged — the keyed diff by li.dataset.id;
 *   - two synchronous render requests coalesce into ONE DOM mutation batch at the next frame (the
 *     row is created once, already reflecting the LATEST state, and is never morphed afterwards);
 *   - the team board skips its innerHTML rebuild (and listener re-wire) when nothing changed.
 * jsdom (pretendToBeVisual) provides requestAnimationFrame + MutationObserver, so both the
 * scheduling and the mutation accounting are exercised for real.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { Environment, Session } from "../../protocol";

let sidebar: typeof import("../../web/src/sidebar");

// The sidebar skeleton renderSessionsNow/renderTeamBoardNow touch ($ throws on a missing element).
const HTML = `<!doctype html><html><body>
  <div id="sidebar">
    <ul id="concierge-list"></ul>
    <ul id="session-list"></ul>
    <section id="finished-section" hidden><ul id="finished-list"></ul></section>
  </div>
  <div id="team-board" hidden></div>
</body></html>`;

// Injected deps (initSidebar) — the test owns main.ts's state.
const sessions = new Map<string, Session>();
const environments = new Map<string, Environment>();
let active: string | null = null;

let seq = 0;
/** A minimal session — only the fields the sidebar renderer actually reads (cast: Usage etc. aren't rendered). */
function mkSession(id: string): Session {
  return {
    id,
    title: id,
    status: "idle",
    model: "sonnet",
    source: "existing-repo",
    cwd: "/",
    autonomy: "mostly-autonomous",
    createdAt: `2026-01-01T00:00:${String(++seq).padStart(2, "0")}Z`,
    lastActivityAt: "2026-01-01T00:00:00Z",
  } as unknown as Session;
}
function addSession(id: string, over: Partial<Session> = {}): Session {
  const s = { ...mkSession(id), ...over } as Session;
  sessions.set(id, s);
  return s;
}

const frame = (): Promise<void> => new Promise((r) => window.requestAnimationFrame(() => r()));

beforeAll(async () => {
  installDom({ html: HTML });
  sidebar = await import("../../web/src/sidebar");
  sidebar.initSidebar({
    sessions,
    environments,
    activeId: () => active,
    selectSession: (id) => {
      active = id;
    },
    persistSessions: () => {},
  });
});
afterAll(() => uninstallDom());

beforeEach(async () => {
  sidebar.flushRenderSessions(); // settle any pending pass before resetting state
  sessions.clear();
  active = null;
  for (const sel of ["#concierge-list", "#session-list", "#finished-list"]) document.querySelector(sel)!.innerHTML = "";
  sidebar.renderTeamBoard(undefined); // clears the board + its cached markup
  await frame();
});

test("[WEB2-2] an unrelated status change leaves other <li> node identities (and children) untouched", async () => {
  addSession("a");
  addSession("b");
  addSession("c");
  sidebar.renderSessions();
  await frame();
  const ul = document.querySelector("#session-list")!;
  const liA = ul.querySelector('li[data-id="a"]')!;
  const liB = ul.querySelector('li[data-id="b"]')!;
  const liC = ul.querySelector('li[data-id="c"]')!;
  const rowA = liA.querySelector("a.srow")!;
  const rowC = liC.querySelector("a.srow")!;

  sessions.get("b")!.status = "thinking"; // only b changed
  sidebar.renderSessions();
  await frame();

  // a and c: same <li> AND same children — the diff never touched them (no morph, no listener loss).
  expect(ul.querySelector('li[data-id="a"]')).toBe(liA);
  expect(liA.querySelector("a.srow")).toBe(rowA);
  expect(ul.querySelector('li[data-id="c"]')).toBe(liC);
  expect(liC.querySelector("a.srow")).toBe(rowC);
  // b: morphed in place — new content, but the <li> node identity survives too.
  expect(ul.querySelector('li[data-id="b"]')).toBe(liB);
  expect(liB.textContent).toContain("thinking");
});

test("[WEB2-2] two synchronous render requests coalesce into one DOM mutation batch", async () => {
  addSession("a", { title: "one" });
  const ul = document.querySelector("#session-list")!;
  const records: MutationRecord[] = [];
  const mo = new window.MutationObserver((rs) => records.push(...rs));
  mo.observe(ul, { childList: true, subtree: true });

  sidebar.renderSessions(); // request 1 — would have painted "one"
  sessions.get("a")!.title = "two";
  sidebar.renderSessions(); // request 2, same frame — coalesces with request 1
  await frame();
  await frame(); // drain a hypothetical second (uncoalesced) pass before counting
  records.push(...mo.takeRecords());
  mo.disconnect();

  const liA = ul.querySelector('li[data-id="a"]')!;
  // One pass, run with the LATEST state: the row appears once already titled "two"…
  expect(liA.textContent).toContain("two");
  expect(records.filter((r) => [...r.addedNodes].includes(liA)).length).toBe(1);
  // …in a single childList batch on the list, and the row itself was never re-touched afterwards
  // (an uncoalesced second pass would have morphed it: a childList record targeting the <li>).
  expect(records.filter((r) => r.target === ul).length).toBe(1);
  expect(records.some((r) => r.target === liA)).toBe(false);
});

test("[WEB2-16] an unchanged team board keeps its DOM (no innerHTML rebuild / listener re-wire)", async () => {
  const lead = addSession("lead", { teamRole: "lead", team: { integration: "combined-pr", maxConcurrentMembers: 3 } });
  addSession("m1", { parentId: "lead", teamRole: "member", memberTask: "write docs", status: "thinking" });
  active = "lead";

  sidebar.renderTeamBoard(lead);
  await frame();
  const board = document.getElementById("team-board")!;
  expect(board.hidden).toBe(false);
  const row = board.querySelector('.tmb-row[data-id="m1"]')!;

  sidebar.renderTeamBoard(lead); // e.g. an unrelated session.updated re-request — nothing changed
  await frame();
  expect(board.querySelector('.tmb-row[data-id="m1"]')).toBe(row); // same node — the rebuild was skipped

  sessions.get("m1")!.status = "idle"; // a real change re-renders
  sidebar.renderTeamBoard(lead);
  await frame();
  expect(board.querySelector('.tmb-row[data-id="m1"]')!.textContent).toContain("idle");
});
