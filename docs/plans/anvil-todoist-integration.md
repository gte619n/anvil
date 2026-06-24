# Anvil × Todoist — Task Autopilot

Status: **in progress** (foundation landed; autopilot pipeline + wiring pending)
Branch: `todoist-integation`

## Goal

Let anvil monitor specific Todoist projects, each linked to a registered Environment (git repo).
Nightly, anvil pulls the project's outstanding tasks, **bundles** them into units of work that make
sense together, **plans** an implementation for each, **builds** it in an isolated worktree session,
runs that environment's **validation gate**, and opens a PR — tagging each task's status in Todoist as
it moves through the pipeline.

## Decisions (locked 2026-06-23)

- **Auth**: personal API token (single-user, self-hosted). Stored at
  `~/.anvil/integrations/todoist.json` (mode 0600). Not OAuth.
- **Status scheme**: namespaced Todoist **labels** (`anvil:planned|building|review|blocked`) for state,
  plus a **comment** on each task carrying the plan, PR link, and validation results (audit trail).
  Sections and the user's own labels are never touched.
- **Task scope**: **all active tasks** in a linked project are candidates (minus obvious excludes).
- **Nightly output**: **plan + auto-execute through validation**. Fully unattended; the validation gate
  is the hard stop. Nothing reaches `anvil:review` (PR open) unless validation passes; on failure the
  unit iterates or goes `anvil:blocked`.

## Status lifecycle

```
(no anvil label) → anvil:planned → anvil:building → anvil:review → ✓ completed (task closed)
                                              ↘ anvil:blocked (needs a human decision)
```

Exactly one `anvil:*` label is kept on a task at a time (`src/integrations/status.ts`).

## Mapping (environments ↔ Todoist projects)

anvild already registers these repos; the obvious links:

| Environment (repo) | Todoist project | Notes |
|---|---|---|
| Anvil (`zellij-android`) | **Anvil** (9) | this repo |
| Tesseta | **Tesseta** (6) | |
| Slates | **Slates** (3) | |
| OXOS Bots (`oxos/bots`) | **OES** (`6cg5wwxVQQjHRv4j`, 30 tasks) | confirmed |
| Shipper | — | no project yet |

Link is stored on `Environment.todoistProjectId`.

## Data model

- `Environment.todoistProjectId?` — the linked project. (`docs/plans/anvil-protocol.ts`)
- `Environment.validation?: { commands: string[] }` — the per-environment validation gate, run in
  order in the worktree; all must exit 0.
- `WorkUnit` (`src/integrations/workunit.ts`) — `{ id, environmentId, todoistProjectId, taskIds[],
  title, rationale, plan, status, sessionId?, prUrl?, validation?, blockedReason? }`. Persisted to
  `~/.anvil/integrations/workunits.json`. A Todoist task belongs to at most one unit.
- `IntegrationStore` (`src/integrations/store.ts`) — token + sync cursor + account, mode 0600.

## Components

| Component | File | State |
|---|---|---|
| Todoist API client (read+write) | `src/integrations/todoist.ts` | ✅ done |
| Token / connection store | `src/integrations/store.ts` | ✅ done |
| Status-label helper | `src/integrations/status.ts` | ✅ done |
| WorkUnit store | `src/integrations/workunit.ts` | ✅ done |
| Environment link + validation fields | `protocol.ts`, `src/env/store.ts` | ✅ done |
| CLI (`set`/`verify`/`dump`/`disconnect`) | `scripts/todoist.ts` | ✅ done |
| **Autopilot — BUNDLE + PLAN** (read-only, dry-runnable) | `src/integrations/autopilot.ts` | ✅ done |
| Autopilot dry-run CLI | `scripts/autopilot.ts` | ✅ done |
| Protocol: `todoist.status`/`projects.list`/`projects.result` + `env.update` link/validation | `protocol.ts` | ✅ done |
| Dispatch routing + connect-time `todoist.status` | `src/server/dispatch.ts`, `src/server/http.ts` | ✅ done |
| Supervisor wiring (IntegrationStore, WorkUnitStore, status/projects methods) | `src/session/supervisor.ts` | ✅ done |
| Web UI: Todoist tab (project browser) + per-env link & validation | `web/src/main.ts`, `web/styles/app.css` | ✅ done |
| **Autopilot — BUILD → VALIDATE → PR → tag** | `src/integrations/autopilot.ts` (+ supervisor) | ⬜ todo |
| **Scheduler** (nightly trigger) | `src/integrations/scheduler.ts` | ⬜ todo |

### Dry-run (verified working)

```
bun run scripts/autopilot.ts dryrun <envNameOrId> [projectId]
```

Pulls active tasks → bundles into units → plans each by reading the repo read-only
(`permissionMode: "plan"`). Writes nothing. Bundling smoke-tested live against the Anvil project:
9 tasks → 7 cohesive units (the chat-UI tweaks correctly grouped; features kept separate).

## Nightly pipeline (autopilot)

For each environment with a `todoistProjectId`:

1. **Pull** active tasks for the project (and their existing `anvil:*` status).
2. **Bundle** — an Agent-SDK pass groups untagged candidate tasks into `WorkUnit`s by section/label/
   semantic affinity, with a short rationale per unit. Tasks already in a unit are skipped.
3. **Plan** — per unit, a planning pass (opus) reads the repo + bundled task descriptions and writes an
   implementation plan. Persist on the unit; post as a Todoist comment on each member task; set tasks →
   `anvil:planned`.
4. **Build** — create a fresh-worktree session off the environment's `defaultBase`, hand it the plan as
   the opening brief. Set tasks → `anvil:building`. Reuses the existing Supervisor session machinery.
5. **Validate** — run `environment.validation.commands` in the worktree. All pass → continue; else
   iterate a bounded number of times, then → `anvil:blocked` with the failure log as a comment.
6. **PR** — open a PR (existing `git` op via `gh`); record `prUrl`; set tasks → `anvil:review`; comment
   the PR link.
7. On human merge (detected later / via UI) → close the Todoist task.

`anvil:blocked` is also set whenever a build session raises an AskUserQuestion / permission it can't
resolve unattended — the question surfaces to you the next morning.

## Safety / constraints

- **Worktree isolation**: all building happens in `~/.anvil/worktrees/<branch>` off `defaultBase`;
  main branches are never touched directly.
- **Validation gate is mandatory** before `anvil:review`. An environment with no `validation` set does
  not auto-execute — it stops at `anvil:planned` for manual review (fail-safe default).
- **Budget**: the autopilot must respect the existing rate-limit tracker (soft-stop) and skip/defer when
  the 7-day window is near the cap.
- **ToS note**: review whether fully unattended Agent-SDK runs are acceptable under the subscription
  auth terms (the daemon is otherwise human-initiated). Gate behind an explicit per-environment
  "autopilot enabled" flag so unattended execution is always opt-in.

## Open questions

- ~~OES vs OXOS for the OXOS Bots environment.~~ Resolved: OXOS Bots → OES (`6cg5wwxVQQjHRv4j`).
- Default validation commands per environment (e.g. Anvil → `bun run typecheck` + `bun test`).
- How merges are detected to auto-close tasks (poll PR state vs. manual "done" in UI).
- Bundle granularity: how aggressively to group (one PR per section? per theme? per task?).
