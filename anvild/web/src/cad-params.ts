// The parameters panel of the live CAD viewer (agent-cad-and-browser spec §4.9, D13, Phase A3).
//
// Lists a part's user parameters. Editing a value sends `cad.param.set` — the OWNER's change: it goes
// straight to the part's queue on the daemon (behind an agent call that is in flight), no model is
// asked, and the expectations are re-derived for the new value. A bad expression comes back with
// SolidCraft's own error, which is shown under the row while the old value is put back.
//
// Under the list is the gate strip: the geometry gate's state, each failing check and the advisory
// lines. Both halves are redrawn from the same `cad.design` event.
//
// Built with DOM nodes and textContent only: parameter names, expressions and SolidCraft's messages
// are untrusted text. Hidden by its host unless the server advertises "cad-work".
import type { CadDesignEvent, CadGateResult, CadParam } from "../../protocol";

export interface CadParamsDeps {
  /** Send `cad.param.set` and wait for its result. */
  setParam(name: string, expression: string): Promise<{ ok: boolean; error?: string }>;
}

export interface CadParams {
  el: HTMLElement;
  onDesign(ev: CadDesignEvent): void;
  /** Paused behind the newest revision: the panel shows the DISPLAYED one and says a newer exists. */
  setNewer(newer: boolean): void;
  dispose(): void;
}

export const GATE_LABEL: Record<CadGateResult["state"], string> = {
  pass: "Gate passed",
  fail: "Gate failed",
  unverified: "Not verified",
  concept: "Concept — dimensions not confirmed",
  gap: "Blocked on an unsupported feature",
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const show = (v: number | string): string => (typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : v);

interface Row {
  root: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
  error: HTMLElement;
  /** The expression the daemon last reported: what a refused edit goes back to. */
  expression: string;
  /** What was last written into the input by us (to tell an untouched field from one being typed in). */
  rendered: string;
  pending: boolean;
  /** A `cad.design` arrived while the edit was on its way (the daemon broadcasts the new state
   *  BEFORE it answers the command), so the canonical text is already known when the answer lands. */
  landed: boolean;
  /** SolidCraft's refusal of the last edit; stays until the row is edited again or a change lands. */
  refused: string;
}

export function createCadParams(deps: CadParamsDeps): CadParams {
  const root = el("div", "cad-params");
  const head = el("div", "cad-params-head");
  head.append(el("span", "cad-params-title", "Parameters"));
  const close = el("button", "cad-params-close", "×");
  close.type = "button";
  close.dataset.act = "params"; // the viewer's delegated toolbar handler closes the sheet
  close.title = "Close";
  close.setAttribute("aria-label", "Close parameters");
  head.append(close);
  const list = el("div", "cad-params-list");
  const gate = el("div", "cad-gate");
  gate.dataset.role = "gate";
  const newerNote = el("div", "cad-params-newer", "Newer revision available — these are the values of the model on screen. Reload to see the newest.");
  newerNote.dataset.role = "newer";
  newerNote.hidden = true;
  root.append(head, newerNote, list, gate);

  const rows = new Map<string, Row>();
  let disposed = false;

  function paint(row: Row, p: CadParam): void {
    row.expression = p.expression;
    // Never write over a field the owner is typing in, or one whose edit is still on its way.
    const typing = document.activeElement === row.input && row.input.value !== row.rendered;
    if (row.pending) row.landed = true;
    if (!typing && !row.pending) {
      row.input.value = p.expression;
      row.rendered = p.expression;
    }
    row.value.textContent = Number.isFinite(p.value) ? `= ${show(p.value)}${p.unit ? ` ${p.unit}` : ""}` : "";
    const msg = row.refused || p.error || "";
    row.error.textContent = msg;
    row.error.hidden = !msg;
    row.root.classList.toggle("cad-param-bad", !!msg);
  }

  async function commit(name: string, row: Row): Promise<void> {
    const next = row.input.value.trim();
    if (row.pending || next === row.expression.trim()) return;
    if (!next) {
      // An empty field is not an expression: put the old one back rather than send it.
      row.input.value = row.expression;
      row.rendered = row.expression;
      return;
    }
    row.pending = true;
    row.landed = false;
    row.refused = "";
    row.input.disabled = true;
    row.root.classList.add("cad-param-pending");
    let res: { ok: boolean; error?: string };
    try {
      res = await deps.setParam(name, next);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (disposed) return;
    row.pending = false;
    row.input.disabled = false;
    row.root.classList.remove("cad-param-pending");
    if (res.ok) {
      // The canonical text ("120 mm" for a typed "120") comes with the part's new `cad.design`: it is
      // usually here already, else the next event paints it.
      if (row.landed) row.input.value = row.expression;
      row.rendered = row.input.value;
      row.error.hidden = true;
      row.error.textContent = "";
      row.root.classList.remove("cad-param-bad");
      return;
    }
    // Refused: say why, in SolidCraft's words, and leave the old value in the field.
    row.refused = res.error?.trim() || "The change was refused.";
    row.input.value = row.expression;
    row.rendered = row.expression;
    row.error.textContent = row.refused;
    row.error.hidden = false;
    row.root.classList.add("cad-param-bad");
  }

  function makeRow(p: CadParam): Row {
    const r = el("div", "cad-param");
    r.dataset.param = p.name;
    const label = el("label", "cad-param-name", p.name);
    const input = el("input", "cad-param-input");
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.inputMode = "text";
    input.id = `cad-param-${p.name.replace(/[^a-z0-9_-]/gi, "_")}`;
    input.setAttribute("aria-label", `${p.name} expression`);
    label.htmlFor = input.id;
    const value = el("span", "cad-param-value");
    const error = el("div", "cad-param-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    r.append(label, input, value, error);
    const row: Row = { root: r, input, value, error, expression: p.expression, rendered: "", pending: false, landed: false, refused: "" };
    input.addEventListener("change", () => void commit(p.name, row));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit(p.name, row);
      } else if (e.key === "Escape") {
        input.value = row.expression;
        row.rendered = row.expression;
      }
    });
    input.addEventListener("input", () => {
      // Typing again retires the last refusal.
      if (!row.refused) return;
      row.refused = "";
      row.error.hidden = true;
      row.root.classList.remove("cad-param-bad");
    });
    return row;
  }

  function drawGate(g: CadGateResult, ev: CadDesignEvent): void {
    gate.replaceChildren();
    gate.dataset.state = g.state;
    gate.className = `cad-gate cad-${g.state}`;
    const pill = el("span", `cad-gate-state cad-${g.state}`, GATE_LABEL[g.state] ?? g.state);
    gate.append(pill);
    if (ev.by === "panel") gate.append(el("span", "cad-gate-by", "after your change"));
    const failing = g.checks.filter((c) => c.hard && !c.ok);
    if (failing.length) {
      const ul = el("ul", "cad-gate-checks");
      for (const c of failing) {
        const li = el("li", "cad-check-fail");
        li.append(el("b", undefined, c.id), el("span", undefined, ` expected ${show(c.expected)}, measured ${show(c.measured)}`));
        ul.append(li);
      }
      gate.append(ul);
    }
    if (g.needsAdoption) gate.append(el("div", "cad-gate-note", g.needsAdoption === "rules" ? "Waiting for you to adopt the changed cad/rules.json." : g.needsAdoption === "references" ? "Waiting for you to approve the current reference (its measurements were not recorded)." : `Waiting for you to adopt the ${g.needsAdoption === "ownerParams" ? "dimensions" : "expectations"}.`));
    const advisory = g.checks.filter((c) => !c.hard);
    if (advisory.length || g.warnings.length || g.staleBuild) {
      const ul = el("ul", "cad-gate-advisory");
      for (const c of advisory) ul.append(el("li", "cad-check-advisory", `${show(c.expected)} — ${show(c.measured)}`));
      for (const w of g.warnings) ul.append(el("li", "cad-check-warning", w));
      if (g.staleBuild) ul.append(el("li", "cad-check-warning", "Measured with a different SolidCraft version than this machine runs."));
      gate.append(ul);
    }
  }

  return {
    el: root,
    onDesign(ev) {
      if (disposed) return;
      const names = ev.params.map((p) => p.name);
      const same = names.length === rows.size && names.every((n) => rows.has(n));
      if (!same) {
        // The set of parameters changed: rebuild the list, keeping the rows that survive (and so
        // whatever is being typed into them).
        for (const [n, r] of [...rows]) {
          if (!names.includes(n)) {
            r.root.remove();
            rows.delete(n);
          }
        }
        for (const p of ev.params) if (!rows.has(p.name)) rows.set(p.name, makeRow(p));
        list.replaceChildren(...(names.length ? names.map((n) => rows.get(n)!.root) : [el("div", "cad-params-empty", "No parameters yet.")]));
      } else if (names.length === 0 && !list.firstChild) {
        list.append(el("div", "cad-params-empty", "No parameters yet."));
      }
      for (const p of ev.params) paint(rows.get(p.name)!, p);
      drawGate(ev.gate, ev);
    },
    setNewer(newer) {
      newerNote.hidden = !newer;
    },
    dispose() {
      disposed = true;
      root.remove();
    },
  };
}
