/**
 * Hard stops on logged-in sites (agent-cad-and-browser §4.12 "Hard stops", §4.14 items 27 and 44).
 * Plugged into the browser gate as `hooks.actionPolicy`, so it sees every call Phase C2 would allow.
 *
 * It is an ALLOW list, because "is this click a submit?" cannot be decided from what the model says
 * it is clicking. On a LOCKED logged-in site — the site of the page the session is on, or the site a
 * navigation goes to — only these run without a prompt:
 *
 *   - read-class tools (snapshot, screenshot, wait, console, network, find, tab listing);
 *   - `browser_press_key` with exactly `PageDown`, `PageUp`, `Home` or `End` (scrolling: there is no
 *     scroll tool);
 *   - a navigation tool call to an `https:` URL on that same site.
 *
 * Everything else asks: "Allow once" / "Unlock <site>" / "Deny", under every policy including
 * `bypass`, with a screenshot of the page on the card. There is no "always allow". "Unlock <site>"
 * sets the site's unlock switch for the whole fleet (item 44) and lets the call through; from then on
 * nothing on that site asks. An unattended session is denied without a card; a card nobody answers is
 * denied when its time runs out.
 *
 * The decision reads ONLY the tool's class (from the closed table), the key of a key press, the
 * target URL of a navigation, and the page site the DAEMON tracked from tool results. It never reads
 * `element`, `text` or any other description the model wrote.
 *
 * The screenshot. The daemon has no connection of its own to the browser, so the picture is the
 * session's most recent `browser_take_screenshot` result, and it must be CURRENT: taken after the last
 * call that could have changed the page, with the page still at the same address. When there is none
 * the call is denied with an instruction to take one first (a screenshot is a read, so it never asks).
 */
import type { PermissionSuggestion, ToolResultImage } from "@protocol";
import type { McpKindVerdict } from "../agent/mcp-gate";
import { isUnattended } from "../agent/protected";
import { PROFILE_UNKNOWN_SITE, TRAFFIC_LOST_SITE, isMarkerSite, type BrowserActionInfo } from "./gate";

/** The keys that count as scrolling (item 27). Compared exactly: `pagedown`, `Shift+End`, ` End` ask. */
export const SCROLL_KEYS: readonly string[] = ["PageDown", "PageUp", "Home", "End"];

/** A hard-stop card nobody answers is denied after this long (under the CLI's own one-hour hook limit,
 *  so the daemon's denial and its retired card come first). */
export const HARD_STOP_TIMEOUT_MS = 50 * 60_000;

export const HARD_STOP_LABELS = (site: string): [string, string, string] => ["Allow once", `Unlock ${site}`, "Deny"];

const suggestions = (site: string): PermissionSuggestion[] => {
  const [once, unlock, no] = HARD_STOP_LABELS(site);
  // Unknown embedded content (C4 review, item 2) is not a site: there is nothing to unlock.
  if (isMarkerSite(site)) return [{ decision: "allow", label: once }, { decision: "deny", label: no }];
  return [
    { decision: "allow", label: once },
    // `allow_always` on the wire (no new decision value, so every client can send it); on THIS card
    // it means "unlock the site", and it is labelled as that.
    { decision: "allow_always", label: unlock },
    { decision: "deny", label: no },
  ];
};

export interface HardStopDeps {
  /** Whether `site` is a logged-in site that is not unlocked. Looked up live on every call. */
  isLocked: (site: string) => boolean;
  /** Set the site's unlock switch, fleet-wide ("Unlock <site>" on the card). */
  unlock: (site: string, sessionId: string) => void;
  /** The session's current page screenshot as a card image, or undefined when it has none. */
  screenshot: (sessionId: string) => ToolResultImage | undefined;
  timeoutMs?: number;
}

/** Whether this call is on the allow list for a page on locked site `site`. */
export function runsWithoutPrompt(info: BrowserActionInfo, site: string): boolean {
  if (info.cls === "read") return true;
  const { tool, input } = info.ctx;
  if (tool === "browser_press_key") return typeof input.key === "string" && SCROLL_KEYS.includes(input.key);
  if (info.cls === "navigation" && info.target) {
    let https = false;
    try {
      https = new URL(info.target.url).protocol === "https:";
    } catch {
      https = false;
    }
    return https && info.target.site === site;
  }
  return false;
}

/** What the card says the call does — built from the tool name and tracked facts only. */
function describe(info: BrowserActionInfo, site: string): string {
  const tool = info.ctx.tool.replace(/^browser_/, "").replace(/_/g, " ");
  if (site === TRAFFIC_LOST_SITE) return `${tool} on ${info.currentSite ?? "a page"} whose embedded content is unknown: the page made more connections than Anvil keeps track of, so Anvil lost track of what it loaded (a frame from a logged-in site may be on it)`;
  if (site === PROFILE_UNKNOWN_SITE) return `${tool} on ${info.currentSite ?? "a page"} in the headed agent browser: the logged-in sites list is damaged and the agent profile could not be read, so any site may be logged in (a page or frame of one can load from the profile with no network traffic)`;
  if (info.profileSites?.includes(site) && site !== info.currentSite && site !== info.target?.site) return `${tool} on ${info.currentSite ?? "a page"} in the headed agent browser, whose profile holds ${site}, a logged-in site: a frame of it can load from the profile with no network traffic, so Anvil cannot tell whether it is on the page`;
  if (site !== info.currentSite && site !== info.target?.site) return `${tool} on ${info.currentSite ?? "a page"} that has loaded ${site}, a logged-in site (a frame or widget from it may be on the page)`;
  if (info.target && info.target.site !== site) return `leave ${site} for ${info.target.site} (${tool})`;
  if (info.target) return `open ${info.target.url.slice(0, 160)} on ${site} without https (${tool})`;
  return `${tool} on ${site}, a logged-in site`;
}

export function makeHardStopPolicy(deps: HardStopDeps): (info: BrowserActionInfo) => McpKindVerdict {
  return (info) => {
    // The sites this call touches: where the page is, and where a navigation would take it.
    // …and the locked logged-in sites this page has loaded something from (C3 review, item 4): a frame
    // from one of them is acted on as if the page were on it.
    const touched = [info.currentSite, info.target?.site, ...(info.embeddedSites ?? [])].filter((s, i, all): s is string => !!s && all.indexOf(s) === i);
    // Unknown embedded content counts as a locked logged-in site (fail closed).
    const site = touched.find((s) => (isMarkerSite(s) || deps.isLocked(s)) && !runsWithoutPrompt(info, s));
    // The daemon does not know which page the current tab shows: assume the worst — a locked
    // logged-in site — never "not logged in". Only a read runs; anything else is refused until a
    // snapshot says where the page is (the gate refuses such calls too; this is the second lock).
    if (!site && info.currentUnknown === true && info.cls !== "read") {
      return { kind: "deny", reason: "Anvil does not know which page the browser is showing, so it is treated as a logged-in site: call browser_snapshot first, then make this call again." };
    }
    if (!site) return undefined;

    // Name every locked site the browser has loaded, not only the one the card is about.
    const others = (info.embeddedSites ?? []).filter((s) => s !== site && !isMarkerSite(s) && deps.isLocked(s));
    const verb = others.every((s) => info.profileSites?.includes(s)) ? "its profile also holds" : "the browser has also loaded";
    const reason = describe(info, site) + (others.length ? ` (${verb} ${others.slice(0, 3).join(", ")}, locked logged-in site${others.length > 1 ? "s" : ""})` : "");
    const session = info.ctx.session;
    if (isUnattended(session)) return { kind: "deny", reason: `${reason} needs the owner's approval (denied: this session is unattended)` };

    const image = deps.screenshot(session.id);
    if (!image) {
      return {
        kind: "deny",
        reason: `${reason} needs the owner's approval, and the approval card must show the page as it is now. Call browser_take_screenshot first, then make this call again.`,
      };
    }
    return {
      kind: "prompt",
      reason,
      suggestions: suggestions(site),
      always: true, // under every policy, `bypass` included, and whatever was allowed before
      denyWhenUnattended: true,
      card: { reason, image },
      timeoutMs: deps.timeoutMs ?? HARD_STOP_TIMEOUT_MS,
      onAnswer: (decision) => {
        if (decision === "allow_always" && !isMarkerSite(site)) deps.unlock(site, session.id);
      },
    };
  };
}
