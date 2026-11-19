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

export type SiteOp = { op: "add" | "remove"; site: string };

export const BROWSER_SITES_FILE = "browser-sites.json";
const MAX_SITES = 2000;

interface Persisted {
  sites: BrowserSite[];
  pending: SiteOp[];
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
    if (changed) this.save();
    return changed;
  }

  /** Member: apply locally AND remember it for the hub. */
  applyAndQueue(op: SiteOp): boolean {
    const changed = this.applyTo(this.state.sites, op);
    // The latest word on a site replaces any earlier queued one.
    this.state.pending = [...this.state.pending.filter((p) => p.site !== op.site), { ...op }];
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
    for (const p of this.state.pending) this.applyTo(next, p);
    this.state.sites = next;
    this.state.hub = { serverId: hub.serverId, ...(hub.url ? { url: hub.url } : this.state.hub?.url ? { url: this.state.hub.url } : {}) };
    this.save();
    return JSON.stringify(this.list()) !== before;
  }

  private applyTo(sites: BrowserSite[], op: SiteOp): boolean {
    const i = sites.findIndex((s) => s.site === op.site);
    if (op.op === "add") {
      if (i >= 0 || sites.length >= MAX_SITES) return false;
      sites.push({ site: op.site, addedAt: this.clock() });
      return true;
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
        if (site && (p.op === "add" || p.op === "remove")) this.state.pending.push({ op: p.op, site });
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
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
