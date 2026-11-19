/**
 * The browser's approval model (agent-cad-and-browser §4.12 "Per-site approval", §4.14 items 23–26
 * and 43): the kind gate `decide()` consults before every `mcp__browser__*` call, and what the daemon
 * learns from every result.
 *
 * Before a call, in this order:
 *   1. No network block running for this session → deny (fail closed).
 *   2. Tool not in the closed table, `browser_run_code_unsafe`, `browser_evaluate`, or a `filename`
 *      argument that is absolute or has `..` → deny.
 *   3. A navigation target that is not `http:`/`https:` (or `about:blank`) → deny.
 *   4. The session is CLOSING a refused page (see below) → only the way out is allowed. (Checked
 *      first: in that state a `browser_navigate` is rewritten, so its own target does not matter.)
 *   5. The session is on HOLD (the last result put the page somewhere not allowed) → prompt for that
 *      site, whatever the call is, under every policy.
 *   6. A navigation to a site not yet allowed → prompt "Allow once / Always allow <site> / Deny".
 *      Under `bypass` the prompt is skipped and the site counts as allowed for the session.
 *   7. An upload → always prompt, paths inside the worktree only.
 *   8. Everything else on an allowed site → allow (Phase C3 adds logged-in-site rules here).
 *
 * After a result: the `- Page URL:` line under `### Page` is the page's address (absent = unchanged).
 * More than one `### Page` block, or a page on a site that is not allowed, puts the session on HOLD.
 *
 * HOLD and `about:blank`. The daemon has no connection of its own to the Playwright server (it is a
 * child of the Claude CLI), so it cannot navigate by itself. When the owner answers Deny on a hold:
 *   - if the held call is `browser_navigate`, the gate ALLOWS it with its input replaced by
 *     `{ url: "about:blank" }` — the navigation to `about:blank` happens right then;
 *   - otherwise the held call is denied and the session is CLOSING: every browser call is denied
 *     except `browser_navigate` (whose input is replaced the same way, whatever URL the model sent)
 *     and `browser_close`. The page can be neither read nor acted on until a result reports
 *     `about:blank` (or the browser closed), which ends CLOSING.
 * An unattended session, a page on a scheme that is not allowed, and a logged-in site reached in
 * headless mode go straight to CLOSING with no prompt.
 *
 * Approvals: "Always allow" is written to the fleet's allowed-sites list (hub-synced, persistent);
 * "Allow once" is remembered for this session only, in memory, and dies with it.
 */
import type { PermissionSuggestion } from "@protocol";
import type { McpKindGateContext, McpKindVerdict, McpToolResult } from "../agent/mcp-gate";
import { isUnattended } from "../agent/protected";
import type { BrowserMode } from "./preset";
import { checkUrl, parsePageReport, toolResultText } from "./sites";
import { classifyBrowserTool, filenameProblem, uploadPathProblem, uploadPaths, type BrowserToolClass } from "./tools";

export const BLANK_INPUT = { url: "about:blank" } as const;

export interface BrowserSessionState {
  /** Sites answered "Allow once" (or allowed by `bypass`) in this session. */
  once: Set<string>;
  /** The last page URL a result reported. */
  currentUrl?: string;
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
}

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
    if (!st) this.states.set(sessionId, (st = { once: new Set() }));
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
    st.currentUrl = undefined;
    st.hold = undefined;
    st.closing = undefined;
  }

  private siteAllowed(st: BrowserSessionState, site: string): boolean {
    return st.once.has(site) || this.deps.isSiteAllowed(site);
  }

  private loggedIn(site: string): boolean {
    return this.deps.hooks.loggedInSites?.().includes(site) ?? false;
  }

  // ── before a call ───────────────────────────────────────────────────────────────────────────

  /** The kind gate registered with `registerMcpKindGate("browser", …)`. */
  readonly gate = (ctx: McpKindGateContext): McpKindVerdict => {
    const rt = this.deps.runtime(ctx.session.id);
    if (!rt) return { kind: "deny", reason: "the browser was not started by Anvil for this session (switch it off and on again in the Tools menu)" };
    if (!rt.proxyRunning) return { kind: "deny", reason: "the browser's network block is not running, so the browser is not allowed to act (press Check in Settings → Integrations)" };

    const st = this.state(ctx.session.id);
    // CLOSING comes first: the only calls it lets through have their input replaced or take none.
    if (st.closing) return this.closingVerdict(ctx, st);

    // What the call would get on its own merits. A call that is refused anyway never costs a prompt.
    const plan = this.plan(ctx, st, rt.mode);
    if (plan.verdict.kind === "deny") return plan.verdict;

    if (st.hold) {
      // The owner may have allowed the site in Settings since the hold began.
      if (st.hold.kind === "site" && this.siteAllowed(st, st.hold.site)) st.hold = undefined;
      else return this.holdVerdict(ctx, st, rt.mode);
    }

    if (plan.recordOnce) st.once.add(plan.recordOnce);
    return plan.verdict;
  };

  /** Steps 2, 3 and 6–8: the verdict for this call with no hold in the way. No side effects. */
  private plan(ctx: McpKindGateContext, st: BrowserSessionState, mode: BrowserMode): Plan {
    const cls = classifyBrowserTool(ctx.tool, ctx.input);
    if ("deny" in cls) return deny(cls.deny);
    const badName = filenameProblem(ctx.input);
    if (badName) return deny(`${ctx.tool}: ${badName}`);
    if (ctx.tool === "browser_run_code_unsafe") return deny("browser_run_code_unsafe is never allowed: it runs arbitrary code in the browser's server");

    const current = st.currentUrl ? checkUrl(st.currentUrl) : undefined;
    const currentSite = current?.ok && "site" in current ? current.site : undefined;
    const info: BrowserActionInfo = { ctx, cls: cls.cls, mode, ...(currentSite ? { currentSite } : {}) };
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

    // A navigation that names where it goes: browser_navigate {url}, browser_tabs {action:"new", url}.
    const hasTarget = ctx.tool === "browser_navigate" || (ctx.tool === "browser_tabs" && ctx.input.action === "new" && ctx.input.url !== undefined);
    if (hasTarget) {
      const target = checkUrl(ctx.input.url);
      if (!target.ok) return deny(target.reason);
      if ("blank" in target) return { verdict: { kind: "allow", reason: "about:blank" } };
      const { site, url } = target;
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
          },
        };
      }
      return this.afterC3({ ...info, target: { site, url } }, { verdict: { kind: "allow", reason: `${site} is an allowed site` } });
    }

    // Reads, inputs, housekeeping, and navigations with no target of their own (back, tab select or
    // close, a new empty tab). Where they lead is checked on the result.
    return this.afterC3(info, { verdict: { kind: "allow", reason: currentSite ? `${currentSite} is an allowed site` : "no page is open on a site yet" } });
  }

  /** PHASE C3 HOOK: logged-in-site rules replace an allow here (see `BrowserGateHooks.actionPolicy`). */
  private afterC3(info: BrowserActionInfo, allowed: Plan): Plan {
    const override = this.deps.hooks.actionPolicy?.(info);
    return override ? { verdict: override } : allowed;
  }

  private recordApproval(st: BrowserSessionState, site: string, decision: string, sessionId: string): void {
    if (decision === "allow_always") this.deps.allowSiteAlways(site, sessionId);
    else st.once.add(site);
  }

  private closingVerdict(ctx: McpKindGateContext, st: BrowserSessionState): McpKindVerdict {
    const why = st.closing!.reason;
    if (ctx.tool === "browser_navigate") return { kind: "allow", reason: `${why}: the page is sent to about:blank`, updatedInput: { ...BLANK_INPUT } };
    if (ctx.tool === "browser_close") return { kind: "allow", reason: `${why}: the browser is closed` };
    return { kind: "deny", reason: `${why}. The page must be left before anything else: call browser_navigate (it will open about:blank, whatever url you pass) or browser_close.` };
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
        this.startClosing(st, refused);
        const v = this.closingVerdict(ctx, st);
        if (v?.kind === "allow" && v.updatedInput) return { allow: { updatedInput: v.updatedInput, reason: v.reason } };
        return { deny: v?.kind === "deny" ? v.reason : refused };
      },
    };
  }

  // ── after a result ──────────────────────────────────────────────────────────────────────────

  /** The kind result hook: read where the page is now and decide whether the next call is held. */
  onResult(sessionId: string, result: McpToolResult, mode: BrowserMode = "headed"): void {
    const st = this.state(sessionId);
    if (result.tool === "browser_close" && !result.isError) {
      st.currentUrl = undefined;
      st.hold = undefined;
      st.closing = undefined;
      return;
    }
    const report = parsePageReport(toolResultText(result.content));
    if (report.blocks > 1) {
      if (!st.closing) st.hold = { kind: "ambiguous" };
      return;
    }
    if (!report.url) return; // no page block: the address is unchanged
    st.currentUrl = report.url;
    const where = checkUrl(report.url);
    if (where.ok && "blank" in where) {
      st.hold = undefined;
      st.closing = undefined;
      return;
    }
    if (st.closing) return; // still has to leave
    if (!where.ok) return this.startClosing(st, `the page moved to an address that is not allowed (${where.reason})`);
    if (mode === "headless" && this.loggedIn(where.site)) return this.startClosing(st, `the page moved to ${where.site}, a logged-in site that the headless browser may not open`);
    if (this.siteAllowed(st, where.site)) {
      if (st.hold?.kind === "site") st.hold = undefined;
      return;
    }
    st.hold = { kind: "site", site: where.site, url: where.url };
  }
}
