# Anvil — Autopilot section (plan review & launch UI)

Status: **in progress** (this branch)
Builds on: [`anvil-todoist-integration.md`](anvil-todoist-integration.md) (the planner that produces the work units this UI surfaces)

## Goal

The Todoist autopilot already **bundles** outstanding tasks into work units and **plans** an
implementation for each — but today those plans only live as Todoist comments and rows in the
daemon's work-unit store. There is no way to see them in the app.

This feature gives pending plans a home: an **Autopilot** section, reached from a new entry at the
bottom of the session list (above *Settings & servers*). It opens a **full-screen, flowing card
grid** of pending plans. Open a card to **read the full plan** with the Markdown reader, **refine it
with Claude** in a lightweight chat, **dismiss** plans you don't want, or hit a single button that
**creates a worktree session seeded with the plan and starts the work**. A **Run autopilot** action
re-plans the linked Todoist projects on demand.

## Decisions (locked via interview, 2026-06-24)

- **Plan source** — Todoist autopilot only: `WorkUnit`s at `anvil:planned` that have not yet been
  started. No manual drafts, no arbitrary `docs/plans/` markdown.
- **Fleet scope** — aggregate across **all connected servers**, cards **grouped by server** (mirrors
  the multi-server session list). Refine/dismiss/start/run each route to the daemon that *owns* the
  work unit (it has the repo + the Todoist token).
- **Refine UX** — a **lightweight refine chat** scoped to the one plan: you type feedback, Claude
  (Opus) rewrites the plan markdown in place. No worktree/session is created yet. The revised plan is
  persisted to the `WorkUnit` **and** posted back as a new Todoist comment (Todoist stays the source
  of truth). No version history (each refine overwrites).
- **Go button** — **create + auto-start working**: a fresh worktree off the plan's environment,
  seeded with the plan as the opening brief, autonomy defaulting to **bypass** so it runs without
  stalling on a permission prompt. Once started, the card **leaves the Autopilot section entirely**
  (it's now a normal session).
- **Dismiss** — removes the card and labels the member Todoist tasks `anvil:dismissed` so the nightly
  run won't re-plan them.
- **Card content** — title + 1–2 line summary, source project/repo + environment, status badge, and
  an **effort/scope hint** (size + files-touched guess) emitted by the planner.
- **Surface** — a **full-screen view** (its own overlay/route), like opening a session.
- **Notify** — a **badge count** of pending plans on the Autopilot entry, plus a **push notification**
  when an autonomous (nightly) run produces new plans.
- **Rerun against Todoist** — a **Run autopilot** button in the Autopilot screen re-plans the linked
  projects (per server) and streams progress.

## Status lifecycle (unchanged + one addition)

```
(no anvil label) → anvil:planned → anvil:building → anvil:review → ✓ completed
                          │                   ↘ anvil:blocked
                          └→ anvil:dismissed (user rejected it in the Autopilot UI)
```

`dismissed` is added to `src/integrations/status.ts`. A task labelled `anvil:dismissed` is no longer a
planning candidate (`candidateTasks` already skips any task carrying an `anvil:*` status), so the
nightly run won't resurrect it.

`pendingPlans()` = work units with `status === "planned"` and no `sessionId`. Starting a plan sets
`sessionId` + `status: "building"`; dismissing sets `status: "dismissed"`. Both drop the unit out of
the pending grid.

## Data model

`WorkUnit` (`src/integrations/workunit.ts`) gains two optional fields:

```ts
summary?: string;          // 1–2 line description for the card (planner-emitted)
effort?: AutopilotEffort;  // { size: "xs"|"s"|"m"|"l"|"xl"; filesTouched?: number }
```

The planner (`planUnit` in `src/integrations/autopilot.ts`) is extended to append a fenced
`json` metadata block to its output — `{ "summary": "...", "size": "m", "filesTouched": 7 }` — which is
parsed out and stripped from the stored plan markdown. Single query, no extra round-trip. A new
`refinePlanQuery()` does the same shape for refinement (current plan + user feedback → revised plan +
refreshed metadata).

## Protocol additions (`docs/plans/anvil-protocol.ts`)

Display type, sent in events:

```ts
export type AutopilotSize = "xs" | "s" | "m" | "l" | "xl";
export interface AutopilotEffort { size: AutopilotSize; filesTouched?: number; }
export type AnvilStatus = "planned" | "building" | "review" | "blocked" | "dismissed";

export interface AutopilotPlanInfo {
  id: string;                  // WorkUnit id
  environmentId: string;
  environmentName?: string;
  todoistProjectId: string;
  title: string;
  rationale?: string;
  summary?: string;
  status: AnvilStatus;
  effort?: AutopilotEffort;
  taskCount: number;
  plan?: RenderedMarkdown;     // full plan (source + sanitized HTML) for the reader
  createdAt: Iso8601;
  updatedAt: Iso8601;
}
```

Events: `autopilot.plans` (list result **and** broadcast on any change), `autopilot.plan` (one updated
plan — refine result), `autopilot.started` (the session a Go created), `autopilot.run.progress`
(streamed log lines), `autopilot.run.result` (run summary).

Commands: `autopilot.plans.list`, `autopilot.refine {workUnitId, feedback}`,
`autopilot.dismiss {workUnitId}`, `autopilot.start {workUnitId, model?, autonomy?}`,
`autopilot.run {environmentId?}`.

## Daemon (`src/session/supervisor.ts` + `src/server/dispatch.ts`)

- `autopilotPlansEvent(cid?)` / `broadcastAutopilotPlans()` — build `AutopilotPlanInfo[]` from
  `pendingPlans()`, enriching with the environment name and the rendered plan.
- `refinePlan(workUnitId, feedback, cid?)` — `refinePlanQuery` against the plan's repo (read-only),
  persist the revised plan + metadata, post a Todoist comment, broadcast, return the updated plan.
- `dismissPlan(workUnitId)` — label member tasks `anvil:dismissed`, set status `dismissed`, broadcast.
- `startPlan(workUnitId, model?, autonomy?, cid?)` — `handoffCreate` a fresh-worktree session seeded
  with the plan brief (autonomy default `bypass`), set `sessionId` + `building`, tag tasks
  `anvil:building`, broadcast, return `autopilot.started`.
- `runAutopilot({environmentId?, notify?, onProgress})` — `planAndTagProject` over every linked
  environment on this server; broadcast plans; on `notify && created>0`, push "N new plans ready".

Dispatch streams `autopilot.run.progress` to all connections (every open Autopilot screen watches the
log) and returns `autopilot.run.result` to the requester.

## Web (`anvild/web`)

- **`index.html`** — an `#open-autopilot` button above `#open-settings`, with a `#autopilot-badge`
  count chip; a new `#autopilot-root` mount for the full-screen view.
- **`main.ts`** —
  - `serverPlans: Map<url, AutopilotPlanInfo[]>` and `planServer: Map<workUnitId, url>` populated from
    `autopilot.plans` events (tagged by the server they arrive from); a `pendingPlanCount()` drives the
    sidebar badge.
  - On connect we already get `session.list`; we also send `autopilot.plans.list` to each server so the
    badge is live without opening the view.
  - `openAutopilot()` — a `position:fixed` overlay (same pattern as Settings) registered as a new
    `"autopilot"` back-stack layer. Renders a responsive card grid (`grid-template-columns:
    repeat(auto-fill, minmax(...))`) grouped by server, plus a **Run autopilot** button + progress log.
  - `openPlan(id)` — the reader: injects the daemon-rendered plan HTML, a refine chat (`autopilot.refine`
    via `sendAwait` → swap in the revised plan), a **Dismiss** button (`autopilot.dismiss`), and the
    **Create session & start** button (`autopilot.start` → `selectSession` the returned session and
    close the overlay).
- **`styles/app.css`** — `.autopilot-view`, `.plan-grid`, `.plan-card`, effort/status chips, the reader
  + refine-chat layout. Responsive: multi-column on desktop/web, single column on a phone.

## Scheduling (in-daemon, decided 2026-06-24)

The autonomous run is driven by an **in-daemon timer** — not OS cron/launchd — so it gets the live
broadcast + push for free and behaves identically on every fleet member. Each daemon schedules its
own linked environments (same per-server model as `runAutopilot`).

**Decisions:**
- **Mechanism** — in-daemon timer: a 5-minute, `unref`'d interval (so it never holds a process /
  test open) checks whether a run is due and fires `runAutopilot({ notify: true, autoStart })`.
- **Run scope** — plan **and auto-start** the new units (fully unattended), with two guardrails:
  - **Auto-start cap** (`maxAutoStart`, default 3): a single run starts at most N sessions; any extra
    planned units stay in the Autopilot grid for manual Go. Stops one busy night from spawning a dozen
    concurrent `bypass`-autonomy sessions.
  - **Rate-limit guard**: if the subscription budget is in warn/soft-stop, the run still plans +
    notifies but **skips auto-start** (so it can't exhaust the weekly Opus window unattended).
- **Config** — set from the app (a control in the Autopilot view): enable, time-of-day (server-local
  `HH:MM`), days (default daily), auto-start on/off, and the cap. Persisted daemon-side.
- **Missed runs** — catch up on next startup: the loop computes the most recent scheduled fire at or
  before `now` and compares it to `lastRunAt`; if the daemon was down at the fire time it runs once
  shortly after coming back, then resumes. No separate "was I down?" bookkeeping.

**Due logic** lives in the SDK-free `src/integrations/schedule.ts` (store + pure
`isRunDue`/`nextScheduledFire`/`lastScheduledFire`), unit-tested deterministically by passing `now`.

**Protocol:** `AutopilotSchedule` type, `autopilot.schedule` event (carries the schedule +
computed `nextRunAt`), `autopilot.schedule.get` / `autopilot.schedule.set` commands.

**`runAutopilot`** gains `autoStart?` + `maxAutoStart?`: after `planAndTagProject`, when `autoStart`
and the budget isn't warning, it `startPlan`s up to the cap of the freshly-created units (each in a
try/catch so one failure doesn't abort the run).

## Open follow-ups (not in this pass)

- Schedule config is currently surfaced for the **hub** in the UI; the daemon fully supports a
  distinct schedule per fleet member (each runs its own), but the control doesn't yet enumerate them.
- Refine is request/response (a spinner per turn), not token-streamed; good enough for "comment &
  refine" and far simpler than standing up a second streaming channel.
