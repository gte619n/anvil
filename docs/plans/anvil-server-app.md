# Anvil Server.app — macOS setup & fleet control panel

**Version:** 0.1-draft
**Created:** 2026-06-23
**Status:** DESIGN — not started
**Extends:** `anvil-multi-server.md` (§4.1 discovery, §7 auth, §8 security, §9 packaging),
`anvil-native-architecture.md` (§3 auth — load-bearing), `anvil-impl-6-push-tailscale-ops.md`
(LaunchAgent, `tailscale serve`, env injection), `anvild/scripts/service.sh`.

---

## 0. Summary

`anvild` is a headless daemon today: you stand it up with `claude setup-token`, a hand-written
`~/.config/anvil/env`, and `scripts/service.sh install`. That's fine for the author and impossible
for everyone else. **Anvil Server.app** is a macOS menu-bar app that turns "set up a Mac as an Anvil
server" into a click-through wizard, and turns "add my other Macs to the fleet" into a pairing flow —
so a non-technical person can run a multi-Mac fleet.

It is the **friendly face of `service.sh`**, not a replacement for the daemon. The daemon stays
headless and authoritative; the app installs it, configures it, distributes the shared credential,
and shows its health.

**Locked from the multi-server interview + this thread:**
| # | Decision | Choice |
|---|----------|--------|
| SA-1 | Form | **Menu-bar agent app** (SwiftUI/`MenuBarExtra`) wrapping the headless daemon. Not a windowed app, not a DMG-of-a-GUI. |
| SA-2 | Fleet join | **Managed from the app** via a pairing flow over the tailnet (hub pushes the shared token to a joiner that displays a code). |
| SA-3 | Credential | **OAuth subscription token only** (`CLAUDE_CODE_OAUTH_TOKEN`). The app never collects or sets an API key (would meter billing — arch §3). |
| SA-4 | Packaging | **Self-contained via embedded Bun + source + node_modules** (spike resolved — §3.1: full `--compile` doesn't boot due to runtime data-file deps; the SDK-spawn issue itself is solvable). The `.app` ships the daemon source + Bun + `web/dist` + the native `claude` CLI; installs/guides Tailscale. |

---

## 1. What it does / doesn't

**Does:** install dependencies; capture the OAuth token (login *or* join); guarantee the §3 auth
invariant; write the LaunchAgent + launcher; run `tailscale serve`; name the server; show health,
URL, and budget; Start/Stop/Restart/Update; **add other Macs to the fleet** (token distribution);
rotate the token across the fleet when it expires.

**Doesn't:** drive Claude sessions (that's the *client* — web hub today, the Apple client in
impl-5); run on Linux (headless servers keep `service.sh`/systemd — §8); hold an API key; replace the
daemon's own `/api/daemon/update` self-update (it triggers it).

The split, in one line: **Server.app administers a machine; the client connects to sessions.** A
person may run both on the same Mac (it's the hub), but they're different layers.

---

## 2. Form factor

- **`MenuBarExtra` (SwiftUI) agent**, `LSUIElement` (no Dock icon). Always running, so it can host the
  pairing receiver (§4) and watch daemon health.
- The menu-bar **icon encodes health**: green (healthy), amber (starting / budget warning), red
  (down / auth invalid), grey (stopped).
- Everything is reachable from the dropdown; the first-run wizard opens a transient window.

---

## 3. Packaging & dependencies

Goal: double-click `Anvil Server.app`, get a running server in minutes, no terminal.

### 3.1 The daemon binary — spike RESOLVED (2026-06-23)

**Decision: embed Bun runtime + daemon source + `node_modules` (Fallback A), not a single
`--compile` binary.** Run `test/tools/compile-spike.ts` to reproduce. Findings:

1. **The Agent-SDK spawn under `--compile` is solvable** ✅. The SDK locates its CLI via
   `import.meta.url` → `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude`, which a
   compiled binary lacks ("Native CLI binary for darwin-arm64 not found"). Shipping that native
   `claude` binary (~216 MB, self-contained — **no `bun` needed**) and setting `ANVIL_CLI_PATH`
   (→ `options.pathToClaudeCodeExecutable`, wired in `src/agent/cli.ts`) makes the compiled binary
   spawn turns. *Verified: compiled spike + native CLI → a turn starts.*
2. **But a naive full `--compile` of the daemon does NOT boot** ❌. Transitive deps load data files
   at runtime that the bundler doesn't trace — first hit: `css-tree/data/patch.json` ("Cannot find
   module … from /$bunfs/root"). With ~1650 modules, more such assets are likely; chasing each
   (embed/external per file) is fragile and breaks as deps change.
3. **So: ship source, install deps on first run.** The app ships **slim** (~18 MB — daemon source +
   prebuilt `web/dist` + `bun.lock`, **no `node_modules`**; bundling them was ~520 MB, dominated by
   the 206 MB native Claude CLI + 80 MB mermaid + 23 MB typescript, none of which belong in a
   download). `Provision` copies the source to `~/.local/share/anvil/anvild` (stable + writable, not
   inside the signed/movable `.app`) and runs **`bun install --frozen-lockfile`** so deps come down at
   the EXACT versions `bun.lock` pins (~250 MB, once, on the user's machine). A `.anvil-app-version`
   marker (the bundled `package.json` version) triggers re-provision on app upgrade. With
   `node_modules` then present the SDK resolves its own CLI normally (`ANVIL_CLI_PATH` optional). Bun
   is installed (pinned) by the wizard if absent.

Daemon changes landed for either path (backward-compatible): `src/agent/cli.ts`
(`claudeCliOptions()` → `executable:"bun"` in dev, `pathToClaudeCodeExecutable` when `ANVIL_CLI_PATH`
set; used by `driver.ts` + `icon.ts`), and `ANVIL_WEB_DIR` override in `src/server/http.ts`.

The `claude` CLI for `setup-token` (login) comes from the same shipped native binary / the SDK's
vendored CLI, so login works with nothing pre-installed.

### 3.2 Tailscale

The fleet boundary is the tailnet (§8), so Tailscale is required. The app **detects** it
(`tailscale` CLI / `Tailscale.app`); if missing, it **guides** install (Homebrew or the signed
download) and asks the user to log in via Tailscale's own UI (we can't automate their auth). It never
ships its own copy. After login it reads tailnet state via the CLI / LocalAPI (already used by
`service.sh` and discovery §4.1).

### 3.3 What lands on disk (unchanged from `service.sh`)

`~/.config/anvil/env` (token, `chmod 600`), `~/.local/bin/anvild-launch` (the launcher that unsets
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and sources the env — arch §3), the LaunchAgent plist
(`com.anvil.anvild`), state in `~/.local/state/anvil`. **The app owns the exact same artifacts as
`service.sh`** (it can shell to a bundled copy of the script for parity, or reimplement in Swift) so
the two never diverge.

---

## 4. Fleet join & token distribution (the crux)

This is what "handle the OAuth token across both servers" means. MS-2 reuses **one** token on every
server; the app's job is to get that one token onto each Mac and keep it current.

### 4.0 The wrinkle that shapes everything

The auth guard (`src/auth/guard.ts` → `assertSubscriptionAuth`) makes `anvild` **exit at startup if
no token is present**. So a freshly-installed Mac has *no running daemon* to receive a token. The
pairing receiver therefore lives in the **always-running app**, not the daemon. The app accepts the
token, writes the env, *then* starts the daemon for the first time.

### 4.1 Two roles

- **Establish a fleet** (first Mac → hub): the wizard runs `claude setup-token` (browser OAuth),
  writes the token, starts the daemon. This Mac now holds the canonical credential.
- **Join a fleet** (every other Mac): no login — it **receives** the token from the hub via pairing.

### 4.2 The pairing handshake (mirrors the shipped ADB pairing UX)

We already pair a Mac to a phone with a 6-digit code (`/api/adb/pair`, Settings → Servers). Reuse the
exact mental model — **the device being added shows a code; the trusted device approves it.**

1. **Joiner** (new Mac): wizard → "Join a fleet." The app opens a **short-lived pairing listener on a
   dedicated tailnet port** (e.g. `7702`, via `tailscale serve --https=7702` for the window) and
   displays: *"On your main Mac: Anvil → Add a Mac → enter code **482 913**. This Mac:
   `joiner.tailnet.ts.net`."* It waits (single window, code expires).
2. **Hub**: dropdown → "Add a Mac to the fleet." The hub lists tailnet peers advertising the pairing
   service (it can reuse discovery §4.1 to find candidates) — pick the joiner, **enter its 6-digit
   code**, confirm. Approving here is the security-meaningful act: *"release MY token to that
   specific Mac."*
3. **Push**: hub `POST https://joiner.tailnet.ts.net:7702/anvil-pair`
   `{ code, token, fleetName, hubServerId }`.
4. **Joiner** validates the code → writes `~/.config/anvil/env` (`600`) → **asserts no API key** →
   installs + starts the daemon → `tailscale serve --https=7701` → replies `{ ok, serverId, url,
   serverName }` → tears down the pairing listener.
5. **Hub** records the new member in its fleet registry (§6) and (web hub) the client discovers it via
   `/api/fleet/discover`.

Result: one login on the hub, N machines joined, each running and reachable — no terminal, no copied
secrets by hand.

### 4.3 Security of the handshake

- **Transit:** WireGuard-encrypted (tailnet) + Tailscale per-node TLS. Only tailnet devices can reach
  `:7702`.
- **The code** gives mutual, human-confirmed intent (right fleet ↔ right Mac), is short-lived, and is
  single-attempt — it stops a wrong/hostile node on a *shared* tailnet from being handed the token, or
  the joiner from accepting a stranger's token.
- **Identity hardening (implemented):** `tailscale serve` terminates TLS at tailscaled and proxies to
  the listener over localhost, so the socket peer is `127.0.0.1` — but it injects a
  **`Tailscale-User-Login`** header identifying the caller's tailnet user. The listener compares that
  to this node's own owner (`tailscale status --json` → Self.UserID → User[…].LoginName); a request
  from a *different* tailnet user is rejected even with a correct code. (This supersedes the earlier
  "whois the socket IP" idea, which the serve-proxy makes meaningless.)
- The token is a bearer secret living on N disks — exactly the posture multi-server §8 already accepts;
  pairing doesn't widen it beyond the documented blast radius.

### 4.4 Rotation & expiry (implemented)

`setup-token` issues a ~1-year OAuth token (impl-1). When it expires (or `subscriptionAuthOk` flips
false / turns start failing with auth errors), **the whole fleet breaks at once** (shared credential).
Implemented flow: on the hub, **Re-login** re-runs `setup-token`; saving the new token automatically
**rotates it to every recorded member** (`FleetRegistry`, §6) by pushing to each member's
**`POST /anvil-token`**. That route is **identity-gated, not code-gated**: it requires the same tailnet
user (the serve header, §4.3) *and* a `hubServerId` matching the hub recorded at first join — so the
hub can refresh the token unattended, but a stranger can't. To make this work, each member runs a
**persistent** fleet-control listener (not just during the join window) — see the §7 posture note.

---

## 5. First-run wizard

1. **Welcome / role** — "Set up this Mac as an Anvil server" → *Establish a new fleet* or *Join an
   existing fleet*.
2. **Dependencies** — check/install the daemon binary (or Bun+source fallback) and Tailscale; wait for
   Tailscale login.
3. **Auth** — *Establish*: run `claude setup-token` (opens browser), capture token. *Join*: show
   pairing code + name, wait for the hub (§4.2).
4. **Guard** — assert `ANTHROPIC_API_KEY` absent; write token to `~/.config/anvil/env` (`600`).
5. **Serve** — `tailscale serve --https=7701`.
6. **Name** — server name (default hostname → `ANVIL_SERVER_NAME` / the persisted `serverId` from the
   identity work).
7. **Start** — write launcher + LaunchAgent, `bootstrap` + `kickstart -k`, wait for
   `/api/health` → `subscriptionAuthOk:true`.
8. **Done** — show the MagicDNS URL + a "copy / open in client" affordance, and (hub) an "Add a Mac"
   button.

---

## 6. Steady-state UI & fleet registry

**Menu dropdown:** server name + health dot; MagicDNS URL (copy); budget summary (Opus/Sonnet
remaining — arch §3); **Start / Stop / Restart**; **Update** (triggers `/api/daemon/update` — respect
the self-update crash-safety rules: `launchctl kickstart -k`, atomic web build); **Add a Mac to the
fleet**; **Re-login & update fleet** (§4.4); **Open client**; **View logs**; **Quit**.

**Fleet registry (app-side):** the hub app persists fleet membership — `{ serverId, serverName, url,
lastSeenOnline }` — in its Application Support dir. This is the source of truth for *administration*
(who gets a rotated token). It overlaps with, but is distinct from, the **client's** connection
registry (§4 of multi-server, localStorage) used to *connect to sessions*. They can seed each other,
but keep the layers separate: Server.app = machine admin, client = session access.

---

## 7. Security posture (delta from multi-server §8)

- Boundary unchanged: tailnet only; daemon binds `127.0.0.1` + `tailscale serve`.
- **New surface — the fleet-control listener on `:7702`.** Originally scoped to "open only during a
  join window," but **token rotation (§4.4) requires it to be persistent on members** so the hub can
  push a refreshed token unattended. So: a joined Mac keeps `:7702` served for the app's lifetime.
  Mitigations — every request is gated by the `Tailscale-User-Login` serve header (same tailnet user,
  §4.3); `/anvil-pair` additionally needs a live 6-digit code (only during a join); `/anvil-token`
  additionally needs a `hubServerId` matching the hub recorded at join. A Mac that has never joined
  doesn't open the listener at all. Net: a small, identity-gated standing surface, reachable only by
  your own tailnet nodes — an accepted trade for unattended rotation.
- **Same token on N disks** — pairing automates distribution but doesn't change the blast radius §8
  already documents. `chmod 600` enforced by the app. Per-machine tokens remain the eventual better
  answer if/when the platform allows it.
- The app **guarantees the §3 invariant** on every machine (writes the OAuth token, asserts no API
  key) — making the load-bearing constraint a property of the install, not of operator discipline.

---

## 8. Build & distribution

- **Signed + notarized** `.app` (Developer ID), Gatekeeper-clean, distributed as a DMG/zip or via a
  Sparkle-style updater. (This is the only place a DMG appears — for the *app*, not the daemon; cf.
  multi-server §9, which correctly rejected a DMG *for the headless daemon*.)
- App self-update via Sparkle; the embedded daemon updates via its existing `/api/daemon/update`
  (crash-safety memo applies). Keep the app and the daemon binary versions visible in the dropdown.
- macOS only (SA-1). The headless `service.sh`/systemd path stays for Linux/CI/headless boxes.

---

## 9. Phased plan

0. **Compile spike (gates SA-4):** ✅ **done** (§3.1). Verdict: ship **Bun + source + node_modules**
   (full `--compile` doesn't boot due to runtime data-file deps; the SDK-spawn issue is solvable on
   its own). Daemon made packaging-ready: `ANVIL_CLI_PATH` (`src/agent/cli.ts`) + `ANVIL_WEB_DIR`.
1–4. ✅ **built** (branch `multi-server-impl`, `anvil-server/` — SwiftPM, compiles with CLT, runtime
   not yet exercised on a GUI Mac):
   - **Wizard** (Establish/Join), menu-bar shell (NSStatusItem + SwiftUI popover, health-tinted icon),
     daemon control via `service.sh`, `/api/health` polling, `tailscale serve`.
   - **Pairing + join** — persistent `:7702` fleet-control listener (Network framework), 6-digit code,
     write-token-then-install.
   - **Hub "Add a Mac" + `FleetRegistry`** (§6) — push token, persist membership.
   - **Rotation + identity hardening** (§4.4/§4.3) — re-login re-pushes to members via `/anvil-token`,
     gated by the `Tailscale-User-Login` serve header + recorded `hubServerId`.
5. **Polish/distribution:** notarization, Sparkle, budget surfacing in-menu, logs viewer — *not done*.

---

## 10. Open questions / risks

- ~~**[gating] Compiled-binary Agent-SDK spawn** (§3.1)~~ — **resolved** (2026-06-23): SDK spawn is
  solvable (`ANVIL_CLI_PATH` → native CLI), but full `--compile` doesn't boot (runtime data-file
  deps), so packaging is Bun + source + node_modules. See §3.1.
- **Pairing direction & UX** — built as: joiner shows code, hub approves (mirrors ADB). Confirm it
  reads naturally for "regular people" once run on real hardware.
- **Pairing transport** — built as `tailscale serve --https=7702` → a local Network-framework listener
  (identity from the injected `Tailscale-User-Login` header). Now **persistent** on members for
  rotation (§7), not just during the join window.
- **Runtime verification** — the whole app is compile-verified only; the pairing handshake,
  `setup-token` capture, and `launchctl`/`tailscale serve` flows need a live run on a GUI Mac.
- **Token lifetime / refresh** — confirm the real `setup-token` lifetime and whether a refresh exists;
  shapes §4.4 (re-login cadence).
- **Membership authority** — app-side registry vs. client localStorage vs. a tiny shared store. v1:
  app-side per §6; revisit if the client and app drift.
- **Tailscale login is out of our hands** — the wizard can guide but not automate Tailscale auth;
  acceptable, but it's a step the user must complete in another app.
```
