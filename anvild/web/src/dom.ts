// ── DOM + formatting helpers ──────────────────────────────────────────────────
// Low-level, dependency-free utilities used throughout the web client: element lookup, HTML
// escaping, slug/icon formatting, and the Tom Select wrappers. Pure leaf module — imports nothing
// from the rest of the app, so it's safe to evaluate first and free of load-order hazards.
import type { Environment, Session } from "../../protocol";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
/**
 * Escape text for interpolation into HTML — including into a **quoted attribute value**.
 *
 * Quotes are part of the set on purpose. This helper is used both as `>${esc(x)}<` (text) and as
 * `value="${esc(x)}"` (attribute), and the client builds a lot of markup by template string. Escaping
 * only `& < >` left every attribute site breakable by a value containing `"` — CodeQL's
 * `js/incomplete-html-attribute-sanitization`, which fires on several call sites here. Escaping the
 * quotes too closes the whole class at the leaf instead of auditing each `innerHTML` in turn.
 *
 * No rendering changes: a browser renders `&quot;`/`&#39;` as `"`/`'` in text content, so text sites
 * look identical — they simply stop being able to break out of an attribute they might later be moved
 * into. `linkifyUrls` below benefits for the same reason: a URL carrying a quote can no longer escape
 * the `href="…"` it gets substituted into.
 */
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
// [SEC-L6] Escape text, then turn bare http(s) URLs into new-tab links. `rel="noopener noreferrer"`
// prevents the opened page from reaching back via `window.opener` (reverse tabnabbing). Text is
// escaped first, so the URL can't inject tags.
export const linkifyUrls = (text: string): string =>
  esc(text).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
export const icon = (name: string): string => `<span class="msym">${name}</span>`;

export const sessIcon = (s: Session): string =>
  s.isDefault ? "robot_2" : s.pending ? "schedule" : s.icon ?? (s.source === "fresh-worktree" ? "account_tree" : "folder");
// An environment's display glyph: its chosen Material Symbol, else a sensible default by repo kind.
export const envIcon = (e: Environment): string => e.icon || (e.isRepo ? "account_tree" : "folder");
// Case-insensitive name sort for environment lists (selector + settings, per server).
export const byEnvName = (a: Environment, b: Environment): number => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// [WEB2-19] The busy-button helper. The disable → spinner-label → restore dance around an awaited
// request was hand-rolled at 9+ call sites (plan actions, settings token/connect buttons, the
// env-clone dialog), each with its own snapshot/reset code. `busy` owns the whole lifecycle: it
// snapshots the button's markup, disables it with an hourglass label while `fn` runs, and ALWAYS
// restores it (finally) — so an error path can just return/throw without leaking a dead button.
// A null/undefined button (an optional anchor that isn't rendered) simply runs `fn`.
export async function busy<T>(btn: HTMLButtonElement | null | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  if (!btn) return fn();
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon("hourglass_empty")} ${esc(label)}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ── Stylized selectors (custom combobox) ──────────────────────────────────────
// A native <select> is a poor fit here: options need a Material Symbol icon + color dot, long lists
// need a search box, and groups need styled headers — none of which a native control renders. So we
// hide the <select> (keeping it in the DOM as the single source of truth for `.value` and "change"
// events) and mirror it with this themed combobox. Every caller that reads `sel.value` or listens
// for "change" keeps working unchanged; on pick we set the select's value and re-dispatch "change".
//
// A previous incarnation leaned on Tom Select, which kept fighting us (blank selections, a stray
// glyph in the control, a dropdown that wouldn't close after a pick). This purpose-built control is
// small, dependency-free, and behaves predictably. All instances live inside modals, so they're
// tracked and torn down when the modal closes.
interface CbxOpt {
  value: string;
  label: string;
  icon?: string;
  color?: string;
  group?: string;
  disabled: boolean;
}
interface Cbx {
  sel: HTMLSelectElement;
  destroy: () => void;
  rebuild: () => void;
}
let comboboxes: Cbx[] = [];

/** The icon glyph + color dot + label shared by the control's current value and each list option. */
const cbxContent = (o: { icon?: string; color?: string; label: string }): string => {
  const ic = o.icon ? `<span class="msym cbx-ic">${esc(o.icon)}</span>` : "";
  const dot = o.color ? `<span class="cbx-dot" style="background:${esc(o.color)}"></span>` : "";
  return `${ic}${dot}<span class="cbx-lbl">${esc(o.label)}</span>`;
};

/** Flatten a <select> (optgroups + options) into our option model, preserving DOM order. We match on
 *  tagName rather than instanceof so this works under the jsdom test harness (which doesn't install
 *  HTMLOptionElement/HTMLOptGroupElement as globals). */
function cbxReadOptions(sel: HTMLSelectElement): CbxOpt[] {
  const out: CbxOpt[] = [];
  const push = (op: HTMLOptionElement, group?: string): void => {
    out.push({ value: op.value, label: op.textContent ?? "", icon: op.dataset.icon || undefined, color: op.dataset.color || undefined, group, disabled: op.disabled });
  };
  for (const child of Array.from(sel.children) as HTMLElement[]) {
    if (child.tagName === "OPTGROUP") {
      const g = (child as HTMLOptGroupElement).label;
      for (const op of Array.from(child.children) as HTMLElement[]) if (op.tagName === "OPTION") push(op as HTMLOptionElement, g);
    } else if (child.tagName === "OPTION") {
      push(child as HTMLOptionElement);
    }
  }
  return out;
}

/** Upgrade a native <select> into a themed combobox. `search` adds a filter box (for long lists). */
export function enhanceSelect(sel: HTMLSelectElement | null, search = false): void {
  if (!sel) return;
  sel.hidden = true; // keep it as the value source, out of view
  sel.setAttribute("aria-hidden", "true");
  sel.tabIndex = -1;

  const wrap = document.createElement("div");
  wrap.className = "cbx";

  const control = document.createElement("button");
  control.type = "button";
  control.className = "cbx-control";
  control.setAttribute("aria-haspopup", "listbox");
  control.setAttribute("aria-expanded", "false");
  const valueEl = document.createElement("span");
  valueEl.className = "cbx-value";
  const chev = document.createElement("span");
  chev.className = "msym cbx-chev";
  chev.textContent = "expand_more";
  control.append(valueEl, chev);

  const panel = document.createElement("div");
  panel.className = "cbx-panel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  let searchInput: HTMLInputElement | null = null;
  if (search) {
    const sw = document.createElement("div");
    sw.className = "cbx-search";
    const si = document.createElement("span");
    si.className = "msym cbx-search-ic";
    si.textContent = "search";
    searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "cbx-search-input";
    searchInput.placeholder = "Search…";
    searchInput.autocomplete = "off";
    sw.append(si, searchInput);
    panel.append(sw);
  }
  const list = document.createElement("div");
  list.className = "cbx-list";
  panel.append(list);
  wrap.append(control, panel);
  sel.after(wrap);

  let itemEls: HTMLElement[] = []; // every selectable option row, in DOM order
  let activeIdx = -1; // index into the currently-visible items (highlighted by keyboard/hover)
  let open = false;

  const visibleItems = (): HTMLElement[] => itemEls.filter((el) => !el.hidden && !el.classList.contains("cbx-item--disabled"));

  const renderValue = (): void => {
    const opts = cbxReadOptions(sel);
    const cur = opts.find((o) => o.value === sel.value) ?? opts[0];
    valueEl.innerHTML = cur ? cbxContent(cur) : `<span class="cbx-lbl"></span>`;
  };

  const setActive = (idx: number): void => {
    const vis = visibleItems();
    activeIdx = vis.length ? Math.max(0, Math.min(idx, vis.length - 1)) : -1;
    for (const el of itemEls) el.classList.remove("cbx-active");
    const el = vis[activeIdx];
    if (el) {
      el.classList.add("cbx-active");
      el.scrollIntoView({ block: "nearest" });
    }
  };

  const applyFilter = (raw: string): void => {
    const q = raw.trim().toLowerCase();
    for (const el of itemEls) el.hidden = q ? !(el.dataset.q ?? "").includes(q) : false;
    // Hide a group header when every option beneath it is filtered out.
    for (const h of Array.from(list.querySelectorAll(".cbx-group")) as HTMLElement[]) {
      let visible = false;
      for (let n = h.nextElementSibling as HTMLElement | null; n && n.classList.contains("cbx-item"); n = n.nextElementSibling as HTMLElement | null) {
        if (!n.hidden) {
          visible = true;
          break;
        }
      }
      h.hidden = !visible;
    }
    const vis = visibleItems();
    const selIdx = vis.findIndex((el) => el.dataset.value === sel.value);
    setActive(selIdx >= 0 ? selIdx : 0);
  };

  const pick = (value: string): void => {
    if (sel.value !== value) {
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    for (const el of itemEls) el.setAttribute("aria-selected", String(el.dataset.value === value));
    renderValue();
    closePanel();
    control.focus();
  };

  const buildList = (): void => {
    list.innerHTML = "";
    itemEls = [];
    let lastGroup: string | undefined = " "; // sentinel: guarantees the first real group is emitted
    for (const o of cbxReadOptions(sel)) {
      if (o.group !== lastGroup) {
        lastGroup = o.group;
        if (o.group) {
          const h = document.createElement("div");
          h.className = "cbx-group";
          h.textContent = o.group;
          list.append(h);
        }
      }
      const it = document.createElement("div");
      it.className = "cbx-item" + (o.disabled ? " cbx-item--disabled" : "");
      it.setAttribute("role", "option");
      it.setAttribute("aria-selected", String(o.value === sel.value));
      it.dataset.value = o.value;
      it.dataset.q = o.label.toLowerCase();
      it.innerHTML = cbxContent(o);
      if (!o.disabled) {
        // mousedown (not click) so the pick lands before the control's blur can close the panel
        it.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(o.value);
        });
        it.addEventListener("mousemove", () => setActive(visibleItems().indexOf(it)));
      }
      list.append(it);
      itemEls.push(it);
    }
    renderValue();
  };

  const openPanel = (): void => {
    if (open || sel.disabled) return;
    open = true;
    // Flip upward when the control sits low enough that a downward panel would be clipped.
    const r = control.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    wrap.classList.toggle("cbx--up", below < 260 && r.top > below);
    panel.hidden = false;
    control.setAttribute("aria-expanded", "true");
    if (searchInput) {
      searchInput.value = "";
      applyFilter("");
      searchInput.focus();
    } else {
      const vis = visibleItems();
      setActive(Math.max(0, vis.findIndex((el) => el.dataset.value === sel.value)));
    }
  };
  const closePanel = (): void => {
    if (!open) return;
    open = false;
    panel.hidden = true;
    control.setAttribute("aria-expanded", "false");
  };

  const onKey = (e: KeyboardEvent): void => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // close the dropdown only — don't let the modal's Escape handler fire too
        closePanel();
        control.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive(activeIdx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(activeIdx - 1);
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(visibleItems().length - 1);
        break;
      case "Enter": {
        e.preventDefault();
        const el = visibleItems()[activeIdx];
        if (el) pick(el.dataset.value ?? "");
        break;
      }
      case "Tab":
        closePanel();
        break;
    }
  };

  const onDocDown = (e: Event): void => {
    if (open && !wrap.contains(e.target as Node)) closePanel();
  };

  control.addEventListener("click", (e) => {
    e.preventDefault();
    if (open) closePanel();
    else openPanel();
  });
  control.addEventListener("keydown", onKey);
  searchInput?.addEventListener("keydown", onKey);
  searchInput?.addEventListener("input", () => applyFilter(searchInput!.value));
  document.addEventListener("mousedown", onDocDown, true);

  buildList();
  comboboxes.push({
    sel,
    rebuild: () => {
      buildList();
      if (open && searchInput) applyFilter(searchInput.value);
    },
    destroy: () => {
      document.removeEventListener("mousedown", onDocDown, true);
      wrap.remove();
      sel.hidden = false;
      sel.removeAttribute("aria-hidden");
      sel.removeAttribute("tabindex");
    },
  });
}

/** Re-read options/value from the underlying <select> after it's been repopulated (or its value set)
 *  programmatically — e.g. the fleet host list, or the account picker re-pointed on env change. */
export function refreshSelect(sel: HTMLSelectElement | null): void {
  if (sel) comboboxes.find((c) => c.sel === sel)?.rebuild();
}
/** Tear down every modal combobox (removes its document listener, restores the native select) —
 *  called when a modal closes. */
export function destroyModalSelects(): void {
  for (const c of comboboxes) c.destroy();
  comboboxes = [];
}
