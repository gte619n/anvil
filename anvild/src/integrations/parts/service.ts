/**
 * The part-sources service (agent-cad-and-browser Phase C5): the three connectors, their keys, what
 * each session's `parts_search` returned (the only URLs `parts_fetch` will take), and the fetch into
 * the session's download quarantine.
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { extname, join } from "node:path";
import { PROTOCOL_VERSION, type PartSourceId, type PartSourcesEvent, type PartsTestResultEvent } from "@protocol";
import { DOWNLOAD_EXTENSIONS, DOWNLOAD_MAX_BYTES, outputDirProblem, quarantineFile, sanitizeDownloadName, type DownloadOutcome } from "../../browser/downloads";
import { ownHosts, systemResolver, type ProxyResolver } from "../../browser/proxy";
import { ensureGitExcluded } from "../../browser/service";
import { DigiKeySource } from "./digikey";
import { downloadPart, type PartDownloadDeps } from "./download";
import { redact } from "./http";
import { ALL_PART_KEY_NAMES, PART_SOURCE_IDS, PART_SOURCE_LABELS, PartKeyStore, isPartSourceId } from "./keys";
import { MouserSource } from "./mouser";
import { TracePartsSource } from "./traceparts";
import { PartSourceError, type ConnectorDeps, type PartResult, type PartSource } from "./types";

export const PARTS_DEFAULT_LIMIT = 5;
export const PARTS_MAX_LIMIT = 20;
/** URLs remembered per session (oldest dropped first). */
const MAX_REMEMBERED = 2000;
const OUTPUT_DIRNAME = ".anvil-browser"; // where quarantineFile takes files from (browser/downloads.ts)

export interface PartsServiceDeps {
  /** The env file the keys are stored in (the launcher's, or a test's). */
  envFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  baseUrls?: Partial<Record<PartSourceId, string>>;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  /** parts_fetch's network vetting (the browser proxy's rules). */
  resolver?: ProxyResolver;
  selfHosts?: () => readonly string[];
  fleetHosts?: () => readonly string[];
  dial?: PartDownloadDeps["dial"];
  ca?: string;
  /** A key was set or cleared here: broadcast the new status (and, on a hub, push to members). */
  onKeysChanged?: (event: PartSourcesEvent, origin: "local" | "fleet") => void;
}

export interface PartsSearchOutcome {
  results: PartResult[];
  /** One line per source that was skipped or failed. */
  notes: string[];
}

export type PartsFetchOutcome = ({ ok: true } & DownloadOutcome & { source: PartSourceId; from: string }) | { ok: false; error: string };

interface Remembered {
  source: PartSourceId;
  kind: "file" | "traceparts-cad";
}

export class PartsService {
  readonly keys: PartKeyStore;
  readonly digikey: DigiKeySource;
  readonly mouser: MouserSource;
  readonly traceparts: TracePartsSource;
  readonly sources: readonly PartSource[];
  private readonly returned = new Map<string, Map<string, Remembered>>();

  constructor(private readonly deps: PartsServiceDeps) {
    this.keys = new PartKeyStore(deps.envFile);
    const base = (id: PartSourceId): ConnectorDeps => ({
      fetch: deps.fetchImpl ?? fetch,
      now: deps.now ?? Date.now,
      sleep: deps.sleep,
      timeoutMs: deps.timeoutMs,
      baseUrl: deps.baseUrls?.[id],
      keys: () => this.keys.values(id),
    });
    this.digikey = new DigiKeySource(base("digikey"));
    this.mouser = new MouserSource(base("mouser"));
    this.traceparts = new TracePartsSource(base("traceparts"));
    this.sources = [this.digikey, this.mouser, this.traceparts];
  }

  source(id: PartSourceId): PartSource {
    return this.sources.find((s) => s.id === id)!;
  }

  anyConfigured(): boolean {
    return this.sources.some((s) => s.configured());
  }

  /** Every key value, for scrubbing text that leaves the daemon. */
  private secrets(): string[] {
    return ALL_PART_KEY_NAMES.map((n) => this.keys.get(n)).filter((x): x is string => !!x);
  }
  private scrub(text: string): string {
    return redact(text, this.secrets());
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────────

  event(): PartSourcesEvent {
    return { v: PROTOCOL_VERSION, ts: new Date().toISOString(), type: "parts.sources", sources: PART_SOURCE_IDS.map((id) => this.keys.status(id)) };
  }

  setKeys(source: unknown, values: unknown): void {
    if (!isPartSourceId(source)) throw new Error(`unknown part source ${JSON.stringify(source)}`);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("values must be an object of field name → value");
    const written = this.keys.set(source, values as Record<string, unknown>);
    if (!written.length) throw new Error(`nothing to save: enter a value for at least one ${PART_SOURCE_LABELS[source]} field`);
    this.deps.onKeysChanged?.(this.event(), "local");
  }

  clearKeys(source: unknown): void {
    if (!isPartSourceId(source)) throw new Error(`unknown part source ${JSON.stringify(source)}`);
    this.keys.clear(source);
    this.deps.onKeysChanged?.(this.event(), "local");
  }

  /** A hub's credential push (`partKeys`): present keys overwrite. */
  adoptFleetKeys(payload: unknown): string[] {
    const written = this.keys.adopt(payload);
    if (written.length) this.deps.onKeysChanged?.(this.event(), "fleet");
    return written;
  }

  fleetPayload(): Record<string, string> | undefined {
    const p = this.keys.fleetPayload();
    return Object.keys(p).length ? p : undefined;
  }

  /** One cheap authenticated call. Never throws; the message never carries a key. */
  async test(source: unknown, cid?: string): Promise<PartsTestResultEvent> {
    const reply = (ok: boolean, message: string): PartsTestResultEvent =>
      ({ v: PROTOCOL_VERSION, ts: new Date().toISOString(), type: "parts.test.result", ...(cid ? { cid } : {}), source: (isPartSourceId(source) ? source : "digikey") as PartSourceId, ok, message: this.scrub(message) });
    if (!isPartSourceId(source)) return reply(false, `unknown part source ${JSON.stringify(source)}`);
    const s = this.source(source);
    if (!s.configured()) return reply(false, `${s.label} is not configured: ${this.keys.status(source).fields.filter((f) => !f.set).map((f) => f.label).join(", ")} missing`);
    try {
      return reply(true, await s.test());
    } catch (e) {
      return reply(false, e instanceof Error ? e.message : String(e));
    }
  }

  // ── parts_search ────────────────────────────────────────────────────────────────────────────

  async search(sessionId: string, query: unknown, opts: { sources?: unknown; limit?: unknown; manufacturer?: unknown } = {}): Promise<PartsSearchOutcome> {
    if (typeof query !== "string" || !query.trim()) throw new PartSourceError("refused", "query must be a non-empty string");
    const q = query.trim().slice(0, 250);
    const limitRaw = opts.limit === undefined ? PARTS_DEFAULT_LIMIT : Number(opts.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(PARTS_MAX_LIMIT, Math.floor(limitRaw))) : PARTS_DEFAULT_LIMIT;
    let wanted: PartSourceId[] = [...PART_SOURCE_IDS];
    if (opts.sources !== undefined) {
      if (!Array.isArray(opts.sources) || opts.sources.some((x) => !isPartSourceId(x))) throw new PartSourceError("refused", `sources must be a list of: ${PART_SOURCE_IDS.join(", ")}`);
      wanted = PART_SOURCE_IDS.filter((id) => (opts.sources as unknown[]).includes(id));
    }
    const manufacturer = typeof opts.manufacturer === "string" && opts.manufacturer.trim() ? opts.manufacturer.trim().slice(0, 120) : undefined;
    const notes: string[] = [];
    const results: PartResult[] = [];
    const bySource = new Map<PartSourceId, PartResult[]>();
    const run = async (s: PartSource, extra: Partial<Parameters<PartSource["search"]>[1]> = {}): Promise<void> => {
      try {
        bySource.set(s.id, await s.search(q, { limit, ...(manufacturer ? { manufacturer } : {}), ...extra }));
      } catch (e) {
        notes.push(this.scrub(`${s.label}: ${e instanceof PartSourceError ? e.message.replace(new RegExp(`^${s.label}: `), "") : `failed (${e instanceof Error ? e.message : String(e)})`}`));
      }
    };
    const skipped = (s: PartSource): boolean => {
      if (s.configured()) return false;
      notes.push(`${s.label}: skipped — no key is set (Settings → Models → Part sources)`);
      return true;
    };
    // The catalogs first, side by side; one failing does not fail the others.
    await Promise.all([this.digikey, this.mouser].filter((s) => wanted.includes(s.id) && !skipped(s)).map((s) => run(s)));
    // In source order, whatever answered first.
    for (const id of ["digikey", "mouser"] as const) results.push(...(bySource.get(id) ?? []));
    // TraceParts looks up, per manufacturer, the part numbers the catalogs found (and the query, with a manufacturer).
    if (wanted.includes("traceparts") && !skipped(this.traceparts)) {
      const candidates = results.map((r) => ({ manufacturer: r.manufacturer, mpn: r.mpn }));
      if (!candidates.length && !manufacturer) notes.push("TraceParts: nothing to look up — it finds CAD models by manufacturer and part number; pass `manufacturer` with a part number as the query, or search a catalog source too");
      else await run(this.traceparts, { candidates });
      results.push(...(bySource.get("traceparts") ?? []));
    }
    this.remember(sessionId, results);
    return { results, notes };
  }

  private remember(sessionId: string, results: readonly PartResult[]): void {
    let m = this.returned.get(sessionId);
    if (!m) this.returned.set(sessionId, (m = new Map()));
    const add = (url: string | undefined, r: Remembered): void => {
      if (!url) return;
      m!.delete(url);
      m!.set(url, r);
    };
    for (const r of results) {
      add(r.datasheetUrl, { source: r.source, kind: "file" });
      for (const l of r.modelUrls ?? []) add(l.url, { source: r.source, kind: r.source === "traceparts" && this.traceparts.isModelRequestUrl(l.url) ? "traceparts-cad" : "file" });
    }
    while (m.size > MAX_REMEMBERED) m.delete(m.keys().next().value!);
  }

  forgetSession(sessionId: string): void {
    this.returned.delete(sessionId);
  }

  // ── parts_fetch ─────────────────────────────────────────────────────────────────────────────

  async fetch(session: { id: string; cwd: string }, url: unknown): Promise<PartsFetchOutcome> {
    if (typeof url !== "string" || !url.trim()) return { ok: false, error: "url must be a string" };
    let href: string;
    try {
      href = new URL(url.trim()).href;
    } catch {
      return { ok: false, error: "that is not a URL" };
    }
    const known = this.returned.get(session.id)?.get(href);
    // A TraceParts model link is this daemon's own description of a CAD request (never fetched as a
    // URL); every URL that IS fetched must be https — here, and again on every redirect.
    if (!href.startsWith("https://") && known?.kind !== "traceparts-cad") return { ok: false, error: "only https URLs are fetched" };
    if (!known) return { ok: false, error: "that URL was not returned by parts_search in this session; parts_fetch only downloads datasheet and model links from a parts_search result (use the browser for anything else)" };
    const max = this.deps.maxDownloadBytes ?? DOWNLOAD_MAX_BYTES;
    const worktree = session.cwd;
    // The staging folder must be a real folder of this worktree, never a link out of it.
    const outBad = outputDirProblem(worktree);
    if (outBad) return { ok: false, error: outBad };
    const outDir = join(worktree, OUTPUT_DIRNAME);
    const madeDir = !existsSync(outDir);
    try {
      const fileUrl = known.kind === "traceparts-cad" ? await this.traceparts.resolveModel(href) : href;
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      if (madeDir) ensureGitExcluded(worktree, `${OUTPUT_DIRNAME}/`);
      const got = await downloadPart(fileUrl, max, (name) => this.destFor(outDir, name), {
        resolver: this.deps.resolver ?? systemResolver,
        selfHosts: this.deps.selfHosts ?? ownHosts,
        fleetHosts: this.deps.fleetHosts ?? (() => []),
        ...(this.deps.dial ? { dial: this.deps.dial } : {}),
        ...(this.deps.ca ? { ca: this.deps.ca } : {}),
      });
      const outcome = quarantineFile(worktree, got.path, { maxBytes: max, exclude: (wt, entry) => void ensureGitExcluded(wt, entry) });
      if (!outcome) return { ok: false, error: "the downloaded file could not be put in quarantine" };
      if (outcome.deleted) return { ok: false, error: `the download was deleted: ${outcome.deleted}` };
      return { ok: true, ...outcome, source: known.source, from: got.finalUrl };
    } catch (e) {
      return { ok: false, error: this.scrub(e instanceof Error ? e.message : String(e)) };
    } finally {
      if (madeDir) {
        try {
          if (!readdirSync(outDir).length) rmdirSync(outDir);
        } catch {
          /* in use by the browser, or gone */
        }
      }
    }
  }

  /** Where a download named `name` is written before it is quarantined; refuses a type the quarantine would delete. */
  private destFor(outDir: string, name: string): string {
    const clean = sanitizeDownloadName(name);
    const ext = extname(clean).slice(1).toLowerCase();
    if (!DOWNLOAD_EXTENSIONS.includes(ext)) {
      throw new PartSourceError("refused", `${ext ? `.${ext} files are` : "a file with no extension is"} not allowed (allowed: ${DOWNLOAD_EXTENSIONS.join(", ")}); nothing was saved`);
    }
    let file = clean;
    for (let i = 1; existsSync(join(outDir, file)); i++) file = `${clean.slice(0, clean.length - ext.length - 1)}-${i}.${ext}`;
    return join(outDir, file);
  }
}
