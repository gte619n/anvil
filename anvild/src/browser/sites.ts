/**
 * Sites for the agent browser (agent-cad-and-browser §4.12 "Per-site approval", §4.14 items 25, 26
 * and 43): what a "site" is, which URLs may be navigated to at all, how the page URL is read out of a
 * tool result, and the allowed-sites list each daemon keeps on disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { getDomain } from "tldts";
import type { BrowserSite } from "@protocol";

// ── What a site is ──────────────────────────────────────────────────────────────────────────────

/**
 * The site a hostname belongs to: its registrable domain by the public suffix list (ICANN and
 * private sections, so `alice.github.io` and `bob.github.io` are different sites and
 * `docs.example.co.uk` is `example.co.uk`). An IP address, a single-label name (`localhost`) or
 * anything the list cannot place is its own site, exactly as written.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || isIP(host)) return host;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** Turn what an owner typed (a hostname, or a whole URL) into a site, or undefined if it is neither. */
export function normalizeSite(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return undefined;
  let host: string;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    host = u.hostname;
  } catch {
    return undefined;
  }
  const site = registrableDomain(host);
  return site && /^[a-z0-9._:-]+$/.test(site) ? site : undefined;
}

// ── Which URLs may be navigated to ──────────────────────────────────────────────────────────────

export type UrlVerdict =
  /** An `http:` / `https:` page on `site`. */
  | { ok: true; site: string; url: string }
  /** `about:blank`: always allowed, belongs to no site. */
  | { ok: true; blank: true }
  | { ok: false; reason: string };

/**
 * Only `http:` and `https:` targets are allowed at all; `about:blank` is the one exception. `file:`,
 * `chrome:`, `data:`, `view-source:`, `javascript:`, every other `about:` page and anything that
 * does not parse are refused — before the call reaches the server, which matters because the server
 * itself ran a `javascript:` URL (C0).
 */
export function checkUrl(raw: unknown): UrlVerdict {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "a navigation needs a url" };
  const text = raw.trim();
  if (text.toLowerCase() === "about:blank") return { ok: true, blank: true };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: `not a full URL (write https://…): ${text.slice(0, 80)}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `${u.protocol} URLs are not allowed in the agent browser (only http: and https:)` };
  }
  if (!u.hostname) return { ok: false, reason: "the URL has no host" };
  return { ok: true, site: registrableDomain(u.hostname), url: u.href };
}

/** Chrome's own "this page could not be loaded" page: browser-made, belongs to no site. */
export const CHROME_ERROR_URL = "chrome-error://chromewebdata/";

/**
 * As `checkUrl`, for a URL the MODEL wrote and the gate will forward to the server unchanged. The
 * string that is checked must be the string that is sent, so anything a second parser could read
 * differently is refused rather than repaired: surrounding or embedded whitespace, control
 * characters, backslashes, and any spelling whose normalized form (`new URL(raw).href`) is not the
 * raw string itself (a bare origin may omit its final `/`). `about:blank` must be written exactly.
 */
export function checkNavigationInput(raw: unknown): UrlVerdict {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "a navigation needs a url" };
  if (raw === "about:blank") return { ok: true, blank: true };
  if (raw.trim().toLowerCase() === "about:blank") return { ok: false, reason: 'write the url exactly as "about:blank"' };
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/.test(raw)) return { ok: false, reason: "the url contains whitespace, a backslash or a control character; write it as one plain URL" };
  const v = checkUrl(raw);
  if (!v.ok || "blank" in v) return v;
  if (v.url !== raw && v.url !== `${raw}/`) return { ok: false, reason: `the url is not in its normal form; write it exactly as ${v.url}` };
  return v;
}

// ── Reading the page URL out of a tool result ───────────────────────────────────────────────────

/** The C0 marker: the `- Page URL:` line directly under a `### Page` heading. */
const PAGE_URL_RE = /^### Page[ \t]*\r?\n- Page URL: (.*)$/m;
const PAGE_HEADING_RE = /^### Page[ \t]*$/gm;

export interface PageReport {
  /** How many `### Page` blocks the result has. More than one cannot be trusted: dialog and console
   *  text is page-controlled and sits in the same result. */
  blocks: number;
  /** The reported URL, when there is exactly one block and it has the line. Absent = unchanged. */
  url?: string;
}

export function parsePageReport(text: string): PageReport {
  const blocks = text.match(PAGE_HEADING_RE)?.length ?? 0;
  if (blocks !== 1) return { blocks };
  const url = PAGE_URL_RE.exec(text)?.[1]?.trim();
  return url ? { blocks, url } : { blocks };
}

// ── Reading the CURRENT TAB's address (review of Phase C2) ───────────────────────────────────────
// Real Playwright MCP 0.0.86 results are a run of `### <Section>` blocks in this order:
//   [Result] [Ran Playwright code] [Open tabs] [Page] [Modal state] [Snapshot] [Events]   — or just [Error].
// `### Page` (with `- Page URL:` as its first line) describes the current tab. `### Open tabs` (when
// there is more than one tab) and the `### Result` of `browser_tabs` list every tab as
// `- <n>: [(current) ][<title>](<url>)`.
//
// What a page controls: its title (one line: inside `- Page Title:` and inside a tab line's
// brackets), its URL, and free multi-line text in `### Modal state` (a dialog's message),
// `### Snapshot` (inline for `browser_snapshot`), `### Events` (console lines), `### Error` (element
// HTML in a call log) and the `### Result` of the tools in PAGE_TEXT_TOOLS. So:
//   - a result of a PAGE_TEXT_TOOLS tool, or an error result, says nothing about the address;
//   - `### Page` counts only when it is the ONLY such heading in the whole result and it comes before
//     any `### Modal state` / `### Snapshot` / `### Events`, after nothing but the server's own
//     sections — otherwise the result is AMBIGUOUS;
//   - a tab line counts only when it has exactly one `](` (a title or URL containing `](` could move
//     the split); the `### Page` block, whose URL is a whole line, is the authority when both exist,
//     and the two must agree.

/** Tools whose result carries page-controlled text. A page address is never read from them. */
export const PAGE_TEXT_TOOLS: ReadonlySet<string> = new Set(["browser_console_messages", "browser_network_requests", "browser_network_request", "browser_find", "browser_evaluate", "browser_run_code_unsafe", "browser_handle_dialog"]);

export interface TabEntry {
  index: number;
  current: boolean;
  /** Absent when the line cannot be split into title and URL with certainty. */
  url?: string;
}

export type PageReading =
  /** The current tab is at `url`. */
  | { kind: "url"; url: string; tabs?: TabEntry[] }
  /** The result does not say where the current tab is. */
  | { kind: "none"; tabs?: TabEntry[] }
  /** The result cannot be trusted to say it (page text in the place of the server's). */
  | { kind: "ambiguous"; why: string };

const HEADING_RE = /^### (.+?)[ \t]*$/;
const SERVER_SECTIONS_BEFORE_PAGE = new Set(["Result", "Ran Playwright code", "Open tabs"]);
const PAGE_TEXT_SECTIONS = new Set(["Modal state", "Snapshot", "Events", "Error"]);
const TAB_LINE_RE = /^- (\d+): (\(current\) )?\[(.*)\)$/;

function parseTabLines(lines: string[]): TabEntry[] | undefined {
  const out: TabEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = TAB_LINE_RE.exec(line);
    if (!m) return undefined; // not a tab list (e.g. `browser_close`'s "No open tabs…")
    const rest = m[3]!;
    const splits = rest.split("](").length - 1;
    out.push({ index: Number(m[1]), current: !!m[2], ...(splits === 1 ? { url: rest.slice(rest.indexOf("](") + 2) } : {}) });
  }
  return out.length ? out : undefined;
}

/** Where the current tab is, according to one tool result. See the block comment above. */
export function readPage(tool: string, text: string, isError = false): PageReading {
  if (isError || PAGE_TEXT_TOOLS.has(tool)) return { kind: "none" };
  const lines = text.split(/\r?\n/);
  const sections: { name: string; at: number }[] = [];
  for (const [i, line] of lines.entries()) {
    const m = HEADING_RE.exec(line);
    if (m) sections.push({ name: m[1]!, at: i });
  }
  const body = (k: number): string[] => lines.slice(sections[k]!.at + 1, sections[k + 1]?.at ?? lines.length);
  const pages = sections.flatMap((s, k) => (s.name === "Page" ? [k] : []));
  if (pages.length > 1) return { kind: "ambiguous", why: "the result has more than one ### Page block" };

  let pageUrl: string | undefined;
  if (pages.length === 1) {
    const k = pages[0]!;
    const before = sections.slice(0, k);
    if (before.some((s) => !SERVER_SECTIONS_BEFORE_PAGE.has(s.name))) return { kind: "ambiguous", why: "the ### Page block is not where the server puts it" };
    const first = body(k)[0] ?? "";
    if (!first.startsWith("- Page URL: ")) return { kind: "ambiguous", why: "the ### Page block has no address line" };
    pageUrl = first.slice("- Page URL: ".length).trim();
    if (!pageUrl) return { kind: "ambiguous", why: "the ### Page block has no address" };
  }

  // Tab lists: `### Open tabs`, and `### Result` of `browser_tabs`. Only ahead of any page-text section.
  const firstPageText = sections.findIndex((s) => PAGE_TEXT_SECTIONS.has(s.name));
  let tabs: TabEntry[] | undefined;
  for (const [k, s] of sections.entries()) {
    if (firstPageText >= 0 && k > firstPageText) break;
    if (s.name !== "Open tabs" && !(s.name === "Result" && tool === "browser_tabs")) continue;
    const parsed = parseTabLines(body(k));
    if (!parsed) continue;
    if (parsed.filter((t) => t.current).length !== 1) return { kind: "ambiguous", why: "the tab list does not name exactly one current tab" };
    if (tabs && JSON.stringify(tabs) !== JSON.stringify(parsed)) return { kind: "ambiguous", why: "the result lists the tabs twice, differently" };
    tabs = parsed;
  }
  const current = tabs?.find((t) => t.current);
  const withTabs = tabs ? { tabs } : {};
  if (pageUrl !== undefined) {
    if (current?.url !== undefined && current.url !== pageUrl) return { kind: "ambiguous", why: "the ### Page block and the tab list disagree about the current tab" };
    return { kind: "url", url: pageUrl, ...withTabs };
  }
  if (current?.url !== undefined) return { kind: "url", url: current.url, ...withTabs };
  return { kind: "none", ...withTabs };
}

/** The files a result says the server wrote (`[Snapshot](/abs/page-….yml)`, a screenshot's path). */
export function resultFileLinks(text: string): string[] {
  return [...text.matchAll(/\]\((\/[^)\n]+\.(?:yml|yaml|md|png|jpe?g|log))\)/g)].map((m) => m[1]!);
}

/** The text of a tool result as the SDK delivers it (a string, or content blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

// ── The allowed-sites list on disk ──────────────────────────────────────────────────────────────

/** One change to the list. `at` is when it was made (ms): the later of an add and a remove of the
 *  same site wins, so a change queued on a member cannot undo a newer one made on the hub. */
export type SiteOp = { op: "add" | "remove"; site: string; at?: number };

/** How long the hub remembers that a site was removed (so a stale queued add cannot bring it back). */
export const SITE_TOMBSTONE_MS = 30 * 24 * 60 * 60_000;

export const BROWSER_SITES_FILE = "browser-sites.json";
const MAX_SITES = 2000;

interface Persisted {
  sites: BrowserSite[];
  pending: SiteOp[];
  /** Removals, newest per site, kept for SITE_TOMBSTONE_MS. */
  removed?: { site: string; at: number }[];
  hub?: { serverId: string; url?: string };
}

/**
 * This daemon's copy of the fleet's allowed-sites list (`<stateDir>/browser-sites.json`).
 *
 * The hub's copy is the authority. A member's copy is the last list the hub pushed, with the
 * member's own unconfirmed changes (`pending`) applied on top, so an approval made on a member takes
 * effect there at once and survives being offline; the queue is cleared when the hub confirms it.
 * The member also remembers which hub pushed to it and at what URL, so it can forward the queue.
 */
export class AllowedSitesStore {
  private readonly file: string;
  private state: Persisted = { sites: [], pending: [] };

  constructor(
    stateDir: string,
    private readonly clock: () => number = Date.now,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, BROWSER_SITES_FILE);
    this.load();
  }

  list(): BrowserSite[] {
    return [...this.state.sites].sort((a, b) => a.site.localeCompare(b.site)).map((s) => ({ ...s }));
  }
  has(site: string): boolean {
    return this.state.sites.some((s) => s.site === site);
  }
  pending(): SiteOp[] {
    return this.state.pending.map((p) => ({ ...p }));
  }
  hub(): { serverId: string; url?: string } | undefined {
    return this.state.hub ? { ...this.state.hub } : undefined;
  }

  /** Apply one change to the local list. Returns whether the list changed. */
  apply(op: SiteOp): boolean {
    const changed = this.applyTo(this.state.sites, op);
    this.save(); // a removal is remembered even when the site was not listed
    return changed;
  }

  /** Member: apply locally AND remember it for the hub, stamped with when it was made. */
  applyAndQueue(op: SiteOp): boolean {
    const stamped: SiteOp = { ...op, at: op.at ?? this.clock() };
    const changed = this.applyTo(this.state.sites, stamped, false);
    // The latest word on a site replaces any earlier queued one.
    this.state.pending = [...this.state.pending.filter((p) => p.site !== op.site), stamped];
    this.save();
    return changed;
  }

  /** Member: the hub confirmed these queued changes. */
  confirm(ops: readonly SiteOp[]): void {
    const done = new Set(ops.map((o) => `${o.op} ${o.site}`));
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => !done.has(`${p.op} ${p.site}`));
    if (this.state.pending.length !== before) this.save();
  }

  /**
   * Member: take the hub's list as the truth, then put this machine's unconfirmed changes back on
   * top. Returns whether the visible list changed.
   */
  replaceFromHub(sites: readonly BrowserSite[], hub: { serverId: string; url?: string }): boolean {
    const before = JSON.stringify(this.list());
    const next = sites.filter((s) => s && typeof s.site === "string" && s.site).map((s) => ({ site: s.site, addedAt: Number(s.addedAt) || this.clock() })).slice(0, MAX_SITES);
    for (const p of this.state.pending) this.applyTo(next, p, false);
    this.state.sites = next;
    this.state.hub = { serverId: hub.serverId, ...(hub.url ? { url: hub.url } : this.state.hub?.url ? { url: this.state.hub.url } : {}) };
    this.save();
    return JSON.stringify(this.list()) !== before;
  }

  /**
   * Apply one change. With `ordered` (the authority's own list) the change's time is compared with
   * what the list already knows: an add older than the site's removal, or a removal older than the
   * site's add, is a stale message and changes nothing.
   */
  private applyTo(sites: BrowserSite[], op: SiteOp, ordered = true): boolean {
    const at = typeof op.at === "number" && Number.isFinite(op.at) ? op.at : this.clock();
    const i = sites.findIndex((s) => s.site === op.site);
    const tombs = (this.state.removed ??= []);
    const tomb = tombs.find((t) => t.site === op.site);
    if (op.op === "add") {
      if (ordered && tomb && tomb.at > at) return false; // removed after this add was made
      if (i >= 0 || sites.length >= MAX_SITES) return false;
      sites.push({ site: op.site, addedAt: at });
      if (ordered && tomb) tombs.splice(tombs.indexOf(tomb), 1);
      return true;
    }
    if (ordered) {
      if (i >= 0 && sites[i]!.addedAt > at) return false; // added again after this removal was made
      if (tomb) tomb.at = Math.max(tomb.at, at);
      else tombs.push({ site: op.site, at });
    }
    if (i < 0) return false;
    sites.splice(i, 1);
    return true;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.sites)) throw new Error("expected { sites: [...] }");
      const seen = new Set<string>();
      for (const s of raw.sites) {
        // Each row is re-normalized, so a hand-edited entry cannot widen to something a site is not.
        const site = normalizeSite((s as BrowserSite | undefined)?.site);
        if (!site || site !== (s as BrowserSite).site || seen.has(site)) continue;
        seen.add(site);
        this.state.sites.push({ site, addedAt: Number((s as BrowserSite).addedAt) || 0 });
      }
      for (const p of Array.isArray(raw.pending) ? raw.pending : []) {
        const site = normalizeSite(p?.site);
        if (site && (p.op === "add" || p.op === "remove")) this.state.pending.push({ op: p.op, site, ...(typeof p.at === "number" ? { at: p.at } : {}) });
      }
      for (const t of Array.isArray(raw.removed) ? raw.removed : []) {
        const site = normalizeSite(t?.site);
        if (site && typeof t.at === "number") (this.state.removed ??= []).push({ site, at: t.at });
      }
      if (raw.hub && typeof raw.hub.serverId === "string") this.state.hub = { serverId: raw.hub.serverId, ...(typeof raw.hub.url === "string" ? { url: raw.hub.url } : {}) };
    } catch (e) {
      // Fail closed: a corrupt list allows nothing. Keep the evidence.
      const dest = `${this.file}.corrupt-${this.clock()}`;
      try {
        renameSync(this.file, dest);
      } catch {
        /* could not move it; the next save overwrites it */
      }
      this.state = { sites: [], pending: [] };
      console.error(`[browser] ${this.file} is corrupt (${e instanceof Error ? e.message : String(e)}); starting with no allowed sites`);
    }
  }

  private save(): void {
    const cutoff = this.clock() - SITE_TOMBSTONE_MS;
    if (this.state.removed) this.state.removed = this.state.removed.filter((t) => t.at >= cutoff);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
