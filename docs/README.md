# Anvil documentation

Start with the [root README](../README.md) for the overview, then:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the approachable tour, with diagrams. Read this first.
- **[CI-CD.md](CI-CD.md)** — the build & deployment pipeline: every target, what to push to ship it (dev + prod), and where builds run. The authoritative reference for releases.
- **[lapo-integration.md](lapo-integration.md)** — the lapo/Logseq OAuth2 integration that posts autopilot run reports to your journal.

## Design & implementation plans (`plans/`)

The deep specs. They are the source of truth for *why* the system is shaped the way it is.

| Plan | What it covers |
|---|---|
| [anvil-native-architecture.md](plans/anvil-native-architecture.md) | The master design: auth/billing, sessions, protocol, render pipeline, every decision. |
| [anvil-protocol.ts](plans/anvil-protocol.ts) | The wire protocol — every envelope, event, and command (typed, `PROTOCOL_VERSION = 1`). |
| [anvil-impl-INDEX.md](plans/anvil-impl-INDEX.md) | Index of the per-component implementation plans (daemon, render, clients, terminal, push). |
| [anvil-impl-1-daemon-core.md](plans/anvil-impl-1-daemon-core.md) … [6](plans/anvil-impl-6-push-tailscale-ops.md) | The component-by-component build plans. |
| [anvil-multi-server.md](plans/anvil-multi-server.md) | Multi-server fleet: one client, many Macs, one Max plan. |
| [anvil-server-app.md](plans/anvil-server-app.md) | The macOS menu-bar control panel. |
| [anvil-autopilot-ui.md](plans/anvil-autopilot-ui.md) · [anvil-todoist-integration.md](plans/anvil-todoist-integration.md) | The Todoist autopilot and its plan-review UI. |
| [anvil-adversarial-pipeline.md](plans/anvil-adversarial-pipeline.md) | The OpenRouter/GLM integration, the adversarial planning panel + auto-start gates, and the 7-phase adversarial dev pipeline. |
| [anvil-improvement-program.md](plans/anvil-improvement-program.md) | The test-first improvement program (audit + phased plan) this repo is executing. |
| [anvil-restart-robustness.md](plans/anvil-restart-robustness.md) | Daemon restart / self-update safety. |
| [file-browser-sftp.md](plans/file-browser-sftp.md) | Earlier file-browser thinking, now sourced from the daemon `fs.*` API. |

## Assets (`assets/`)

Brand assets — the logo and the README banners. See [assets/README.md](assets/README.md).

## Component docs

Each component keeps its own build/run notes:

- [anvild/README.md](../anvild/README.md) — the daemon + web client
- [app/README.md](../app/README.md) — Android (Kotlin WebView + FCM) shell
- [apple/README.md](../apple/README.md) — Apple (macOS-first) shell
- [anvil-server/README.md](../anvil-server/README.md) — the menu-bar control panel
- [scripts/README.md](../scripts/README.md) — build/release utilities (CI release notes, Apple signing)
