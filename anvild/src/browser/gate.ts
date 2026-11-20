/**
 * The browser's approval model (agent-cad-and-browser §4.12 "Per-site approval", §4.14 items 23–26
 * and 43, as hardened by the Phase C2 review): the kind gate `decide()` consults before every
 * `mcp__browser__*` call, and what the daemon learns from every result.
 *
 * Before a call, in this order:
 *   1. No network block running for this session → deny (fail closed).
 *   2. CLOSING (a refused page is still open) → only `browser_navigate` with the url written exactly
 *      `about:blank`, or `browser_close`, is allowed.
 *   3. Tool not in the closed table, `browser_run_code_unsafe`, `browser_evaluate`, a `filename`
 *      argument that is absolute or has `..`, or any `filename` on `browser_take_screenshot` → deny.
 *   4. A navigation target that is not a plain `http:`/`https:` URL in its normal form (or exactly
 *      `about:blank`) → deny. The string that is checked is the string that is forwarded.
 *   5. `browser_navigate_back` after the owner refused a page in this browser → deny (the history
 *      holds that page). `browser_tabs select` of a tab known to be on a refused site → deny; of a tab
 *      known to be on a site not yet allowed → the site prompt, before the tab is shown.
 *   6. UNKNOWN (the last result did not say where the current tab is — see below) → only the calls
 *      that establish it are allowed.
 *   7. HOLD (the current tab is on a site that is not allowed, or the last result could not be
 *      trusted) → prompt, whatever the call is, under every policy.
 *   8. A navigation to a site not yet allowed → prompt "Allow once / Always allow <site> / Deny".
 *      Under `bypass` the prompt is skipped and the site counts as allowed for the session.
 *   9. An upload → always prompt, paths inside the worktree only.
 *  10. Everything else on an allowed site → allow (Phase C3 adds logged-in-site rules here).
 *
 * After a result (`readPage` in sites.ts): the CURRENT TAB's address comes from the server's own
 * `### Page` block or tab list — never from a tool whose result is page text, never from an error,
 * and never from a block in a place a page could have written. Then:
 *   - ambiguous → HOLD (ambiguous);
 *   - known → on a site that is not allowed: HOLD (that site), and the caller deletes the snapshot
 *     and screenshot files the result wrote; on a scheme that is not allowed, or a logged-in site in
 *     headless mode: CLOSING;
 *   - not known → after a call that changes which page is shown (`browser_navigate`,
 *     `browser_navigate_back`, `browser_tabs` new / select / close): UNKNOWN("navigation") — only
 *     `browser_snapshot` and `browser_tabs list` (and the way out) may run next, and their result
 *     sets the address. After an input-class call (click, key, type, fill, select, drag, dialog,
 *     drop, upload): UNKNOWN("input") — the page may have moved by itself, so read-class calls may
 *     run but no further input until a result says where the tab is.
 *   Residual, inherent to learning the address from results: when a page navigates by itself, the
 *   ONE call that reveals it (a read, or the input call that caused it) runs on the new site.
 *
 * What the browser contacted (C3 review, item 1). A page can move by itself — a timer setting
 * `location`, a meta refresh, `location.replace` — after the result that established it, and the
 * next input would then land on the new page unprompted. So the session's proxy records the site of
 * every connection its browser makes, in order (`hooks.trafficSince`), and before any input, upload,
 * script or navigation call the gate looks at what was contacted since the last result that said
 * where the page is. Any site that is (a) a locked logged-in site other than the page's own, or (b)
 * not allowed for this session (and not the page's own) makes the page UNKNOWN("traffic"): the call
 * is refused with "take a snapshot first", and the snapshot's result then applies the normal hold and
 * hard-stop rules. Accepted cost: a page that keeps loading things from other sites (ads, analytics,
 * a logged-in site's widget) forces a snapshot before most inputs. Residual: a connection Chrome
 * already holds open (HTTP/2 reuse of a socket opened before the last result) is not seen again.
 *
 * Embedded logged-in sites (C3 review, item 4): while any locked logged-in site has been contacted
 * since the navigation that led to the current page (a frame or widget from it on this page), input,
 * upload, script and housekeeping calls on that page are hard-stopped as if they were on that site,
 * naming it (`BrowserActionInfo.embeddedSites`). Reads and navigations are not.
 *
 * The session's own test daemon (C4 review, item 1) gets NO exemption from either rule: the agent
 * wrote that page itself, so it is the least trusted page there is. The only differences are that its
 * origin needs no site prompt, is never a logged-in site, and its own port is not in the traffic log;
 * everything else it contacts — another site it moves itself to, a frame it embeds — counts exactly as
 * on any other page (it has no "own site" whose traffic is ignored).
 *
 * A traffic log that overflowed (C4 review, item 2). The log is bounded; when entries since the
 * navigation to the current page were dropped, Anvil no longer knows what that page loaded. Then the
 * page is UNKNOWN for input (snapshot first, like any traffic since the last result), and after the
 * snapshot every input-like call on it is hard-stopped as "unknown embedded content"
 * (`TRAFFIC_LOST_SITE` in `embeddedSites`), naming that Anvil lost track, until a navigation to a page
 * whose log is complete.
 *
 * Time (C4 review, item 4). Chrome can reuse an HTTPS tunnel it already holds, so a page can move
 * itself to another page on a site it is already connected to without the proxy seeing anything new.
 * So an input, upload or script call needs a result that said where the page is (the server's own page
 * block — a snapshot's, or the previous call's) no more than `FRESH_PAGE_MS` (2 s) ago, and after the
 * last `browser_wait_for` (a wait whose result carries no page block makes the page unknown for input).
 * Otherwise the call is refused with "take a snapshot first". What remains: a page can still navigate
 * by itself over a reused tunnel between that result and the input, within those 2 s (or while an
 * owner's prompt for the call is open); the input's own result then reveals the new page, and the next
 * call is decided on it.
 *
 * `browser_close` is always allowed: it is the way out, in every state (C3 review, item 6).
 *
 * Deny. The daemon has no connection of its own to the browser, so it cannot navigate by itself, and
 * nothing here depends on the CLI applying a rewritten input. When the owner answers Deny on a hold
 * the held call is denied and the session is CLOSING until a result reports `about:blank` (or the
 * browser is closed). The refused site is remembered for the session: going back in history is
 * refused, and so is selecting a tab known to be on it. An unattended session, a page on a scheme
 * that is not allowed, and a logged-in site reached in headless mode go straight to CLOSING.
 *
 * Approvals: "Always allow" is written to the fleet's allowed-sites list (hub-synced, persistent);
 * "Allow once" is remembered for this session only, in memory, and dies with it.
 */
import type { PermissionSuggestion } from "@protocol";
import type { McpKindGateContext, McpKindVerdict, McpToolResult } from "../agent/mcp-gate";
import { isUnattended } from "../agent/protected";
import type { BrowserMode } from "./preset";
import { CHROME_ERROR_URL, checkNavigationInput, checkUrl, readPage, toolResultText, type TabEntry, type UrlVerdict } from "./sites";
import { classifyBrowserTool, filenameProblem, uploadPathProblem, uploadPaths, type BrowserToolClass } from "./tools";

export const BLANK_URL = "about:blank";
/** How recent the result that said where the page is must be for an input-like call (C4 review, item 4). */
export const FRESH_PAGE_MS = 2000;
/** What `trafficSince` reports when the bounded log no longer reaches back that far — and the name a
 *  hard stop shows for what the page may have embedded then. Not a hostname: never on any list. */
export const TRAFFIC_LOST_SITE = "(unknown embedded content: more connections than Anvil keeps track of)";

export interface BrowserSessionState {
  /** Sites answered "Allow once" (or allowed by `bypass`) in this session. */
  once: Set<string>;
  /** Sites the owner refused in this session. */
  denied: Set<string>;
  /** The current tab's address, as last established by a result. */
  currentUrl?: string;
  /** The current tab's address is NOT known: the last result that could have changed it did not say.
   *  `navigation`: a call that changes the page. `input`: an input-class call. `traffic`: the browser
   *  contacted something since. `wait`: a `browser_wait_for` whose result had no page block. */
  unknown?: "navigation" | "input" | "traffic" | "wait";
  /** When (the gate's clock) the last result that said where the page is was read. */
  establishedAt?: number;
  /** The proxy's traffic sequence when the last result established the page. */
  resultSeq?: number;
  /** The traffic sequence when the navigation that led to the current page began. */
  pageSeq?: number;
  /** The traffic sequence when the last navigation-class call was allowed. */
  navCallSeq?: number;
  /** The tabs as last listed by the server (only entries whose URL could be read with certainty). */
  tabs?: TabEntry[];
  /** The owner refused a page that this browser's history still holds: no going back. */
  backBlocked?: boolean;
  hold?: { kind: "site"; site: string; url: string } | { kind: "ambiguous" };
  /** CLOSING: the page must go to `about:blank` before anything else. */
  closing?: { reason: string };
}

/** What Phase C3 sees when it decides a call that Phase C2 would allow. */
export interface BrowserActionInfo {
  ctx: McpKindGateContext;
  cls: BrowserToolClass;
  /** The site of the page the session is on (undefined before the first page, or on `about:blank`). */
  currentSite?: string;
  /** True when the current tab's address is not known (see `BrowserSessionState.unknown`). Phase C3
   *  must then assume the worst (a locked logged-in site), never "not logged in". */
  currentUnknown?: boolean;
  /** For a navigation with a target: where it goes. */
  target?: { site: string; url: string };
  /** Locked logged-in sites the browser contacted since the navigation to the current page (a frame
   *  or widget from them on it). Input-like calls are hard-stopped as if on them. */
  embeddedSites?: string[];
  mode: BrowserMode;
}

/**
 * The seams later phases plug into. All optional; with none set the browser behaves as Phase C2
 * specifies. They are plain mutable fields on the service's `hooks` object.
 */
export interface BrowserGateHooks {
  /** PHASE C3 — the machine's logged-in sites (the owner's list plus sites logged into through
   *  "Open agent browser"). Phase C2 uses it for one rule only: in headless mode a navigation to a
   *  listed site is refused. */
  loggedInSites?: () => readonly string[];
  /** PHASE C3 — whether a logged-in site is unlocked (item 44). Not read by Phase C2; it is here so
   *  the unlock list has one place to live next to `loggedInSites`. */
  isUnlocked?: (site: string) => boolean;
  /** PHASE C3 — logged in and not unlocked (a damaged list counts every profile site; see loggedin.ts). */
  isLocked?: (site: string) => boolean;
  /**
   * PHASE C3 — per-action rules for logged-in sites (hard stops). Called for every call Phase C2 is
   * about to ALLOW (reads, inputs, housekeeping, and navigations whose site is allowed). Return a
   * verdict to replace the allow — typically `{ kind: "prompt", always: true, … }` for a click on a
   * locked logged-in site — or undefined to keep it.
   */
  actionPolicy?: (info: BrowserActionInfo) => McpKindVerdict;
  /** PHASE C4 — whether `browser_evaluate` may run: true only when the page is the session's own
   *  throwaway test daemon. Absent → `browser_evaluate` is always denied. */
  allowEvaluate?: (info: BrowserActionInfo) => boolean;
  /** PHASE C4 — the origin (`http://127.0.0.1:<port>`, exactly) of the session's own running test
   *  daemon. A page on it is the session's own: allowed without a site prompt, in every mode, and
   *  never treated as a logged-in site. Compared by ORIGIN, so no other loopback port is covered. */
  ownOrigin?: (sessionId: string) => string | undefined;
  /** C3 REVIEW — the session's proxy traffic: the current sequence number, and the sites (registrable
   *  domains) its browser contacted after sequence `seq`. Absent → no traffic rule. */
  trafficSeq?: (sessionId: string) => number;
  trafficSince?: (sessionId: string, seq: number) => string[];
}

/** What the hard-stop policy is shown in place of the site of the session's own test daemon: not a
 *  hostname, so it can never be on a logged-in list. */
export const OWN_TEST_DAEMON_SITE = "(this session's test daemon)";

export interface BrowserGateDeps {
  /** The fleet's allowed-sites list. */
  isSiteAllowed: (site: string) => boolean;
  /** Record "Always allow <site>" (persist, broadcast, send to the hub). */
  allowSiteAlways: (site: string, sessionId: string) => void;
  /** How this session's browser was started, and whether its proxy is accepting connections.
   *  Undefined when Anvil did not start a browser for the session. */
  runtime: (sessionId: string) => { mode: BrowserMode; proxyRunning: boolean } | undefined;
  hooks: BrowserGateHooks;
  /** Milliseconds, for the freshness rule (default `Date.now`; a test seam). */
  clock?: () => number;
}

const SITE_SUGGESTIONS = (site: string): PermissionSuggestion[] => [
  { decision: "allow", label: "Allow once" },
  { decision: "allow_always", label: `Always allow ${site}` },
  { decision: "deny", label: "Deny" },
];
const ONCE_SUGGESTIONS: PermissionSuggestion[] = [
  { decision: "allow", label: "Allow once" },
  { decision: "deny", label: "Deny" },
];

type Plan = { verdict: Exclude<McpKindVerdict, undefined>; recordOnce?: string };
const deny = (reason: string): Plan => ({ verdict: { kind: "deny", reason } });

export class BrowserGate {
  private readonly states = new Map<string, BrowserSessionState>();

  constructor(private readonly deps: BrowserGateDeps) {}

  state(sessionId: string): BrowserSessionState {
    let st = this.states.get(sessionId);
    if (!st) this.states.set(sessionId, (st = { once: new Set(), denied: new Set() }));
    return st;
  }

  /** The session ended, was reset, or its browser was torn down: its approvals and holds go. */
  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** The session's browser process is gone (driver rebuilt): the page is gone too, the approvals stay. */
  pageGone(sessionId: string): void {
    const st = this.states.get(sessionId);
    if (!st) return;
    this.resetPage(st);
  }

  private resetPage(st: BrowserSessionState): void {
    st.currentUrl = undefined;
    st.resultSeq = undefined;
    st.pageSeq = undefined;
    st.navCallSeq = undefined;
    st.establishedAt = undefined;
    st.hold = undefined;
    st.closing = undefined;
    st.unknown = undefined;
    st.tabs = undefined;
    st.backBlocked = undefined;
  }

  private siteAllowed(st: BrowserSessionState, site: string): boolean {
    return st.once.has(site) || this.deps.isSiteAllowed(site);
  }

  private loggedIn(site: string): boolean {
    return this.deps.hooks.loggedInSites?.().includes(site) ?? false;
  }

  /** Whether `url` is a page of the session's own running test daemon (Phase C4): same origin, exactly. */
  private isOwn(sessionId: string, url: string | undefined): boolean {
    const own = this.deps.hooks.ownOrigin?.(sessionId);
    if (!own || !url) return false;
    try {
      return new URL(url).origin === own;
    } catch {
      return false;
    }
  }

  /**
   * The session's test daemon was stopped (Phase C4). A page still showing it must be left before
   * anything else — no prompt for the owner: it was the session's own page, and it is gone.
   */
  ownOriginGone(sessionId: string, origin: string): void {
    const st = this.states.get(sessionId);
    if (!st?.currentUrl || st.closing) return;
    let on = false;
    try {
      on = new URL(st.currentUrl).origin === origin;
    } catch {
      on = false;
    }
    if (on) this.startClosing(st, "this session's test daemon was stopped, so the page that was showing it is dead");
  }

  // ── before a call ───────────────────────────────────────────────────────────────────────────

  /** The kind gate registered with `registerMcpKindGate("browser", …)`. */
  readonly gate = (ctx: McpKindGateContext): McpKindVerdict => {
    const rt = this.deps.runtime(ctx.session.id);
    if (!rt) return { kind: "deny", reason: "the browser was not started by Anvil for this session (switch it off and on again in the Tools menu)" };
    if (!rt.proxyRunning) return { kind: "deny", reason: "the browser's network block is not running, so the browser is not allowed to act (press Check in Settings → Integrations)" };

    // The way out is always open (C3 review, item 6).
    if (ctx.tool === "browser_close") return { kind: "allow", reason: "browser_close is always allowed" };

    const st = this.state(ctx.session.id);
    // CLOSING comes first: only the way out is open.
    if (st.closing) return this.closingVerdict(ctx, st);

    // The page may have moved by itself since the last result (C3 review, item 1).
    const moved = this.movedByItself(ctx, st);
    if (moved) {
      st.unknown = "traffic";
      return { kind: "deny", reason: `the page may have changed by itself: since the last result the browser contacted ${moved}. Call browser_snapshot first; no action runs until a snapshot says where the page is.` };
    }

    // The page may have moved over a connection Chrome already held (C4 review, item 4).
    const stale = this.staleForInput(ctx, st);
    if (stale) return { kind: "deny", reason: `${stale}, and the page may have changed by itself since. Call browser_snapshot first, then make this call again.` };

    // What the call would get on its own merits. A call that is refused anyway never costs a prompt.
    const plan = this.plan(ctx, st, rt.mode);
    if (plan.verdict.kind === "deny") return plan.verdict;

    // UNKNOWN: nothing acts on a page whose address the daemon does not know.
    if (st.unknown && !this.establishesPage(ctx, st.unknown)) {
      return {
        kind: "deny",
        reason:
          st.unknown === "navigation"
            ? "Anvil does not know which page the browser is showing after the last call. Call browser_snapshot (or browser_tabs with action \"list\") first; nothing else runs until then."
            : st.unknown === "wait"
              ? "the page may have changed while browser_wait_for waited, and its result did not say where the page is. Call browser_snapshot first; no further action runs until then."
              : "the last action may have moved the page, and its result did not say where the page is. Call browser_snapshot first; no further action runs until then.",
      };
    }

    if (st.hold) {
      // The owner may have allowed the site in Settings since the hold began.
      if (st.hold.kind === "site" && (this.siteAllowed(st, st.hold.site) || this.isOwn(ctx.session.id, st.hold.url))) st.hold = undefined;
      else return this.holdVerdict(ctx, st, rt.mode);
    }

    if (plan.recordOnce) st.once.add(plan.recordOnce);
    this.noteNavigationCall(ctx, st, plan.verdict);
    return plan.verdict;
  };

  private trafficSince(sessionId: string, seq: number | undefined): string[] {
    return this.deps.hooks.trafficSince?.(sessionId, seq ?? 0) ?? [];
  }

  private isLocked(site: string): boolean {
    if (this.deps.hooks.isLocked) return this.deps.hooks.isLocked(site);
    return this.loggedIn(site) && this.deps.hooks.isUnlocked?.(site) !== true;
  }

  private currentSite(st: BrowserSessionState): string | undefined {
    const current = st.currentUrl ? checkUrl(st.currentUrl) : undefined;
    return current?.ok && "site" in current ? current.site : undefined;
  }

  /**
   * Before an input, upload, script or navigation call: the sites contacted since the last result
   * that make the page's address untrustworthy (see the file comment), as text, or undefined.
   */
  private movedByItself(ctx: McpKindGateContext, st: BrowserSessionState): string | undefined {
    if (!this.deps.hooks.trafficSince || st.currentUrl === undefined || st.resultSeq === undefined) return undefined;
    if (ctx.tool === "browser_navigate" && ctx.input.url === BLANK_URL) return undefined; // the way out
    const cls = classifyBrowserTool(ctx.tool, ctx.input);
    if (!("cls" in cls) || cls.cls === "read") return undefined;
    // The session's own test daemon has no exemption (C4 review, item 1): only its own port is
    // left out of the log, and it has no "own site" whose traffic is ignored.
    const here = this.pageOwnSite(ctx.session.id, st);
    const bad = this.trafficSince(ctx.session.id, st.resultSeq).filter((s) => s === TRAFFIC_LOST_SITE || (s !== here && (this.isLocked(s) || !this.siteAllowed(st, s))));
    if (!bad.length) return undefined;
    return bad
      .slice(0, 4)
      .map((s) => (s === TRAFFIC_LOST_SITE ? "more connections than Anvil keeps track of (it lost track of what the page loaded)" : this.isLocked(s) ? `${s} (a locked logged-in site)` : `${s} (not allowed in this session)`))
      .join(", ");
  }

  /** The site whose traffic belongs to the page itself: the current page's site — none for the
   *  session's own test daemon, whose own port never reaches the log. */
  private pageOwnSite(sessionId: string, st: BrowserSessionState): string | undefined {
    return this.isOwn(sessionId, st.currentUrl) ? undefined : this.currentSite(st);
  }

  /**
   * Before an input, upload or script call (C4 review, item 4): why the last word on where the page
   * is is too old to act on, or undefined. Needs a result with the server's page block no more than
   * `FRESH_PAGE_MS` ago (a wait with no page block already made the page unknown).
   */
  private staleForInput(ctx: McpKindGateContext, st: BrowserSessionState): string | undefined {
    if (st.currentUrl === undefined || st.unknown) return undefined; // no page yet, or already unknown
    const cls = classifyBrowserTool(ctx.tool, ctx.input);
    if (!("cls" in cls) || (cls.cls !== "input" && cls.cls !== "upload" && cls.cls !== "script")) return undefined;
    const now = (this.deps.clock ?? Date.now)();
    if (st.establishedAt !== undefined && now - st.establishedAt <= FRESH_PAGE_MS && now >= st.establishedAt) return undefined;
    const ago = st.establishedAt === undefined ? undefined : Math.round((now - st.establishedAt) / 100) / 10;
    return `the last result that said where the page is is ${ago === undefined ? "missing" : `${ago} s old`} (an action needs one from the last ${FRESH_PAGE_MS / 1000} s)`;
  }

  /** An allowed navigation-class call: the traffic from here on belongs to the page it leads to. */
  private noteNavigationCall(ctx: McpKindGateContext, st: BrowserSessionState, verdict: McpKindVerdict): void {
    if (verdict?.kind !== "allow" || !this.deps.hooks.trafficSeq) return;
    const cls = classifyBrowserTool(ctx.tool, ctx.input);
    if ("cls" in cls && cls.cls === "navigation") st.navCallSeq = this.deps.hooks.trafficSeq(ctx.session.id);
  }

  /** Whether this call is one that may run while the page's address is unknown: the calls whose
   *  result establishes it, the way out, and — after an input-class call only — any read. */
  private establishesPage(ctx: McpKindGateContext, unknown: NonNullable<BrowserSessionState["unknown"]>): boolean {
    if (ctx.tool === "browser_snapshot" || ctx.tool === "browser_close") return true;
    if (ctx.tool === "browser_tabs" && ctx.input.action === "list") return true;
    if (ctx.tool === "browser_navigate" && ctx.input.url === BLANK_URL) return true;
    if (unknown === "input" || unknown === "traffic" || unknown === "wait") {
      const cls = classifyBrowserTool(ctx.tool, ctx.input);
      return "cls" in cls && cls.cls === "read";
    }
    return false;
  }

  /** Steps 3–5 and 8–10: the verdict for this call with no hold in the way. No side effects. */
  private plan(ctx: McpKindGateContext, st: BrowserSessionState, mode: BrowserMode): Plan {
    const cls = classifyBrowserTool(ctx.tool, ctx.input);
    if ("deny" in cls) return deny(cls.deny);
    // A screenshot is only ever returned inline (C4 review, item 3): a file the agent could replace is
    // never what a hard-stop card shows, so the screenshot tool is not asked to write one.
    if (ctx.tool === "browser_take_screenshot" && ctx.input.filename !== undefined) return deny("browser_take_screenshot may not save to a file: call it without filename (the screenshot is returned to you inline)");
    const badName = filenameProblem(ctx.input);
    if (badName) return deny(`${ctx.tool}: ${badName}`);
    if (ctx.tool === "browser_run_code_unsafe") return deny("browser_run_code_unsafe is never allowed: it runs arbitrary code in the browser's server");

    const current = st.currentUrl ? checkUrl(st.currentUrl) : undefined;
    const currentSite = current?.ok && "site" in current ? current.site : undefined;
    // The session's own test daemon is never a logged-in site: the hard-stop policy sees a name
    // that is not a hostname in place of its site.
    const onOwn = this.isOwn(ctx.session.id, st.currentUrl);
    const shownSite = onOwn ? OWN_TEST_DAEMON_SITE : currentSite;
    // Locked logged-in sites this page has loaded something from (a frame, a widget): input-like calls
    // are hard-stopped as if on them — on the session's own test daemon too (C4 review, item 1). When
    // the log lost entries since the navigation here, what the page loaded is unknown (item 2).
    const here = onOwn ? undefined : currentSite;
    const embedded = cls.cls === "read" || cls.cls === "navigation" ? [] : this.trafficSince(ctx.session.id, st.pageSeq).filter((s) => s === TRAFFIC_LOST_SITE || (s !== here && this.isLocked(s)));
    const info: BrowserActionInfo = { ctx, cls: cls.cls, mode, ...(shownSite ? { currentSite: shownSite } : {}), ...(st.unknown ? { currentUnknown: true } : {}), ...(embedded.length ? { embeddedSites: embedded } : {}) };
    const session = ctx.session;

    if (cls.cls === "script") {
      // A script can reach into a frame (`ref` in it): never with a locked site's frame on the page.
      if (embedded.length) return deny(`browser_evaluate is not allowed on a page that has loaded ${embedded.slice(0, 3).join(", ")}${embedded.includes(TRAFFIC_LOST_SITE) ? "" : " (a locked logged-in site)"}`);
      if (this.deps.hooks.allowEvaluate?.(info) === true) return { verdict: { kind: "allow", reason: "script evaluation on the session's own test daemon" } };
      return deny("browser_evaluate is only allowed on this session's own throwaway test daemon");
    }

    if (cls.cls === "upload") {
      const paths = uploadPaths(ctx.input);
      if (!paths) return deny(`${ctx.tool}: paths must be a non-empty list of file paths`);
      for (const p of paths) {
        const bad = uploadPathProblem(p, ctx.cwd);
        if (bad) return deny(`${ctx.tool}: ${bad}`);
      }
      const where = currentSite ?? "the page";
      return {
        verdict: {
          kind: "prompt",
          reason: `upload ${paths.length === 1 ? paths[0] : `${paths.length} files`} to ${where}`,
          suggestions: ONCE_SUGGESTIONS, // an upload is asked every time: there is no "always"
          always: true,
          denyWhenUnattended: true,
        },
      };
    }

    // Going back after the owner refused a page: the history holds that page.
    if (ctx.tool === "browser_navigate_back" && st.backBlocked) {
      return deny("going back is not allowed after the owner refused a page in this browser (the history holds it); open the page you want with browser_navigate");
    }

    // A navigation that names where it goes: browser_navigate {url}, browser_tabs {action:"new", url}
    // — and browser_tabs {action:"select"} of a tab whose address the server listed.
    const hasTarget = ctx.tool === "browser_navigate" || (ctx.tool === "browser_tabs" && ctx.input.action === "new" && ctx.input.url !== undefined);
    const selected = ctx.tool === "browser_tabs" && ctx.input.action === "select" ? st.tabs?.find((t) => t.index === ctx.input.index)?.url : undefined;
    if (hasTarget || selected !== undefined) {
      // A URL the model wrote is forwarded as written, so it is held to its normal form; a tab's
      // address came from the server and is only read.
      const target: UrlVerdict = hasTarget ? checkNavigationInput(ctx.input.url) : selected === CHROME_ERROR_URL ? { ok: true, blank: true } : checkUrl(selected);
      if (!target.ok) return deny(hasTarget ? target.reason : `that tab is on an address that is not allowed (${target.reason})`);
      if ("blank" in target) return { verdict: { kind: "allow", reason: "about:blank" } };
      const { site, url } = target;
      // The session's own test daemon: no site prompt, in every mode; leaving a logged-in site for it
      // is still the hard-stop policy's call.
      if (this.isOwn(session.id, url)) return this.afterC3({ ...info, target: { site: OWN_TEST_DAEMON_SITE, url } }, { verdict: { kind: "allow", reason: "this session's own test daemon" } });
      if (!hasTarget && st.denied.has(site) && !this.siteAllowed(st, site)) return deny(`that tab is on ${site}, which the owner refused in this session`);
      if (mode === "headless" && this.loggedIn(site)) {
        return deny(`${site} is a logged-in site, and this machine's agent browser is running headless with a throwaway profile; it can only be opened in the headed browser, at the desk`);
      }
      if (!this.siteAllowed(st, site)) {
        if (isUnattended(session)) return deny(`${site} is not an allowed site (denied: this session is unattended; add it in Settings → Integrations)`);
        // `bypass` skips the site prompt; the site then counts as allowed for this session.
        if (session.data.autonomy === "bypass") return this.afterC3({ ...info, target: { site, url } }, { verdict: { kind: "allow", reason: `bypass: ${site} allowed for this session` }, recordOnce: site });
        return {
          verdict: {
            kind: "prompt",
            reason: `open ${site} in the agent browser`,
            suggestions: SITE_SUGGESTIONS(site),
            denyWhenUnattended: true,
            onAnswer: (decision) => this.recordApproval(st, site, decision, session.id),
            onDeny: () => void st.denied.add(site),
          },
        };
      }
      return this.afterC3({ ...info, target: { site, url } }, { verdict: { kind: "allow", reason: `${site} is an allowed site` } });
    }

    // Reads, inputs, housekeeping, and navigations with no target of their own (back, tab select or
    // close, a new empty tab). Where they lead is checked on the result.
    return this.afterC3(info, { verdict: { kind: "allow", reason: onOwn ? "this session's own test daemon" : currentSite ? `${currentSite} is an allowed site` : "no page is open on a site yet" } });
  }

  /** PHASE C3 HOOK: logged-in-site rules replace an allow here (see `BrowserGateHooks.actionPolicy`). */
  private afterC3(info: BrowserActionInfo, allowed: Plan): Plan {
    const override = this.deps.hooks.actionPolicy?.(info);
    return override ? { verdict: override } : allowed;
  }

  private recordApproval(st: BrowserSessionState, site: string, decision: string, sessionId: string): void {
    st.denied.delete(site); // the owner changed their mind
    if (decision === "allow_always") this.deps.allowSiteAlways(site, sessionId);
    else st.once.add(site);
  }

  private closingVerdict(ctx: McpKindGateContext, st: BrowserSessionState): McpKindVerdict {
    const why = st.closing!.reason;
    // The call itself must already be the way out. Nothing is rewritten: the gate does not rely on
    // the CLI applying a replacement input.
    if (ctx.tool === "browser_navigate" && ctx.input.url === BLANK_URL) return { kind: "allow", reason: `${why}: the page is sent to about:blank` };
    if (ctx.tool === "browser_close") return { kind: "allow", reason: `${why}: the browser is closed` };
    return { kind: "deny", reason: `${why}. The page must be left before anything else: call browser_navigate with the url written exactly "about:blank", or browser_close. Nothing else runs until then.` };
  }

  private startClosing(st: BrowserSessionState, reason: string): void {
    st.hold = undefined;
    st.closing = { reason };
  }

  private holdVerdict(ctx: McpKindGateContext, st: BrowserSessionState, mode: BrowserMode): McpKindVerdict {
    const hold = st.hold!;
    const what = hold.kind === "site" ? `the page moved to ${hold.site}, which is not an allowed site` : "the last result described more than one page, so the page's address cannot be trusted";
    const refused = hold.kind === "site" ? `the owner did not allow ${hold.site}` : "the owner did not let the browser continue";

    if (isUnattended(ctx.session)) {
      this.startClosing(st, `${what} (this session is unattended, so nobody can allow it)`);
      return this.closingVerdict(ctx, st);
    }
    return {
      kind: "prompt",
      reason: hold.kind === "site" ? `${what} (${hold.url.slice(0, 200)})` : what,
      suggestions: hold.kind === "site" ? SITE_SUGGESTIONS(hold.site) : ONCE_SUGGESTIONS,
      always: true, // a hold is asked under every policy, `bypass` included
      denyWhenUnattended: true,
      onAnswer: (decision) => {
        if (hold.kind === "site") this.recordApproval(st, hold.site, decision, ctx.session.id);
        st.hold = undefined;
        // The hold is cleared; the held call still has to pass on its own.
        const plan = this.plan(ctx, st, mode);
        if (plan.verdict.kind === "deny") return { deny: plan.verdict.reason };
        if (plan.verdict.kind === "prompt") return { deny: `${hold.kind === "site" ? `${hold.site} is now allowed` : "the browser may continue"}, but this call needs its own approval (${plan.verdict.reason}): call it again` };
        if (plan.recordOnce) st.once.add(plan.recordOnce);
        return undefined;
      },
      onDeny: () => {
        if (hold.kind === "site") st.denied.add(hold.site);
        st.backBlocked = true; // the refused page is in this browser's history
        this.startClosing(st, refused);
        // The held call is refused even when it is itself the way out: it was asked about the page.
        const v = this.closingVerdict({ ...ctx, tool: "", input: {} }, st);
        return { deny: v?.kind === "deny" ? v.reason : refused };
      },
    };
  }

  // ── after a result ──────────────────────────────────────────────────────────────────────────

  /**
   * The kind result hook: read where the current tab is now and decide whether the next call is
   * held. Returns `purge: true` when the result showed a page the session may not see yet (a site
   * that is not allowed, or a refused address): the caller deletes the files that result wrote.
   */
  onResult(sessionId: string, result: McpToolResult, mode: BrowserMode = "headed"): { purge: boolean } {
    const st = this.state(sessionId);
    if (result.tool === "browser_close" && !result.isError) {
      this.resetPage(st);
      return { purge: false };
    }
    const reading = readPage(result.tool, toolResultText(result.content), result.isError);
    const cls = classifyBrowserTool(result.tool, result.input);
    const changesPage = result.tool === "browser_navigate" || result.tool === "browser_navigate_back" || (result.tool === "browser_tabs" && result.input.action !== "list");
    if (reading.kind === "ambiguous") {
      if (!st.closing) st.hold = { kind: "ambiguous" };
      return { purge: false };
    }
    if (reading.tabs) st.tabs = reading.tabs;
    else if (changesPage) st.tabs = undefined; // the list we had may no longer be true
    if (reading.kind === "none") {
      if (changesPage) st.unknown = "navigation";
      else if ("cls" in cls && (cls.cls === "input" || cls.cls === "upload" || cls.cls === "script")) st.unknown ??= "input";
      else if (result.tool === "browser_wait_for") st.unknown ??= "wait"; // time passed with the page live
      return { purge: false };
    }

    st.unknown = undefined;
    st.establishedAt = (this.deps.clock ?? Date.now)();
    // The traffic so far is accounted for by this result; traffic before the navigation that led here
    // belongs to an earlier page.
    const seq = this.deps.hooks.trafficSeq?.(sessionId);
    if (seq !== undefined) {
      if (st.currentUrl !== reading.url || st.pageSeq === undefined) st.pageSeq = changesPage ? (st.navCallSeq ?? st.resultSeq ?? 0) : (st.resultSeq ?? 0);
      st.resultSeq = seq;
    }
    st.currentUrl = reading.url;
    const where: UrlVerdict = reading.url === CHROME_ERROR_URL ? { ok: true, blank: true } : checkUrl(reading.url);
    if (where.ok && "blank" in where) {
      st.hold = undefined;
      if (reading.url !== CHROME_ERROR_URL) st.closing = undefined; // only about:blank ends CLOSING
      return { purge: false };
    }
    if (st.closing) return { purge: true }; // still has to leave
    if (!where.ok) {
      this.startClosing(st, `the page moved to an address that is not allowed (${where.reason})`);
      return { purge: true };
    }
    const own = this.isOwn(sessionId, where.url);
    if (!own && mode === "headless" && this.loggedIn(where.site)) {
      this.startClosing(st, `the page moved to ${where.site}, a logged-in site that the headless browser may not open`);
      return { purge: true };
    }
    if (own || this.siteAllowed(st, where.site)) {
      if (st.hold?.kind === "site") st.hold = undefined;
      return { purge: false };
    }
    st.hold = { kind: "site", site: where.site, url: where.url };
    return { purge: true };
  }
}
