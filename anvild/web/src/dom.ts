// ── DOM + formatting helpers ──────────────────────────────────────────────────
// Low-level, dependency-free utilities used throughout the web client: element lookup, HTML
// escaping, slug/icon formatting, and the Tom Select wrappers. Pure leaf module — imports nothing
// from the rest of the app, so it's safe to evaluate first and free of load-order hazards.
import TomSelect from "tom-select";
import type { Environment, Session } from "../../protocol";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
export const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
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

// ── Stylized selectors (Tom Select) ──────────────────────────────────────────
// Native <select>s are upgraded to themed Tom Select dropdowns so options can carry a Material
// Symbol icon and a color dot. Each <option> may set data-icon / data-color; the render below
// picks them up (Tom Select copies an option's data-* attributes onto its option data). All our
// selects live inside modals, so instances are tracked and torn down when the modal closes.
let modalTomSelects: TomSelect[] = [];
const renderTomOption = (data: { [k: string]: unknown }, escape: (s: string) => string): string => {
  const ic = data.icon ? `<span class="msym ts-ic">${escape(String(data.icon))}</span>` : "";
  const dot = data.color ? `<span class="ts-dot" style="background:${escape(String(data.color))}"></span>` : "";
  return `<div class="ts-opt">${ic}${dot}<span class="ts-lbl">${escape(String(data.text ?? ""))}</span></div>`;
};
/** Upgrade a native <select> into a stylized Tom Select. `search` shows the filter box (long lists). */
export function enhanceSelect(sel: HTMLSelectElement | null, search = false): void {
  if (!sel) return;
  const base = { maxOptions: null, hideSelected: false, render: { option: renderTomOption, item: renderTomOption } };
  modalTomSelects.push(new TomSelect(sel, search ? base : { ...base, controlInput: null }));
}
/** Re-read options/value from the underlying <select> after it's been repopulated programmatically. */
export function refreshSelect(sel: HTMLSelectElement | null): void {
  if (sel) modalTomSelects.find((t) => t.input === sel)?.sync();
}
/** Tear down every modal Tom Select (removes its global listeners) — called when a modal closes. */
export function destroyModalSelects(): void {
  for (const t of modalTomSelects) t.destroy();
  modalTomSelects = [];
}
