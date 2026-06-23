# Anvil Server.app

macOS menu-bar control panel that stands up and manages the headless `anvild` daemon, and joins Macs
into a fleet — so a non-technical person can run a multi-Mac Anvil setup without a terminal.

Design: [`docs/plans/anvil-server-app.md`](../docs/plans/anvil-server-app.md). It's the friendly face
of `anvild/scripts/service.sh` (it shells out to `service.sh`, `tailscale`, `claude`, `launchctl`).

## Status

**Compiles cleanly (`swift build`); runtime behavior is not yet verified end-to-end** — it needs to be
run on a real Mac with a GUI session (this was authored in a headless environment). Treat as a first
cut of Phases 5B (single-server wizard) + 6B (fleet join/pairing).

## Build & run (dev)

Requires the Swift toolchain (Command Line Tools is enough — no full Xcode):

```sh
swift build                 # compile
./make-app.sh               # assemble + ad-hoc-sign "Anvil Server.app"
open "Anvil Server.app"
```

First run: the app needs to know where the `anvild` checkout is (for `service.sh`). It looks at, in
order: the `anvildDir` setting → `ANVILD_DIR` env → a bundled `Contents/Resources/anvild` → a
dev-checkout guess (`~/Development/zellij-android/anvild`). For dev:

```sh
ANVILD_DIR=/path/to/anvild open "Anvil Server.app"
```

Ad-hoc signing means Gatekeeper may warn on first open (right-click → Open). A distributable,
notarized DMG needs a Developer ID (design §8) — not wired yet.

## What it does

- **Menu bar:** health dot (green/yellow/orange/grey), server name + tailnet URL, budget warning,
  Start/Restart, Open client, Add a Mac, Settings, Quit.
- **First-run wizard:** *Establish a fleet* (`claude setup-token` → paste token → write
  `~/.config/anvil/env` 0600 → `service.sh install` → `tailscale serve`) or *Join a fleet* (show a
  6-digit code + this Mac's MagicDNS name; receive the token from the hub).
- **Add a Mac (hub):** enter the joiner's tailnet name + its code → push the OAuth token over the
  tailnet to its pairing listener (`:7702`, code-gated, WireGuard-encrypted — design §4.3).

## Known gaps / next

- **Runtime-untested** (see Status). The pairing HTTP listener, `claude setup-token` capture, and
  `launchctl` flows need a live run.
- **`claude setup-token`** is launched in Terminal and the token is pasted back (it needs a browser +
  TTY); a fully in-app capture is a later refinement.
- **Token rotation** across the fleet (Phase 7B) and **Tailscale `whois` hardening** of pairing
  (design §4.3) are not implemented yet.
- **Notarization / Sparkle updates** (design §8) — not wired.
