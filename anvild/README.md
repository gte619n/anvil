# anvild — the Anvil daemon

The keystone of Anvil. One daemon per Mac: it supervises Claude Code sessions, drives them
through the Agent SDK, renders markdown, enforces permissions, tracks usage, persists an
event log, owns the git worktrees, and serves both the web client and the protocol over
Tailscale.

- **Architecture tour:** [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- **Full design:** [`../docs/plans/anvil-native-architecture.md`](../docs/plans/anvil-native-architecture.md)
- **Wire protocol:** [`protocol.ts`](protocol.ts) → symlink to [`../docs/plans/anvil-protocol.ts`](../docs/plans/anvil-protocol.ts)

---

## Run

Requires [Bun](https://bun.sh) ≥ 1.3.14 and a Claude **Max** subscription.

```sh
bun install

# Auth via your subscription — NOT a metered API key (see "Auth & billing" below).
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # one-time

bun run start          # http://localhost:7701   (ws: /ws · health: /api/health)
bun run dev            # watch mode
bun test               # unit + integration + contract + web (no token/network needed — uses mocks)
bun run typecheck      # daemon (src/ + test/);  `bun run typecheck:web` covers web/ separately
```

> CI (`.github/workflows/ci.yml`) gates every PR on `typecheck` + `typecheck:web` + `build:web` +
> `bun test`, and the release workflows re-run the same checks before shipping — so a broken build
> can't merge or ship. Web-client tests live under `test/web/` (jsdom harness); the protocol
> contract test under `test/contract/` guards daemon↔client drift.

> [!IMPORTANT]
> **Auth & billing.** The daemon **refuses to start** if `ANTHROPIC_API_KEY` /
> `ANTHROPIC_AUTH_TOKEN` is set — they outrank the OAuth token and would silently switch
> every turn from your subscription to metered pay-per-token billing. Anvil only ever drives
> Claude through the Agent SDK with the subscription OAuth token. Full rationale:
> [`anvil-native-architecture.md` §3](../docs/plans/anvil-native-architecture.md).

### Over Tailscale (drive from your phone + desktop)

```sh
tailscale serve --bg --https=443 http://localhost:7701
# then open https://<your-magicdns-host>/   (the WS connects same-origin to /ws)
```

---

## Web client

The web client (`web/`) is both the daily-driver browser UI and the reusable render surface
bundled into the native shells.

```sh
bun run build:web         # bundle web/src → web/dist
bun run start             # daemon serves the app at http://localhost:7701/
bun run typecheck:web
```

Rebuild with `bun run build:web` after editing `web/src`. The native shells get the same
bundle via `web/bundle-native.ts`.

---

## Service (macOS launchd / Linux systemd)

`service.sh` is cross-platform: on macOS it manages a launchd **LaunchAgent**, and on Linux
(Fedora / CentOS / Ubuntu / …) a **systemd `--user`** service. The commands are identical:

```sh
./scripts/service.sh install     # build web, install + load the service, wire tailscale serve
./scripts/service.sh status      # service state + /api/health
./scripts/service.sh restart     # rebuild web + restart the service (full deploy)
./scripts/service.sh logs        # tail the daemon log
./scripts/service.sh uninstall   # unload + remove the unit/launcher (keeps state)
```

`install` lays down `~/.local/bin/anvild-launch` (sources `~/.config/anvil/env` and unsets
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`) plus the service unit — on macOS
`~/Library/LaunchAgents/com.anvil.anvild.plist` (`RunAtLoad` + `KeepAlive`), on Linux
`~/.config/systemd/user/com.anvil.anvild.service` (`WantedBy=default.target` + `Restart=always`).
No secrets live in the unit; logs go to `~/.local/state/anvil/` on both. The service starts at
login and restarts on crash.

> **Linux prerequisites:** [Bun](https://bun.sh) ≥ 1.3.14, a running systemd `--user` instance,
> and — for the daemon to survive logout / start at boot — user lingering
> (`loginctl enable-linger "$USER"`; `install` attempts this for you). Installing over SSH?
> Enable lingering first, then reconnect, so `systemctl --user` has a session bus.

> The daemon runs with `settingSources: []`, so it does **not** inherit your ambient Claude
> Code allow-rules — the daemon is the permission authority. Trade-off: the repo's
> `CLAUDE.md` isn't auto-loaded; project-context injection is a later item.

For a terminal-free install + multi-Mac fleet setup, use the menu-bar
[Anvil Server](../anvil-server/) app, which shells out to `service.sh`.

---

## What's inside

| Area | Path | Responsibility |
|---|---|---|
| Server | [`src/server/`](src/server/) | HTTP + WebSocket, envelope dispatch, connection registry, capabilities/identity, fleet endpoints |
| Session | [`src/session/`](src/session/) | supervisor, process groups, worktree create/kill/reap, terminal PTYs, file watching, persistence |
| Agent | [`src/agent/`](src/agent/) | Agent SDK driver + message map, permissions & danger list, questions (AskUserQuestion), model roster, skills, file offers, input queue, default (concierge) tools |
| Render | [`src/render/`](src/render/) | markdown-it → Shiki → KaTeX → DOMPurify pipeline (mermaid stays client-side) |
| Git | [`src/git/`](src/git/) | branch/diffstat metadata, commit/push/PR/merge ops |
| Event log | [`src/eventlog/`](src/eventlog/) | append-only `events.ndjson` — the source of truth for resume |
| Budget | [`src/budget/`](src/budget/) | rolling 7-day usage → Opus/Sonnet hours, warn + soft-stop |
| Push | [`src/push/`](src/push/) | Web Push / FCM / APNs registries |
| Fleet | [`src/fleet/`](src/fleet/) | multi-server discovery, token push/rotation |
| Integrations | [`src/integrations/`](src/integrations/) | autopilot planner, Todoist client, lapo/OpenRouter clients, adversarial plan panel, nightly scheduler, work-unit store |
| Pipeline | [`src/pipeline/`](src/pipeline/) | the unattended cross-model dev pipeline (phases, orchestrator, adversary metrics, Design History File) |
| Prompts | [`src/prompts/`](src/prompts/) | the device-synced prompt library |
| Attach / Env / Auth | [`src/attach/`](src/attach/) · [`src/env/`](src/env/) · [`src/auth/`](src/auth/) | attachment store, environment registry, provider-token store + the startup billing guard |
| Web client | [`web/`](web/) | the browser UI + shared render surface |

---

## Auth & billing — read first

Anvil draws on the **Max subscription pool**, never metered API billing. Two rules make that
true, and the daemon enforces both at startup:

1. **Always go through the Agent SDK / Claude Code** — never the raw Messages API.
2. **Authenticate with `CLAUDE_CODE_OAUTH_TOKEN`** (from `claude setup-token`), and keep
   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` out of the environment.

This is a hard constraint, not a preference — see
[`anvil-native-architecture.md` §3](../docs/plans/anvil-native-architecture.md) for the
caveats worth tracking (the announced-then-paused Agent-SDK billing split, the shared usage
pool, and unattended-use ToS notes).
