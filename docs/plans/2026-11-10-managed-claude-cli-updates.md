# Managed Claude CLI updates (decouple the engine from the Anvil release)

**Status:** build-ready · **Branch:** `claude-update` · **Date:** 2026-11-10

## Problem

Claude sessions on every fleet machine run through `@anthropic-ai/claude-agent-sdk`, which
*bundles* the Claude Code CLI. The CLI version is frozen into `anvild/bun.lock` at install time,
so it only advances when someone bumps the dependency, regenerates the lockfile, and cuts a full
Anvil release. When Anthropic ships a new model (e.g. Fable 5.2) the Models API rejects the old
CLI:

```
API Error: 400 Claude Code 2.1.183 does not support this model; version 2.1.290 or newer is
required. Run 'claude update', or update the Claude desktop app, then try again.
```

Neither `claude update` nor the desktop app helps — those don't touch the daemon's bundled copy.
Today the only fix is a code change + release, which is slow and couples the Claude engine's
cadence to Anvil's.

## Goals

1. **Latest Claude without an Anvil release.** The CLI the daemon spawns can advance independently
   of the pinned npm dependency and `bun.lock`.
2. **UI trigger.** A control in **Settings → Models** updates the Claude engine on demand.
3. **Fleet-wide.** Triggering rolls the new CLI to every reachable member (each machine runs its
   own sessions, so each needs its own CLI).
4. **Honor the pinned-rollout philosophy.** The fleet's determinism (frozen-lockfile installs,
   watchdog rollback) must not regress. Updates are *auto-checked* but *manually applied* — a bad
   upstream CLI can never silently break the fleet.

## Non-goals

- Changing how the *daemon itself* updates (the Stable Update Service is untouched).
- Floating `bun.lock`. The bundled CLI stays pinned as a deterministic **floor/fallback**.
- Auto-applying CLI updates (explicitly rejected — see Decision D2).

## Key decisions

- **D1 — Managed override, bundled floor.** A separately-installed "managed" Claude CLI lives
  under the daemon state dir and, when present, overrides the bundled one via the SDK's
  `pathToClaudeCodeExecutable`. If no managed CLI is installed, the daemon uses the bundled version
  exactly as today. `bun.lock` is never mutated by this feature.
- **D2 — Auto-check, manual apply.** A background timer (reusing the 4h model-labels cadence)
  records the latest published CLI version; the Models tab surfaces "update available"; the operator
  clicks to apply. No auto-install.
- **D3 — Fleet fan-out.** The hub resolves one target version, then installs it on each reachable
  member in parallel and reports per-member status — same shape as `FleetRolloutCoordinator`, but
  the unit of work is "install CLI version X" not "checkout SHA".
- **D4 — Isolated install root.** The managed CLI is installed into `<stateDir>/claude-cli/` with
  its *own* `package.json`/lockfile, so `bun add` there never touches the daemon's `node_modules`
  or tracked lockfile. Package: `@anthropic-ai/claude-code@<version>` (ships a native `claude` bin).
- **D5 — Capability gated.** New capability `claude-cli-update` on `server.hello`; the UI hides the
  control on daemons that don't advertise it. Graceful degradation, matching `model-catalog`.
- **D6 — Identity/transport posture.** New REST routes reuse the Update API posture: tailnet-gated,
  reject proven `otherUser`, `content-type: application/json` required on mutating POSTs.

## Architecture

### Resolution (what CLI gets spawned)

`anvild/src/agent/cli.ts` gains a managed-path override consulted by `claudeCliOptions()`:

```
priority: ANVIL_CLI_PATH (packaged mode, unchanged)
        → managed CLI path (set at boot if installed)
        → { executable: "bun" } (bundled, dev/default)
```

Two spawn sites currently hardcode `executable: "bun"` and bypass the resolver —
`src/integrations/autopilot.ts` and `src/agent/query.ts`. Both are changed to spread
`...claudeCliOptions()` so autopilot/pipeline agents also pick up the managed CLI.

### Install engine — `anvild/src/daemon/claude-cli.ts`

Pure, testable module (clock/fetch/exec injected):

- `resolveLatest(fetchFn)` → latest `@anthropic-ai/claude-code` version from the npm registry
  dist-tags.
- `bundledVersion()` → the CLI version shipped by the installed agent-sdk (read from
  `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/package.json#claudeCodeVersion`). This is
  the floor shown when nothing is managed.
- `installedVersion(stateDir)` → version in `<stateDir>/claude-cli/installed.json`, or null.
- `install(stateDir, version, execFn)` → writes the isolated `package.json`, runs
  `bun add @anthropic-ai/claude-code@<version>`, resolves the installed `claude` binary path,
  persists `installed.json` `{ version, binPath, installedAt }`. Returns `{ version, binPath }`.
- `managedCliPath(stateDir)` → `binPath` if a valid managed install exists, else null (consulted at
  boot to prime the resolver).
- `cliStatus(stateDir)` → `{ active, bundled, latest?, checkedAt? }` for the UI.

State files under `<stateDir>/claude-cli/`: `installed.json` (applied version) and
`check.json` (`{ latestVersion, checkedAt }`, written by the background check).

### Background check

Supervisor gains `refreshClaudeCliLatest()` mirroring `refreshModelLabels()`: resolve latest,
write `check.json`, broadcast. Scheduled on the same 4h timer and on boot. No token needed (public
registry), so it runs even when no Claude token is set.

### Protocol (`anvild/protocol.ts`)

- `ClaudeCliInfo { active: string; bundled: string; latest?: string; checkedAt?: string; managed: boolean }`
- WS: `ClaudeCliCheckCmd { type: "claudecli.check" }` (force a check — the "refresh" button) and
  `ClaudeCliStatusEvent { type: "claudecli.status"; info: ClaudeCliInfo }` (broadcast).
- REST (`rest.claudecli.*`): member `InstallRequest { version?: string }` / `InstallResponse`,
  `StatusResponse`; hub fleet `FleetCliUpdateRequest`/`...Response`/`...StatusResponse`
  (per-member `{ name, state, version, detail }`).
- Capability `claude-cli-update` added to `SERVER_CAPABILITIES`.

### HTTP routes (`anvild/src/server/http.ts`)

- `GET  /api/claude-cli/status` — this daemon's `ClaudeCliInfo`.
- `POST /api/claude-cli/install {version?}` — install (defaults to latest) on this daemon, hot-swap
  the resolver for subsequent sessions. In-flight guard like `updateApply`.
- `POST /api/fleet/claude-cli/update {version?}` — hub resolves target, fans out to members.
- `GET  /api/fleet/claude-cli/update/status` — rollout snapshot.

### Fleet coordinator — `anvild/src/server/fleet-cli-rollout.ts`

Mirrors `FleetRolloutCoordinator`: pin one target version, parallel install across reachable
members via the member-REST transport, mark unreachable members `pending-offline`, hub installs
itself last. Per-member state machine: `pending → installing → healthy | error | pending-offline`.

### UI (`anvild/web/src/settings.ts`, Models panel)

Under the existing model-tier table, a new "Claude engine" card:

- Shows **Active** version (managed or bundled), **Bundled** floor, **Latest available**, and last
  check time. When `latest > active`, an "Update available" badge appears.
- **"Check for updates"** → `claudecli.check` (reuses the model-refresh affordance).
- **"Update Claude engine"** → `POST /api/fleet/claude-cli/update`, then polls
  `/api/fleet/claude-cli/update/status` and renders per-member progress (same live-`<pre>` pattern
  as `wireDaemonUpdate`).
- Entire card gated on `serverSupports(hub(), "claude-cli-update")`.

## Testing

- `claude-cli.test.ts` — unit: `resolveLatest` parses dist-tags; `install` writes isolated
  package root + `installed.json` and never touches the repo lockfile (injected exec); `cliStatus`
  composes active/bundled/latest; resolver precedence (env > managed > bundled).
- `cli.test.ts` — `claudeCliOptions` honors managed path and ANVIL_CLI_PATH precedence.
- `fleet-cli-rollout.test.ts` — injected transport: fan-out, offline members, hub-last, terminal
  states (adapted from the existing fleet-rollout tests).
- Dispatch/HTTP tests for the new WS command + routes (identity gate, in-flight guard).

## Rollout / safety notes

- The feature is dormant until a managed CLI is installed; existing fleets behave identically.
- Because the managed install is isolated from `bun.lock`, the **Stable Update Service dirty-tree
  guard is unaffected** (`<stateDir>/claude-cli/` is outside the repo working tree).
- A managed CLI that fails to spawn should fall back to bundled; `managedCliPath()` validates the
  binary exists before priming the resolver, and install only persists `installed.json` after a
  successful `bun add`.
- M4 dev box caveat (runs from the live checkout) applies to daemon updates, not to this feature —
  the managed CLI lives in the state dir, not the repo.
