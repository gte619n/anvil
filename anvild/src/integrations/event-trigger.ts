/**
 * Event-driven autopilot intake (loop-engineering "Channels": an external event, not the nightly tick,
 * is the trigger). An inbound event — a task labelled #Autopilot, a CI failure, a GitHub comment, a raw
 * webhook — is normalized here into a *proposed* work-unit intent. Pure + SDK-free (like autostart-gate),
 * so the normalization/dedupe/disposition rules are unit-testable without spinning the daemon.
 *
 * The default disposition is PROPOSE, never RUN: an ambient trigger drops a card into a pending-approval
 * state for a one-tap human approve, rather than auto-starting a bypass-permission build. That's the
 * "propose don't run" guard the catalog incident argued for — a trusted source can opt into auto-approve
 * explicitly, but nothing runs unattended off an event by default.
 */

/** Where a trigger came from. Kept open-ended (string-typed source) so new channels need no enum churn. */
export type TriggerKind = "ci-failure" | "github" | "todoist-label" | "webhook" | "manual";

const TRIGGER_KINDS: ReadonlySet<string> = new Set<TriggerKind>([
  "ci-failure",
  "github",
  "todoist-label",
  "webhook",
  "manual",
]);

/** The raw event a channel hands the daemon (via the `autopilot.trigger` command or an HTTP webhook). */
export interface TriggerEvent {
  kind: TriggerKind;
  source: string; // human label for the origin, e.g. "CI build #1421" or "GH issue #87"
  title: string; // becomes the proposed unit's title
  body?: string; // detail (failure log, comment text) — seeds the card summary + planning brief
  environmentId?: string; // route to a specific environment; unset → the caller picks a default
  dedupeKey?: string; // caller-supplied idempotency key; auto-derived when absent
  autoApprove?: boolean; // a trusted source may bypass the propose gate (still bounded by budget upstream)
}

/** The trigger provenance persisted on the work unit + surfaced on the card. */
export interface TriggerInfo {
  kind: TriggerKind;
  source: string;
  at: string; // Iso8601 when the event was ingested
  dedupeKey: string;
}

/** A normalized, validated intent ready to become a `proposed` work unit. */
export interface ProposedIntent {
  title: string;
  summary: string; // 1–2 line card description derived from source + body
  environmentId?: string;
  trigger: TriggerInfo;
  autoApprove: boolean;
}

/** Lowercase-slug a string for a stable dedupe key (mirrors the worktree slugify shape, kept local so
 *  this module stays dependency-free). */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Idempotency key for an event: the caller's key wins; otherwise derive a stable one from kind+title so
 *  the same CI failure or re-delivered webhook collapses onto one card instead of spawning duplicates. */
export function dedupeKeyFor(e: Pick<TriggerEvent, "kind" | "title" | "dedupeKey">): string {
  const explicit = e.dedupeKey?.trim();
  if (explicit) return explicit;
  return `${e.kind}:${slug(e.title) || "untitled"}`;
}

/** One-line summary for the card: the source, plus the first line of the body when present. */
function summarize(e: TriggerEvent): string {
  const firstLine = e.body?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (firstLine) return `${e.source} — ${firstLine.slice(0, 160)}`;
  return e.source;
}

/**
 * Validate + normalize a raw event into a proposed intent. Throws (with a user-facing message) on the
 * two things that make an event unactionable — an unknown kind or an empty title — so a malformed
 * webhook is rejected at the door rather than creating a titleless card. `nowIso` is injected for
 * deterministic tests (same pattern as schedule.ts taking `now`).
 */
export function normalizeTrigger(e: TriggerEvent, nowIso: string): ProposedIntent {
  if (!TRIGGER_KINDS.has(e.kind)) throw new Error(`unknown trigger kind: ${String(e.kind)}`);
  const title = e.title?.trim();
  if (!title) throw new Error("trigger event has no title");
  const source = e.source?.trim() || e.kind;
  return {
    title,
    summary: summarize({ ...e, source }),
    ...(e.environmentId ? { environmentId: e.environmentId } : {}),
    trigger: { kind: e.kind, source, at: nowIso, dedupeKey: dedupeKeyFor(e) },
    autoApprove: e.autoApprove === true,
  };
}
