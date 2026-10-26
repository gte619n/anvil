// Plan-usage gauge (arch §3): the Claude subscription's real rate-limit windows, one row per account,
// merged across every connected server. Rate limits belong to an ACCOUNT, so two fleet members on the
// same account report the same windows at different freshness — we keep the newest reading per account.
// The merge/format half is DOM-free and unit-tested (test/web/usage.test.ts); `renderUsage` paints it.
import type { Budget, RateWindow } from "../../protocol";
import { esc } from "./dom";

/** A reading older than this is flagged stale (the account has no live session to poll through). */
export const STALE_MS = 15 * 60_000;

/** Merge every server's per-account gauges: one per account, newest `updatedAt` wins, then sorted by
 *  label for a stable row order. Keyed by `subscriptionKey` (a token fingerprint) so the SAME account
 *  seen from two fleet machines — which mint different local `accountId`s — collapses to one row;
 *  older daemons without it fall back to `accountId`, then to a single "" key (bare env token /
 *  pre-roster daemon). Unavailable gauges are dropped. */
export function mergeGauges(perServer: Budget[][]): Budget[] {
  const best = new Map<string, Budget>();
  for (const list of perServer) {
    for (const g of list) {
      if (!g.available) continue;
      const key = g.subscriptionKey ?? g.accountId ?? "";
      const cur = best.get(key);
      if (!cur || (g.updatedAt ?? "") > (cur.updatedAt ?? "")) best.set(key, g);
    }
  }
  return [...best.values()].sort((a, b) => gaugeLabel(a).localeCompare(gaugeLabel(b), undefined, { sensitivity: "base" }));
}

/** A server's gauges from its budget event: the per-account list when sent, else the legacy single. */
export function gaugesOf(e: { budget: Budget; budgets?: Budget[] }): Budget[] {
  return e.budgets ?? (e.budget.available ? [e.budget] : []);
}

export function gaugeLabel(g: Budget): string {
  return g.accountLabel || (g.subscriptionType ? `Claude ${cap(g.subscriptionType)}` : "Claude plan");
}

/** "2h 14m" / "3d 4h" / "12m" until `iso`, or "" when unknown/past. */
export function untilText(iso: string | undefined, nowMs: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "just now" / "7m ago" / "3h ago" since `iso`. */
export function agoText(iso: string | undefined, nowMs: number): string {
  if (!iso) return "never";
  const m = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export const isStale = (g: Budget, nowMs: number): boolean => !g.updatedAt || nowMs - Date.parse(g.updatedAt) > STALE_MS;

/** Severity of one window: "" < "warm" (≥80%) < "hot" (≥95%). */
export function level(w: RateWindow | undefined): "" | "warm" | "hot" {
  const u = w?.utilization ?? 0;
  return u >= 95 ? "hot" : u >= 80 ? "warm" : "";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function bar(name: string, w: RateWindow | undefined, nowMs: number): string {
  if (!w) return "";
  const pct = Math.max(0, Math.min(100, w.utilization));
  const resets = untilText(w.resetsAt, nowMs);
  return `<div class="usage-row ${level(w)}" title="${esc(`${name}: ${pct}% used${resets ? ` · resets in ${resets}` : ""}`)}">
    <span class="usage-name">${esc(name)}</span>
    <span class="usage-bar"><i style="width:${pct}%"></i></span>
    <span class="usage-pct">${Math.round(pct)}%</span>
  </div>`;
}

/** Paint the merged gauges into `el`. With no gauges, show a "no reading yet" placeholder while a
 *  server is connected (the first poll can take a few minutes) and only fully hide when nothing is
 *  attached — so the meter never silently vanishes on an account that simply hasn't been read yet. */
export function renderUsage(el: HTMLElement | null, gauges: Budget[], nowMs = Date.now(), expectReading = false): void {
  if (!el) return;
  if (gauges.length === 0) {
    el.hidden = !expectReading;
    el.innerHTML = expectReading ? `<div class="usage-acct usage-empty">No plan-usage reading yet…</div>` : "";
    return;
  }
  el.hidden = false;
  // With a single account the label is noise ("default"/"Claude plan") — show just the bars. The head
  // is still emitted when a gauge is stale, to carry the "Xm ago" freshness hint.
  const showLabel = gauges.length > 1;
  el.innerHTML = gauges
    .map((g) => {
      const stale = isStale(g, nowMs);
      const extra = [
        g.weekOpus ? `Opus week ${Math.round(g.weekOpus.utilization)}%` : "",
        g.weekSonnet ? `Sonnet week ${Math.round(g.weekSonnet.utilization)}%` : "",
        `updated ${agoText(g.updatedAt, nowMs)}`,
      ].filter(Boolean);
      const head =
        (showLabel ? `<span class="usage-label">${esc(gaugeLabel(g))}</span>` : "") +
        (stale ? `<span class="usage-ago">${esc(agoText(g.updatedAt, nowMs))}</span>` : "");
      return `<div class="usage-acct${stale ? " stale" : ""}" title="${esc(extra.join(" · "))}">
        ${head ? `<div class="usage-head">${head}</div>` : ""}
        ${bar("5h", g.session, nowMs)}${bar("Week", g.week, nowMs)}
      </div>`;
    })
    .join("");
}

let ticker: ReturnType<typeof setInterval> | undefined;
/** Start (once) a one-minute repaint so relative times stay current; idempotent. */
export function startUsageTicker(paint: () => void): void {
  ticker ??= setInterval(paint, 60_000);
}
