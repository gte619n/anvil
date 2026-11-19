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
//   DIMENSIONS         kind "dimensions" (Phase A4) — the agent's proposed named dimensions as EDITABLE
//                      numbers; Submit sends the owner's typed values (checked again by the daemon).
//   RELEASE            kind "release" (Phase A4) — expected and measured numbers, holes, advisories,
//                      script size and who approved the numbers; Approve / Deny.
// Phase A4 on the part card: the thumbnail (served by the preview route, never inline data), "Release"
// while the gate passes, the "Released" badge (only for a pack whose HMAC the daemon verified), the
// gap with "Clear gap", the script size above 5 MB, and a concept's picture score (an advisory line).
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
  /** Send `cad.expectations.respond` to the server the card came from (`values`: a dimensions card). */
  respond(url: string, requestId: string, approve: boolean, values?: Record<string, number>): void;
  /** "Release" on a passing part card: send `cad.release.request` (the daemon raises the release card). */
  release?(url: string, ev: CadDesignEvent): void;
  /** "Clear gap": send `cad.gap.clear`. */
  clearGap?(url: string, ev: CadDesignEvent): void;
  /** The URL of a worktree-relative file served by the preview route (the thumbnail). */
  fileUrl?(url: string, ev: CadDesignEvent, path: string): string;
  /** "Open" on a part card (Phase A3 points this at the live viewer). */
  open(url: string, ev: CadDesignEvent): void;
  /** "Confirm numbers" on a part card: send `cad.expectations.confirm` (the daemon raises the owner card). */
  confirm?(url: string, ev: CadDesignEvent): void;
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
  initial: "Set expectations",
  confirm: "Confirm numbers",
  dimensions: "Dimensions",
  release: "Release part",
};
const BLURB: Record<CadExpectationsRequestEvent["kind"], string> = {
  propose: "The agent asks to change what this part is checked against.",
  "adopt-expectations": "This part's expectations were not approved on this fleet (a fresh clone, or the file was edited). Approve to check the part against these values.",
  "adopt-ownerParams": "The dimensions recorded in part.json differ from the ones you entered.",
  "adopt-rules": "cad/rules.json changed. Approve to check every part of this repo against the new rules.",
  initial: "The agent asks to set what this part is checked against.",
  confirm: "These numbers were set by the agent. Approve to make them yours.",
  dimensions: "Type the real dimensions of this part. Your numbers become what it is built to and checked against.",
  release: "Release this part: the daemon writes the STEP, the views, a spec sheet (not a drawing) and a signed manifest.",
};
/** Owner item 45: the card shows the script size once it is above this. */
export const SCRIPT_SIZE_NOTICE_BYTES = 5 * 1024 * 1024;

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
    const thumb = el("span", "cad-part-thumb");
    thumb.dataset.slot = "thumbnail";
    thumb.hidden = true;
    if (ev.thumbnail && deps.fileUrl) {
      const img = el("img");
      img.alt = `${ev.part} preview`;
      img.width = 80;
      img.height = 60;
      img.loading = "lazy";
      img.src = deps.fileUrl(url, ev, ev.thumbnail);
      thumb.append(img);
      thumb.hidden = false;
    }
    head.append(thumb);
    head.append(el("span", "cad-part-name", ev.part), el("span", `cad-part-state cad-${gate.state}`, STATE_LABEL[gate.state] ?? gate.state));
    if (ev.released) {
      const badge = el("span", "cad-part-released", "Released");
      badge.dataset.role = "released";
      badge.title = `Release pack ${ev.released.path} (signature verified)`;
      head.append(badge);
    }
    if (ev.busy) head.append(el("span", "cad-part-busy", "working…"));
    card.append(head);
    if (gate.gap) {
      const gap = el("div", "cad-part-gap");
      gap.dataset.role = "gap";
      gap.append(el("b", undefined, `Blocked: ${gate.gap.feature}`), el("span", undefined, ` — ${gate.gap.detail}`));
      card.append(gap);
    }

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
    // Where the numbers came from: an agent's own numbers pass the gate, but they are not the owner's
    // until the owner says so (one tap raises the standard card with the numbers, process and status).
    if (gate.approvedBy === "agent-initial") {
      const by = el("div", "cad-part-note cad-part-unconfirmed", "Expected numbers were set by the agent and have not been confirmed by you.");
      by.dataset.role = "unconfirmed";
      card.append(by);
    }
    if (typeof ev.scriptBytes === "number" && ev.scriptBytes > SCRIPT_SIZE_NOTICE_BYTES) {
      const size = el("div", "cad-part-note", `Design script is ${Math.round((ev.scriptBytes / 1024 / 1024) * 10) / 10} MB (references are embedded in it) — large for git.`);
      size.dataset.role = "script-size";
      card.append(size);
    }
    const actions = el("div", "cad-part-actions");
    const open = el("button", "cad-part-open", "Open");
    open.type = "button";
    open.onclick = () => deps.open(url, ev);
    const release = el("span", "cad-part-release");
    release.dataset.slot = "release";
    release.hidden = true;
    if (gate.state === "pass" && deps.release) {
      const b = el("button", "cad-part-action cad-part-release-btn", "Release");
      b.type = "button";
      b.onclick = () => {
        b.disabled = true;
        deps.release!(url, ev);
      };
      release.append(b);
      release.hidden = false;
    }
    actions.append(open);
    if (gate.gap && deps.clearGap) {
      const clear = el("button", "cad-part-action cad-part-clear-gap", "Clear gap");
      clear.type = "button";
      clear.onclick = () => {
        clear.disabled = true;
        deps.clearGap!(url, ev);
      };
      actions.append(clear);
    }
    if (gate.approvedBy === "agent-initial" && deps.confirm) {
      const confirm = el("button", "cad-part-open cad-part-confirm", "Confirm numbers");
      confirm.type = "button";
      confirm.onclick = () => {
        confirm.disabled = true;
        deps.confirm!(url, ev);
      };
      actions.append(confirm);
    }
    actions.append(release);
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

  /** The dimensions card: one numeric input per proposed dimension, prefilled with the proposal. */
  function drawDimensions(card: HTMLElement, url: string, ev: CadExpectationsRequestEvent): void {
    const form = el("form", "cad-dims");
    const inputs = new Map<string, HTMLInputElement>();
    for (const d of ev.dimensions ?? []) {
      const row = el("label", "cad-dim");
      row.dataset.dim = d.name;
      const input = el("input", "cad-dim-input");
      input.type = "number";
      input.step = "any";
      input.inputMode = "decimal";
      input.required = true;
      input.value = String(d.value);
      input.name = d.name;
      input.setAttribute("aria-label", d.name);
      inputs.set(d.name, input);
      row.append(el("span", "cad-dim-name", d.name), input, el("span", "cad-dim-unit", d.unit ?? ""));
      if (d.note) row.append(el("span", "cad-dim-note", d.note));
      form.append(row);
    }
    const err = el("div", "cad-dim-error");
    err.dataset.role = "error";
    err.hidden = true;
    const btns = el("div", "perm-btns");
    const submit = el("button", "perm-btn allow", "Submit");
    submit.type = "submit";
    const deny = el("button", "perm-btn deny", "Deny");
    deny.type = "button";
    btns.append(submit, deny);
    form.append(err, btns);
    const lock = (): void => {
      for (const x of btns.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const values: Record<string, number> = {};
      for (const [name, input] of inputs) {
        const v = input.value.trim() === "" ? NaN : Number(input.value);
        if (!Number.isFinite(v)) {
          err.textContent = `${name} must be a number`;
          err.hidden = false;
          input.focus();
          return;
        }
        values[name] = v;
      }
      err.hidden = true;
      lock();
      deps.respond(url, ev.requestId, true, values);
    };
    deny.onclick = () => {
      lock();
      deps.respond(url, ev.requestId, false);
    };
    card.append(form);
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
    if (ev.note) {
      const note = el("div", ev.kind === "release" ? "cad-expect-note cad-expect-note-strong" : "cad-expect-note", ev.note);
      note.dataset.role = "note";
      card.append(note);
    }
    if (ev.reason) {
      const why = el("div", "cad-expect-reason");
      why.append(el("span", "cad-expect-reason-label", "Agent's reason: "), el("span", undefined, ev.reason));
      card.append(why);
    }
    if (ev.kind === "dimensions" && ev.dimensions?.length) {
      drawDimensions(card, url, ev);
      requestCards.set(ev.requestId, card);
      deps.container().appendChild(card);
      deps.scrollDown?.();
      return;
    }
    if (ev.rows.length) {
      const table = el("table", "cad-expect-rows");
      const hr = el("tr");
      const heads =
        ev.kind === "propose" ? ["Now", "Proposed"] : ev.kind === "initial" ? ["Now", "Asked for"] : ev.kind === "confirm" ? ["Now", "To confirm"] : ev.kind === "release" ? ["Expected", "Measured"] : ["Approved", "In the file"];
      hr.append(el("th", undefined, ""), el("th", undefined, heads[0]), el("th", undefined, heads[1]));
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
      for (const x of card.querySelectorAll("input")) (x as HTMLInputElement).disabled = true;
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
