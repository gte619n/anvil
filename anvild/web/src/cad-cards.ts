// CAD cards in the chat (agent-cad-and-browser spec §4.9, Phase A2). Three cards, all driven by
// global daemon events and all hidden unless the server advertises the "cad-work" capability:
//
//   PART CARD          `cad.design` — one per part touched in a turn, updated in place: the part's
//                      name, the geometry gate's state with every failing check listed, advisory
//                      lines and SolidCraft warnings, and "Open". The thumbnail (Phase A3) and
//                      "Release" (Phase A4) have empty slots: [data-slot="thumbnail"], [data-slot="release"].
//   EXPECTATION CHANGE `cad.expectations.request` kind "propose" — old and new values side by side,
//                      the agent's reason, Approve / Deny.
//   ADOPT              the same event, kinds "adopt-*" — the values (or the rules diff) the owner is
//                      asked to accept, Approve / Deny.
//
// Neither event is session-scoped or replayed from a session's log (they are current state, re-sent
// when a socket opens), so this module keeps the latest of each and redraws them when the
// conversation is rebuilt (`restore`). Everything is built with DOM nodes and textContent: the
// agent's reason and file contents are untrusted text and are never parsed as HTML.
import type { CadDesignEvent, CadExpectationsRequestEvent, CadExpectationsResolvedEvent, CadGateResult } from "../../protocol";

export interface CadCardsDeps {
  /** Does the server at `url` advertise "cad-work"? */
  supported(url: string): boolean;
  /** The session on screen and the server it lives on. */
  active(): { sessionId: string; url: string } | undefined;
  /** The conversation pane. */
  container(): HTMLElement;
  /** Send `cad.expectations.respond` to the server the card came from. */
  respond(url: string, requestId: string, approve: boolean): void;
  /** "Open" on a part card (Phase A3 points this at the live viewer). */
  open(url: string, ev: CadDesignEvent): void;
  scrollDown?(): void;
}

const STATE_LABEL: Record<CadGateResult["state"], string> = {
  pass: "Gate passed",
  fail: "Gate failed",
  unverified: "Not verified",
  concept: "Concept — dimensions not confirmed",
  gap: "Blocked on an unsupported feature",
};
const TITLE: Record<CadExpectationsRequestEvent["kind"], string> = {
  propose: "Change expectations",
  "adopt-expectations": "Adopt expectations",
  "adopt-ownerParams": "Adopt dimensions",
  "adopt-rules": "Adopt manufacturing rules",
};
const BLURB: Record<CadExpectationsRequestEvent["kind"], string> = {
  propose: "The agent asks to change what this part is checked against.",
  "adopt-expectations": "This part's expectations were not approved on this fleet (a fresh clone, or the file was edited). Approve to check the part against these values.",
  "adopt-ownerParams": "The dimensions recorded in part.json differ from the ones you entered.",
  "adopt-rules": "cad/rules.json changed. Approve to check every part of this repo against the new rules.",
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const show = (v: number | string): string => (typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : v);

export function createCadCards(deps: CadCardsDeps) {
  /** Latest `cad.design` per server + worktree + part. */
  const designs = new Map<string, { url: string; ev: CadDesignEvent }>();
  /** Cards waiting for an answer. */
  const requests = new Map<string, { url: string; ev: CadExpectationsRequestEvent }>();
  /** The part card of the CURRENT turn, per part. A new turn starts a new card. */
  const turnCards = new Map<string, HTMLElement>();
  const requestCards = new Map<string, HTMLElement>();
  const key = (url: string, ev: { cwd: string; part: string }): string => `${url}\n${ev.cwd}\n${ev.part}`;
  const onScreen = (url: string, sessionIds: readonly string[] | undefined): boolean => {
    const a = deps.active();
    return !!a && a.url === url && !!sessionIds?.includes(a.sessionId) && deps.supported(url);
  };

  function fillPartCard(card: HTMLElement, url: string, ev: CadDesignEvent): void {
    const gate = ev.gate;
    card.className = `bubble assistant cad-part cad-${gate.state}`;
    card.dataset.cadPart = ev.part;
    card.dataset.cadState = gate.state;
    card.dataset.cadRev = String(ev.rev);
    card.replaceChildren();
    const head = el("div", "cad-part-head");
    head.append(el("span", "cad-part-thumb")); // Phase A3 puts the preview thumbnail here
    (head.lastChild as HTMLElement).dataset.slot = "thumbnail";
    (head.lastChild as HTMLElement).hidden = true;
    head.append(el("span", "cad-part-name", ev.part), el("span", `cad-part-state cad-${gate.state}`, STATE_LABEL[gate.state] ?? gate.state));
    if (ev.busy) head.append(el("span", "cad-part-busy", "working…"));
    card.append(head);

    const failing = gate.checks.filter((c) => c.hard && !c.ok);
    if (failing.length) {
      const list = el("ul", "cad-part-checks");
      for (const c of failing) {
        const li = el("li", "cad-check-fail");
        li.append(el("b", undefined, c.id), el("span", undefined, ` expected ${show(c.expected)}, measured ${show(c.measured)}`));
        list.append(li);
      }
      card.append(list);
    }
    if (gate.needsAdoption) card.append(el("div", "cad-part-note", gate.needsAdoption === "rules" ? "Waiting for you to adopt the changed cad/rules.json." : `Waiting for you to adopt the ${gate.needsAdoption === "ownerParams" ? "dimensions" : "expectations"}.`));
    const advisory = gate.checks.filter((c) => !c.hard);
    if (advisory.length || gate.warnings.length || gate.staleBuild) {
      const list = el("ul", "cad-part-advisory");
      for (const c of advisory) list.append(el("li", "cad-check-advisory", `${show(c.expected)} — ${show(c.measured)}`));
      for (const w of gate.warnings) list.append(el("li", "cad-check-warning", w));
      if (gate.staleBuild) list.append(el("li", "cad-check-warning", "Measured with a different SolidCraft version than this machine runs."));
      card.append(list);
    }
    const actions = el("div", "cad-part-actions");
    const open = el("button", "cad-part-open", "Open");
    open.type = "button";
    open.onclick = () => deps.open(url, ev);
    const release = el("span", "cad-part-release"); // Phase A4 puts "Release" here when the gate passes
    release.dataset.slot = "release";
    release.hidden = true;
    actions.append(open, release);
    card.append(actions);
  }

  function drawDesign(url: string, ev: CadDesignEvent, fresh: boolean): void {
    if (!onScreen(url, ev.sessionIds)) return;
    const k = key(url, ev);
    let card = turnCards.get(k);
    if (!card || !card.isConnected) {
      card = el("div");
      turnCards.set(k, card);
      deps.container().appendChild(card);
      if (fresh) deps.scrollDown?.();
    }
    fillPartCard(card, url, ev);
  }

  function drawRequest(url: string, ev: CadExpectationsRequestEvent): void {
    if (!onScreen(url, [ev.sessionId])) return;
    if (requestCards.get(ev.requestId)?.isConnected) return; // already on screen (a replay)
    const card = el("div", "bubble permission cad-expect");
    card.setAttribute("role", "alert");
    card.dataset.req = ev.requestId;
    card.dataset.cadKind = ev.kind;
    const head = el("div", "perm-head");
    head.append(el("span", undefined, `${TITLE[ev.kind] ?? "Expectations"} · `), el("b", undefined, ev.part));
    card.append(head, el("div", "cad-expect-blurb", BLURB[ev.kind] ?? ""));
    if (ev.reason) {
      const why = el("div", "cad-expect-reason");
      why.append(el("span", "cad-expect-reason-label", "Agent's reason: "), el("span", undefined, ev.reason));
      card.append(why);
    }
    if (ev.rows.length) {
      const table = el("table", "cad-expect-rows");
      const hr = el("tr");
      hr.append(el("th", undefined, ""), el("th", undefined, ev.kind === "propose" ? "Now" : "Approved"), el("th", undefined, ev.kind === "propose" ? "Proposed" : "In the file"));
      table.append(hr);
      for (const r of ev.rows) {
        const tr = el("tr", r.old !== r.new ? "cad-row-changed" : undefined);
        tr.append(el("td", "cad-row-label", r.label), el("td", "cad-row-old", r.old ?? "—"), el("td", "cad-row-new", r.new ?? "—"));
        table.append(tr);
      }
      card.append(table);
    }
    if (ev.rulesDiff?.length) {
      const pre = el("pre", "cad-expect-diff");
      for (const d of ev.rulesDiff) pre.append(el("span", d.op === "+" ? "cad-diff-add" : d.op === "-" ? "cad-diff-del" : "cad-diff-same", `${d.op} ${d.line}\n`));
      card.append(pre);
    }
    // Approve / Deny only: this card is asked every time, so it never offers "always allow".
    const btns = el("div", "perm-btns");
    for (const [label, approve] of [["Approve", true], ["Deny", false]] as const) {
      const b = el("button", `perm-btn ${approve ? "allow" : "deny"}`, label);
      b.type = "button";
      b.onclick = () => {
        for (const x of btns.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
        deps.respond(url, ev.requestId, approve);
      };
      btns.append(b);
    }
    card.append(btns);
    requestCards.set(ev.requestId, card);
    deps.container().appendChild(card);
    deps.scrollDown?.();
  }

  return {
    onDesign(url: string, ev: CadDesignEvent): void {
      if (!deps.supported(url)) return;
      designs.set(key(url, ev), { url, ev });
      drawDesign(url, ev, true);
    },
    onRequest(url: string, ev: CadExpectationsRequestEvent): void {
      if (!deps.supported(url)) return;
      requests.set(ev.requestId, { url, ev });
      drawRequest(url, ev);
    },
    onResolved(_url: string, ev: CadExpectationsResolvedEvent): void {
      requests.delete(ev.requestId);
      const card = requestCards.get(ev.requestId);
      requestCards.delete(ev.requestId);
      if (!card) return;
      card.classList.add("resolved");
      card.querySelector(".perm-btns")?.replaceChildren(el("span", "cad-expect-outcome", ev.superseded ? "Replaced by a newer card" : ev.approved ? "Approved" : "Denied"));
    },
    /** A new user message: the next `cad.design` for a part starts a new card. */
    newTurn(): void {
      turnCards.clear();
    },
    /** The conversation was rebuilt (session switch, snapshot replay): redraw what belongs in it. */
    restore(): void {
      turnCards.clear();
      for (const { url, ev } of designs.values()) drawDesign(url, ev, false);
      for (const { url, ev } of requests.values()) drawRequest(url, ev);
    },
    /** A server went away or lost the capability: forget its cards. */
    forget(url: string): void {
      for (const [k, v] of designs) if (v.url === url) designs.delete(k);
      for (const [k, v] of requests) if (v.url === url) requests.delete(k);
    },
    pendingCount: (): number => requests.size,
  };
}
export type CadCards = ReturnType<typeof createCadCards>;
