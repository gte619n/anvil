# Working in this repo

Anvil is a native, multi-device client for Claude Code: a Bun/TypeScript daemon (`anvild`)
supervises Claude Code sessions and streams them as structured events to thin native clients over
Tailscale. Start with [`README.md`](README.md) for the product overview and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system design.

## Orientation — where things live

| Path | What it is |
|------|-----------|
| `anvild/` | The daemon (Bun/TS). `src/` = server + session supervisor + agent driver + pipeline + integrations; `web/` = the PWA web client (its own `tsconfig`, bundled by `web/build.ts`). |
| `app/` | Android client (Kotlin WebView shell + FCM). Bundles the web UI into the APK. |
| `apple/` | iOS + macOS client (Swift WebView shell + APNs, `anvil-app://` custom scheme). |
| `anvil-server/` | macOS menu-bar app that provisions Tailscale and manages the `anvild` lifecycle. |
| `docs/` | `ARCHITECTURE.md`, `plans/` (design docs + the wire protocol `anvil-protocol.ts`), and the improvement program (`plans/anvil-improvement-program.md`). |
| `scripts/`, `anvild/scripts/` | Build/release/signing + service management (`service.sh`, `merge-session.sh`). |

**Session supervisor (`anvild/src/session/supervisor.ts`) is being decomposed into domain services**
(behavior-preserving; see the P7 section of `docs/plans/2026-08-01-improvement-program-v2-decisions.md`).
The supervisor still owns session lifecycle + the WS event fan-out, but delegates cohesive domains to
injected-deps modules in `src/session/`: `integrations-facade.ts` (Todoist/lapo), `account-roster-service.ts`
(multi-account roster), `environment-service.ts` (project CRUD/clone/README), `git-projection-service.ts`
(git status + PR badges/sweep). Each has a `*Deps` interface documenting exactly what supervisor state it
touches, and a `*-service.test.ts` guard. `BadCommand` lives in `src/session/errors.ts`. Teams and
autopilot remain in `supervisor.ts` (next to be extracted). When adding to one of these domains, edit the
service, not the supervisor's thin delegation.

The wire protocol is the source of truth for daemon↔client contracts:
`docs/plans/anvil-protocol.ts` (symlinked as `anvild/protocol.ts`, imported as `@protocol`;
`PROTOCOL_VERSION` is currently **4**). Two contract tests in `anvild/test/contract/` guard it:
`protocol-surface.test.ts` pins the version + the set of `type` literals, and `wire-shape.test.ts` pins
the required fields + types of the critical v4/hello/permission envelopes. Changes are **additive-or-bump**
— a field rename/retype/drop is breaking; bump `PROTOCOL_VERSION` and update all four clients together.
See [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) §4 for the policy.

## Build, test, run

All daemon commands run from `anvild/` (Bun ≥ 1.3.14):

```bash
cd anvild
bun test                 # the full suite (bun:test)
bun run typecheck        # tsc --noEmit over src/ + test/  (does NOT cover web/)
bun run typecheck:web    # tsc over web/  — a SEPARATE tsconfig; run BOTH after editing web/src
bun run build:web        # bundle the PWA to web/dist (see "Common pitfalls")
bun run dev              # run the daemon locally with --watch
bun run start            # run the daemon (src/main.ts)
```

CI (`.github/workflows/ci.yml`) gates every PR on `typecheck` + `typecheck:web` + `build:web` +
`bun test`; the release workflows re-run the same checks before shipping. Keep all four green.

**Auth model (read carefully — the docs used to overstate this).** A missing `CLAUDE_CODE_OAUTH_TOKEN`
is NOT fatal: the daemon boots **degraded** (it serves the UI + pairing/takeover flow so a headless
member can be joined into a fleet), it just can't run a turn until a subscription token is present. What
IS fatal is a **metered key**: the daemon refuses to start if `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` are set — those outrank the OAuth token and would meter per-token billing (the §3
guard in `src/auth/guard.ts`). For local dev you'll want a real `CLAUDE_CODE_OAUTH_TOKEN` so turns
actually run. Tokens now live in the **account roster** (`src/auth/accounts.ts`, multi-account §3); the
env var is the migration seed + the mirror for the default account, not the only home. The daemon's
security boundary is Tailscale itself — see [`SECURITY.md`](SECURITY.md) and
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md).

**The frozen Update API v1 is load-bearing — do not casually refactor it.** `src/daemon/update-api.ts`
and `src/daemon/updater/*` (watchdog) implement a STABLE contract (`UPDATE_API_VERSION`) that a hub and a
partially-updated fleet coordinate over, and that the out-of-process watchdog reads to roll a bricked
release back. Response SHAPES are additive-only (guarded by `test/unit/update-api-contract.test.ts`);
breaking them silently strands members mid-rollout. Bump to `/v2` + `UPDATE_API_VERSION` instead of
changing v1. See `docs/plans/2026-08-01-stable-update-service.md`.

## Common pitfalls

- **Web bundle cache staleness.** After editing `anvild/web/src`, you must re-run `bun run build:web`
  — the daemon serves `web/dist`, not the source. A stale `web/dist` (or a browser/service-worker
  cache; `web/sw.js` is a real SW) shows up as "my UI change didn't take."
- **The Android/Apple apps bundle their own copy of the web UI.** `anvild/web/bundle-native.ts` embeds
  the web client into the native shells, so updating `anvild` never updates a phone's UI — the app
  must be re-shipped. A daemon self-update won't reach installed native clients.
- **The daemon runs sessions with `settingSources: []`** (`src/agent/driver.ts`), so this `CLAUDE.md`
  is NOT auto-loaded into daemon-driven Claude Code sessions. Conventions here guide humans/agents
  editing the repo, not the running agent's context.

## Merging a session's PR

**Do NOT run `gh pr merge --delete-branch` in a worktree.** `--delete-branch` switches the local
checkout to `main` *before* deleting the remote branch. `main` is already checked out by the
canonical clone, so the switch fails, gh aborts, and you're left with the worktree stranded on the
merged branch **and** the remote branch undeleted (the "let me delete the remote branch manually"
/ "couldn't auto-switch to main" warnings).

Instead, run the worktree-safe merge:

```bash
anvild/scripts/merge-session.sh --squash   # or --merge / --rebase
```

It merges (no `--delete-branch`), deletes the remote branch with a plain push, rolls the worktree
onto a fresh `<branch>_followup` off `origin/main`, and deletes the local branch. The daemon's
in-app Merge button does the same thing via `mergePr()` in `anvild/src/git/ops.ts` — prefer either
of those over hand-rolling `gh`. **A worktree can never check out `main`** (git forbids the same
branch in two worktrees); ending on `<branch>_followup` is correct and expected, not an error.

## Verifying before merge

Sessions run inside a **git worktree** under `<stateDir>/worktrees/<session-id>` — `stateDir` defaults
to `~/.anvil` (override with `ANVIL_STATE_DIR`), so the default path is `~/.anvil/worktrees/<session-id>`
(there is no `.claude/worktrees`). Branched off `main`. New worktrees get `node_modules` symlinked in from the
canonical checkout (`createWorktree`/`linkDeps` in `anvild/src/session/worktree.ts`), so you **can**
run a real typecheck in-worktree:

```bash
cd anvild && bunx tsc --noEmit       # types (also run `bun run typecheck:web` for web/ edits)
bun run build:web                    # web bundle
bun test                             # the suite
```

If `node_modules` is somehow missing (link failed, older worktree), fall back to the esbuild
syntax check and say so. Deploying the change (`anvild/scripts/service.sh restart`) still happens
on the **canonical checkout** — the daemon runs from there, not from the worktree.
