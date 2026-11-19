/**
 * The browser's approval model (agent-cad-and-browser §4.12 "Per-site approval", §4.14 items 23–26
 * and 43, as hardened by the Phase C2 review): the kind gate `decide()` consults before every
 * `mcp__browser__*` call, and what the daemon learns from every result.
 *
 * Before a call, in this order:
 *   1. No network block running for this session → deny (fail closed).
 *   2. CLOSING (a refused page is still open) → only `browser_navigate` with the url written exactly
 *      `about:blank`, or `browser_close`, is allowed.
 *   3. Tool not in the closed table, `browser_run_code_unsafe`, `browser_evaluate`, or a `filename`
 *      argument that is absolute or has `..` → deny.
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

export interface BrowserSessionState {
  /** Sites answered "Allow once" (or allowed by `bypass`) in this session. */
  once: Set<string>;
  /** Sites the owner refused in this session. */
  denied: Set<string>;
  /** The current tab's address, as last established by a result. */
  currentUrl?: string;
  /** The current tab's address is NOT known: the last result that could have changed it did not say.
   *  `navigation`: a call that changes the page. `input`: an input-class call. */
  unknown?: "navigation" | "input";
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

    const st = this.state(ctx.session.id);
    // CLOSING comes first: only the way out is open.
    if (st.closing) return this.closingVerdict(ctx, st);

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
            : "the last action may have moved the page, and its result did not say where the page is. Call browser_snapshot first; no further action runs until then.",
      };
    }

    if (st.hold) {
      // The owner may have allowed the site in Settings since the hold began.
      if (st.hold.kind === "site" && (this.siteAllowed(st, st.hold.site) || this.isOwn(ctx.session.id, st.hold.url))) st.hold = undefined;
      else return this.holdVerdict(ctx, st, rt.mode);
    }

    if (plan.recordOnce) st.once.add(plan.recordOnce);
    return plan.verdict;
  };

  /** Whether this call is one that may run while the page's address is unknown: the calls whose
   *  result establishes it, the way out, and — after an input-class call only — any read. */
  private establishesPage(ctx: McpKindGateContext, unknown: "navigation" | "input"): boolean {
    if (ctx.tool === "browser_snapshot" || ctx.tool === "browser_close") return true;
    if (ctx.tool === "browser_tabs" && ctx.input.action === "list") return true;
    if (ctx.tool === "browser_navigate" && ctx.input.url === BLANK_URL) return true;
    if (unknown === "input") {
      const cls = classifyBrowserTool(ctx.tool, ctx.input);
      return "cls" in cls && cls.cls === "read";
    }
    return false;
  }

  /** Steps 3–5 and 8–10: the verdict for this call with no hold in the way. No side effects. */
  private plan(ctx: McpKindGateContext, st: BrowserSessionState, mode: BrowserMode): Plan {
    const cls = classifyBrowserTool(ctx.tool, ctx.input);
    if ("deny" in cls) return deny(cls.deny);
    const badName = filenameProblem(ctx.input);
    if (badName) return deny(`${ctx.tool}: ${badName}`);
    if (ctx.tool === "browser_run_code_unsafe") return deny("browser_run_code_unsafe is never allowed: it runs arbitrary code in the browser's server");

    const current = st.currentUrl ? checkUrl(st.currentUrl) : undefined;
    const currentSite = current?.ok && "site" in current ? current.site : undefined;
    // The session's own test daemon is never a logged-in site: the hard-stop policy sees a name
    // that is not a hostname in place of its site.
    const onOwn = this.isOwn(ctx.session.id, st.currentUrl);
    const shownSite = onOwn ? OWN_TEST_DAEMON_SITE : currentSite;
    const info: BrowserActionInfo = { ctx, cls: cls.cls, mode, ...(shownSite ? { currentSite: shownSite } : {}), ...(st.unknown ? { currentUnknown: true } : {}) };
    const session = ctx.session;

    if (cls.cls === "script") {
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
      return { purge: false };
    }

    st.unknown = undefined;
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
