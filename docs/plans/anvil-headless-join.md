# Anvil Headless Join — tokenless boot + in-UI fleet pairing

**Version:** 1.1
**Created:** 2026-07-21
**Status:** SPEC COMPLETE — implementation not started
**Extends:** `anvil-multi-server.md` (MS-2 shared token), `anvil-server-app.md` (§4 pairing & token
distribution), `anvil-native-architecture.md` (§3 auth/billing guard)

> **Changelog**
> **v0.1** initial draft — joiner-initiated pull + CLI join.
> **v0.2** reversed to hub-initiated push with the code in the joiner's web UI; dropped the CLI (§3.2).
> **v0.3** HJ-8: `service.sh install` stays the Linux bootstrap (§3.3).
> **v0.4** HJ-9: reuse existing discovery, no new advertisement (§3.4). HJ-10: confirm-and-overwrite (§3.5).
> **v1.0** decisions HJ-11…HJ-34 locked via design interview; added testing strategy (§9), definition
> of done (§10), and the phase tracking ledger (§11).
> **v1.1** spec review against the code. HJ-32 **reversed** — capability tag instead of a version bump
> (§3.5). New: HJ-35 persisted degrade marker, HJ-36 browser-only takeover for v1, HJ-37 header trusted
> only from loopback, HJ-38 `:7702` rotation leg mocked-only by decision. Corrected §7 identity order,
> HJ-15's fallback trigger, §9.2's degraded-boot recipe, and §9.3 step 14.

---

## 0. Summary

Anvil can only add a machine to a fleet if that machine is a **Mac running Anvil Server.app**. The
token-receiving listener lives in the Swift menu-bar app, not the daemon, so a headless Linux box has
no way to be handed the fleet credential — and no way to boot without one.

This spec removes that limitation:

1. **Tokenless boot** — `anvild` starts in a degraded, clearly-reported state when no token is
   present, instead of exiting.
2. **In-UI pairing** — the tokenless machine's web UI offers *"join a fleet"* (shows a code) or
   *"enter a token directly."* The hub adds the machine, confirms the code, and pushes credentials.
3. **Credential lifecycle** — rotation reaches non-Mac members, and an expired token auto-degrades
   the daemon back into the same setup flow.

**No new shell scripts.** After the one-time install, every step happens in a web UI.

---

## 1. Why

The immediate driver: `beelink-4450`, a headless Linux box, should join an existing fleet of Macs.
`anvild` supports Linux/systemd already (`scripts/service.sh` has a full `svc_*` path), but the
*join* story is macOS-only. More generally, "joining a fleet" depends on a GUI app that exists on
exactly one platform, which excludes any always-on build box — Linux, a VM, a container.

### 1.1 The wrinkle, restated

`anvil-server-app.md` §4.0 ("The wrinkle that shapes everything"):

> The auth guard (`src/auth/guard.ts` → `assertSubscriptionAuth`) makes `anvild` **exit at startup if
> no token is present**. So a freshly-installed Mac has *no running daemon* to receive a token. The
> pairing receiver therefore lives in the **always-running app**, not the daemon.

Every downstream complication — the separate `:7702` port, the standalone Swift listener, its own
HTTP parser and identity checks, the macOS-only dependency — descends from that one line. **Phase 1
removes the premise.**

---

## 2. Findings

Established by reading and by running the daemon (2026-07-21):

| # | Finding | Evidence |
|---|---------|----------|
| F1 | Nothing in install or boot requires a *valid* token — only a **non-empty string**. | Booted `src/main.ts` with `CLAUDE_CODE_OAUTH_TOKEN=placeholder-not-a-real-token`; daemon came up fully: serverId minted, sessions restored, WS listening. |
| F2 | `subscriptionAuthOk` currently **lies**. | Same run reported `{"ok":true,"subscriptionAuthOk":true,…}` with a garbage token. `checkAuth()` is presence-only. |
| F3 | The token is first genuinely used at **session spawn**, not at boot. | `buildAgentEnv()` (`src/agent/env.ts:40`) reads `opts.src ?? process.env` per-spawn. |
| F4 | A token set at runtime takes effect **without a restart**. | `setClaudeToken()` (`src/auth/store.ts:53`) updates `process.env` *and* the env file; F3 does the rest. |
| F5 | The installer only checks the env file **exists** — never reads it. | `scripts/service.sh:305` is `[ -f "$CONFIG_ENV" ]`. |
| F6 | The `:7702` pairing listener is macOS-only. | `anvil-server/Sources/AnvilServer/Pairing.swift`. Nothing in `anvild/src` binds 7702. |
| F7 | Hub-side discovery **already finds a tokenless daemon**. | `discoverFleet()` (`fleet.ts:174`) enumerates tailnet peers and probes `/api/health`; F1 shows a tokenless daemon answers with `serverId`/`serverName`/`version`. |

F1–F4 mean Phase 1 is a small change to a system that already behaves correctly in the degraded
state — it simply refuses to enter it.

---

## 3. Decisions

### 3.1 Boot & auth state

| # | Decision | Choice |
|---|----------|--------|
| HJ-1 | Boot with no token | **Warn + run degraded.** Sessions refuse to spawn with an explicit error. |
| HJ-2 | Boot with `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | **Stays fatal — unchanged.** |
| HJ-23 | Detecting an expired/revoked token | **Auto-degrade**: an auth-class spawn failure flips the daemon into the same degraded state, recoverable by re-pairing. |
| HJ-28 | Auto-degrade trigger rule | **Explicit auth errors only (401/403-class), N=2 consecutive.** Never network, timeout, or rate-limit errors. |
| HJ-11 | In-flight sessions when the token changes | **Auto-restart idle sessions**; sessions mid-turn are left alone and flagged in the UI. |
| HJ-12 | Scheduled work (autopilot/cron) while degraded | **Suppress, with one alert.** No repeated failures, no silent stop. |
| HJ-25 | What degraded mode restricts | **Nothing.** Terminal, file API, and git keep working (§8.3). |
| HJ-35 | Degraded state across a restart | **Persist a marker** in `stateDir`. The launcher re-sources the env file on every start, so an in-memory flag would evaporate (§4.6). |

### 3.2 Pairing

| # | Decision | Choice |
|---|----------|--------|
| HJ-3 | Join direction | **Hub pushes to joiner**, code shown in the joiner's own web UI. |
| HJ-4 | Transport | The existing **`:7701` daemon API**. No new port, no new listener process. |
| HJ-5 | macOS join flow | **Unchanged.** `:7702` + Server.app keeps working. |
| HJ-6 | Token distribution model | Unchanged from MS-2 — **one token, copied to every server**. |
| HJ-7 | Operator surface *after* install | **Web UI only.** No CLI join command; no new shell scripts. |
| HJ-8 | Getting `anvild` onto a new Linux box | **`service.sh install` stays the bootstrap.** |
| HJ-9 | How the hub finds a pairable machine | **Existing `discoverFleet()`.** Carry `subscriptionAuthOk` into `DiscoveredServer` to label it. |
| HJ-10 | Pairing over an existing token | **Confirm and overwrite**, consented at the joiner when arming. |
| HJ-13 | Where the pairing code is shown | **Joiner's web UI only.** No log/CLI fallback — the code lives in exactly one place. |
| HJ-14 | Multi-hub membership | **Single hub.** Re-pairing to a different hub is allowed, but the joiner warns it will detach from the current one. |
| HJ-15 | Push destination order | **Capability-directed, with a 404 fallback**: use `:7701` when health advertises `pairing`, else `:7702`; also fall back on 404/405 from `:7701` (§5.4). |
| HJ-16 | Partial pair (lost reply) | **Stay armed until the hub ACKs**, bounded by HJ-17. |
| HJ-17 | Bounding the armed window | **Lock to hub after first use**: once a valid code is accepted, the window only accepts a retry carrying the *same* `hubServerId` + code, until ACK or TTL. |
| HJ-21 | Degraded web UI | **Full-screen takeover** until authed. |
| HJ-36 | Takeover on native clients | **Browser-only for v1.** The shells bundle their own `web/dist`, so the takeover reaches them only after an app re-ship — out of scope for this PR (§5.1). |
| HJ-37 | Trusting `Tailscale-User-Login` | **Only from a loopback peer** (i.e. `tailscale serve` injected it). On a direct tailnet bind the header is caller-controlled and must be ignored (§7). |
| HJ-24 | Sibling secrets | **Push all on pair** — Claude + Todoist + OpenRouter in one payload. |
| HJ-27 | Sibling key conflict | **Overwrite everything.** Joining a fleet means adopting its config. |
| HJ-26 | Seeding the joiner's server registry | **Joiner stays standalone.** `hubServerId` is recorded for rotation gating only. |

### 3.3 Notifications & process

| # | Decision | Choice |
|---|----------|--------|
| HJ-29 | Notify on | **auto-degrade fired · pair succeeded · pair rejected · scheduled work suppressed** |
| HJ-33 | Rejection-notification abuse | **Coalesce per window**: at most one per armed window (with a count); an *unarmed* machine logs but never notifies. |
| HJ-18 | Automated test topology | **Unit + mocked HTTP** (matches existing `fleet.ts` injectable seams). |
| HJ-20 | Functional proof | **Scripted manual E2E gate** (§9.3) with captured evidence. |
| HJ-19 | Tracking | **In-spec ledger + pasted verification evidence** (§11). |
| HJ-38 | Proving the `:7702` rotation leg | **Mocked coverage only — accepted.** It is reachable only from a pre-capability member, a state the rollout closes; the release will not be gated on holding a Mac back (§9.3). |
| HJ-22 | Shipping | **One PR, all phases.** Phases are development/tracking units, not separate releases. |
| HJ-30 | Meaning of "Pushed" | **Merged AND deployed AND verified live** on at least one real machine. |
| HJ-31 | `beelink-4450` sequencing | **Leave tokenless until the feature ships** — it is the E2E fixture. |
| HJ-32 | Protocol change | **No `PROTOCOL_VERSION` bump.** Add a `pairing` tag to `SERVER_CAPABILITIES` and expose `capabilities` on `/api/health` (§3.5). *Reversed in v1.1.* |
| HJ-34 | Extra DoD gates | Tracking updated in-PR · user-facing docs updated · rollback path stated · security review of gates. |

### 3.4 Rationale for the non-obvious choices

**HJ-1/HJ-2 (the split).** §3's purpose is preventing **metered billing**, not preventing **no
billing**. A stray API key silently bills per-token and must stay fatal. An absent token cannot cause
a surprise charge — its only consequence is that turns don't run. The distinction is already latent
in the protocol: `/api/health` returns `ok` and `subscriptionAuthOk` as **separate fields**
(`http.ts:326-327`). The shape has always modelled "up but unauthed"; there was no way to reach it.

**HJ-3 (push, not pull).** The joiner already has a UI — §4.5. "Headless" means no *local* screen,
not no interface. Push also matches the shipped mental model (`anvil-server-app.md` §4.2: *"the
device being added shows a code; the trusted device approves it"*) and is a smaller diff, since
`inviteMac()` (`fleet.ts:259`) already implements hub-side push; only its destination changes.

**HJ-8 (install stays a terminal step).** The install is a one-time, per-machine act on a box you
already have shell access to — you had to SSH in to create the user, place keys, and join the
tailnet. A curl-pipe installer adds a distribution artifact and a trust surface to save one command.
The recurring, phone-friendly part is the *join*, and that moves into the UI.

**HJ-9 (no new discovery).** `discoverFleet()` already enumerates tailnet peers and probes health;
F7 confirms a tokenless daemon answers. An honest `subscriptionAuthOk` already *means* "needs a
token", so a separate "pairable" advertisement would be a second signal that could disagree with
health. We deliberately do **not** expose arm-state on unauthenticated health — that would broadcast
an open credential window to the whole tailnet.

**HJ-10 (consent at the joiner).** The hub operator can't see what they'd be clobbering. Arming is
already a deliberate human act in the joiner's UI, so that screen carries the warning and proceeding
is the consent.

**HJ-16 + HJ-17 (partial pair).** Staying armed until ACK closes the lost-reply hole where a joiner
is authed but unrecorded and the consumed code no longer works. Left unbounded it would contradict
§8.2's default-closed posture — so after the first accepted code the window narrows to a *single
known caller*, which is a strictly smaller surface than a fresh armed window.

**HJ-23 (auto-degrade).** Expiry then self-presents as the setup screen and is recovered by
re-pairing, reusing the entire Phase 2 flow instead of inventing a repair path.

**HJ-35 (why a marker file).** §4.6 deliberately leaves the dead token in the env file so the operator
can inspect it — but the launcher does `set -a; . ~/.config/anvil/env` on *every* start, and
`loadPersistedClaudeToken()` (`main.ts:15`) reloads that key even in a dev run. Without a durable
marker, any restart comes back looking authed, the takeover screen vanishes, and the box re-degrades
only after burning two more turns — repeating on every reboot. That is the exact failure mode the
headless fixture would hit most.

**HJ-36 (browser-only takeover).** `anvild/web/bundle-native.ts` embeds `web/dist` into the Android and
Apple shells at *their* build time, so a daemon-side UI change never reaches an installed app. Making
the takeover visible in the apps means shipping two release pipelines, which contradicts HJ-22's
one-PR scope. The joiner is reachable at `https://<host>:7701` from any browser, which is all the
pairing flow needs.

**HJ-37 (loopback-only header trust).** `Tailscale-User-Login` is trustworthy *because
`tailscale serve` injects it* — it is not an authenticated field on the wire. `setup_serve`
(`service.sh:134`) falls back to binding the tailnet IP directly when serve is unavailable (the
sandboxed App Store Tailscale), and `fleet.ts:231` documents that mode as load-bearing. On a direct
bind, any tailnet peer can set the header itself; trusting it first would let a forged header defeat
the `whois` check entirely. Loopback is the only context in which the header could have come from the
proxy.

### 3.5 HJ-32 reversed — capability tag, not a version bump

The v1.0 decision was to bump `PROTOCOL_VERSION`. Reading the code, that is both **unnecessary and
misleading**, and it leaves a real problem unsolved:

- **Nothing consumes it.** `protocolVersion` is only *set* (`identity.ts:89`) and asserted in tests;
  no client negotiates on it. `anvil-improvement-program.md` `[NAT-11]` lists version negotiation as
  unbuilt.
- **The golden doesn't cover this change.** `test/contract/protocol-surface.golden.json` pins
  `wireTypes` — the WS event set. This spec adds REST routes and one optional field on
  `DiscoveredServer`; no WS event changes shape.
- **A bump signals a break that doesn't exist**, and every envelope carries `v` (`session.ts:91`), so
  it is a fleet-wide cosmetic change for no reader.
- **It solves nothing.** The hub still can't tell whether a peer speaks `:7701` pairing.

`SERVER_CAPABILITIES` (`identity.ts:79`) is the mechanism the repo already built for exactly this, and
its own comment says so: *"PROTOCOL_VERSION can't serve this — it's a single frozen number, so it
can't express 'supports X but not Y' across a partially-updated fleet."* So:

- Add `"pairing"` to `SERVER_CAPABILITIES`.
- Add `capabilities: string[]` to `HealthResponse` (it is currently WS-hello-only, and discovery is
  REST — the hub has no WS session with a machine it hasn't joined yet).
- `discoverFleet()` carries it through `ProbeResult` alongside `subscriptionAuthOk` (HJ-9).

The hub then *knows* the destination instead of guessing, which is what HJ-15 needs. Absent
capabilities (a pre-capability daemon) means `:7702`.

---

## 4. Phase 1 — Degraded boot

### 4.1 Guard

Split the outcomes in `src/auth/guard.ts`. Note `guard.ts` already exports an interface named
`AuthStatus`, and `auth/store.ts` exports a *different* type with the same name — name the new one
**`GuardStatus`** rather than widening either:

```
checkAuth() → GuardStatus { subscriptionAuthOk: boolean; fatal: boolean; reason?: string }
```

The two axes are independent, so all four combinations are defined explicitly:

| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | OAuth token | `fatal` | `subscriptionAuthOk` |
|---|---|---|---|
| set | any | **true** | `false` (moot — the process exits) |
| unset | plausible | false | **true** |
| unset | absent/empty | false | **false** |
| unset | present but `sk-ant-api…` | false | **false** (§4.2) |

- `fatal: true` → `assertSubscriptionAuth()` keeps calling `process.exit(1)`. **No behaviour change.
  Regression-critical.**
- `fatal: false, subscriptionAuthOk: false` → log a prominent warning and continue to
  `createServer()`.

Reporting `subscriptionAuthOk: false` on the fatal path (rather than leaving it undefined) keeps
`/api/health` total, even though that branch is unreachable from a running daemon.

Ordering (`loadPersistedClaudeToken()` at `main.ts:15`, guard at `:21`) is unchanged, except that the
degrade marker (§4.6) is consulted between them.

### 4.2 Honest health (narrows F2)

`subscriptionAuthOk` must mean "a plausible subscription token is present". Reuse
`looksLikeMeteredKey()` (`store.ts:34`); report `false` for empty *and* `sk-ant-api…`. No network
validation — revocation is caught at spawn instead (§4.6).

**This narrows F2 rather than closing it.** `looksLikeMeteredKey` only matches `sk-ant-api…`, so F1's
literal fixture (`placeholder-not-a-real-token`) still reports `subscriptionAuthOk: true` until a turn
actually fails. Statically, "honest" can only mean *well-formed*; §4.6 is what makes the flag
eventually truthful about a token that is merely wrong. Don't read §4.2 as a validity check.

Also add `capabilities: string[]` to `HealthResponse`, sourced from `SERVER_CAPABILITIES` (HJ-32,
§3.5) — the same route change, and what §5.4 routes on.

### 4.3 Fail loudly at spawn

`buildAgentEnv()` silently omits the key when empty (`env.ts:60-61`), producing an opaque SDK
failure. Add an explicit precondition for the `claude` profile, mirroring the `glm` profile's
existing `OPENROUTER_API_KEY` check (`env.ts:56`):

> `no Claude OAuth token — pair this machine with your fleet, or set a token in Settings → Auth.`

### 4.4 Installer

`service.sh:305` stops hard-failing when `~/.config/anvil/env` is missing — create `~/.config/anvil`
at mode `700` and the env file at mode `600` (`umask 077`), then continue. The launcher's
`set -a; . "$CONFIG_ENV"` is happy with an empty file. A **deletion of a check**, not a new script
(HJ-7/HJ-8).

### 4.5 "Headless" ≠ "no UI"

Once the daemon boots it serves the full web client on the tailnet:
`https://<machine>.<tailnet>.ts.net:7701`. That is where the pairing code is shown (HJ-13) and where
a token can be pasted directly.

### 4.6 Auto-degrade on credential failure (HJ-23, HJ-28, HJ-35)

Classify spawn failures. On the **second consecutive auth-class (401/403) failure**, clear the live
token from `process.env`, write the degrade marker, flip to degraded, and notify (HJ-29). Network,
timeout, and rate-limit failures never count.

**The marker is what makes this survive a restart (HJ-35).** Clearing `process.env` alone does not:
the launcher sources `~/.config/anvil/env` on every start, and `loadPersistedClaudeToken()` reloads
that key even when it doesn't. Without a marker the daemon returns looking authed and re-degrades only
after two more failed turns — on every reboot.

```
<stateDir>/auth-degraded      # ~/.anvil/auth-degraded, mode 600
{ "at": "<iso8601>", "reason": "2 consecutive auth failures (401)", "masked": "sk-ant-oa…9f21" }
```

- **Written** by the auto-degrade path only. Never by an absent token — an empty env file is already
  self-evidently degraded, and a marker there would be a second source of truth (cf. HJ-9's argument
  against a second signal).
- **Read** in `main.ts` *after* `loadPersistedClaudeToken()` and *before* the guard. Present ⇒ degraded
  regardless of what the env file carried, and the loaded token is dropped from `process.env` again so
  no spawn can pick it up.
- **Cleared** by any successful credential write: `setClaudeToken()` (direct paste, §5.1), a successful
  pair (§5.3), or a successful rotation (§6). Clearing also resets the consecutive-failure counter.
- The persisted env-file value is left alone — the operator can inspect it — and re-pairing overwrites
  it (HJ-10/HJ-27). The `masked` field is `mask()`ed (`env-file.ts:20`), never the raw token (§8.5).

The marker is state, not a security control: deleting it by hand and restarting is a legitimate
"I fixed the env file myself" escape hatch, and is exactly as trusted as editing the env file.

### 4.7 Degraded-mode side effects

- **Scheduled work** (autopilot/cron) is suppressed while degraded, with exactly one alert per
  degraded episode (HJ-12, HJ-29).
- **Nothing else is restricted** (HJ-25). Terminal, file API, and git continue to work.

---

## 5. Phase 2 — In-UI pairing

### 5.1 Joiner UI

When `subscriptionAuthOk` is false the web client renders a **full-screen setup takeover** (HJ-21)
instead of the session list:

- **"Join a fleet"** → arms a window; displays a fresh 6-digit code, this machine's MagicDNS name,
  and a countdown. Warns first if a token already exists (replacement, HJ-10) or if the machine is
  already paired to a different hub (detach, HJ-14).
- **"Enter a token directly"** → the existing `setClaudeToken()` path. Like pairing, a successful write
  clears the degrade marker and the failure counter (§4.6) — that is the only way out of degraded mode
  other than a pair.

Reachable later from Settings → Auth so a machine whose token was cleared can re-pair.

**Browser-only in v1 (HJ-36).** `anvild/web/bundle-native.ts` embeds `web/dist` into the Android and
Apple shells at *their* build time, so a daemon self-update never updates an installed app's UI. An
app built before this feature, pointed at a degraded daemon, will render its normal session list and
fail opaquely on the first command. The v1 target is therefore the browser
(`https://<machine>.<tailnet>.ts.net:7701`), which is what §4.5 already establishes and all the
pairing flow needs. Shipping the takeover to the apps is a follow-up re-ship, explicitly **not** a
gate on this PR (HJ-22) — recorded in §14.

### 5.2 Flow

```mermaid
sequenceDiagram
    participant Op as Operator (phone browser)
    participant J as Joiner anvild (:7701, degraded)
    participant Hub as Hub anvild (:7701)

    Op->>J: open joiner web UI → "Join a fleet"
    J-->>Op: code 482913 · joiner.tailnet.ts.net · 10 min
    Op->>Hub: Fleet → "Add a machine" → pick candidate, enter code
    Hub->>J: POST /api/fleet/pair { code, token, todoist?, openrouter?, fleetName, hubServerId }
    J->>J: verify code + tailnet identity → setClaudeToken() + sibling keys
    J-->>Hub: { ok, serverId, serverName, url }
    Hub->>Hub: record member; ACK
    J->>J: disarm on ACK
    J-->>Op: "joined <fleet> — auth OK"  📲
```

No restart: F4 means the token is live for the next spawn. Idle sessions are respawned (HJ-11).

### 5.3 Joiner receive routes

**`POST /api/fleet/pair`** — mirrors `/anvil-pair` semantics:

- **Default closed** — rejects with `not accepting pairings` unless armed via §5.1.
- Validates code, window expiry, and tailnet identity (§7).
- After a first accepted code the window **locks to that `hubServerId`** (HJ-17) and stays armed
  until ACK or TTL.
- On success: write credentials via `setClaudeToken()` (so §8.4's metered-key rejection applies) plus
  sibling keys (HJ-24/HJ-27); record `hubServerId`; reply with this machine's identity.
- Rejections use the existing vocabulary (`Pairing.swift:129`): `not accepting pairings` /
  `wrong code` / `expired` / `different tailnet user`.

**`POST /api/fleet/pair/ack`** — hub confirms the member is recorded; joiner disarms (HJ-16). It is
**gated exactly as `/api/fleet/pair` is** — same tailnet-identity check (§7), and the body must carry
the *same* `hubServerId` **and** the same code the window locked to (HJ-17). Without that gate any
tailnet peer could POST it and cancel someone else's pairing window mid-flow. It is **idempotent**: a
re-sent ACK for an already-disarmed window returns `ok` rather than an error, since the hub retries an
ACK whose reply it lost — the mirror of HJ-16's lost-reply case.

**`POST /api/fleet/token`** — rotation counterpart. **Identity-gated, not code-gated**, persistent
rather than armed, per `anvil-server-app.md` §4.4. See §8.6 for what `hubServerId` does and does not
prove.

### 5.4 Hub side

- `/api/fleet/discover` (`http.ts:338`) lists candidates; those with `subscriptionAuthOk:false` are
  labelled **"needs setup"** (HJ-9). `defaultProbe()` (`fleet.ts:114`) currently keeps only
  `serverId`/`serverName`/`version` from the health body — widen `ProbeResult` to carry
  `subscriptionAuthOk` and `capabilities` too. `Probe` is an injected seam, so the test doubles in
  §9.1 change with it.
- `/api/fleet/invite` → rename `inviteMac` → **`invitePeer`**, choosing its destination by
  **capability, not by failure** (HJ-15, §3.5):

  1. Health advertises `pairing` → `:7701/api/fleet/pair`.
  2. Health advertises capabilities but not `pairing`, or advertises none at all (a pre-capability
     daemon) → `:7702/anvil-pair`.
  3. **Fallback on 404 or 405 from `:7701`, not only on a connection error** → retry `:7702`.

  Step 3 is load-bearing and was wrong in v1.0. An un-upgraded Mac *does* answer on `:7701` — that is
  the ordinary daemon port — and returns **404** for an unknown route. A connect-failure-only fallback
  would treat that as a hard failure and never try `:7702`, breaking pairing against every Mac not yet
  upgraded. Treat a non-JSON body (an HTML error page from a proxy) the same way.
- Reuse `memberBases()` (`fleet.ts:273`) https-then-http fallback. This matters more than it looks: in
  serve mode the joiner binds **loopback only** (`ANVIL_HOST=127.0.0.1`), so only the `https://` form
  reaches it, while a direct-bind joiner answers only `http://`. Scheme fallback is not optional.
- On a successful reply, record the member, then send the ACK.

---

## 6. Phase 3 — Rotation to non-Mac members

`rotateToken()` (`fleet.ts:331`) targets `:7702/anvil-token`. Give it the same destination selection as
§5.4 — capability-directed, with the 404/405 fallback — preferring `:7701/api/fleet/token`. First-join
and rotation are the same push differing only in gate (code vs `hubServerId`) — the split macOS
already makes.

Consequence worth stating: once this ships, an **upgraded** Mac receives rotation on `:7701` like any
other member. `:7702` is the path for pre-upgrade daemons only. §9.3 step 14 is written accordingly.

---

## 7. Transport & caller identity

The existing docs disagree, and this spec resolves it:

- `fleet.ts:231` — `:7702` is plain HTTP **direct-bound on the tailnet interface**, so
  `tailscale whois` on the socket IP identifies the caller (`Pairing.swift:10`).
- `anvil-server-app.md` §4.3 — that approach is **superseded**: `tailscale serve` terminates TLS and
  proxies over loopback, so the peer is `127.0.0.1` and identity comes from the injected
  **`Tailscale-User-Login`** header.

Both are right for different transports, and `service.sh setup_serve` (`:134`) picks between exactly
those two at install time. Because §5.3 puts the routes on `:7701` — the port `tailscale serve`
fronts — **serve mode is the common case and the header path is primary**.

**Resolution branches on the peer address first, not on the header (HJ-37).** The header is trustworthy
only because `tailscale serve` injected it; it is not authenticated on the wire. On a direct tailnet
bind — the fallback `setup_serve` (`service.sh:142`) takes when serve is unavailable — any peer can
send `Tailscale-User-Login: <owner>` itself. Checking the header first, as v1.0 did, would let a
forged header override the `whois` result and defeat the identity check entirely.

1. **Peer is loopback (`127.0.0.1`/`::1`)** — the serve-mode case.
   - `Tailscale-User-Login` present → compare to this node's owner. This is the primary path.
   - Header absent → **not trusted**. That is what an unauthenticated local process presents; it is
     not "unknown identity", it is a caller that bypassed the proxy. Reject.
2. **Peer is a tailnet IP** — the direct-bind case. **Ignore any `Tailscale-User-Login` header on this
   branch** (it can only be caller-supplied) and use `tailscale whois` on the peer IP.
   - whois returns a *different* user → reject.
   - whois returns this node's owner → identity satisfied.
   - whois can't resolve → code-only, matching existing `notOtherUser` semantics
     (`Pairing.swift:118`): whois-unknown permitted, *known-different* user rejected.
3. **Peer is neither** (an unexpected source address) → reject.

The rule in one line: **an inbound `Tailscale-User-Login` is evidence only from loopback, and
loopback is evidence only with the header.**

---

## 8. Security

### 8.1 Posture delta

Unchanged from `anvil-multi-server.md` §8 and `anvil-server-app.md` §4.3: one bearer token on N
disks, tailnet-only reachability, WireGuard transit. This spec changes *which platforms* can be
inside that boundary, not how wide it is.

### 8.2 The cost of push, and the mitigations

Push means a tokenless daemon exposes a route that **accepts credentials from the network**:

- **Default closed** — rejects until a human arms a window in the joiner's UI.
- **Locked to one caller after first use** (HJ-17), and short-lived with a hard TTL.
- **Code + tailnet identity** both required (§7).
- **Replacement requires confirmation at the joiner** (HJ-10).
- `setClaudeToken()` performs the write, so metered-key rejection applies (§8.4).
- **Rejections coalesce** per window; an unarmed machine never notifies (HJ-33).

Net: exposure equivalent to the `:7702` listener the project already accepts, with the same gates.

### 8.3 Degraded-mode exposure

A tokenless daemon is reachable on the tailnet and cannot run turns, but still exposes the terminal,
file API, and git. **Degraded mode is not a security boundary** and must not be treated as a safe
state for an untrusted machine — it is exactly as sensitive as a normal install. The tailnet remains
the boundary (`SECURITY.md`). HJ-25 accepts this deliberately.

### 8.4 Rejections carried over

`setClaudeToken()` refuses `sk-ant-api…` (`store.ts:56`). The pair route must go through it rather
than writing the env file directly, so a hub holding a metered key can't propagate it fleet-wide.

### 8.5 Security review checklist (HJ-34)

An explicit adversarial pass, separate from code review, before merge:

- [ ] Unarmed machine rejects every pair attempt, and does not notify.
- [ ] Code from hub A cannot be replayed by hub B after HJ-17 lock-in.
- [ ] Expired window rejects a previously-valid code.
- [ ] `Tailscale-User-Login` from a different tailnet user is rejected **even with a correct code**.
- [ ] Loopback with no header is rejected, not auto-trusted (§7 branch 1).
- [ ] **A `Tailscale-User-Login` header on a non-loopback peer is ignored, not honoured** (HJ-37) —
      a forged header must not override `whois`. Test both: forged-header-plus-correct-code from a
      whois-different user is rejected; forged header from a whois-unknown peer falls to code-only,
      not to trusted.
- [ ] `/api/fleet/pair/ack` from an unrelated tailnet peer cannot disarm an armed window (§5.3).
- [ ] Token is never returned by any GET, and never logged — only `mask()`ed. Includes the §4.6
      degrade marker (`masked` field) and any pair/rotation rejection message.
- [ ] A metered `sk-ant-api…` key is rejected at the pair route, not just in the UI.
- [ ] Rotation rejects a mismatched `hubServerId` — read §8.6 for what that check is worth.
- [ ] Auto-degrade cannot be triggered remotely (auth-class failures only, N=2).
- [ ] The degrade marker is mode `600` and contains no raw secret.

### 8.6 What `hubServerId` proves — and doesn't

`hubServerId` is a **self-asserted body field**, exactly as in today's `:7702/anvil-token`. Anyone who
clears §7's identity gate can also claim any `hubServerId` they like. So the real authentication for
rotation is **tailnet identity — same-user reachability — and nothing more**; `hubServerId` is an
anti-confusion check that stops a *different* hub in the same tailnet from silently retargeting a
member (HJ-14's detach case), not a credential.

This is not a regression — it is the posture `anvil-multi-server.md` §8 already accepts, where every
same-user tailnet peer is inside the trust boundary. It is written down here so §8.5's checklist line
isn't read as "rotation is authenticated". If the fleet ever needs a hub to be cryptographically
distinguishable from any other same-user peer, that is a separate change and is out of scope.

---

## 9. Testing

Both layers are required: **technical** (the code does what it says) and **functional** (the operator
experience actually works end to end).

### 9.1 Automated — unit + mocked HTTP (HJ-18)

Runs in CI. Uses the existing injectable seams (`runTailscale`, `probe`, `fetchImpl` in `fleet.ts`).

| Area | Cases |
|------|-------|
| Guard | absent token → boots, `subscriptionAuthOk:false` · **`ANTHROPIC_API_KEY` set → still exits 1 (regression-critical)** · `ANTHROPIC_AUTH_TOKEN` set → exits 1 · API key **plus** a valid OAuth token → still exits 1 (§4.1 table) |
| Health | empty and `sk-ant-api…` both report `subscriptionAuthOk:false` (§4.2) · `capabilities` includes `pairing` (HJ-32) |
| Spawn | tokenless spawn throws the explicit §4.3 error, not an SDK failure |
| Auto-degrade | 2 consecutive 401s → degraded + notify · 1 auth failure → no change · network/timeout/429 → never degrades · mixed sequence resets the counter |
| Degrade marker | written on auto-degrade only · **present marker ⇒ degraded even when the env file still carries a token** (HJ-35, the restart case) · cleared by `setClaudeToken()`, by a pair, and by a rotation · clearing resets the failure counter · contains only a `mask()`ed token |
| Pair gates | happy path · wrong code · expired · **no window armed** · different tailnet user · replay after HJ-17 lock-in · pair over an existing token |
| ACK | joiner stays armed until ACK · disarms on ACK · TTL expiry disarms without ACK · **ACK with a wrong/absent `hubServerId` or code does not disarm** · re-sent ACK after disarm returns `ok` (idempotent) |
| Identity | serve mode: loopback **with** header (trusted) · loopback with **no** header (rejected) · direct-bind whois: same user / different user / unresolvable → code-only · **direct-bind peer sending its own `Tailscale-User-Login` → header ignored, whois decides** (HJ-37) |
| Sibling keys | Claude + Todoist + OpenRouter all written; all overwritten (HJ-27) |
| Sessions | idle sessions respawn on token change; mid-turn sessions are flagged, not killed (HJ-11) |
| Scheduling | scheduled run suppressed while degraded; exactly one alert per episode (HJ-12) |
| Destination choice | `pairing` capability → `:7701` · no capabilities → `:7702` · **`:7701` returns 404 → falls back to `:7702`** (HJ-15, the un-upgraded-Mac case) · connection refused → falls back · https-then-http scheme fallback works in both serve and direct-bind shapes |
| Rotation | matching `hubServerId` accepted, mismatch rejected, arm-state irrelevant · upgraded member routed to `:7701`, pre-capability member to `:7702` |
| Discovery | tokenless daemon appears with `subscriptionAuthOk:false` and its capabilities; arm-state **not** exposed |
| Contract | golden unchanged — **no `PROTOCOL_VERSION` bump** (HJ-32/§3.5); assert the golden still matches after the REST additions, proving no WS wire type moved |

### 9.2 Verification commands

Every command must be run and its **actual output pasted** into §11 before a row is ticked.

```bash
cd anvild
bun run typecheck          # expect: no output, exit 0
bun run typecheck:web      # expect: no output, exit 0
bun run build:web          # expect: "built web client → …/web/dist"
bun test                   # expect: 0 fail

# Guard regression — MUST still exit 1
ANTHROPIC_API_KEY=x CLAUDE_CODE_OAUTH_TOKEN=y bun run src/main.ts; echo "exit=$?"
# expect: "[anvild] FATAL — auth/billing guard (arch §3): …"  and  exit=1

# Degraded boot — MUST come up.
# NOTE: `env -u CLAUDE_CODE_OAUTH_TOKEN` is NOT sufficient on its own. loadPersistedClaudeToken()
# runs at main.ts:15, BEFORE the guard, and envFile() (auth/env-file.ts:15) hardcodes
# ~/.config/anvil/env with no override — by design ("do NOT swap in XDG_CONFIG_HOME"). On any machine
# that has ever set a token from the UI, the daemon would boot fully authed and this check would
# silently pass for the wrong reason. Override HOME so there is no env file to load.
SANDBOX="$(mktemp -d)"
env -u CLAUDE_CODE_OAUTH_TOKEN HOME="$SANDBOX" \
    ANVIL_PORT=7799 ANVIL_HOST=127.0.0.1 ANVIL_STATE_DIR="$SANDBOX/.anvil" \
    bun run src/main.ts &
DAEMON=$!
# Startup is not instant (Shiki grammar load + session restore) — poll, don't race the curl.
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:7799/api/health && break; sleep 0.5; done
# expect: {"ok":true,"subscriptionAuthOk":false,…,"capabilities":[…,"pairing"]}
kill "$DAEMON"; rm -rf "$SANDBOX"

# Degrade marker survives a restart (HJ-35) — the check the v1.0 recipe had no way to express.
SANDBOX="$(mktemp -d)"; mkdir -p "$SANDBOX/.config/anvil" "$SANDBOX/.anvil"
printf 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-stale\n' > "$SANDBOX/.config/anvil/env"
printf '{"at":"2026-07-21T00:00:00Z","reason":"2 consecutive auth failures (401)"}\n' \
  > "$SANDBOX/.anvil/auth-degraded"
env HOME="$SANDBOX" ANVIL_PORT=7799 ANVIL_HOST=127.0.0.1 ANVIL_STATE_DIR="$SANDBOX/.anvil" \
    bun run src/main.ts &
DAEMON=$!
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:7799/api/health && break; sleep 0.5; done
# expect: subscriptionAuthOk:false — the marker wins over the token in the env file
kill "$DAEMON"; rm -rf "$SANDBOX"
```

### 9.3 Functional — scripted manual E2E gate (HJ-20)

**Fixture:** `beelink-4450`, deliberately left tokenless (HJ-31). **Hub:** an existing Mac.
Nothing is marked done until every step passes and its evidence is captured.

| # | Step | Pass criterion |
|---|------|----------------|
| 1 | Install on the tokenless box: `scripts/service.sh install` | Exits 0. Previously impossible (F5). Prints the machine URL. |
| 2 | `systemctl --user status com.anvil.anvild` | `Active: active (running)` |
| 3 | `curl …/api/health` | `subscriptionAuthOk:false`, `ok:true` |
| 4 | Open the joiner URL in a **phone browser** (not the Anvil app — HJ-36) | Full-screen setup takeover; no session list |
| 5 | On the hub UI, open "Add a machine" | beelink listed, labelled **"needs setup"** |
| 6 | Attempt to pair **before arming** | Rejected `not accepting pairings`; **no notification** |
| 7 | Joiner UI → "Join a fleet" | 6-digit code + MagicDNS name + countdown |
| 8 | Hub: enter a **wrong** code | Rejected `wrong code`; window still armed |
| 9 | Hub: enter the correct code | Pair succeeds; member recorded; 📲 "pair succeeded" |
| 10 | Joiner UI reloads | Normal session list; `subscriptionAuthOk:true` |
| 11 | Start a session and send a prompt | Turn completes — **proves the token actually works** |
| 12 | Confirm sibling keys | Todoist/OpenRouter present in Settings (HJ-24) |
| 13 | Reboot the box | Daemon returns automatically; still authed; session history intact |
| 14 | Hub: rotate the token | beelink **and** every upgraded Mac receive it on `:7701` (§6). The `:7702` leg is **not** exercised here — see the note below (HJ-38) |
| 15 | Set an invalid token, run 2 turns | Auto-degrades to the setup screen; 📲 alert (HJ-23/HJ-28) |
| 15b | **Restart the daemon while degraded** (`service.sh restart`) | **Still degraded** — takeover screen, `subscriptionAuthOk:false`, and **no turn is consumed** re-discovering it (HJ-35). Without the marker this silently returns to "authed" |
| 16 | Re-pair from the hub | Recovers to authed without touching a terminal; marker gone |

Step 11 is the one that cannot be faked by mocks, step 13 is the one that answers the original
request (**persists through restarts**), and step 15b is the one that catches the marker being
in-memory only.

> **The `:7702` rotation leg ships with mocked coverage only (HJ-38).** Once §6 lands, the hub routes
> by capability, so `:7702` is reachable *only* from a member still running a pre-capability daemon.
> That state exists in exactly one window — new hub, not-yet-upgraded member — which the rollout
> closes. Proving it live would mean pausing the fleet rollout mid-flight to hold a Mac back, and we
> have chosen not to gate the release on that.
>
> What covers it instead: the §9.1 *Destination choice* row (`no capabilities → :7702`, and
> `:7701` 404 → `:7702`), both against injected `fetchImpl`/`Probe` doubles. That exercises the
> selection logic and the fallback trigger, but **never a real pre-capability daemon** — the mock
> asserts what we believe an old daemon does, not what it does.
>
> Residual risk, stated plainly: if that belief is wrong, rotation silently fails to reach Macs during
> the upgrade window. It is bounded — §12 Phase 3's rollback is "revert to `:7702`-only", the window
> is one rollout long, and a member that misses a rotation can still have a token set from its own UI.
> Do not tick this as functionally verified; record `MOCKED (HJ-38)`.

---

## 10. Definition of Done

A phase is done only when **all** of the following hold:

1. **Implemented** — code merged into the single PR (HJ-22).
2. **Automated tests pass** — §9.1 cases written; `typecheck`, `typecheck:web`, `build:web`, and
   `bun test` all green (CI gates all four).
3. **Functionally verified** — every §9.3 step for that phase passes, with output captured.
4. **Evidence recorded** — §11 updated **in the same PR**, with pasted command output, not claims
   (HJ-19/HJ-34).
5. **Docs updated** — README, `docs/ARCHITECTURE.md`, and `anvil-server-app.md` §4.0 amended to note
   the wrinkle is lifted for non-Mac joiners (HJ-34). The docs must say the setup/pairing UI is
   **browser-only** in this release (HJ-36), so an app user isn't sent looking for a screen that
   isn't in their build.
6. **Rollback stated** — §12 filled in for that phase (HJ-34).
7. **Security review** — §8.5 checklist completed and signed off (HJ-34).
8. **Pushed** — merged **and deployed** to at least one real machine **and verified live** (HJ-30).
   Deployment is `anvild/scripts/service.sh restart` on the **canonical checkout**, not a worktree.

> **Agent instruction — do not mark any row done without evidence.** For each row, run the command in
> §9.2 or the step in §9.3 and paste the **actual** output into the Evidence column. If a command
> cannot be run (no hardware, no hub), record `BLOCKED: <reason>` — never infer a pass. A green
> typecheck is not evidence that a *feature* works; only §9.3 establishes that.

---

## 11. Tracking ledger

Legend: ☐ not started · ◐ in progress · ☑ done (evidence required) · ⊘ blocked

Because all phases ship in one PR (HJ-22), **Pushed** flips once for the whole feature.

### 11.1 Phase 1 — Degraded boot

| # | Item | Impl | Tested | Evidence |
|---|------|------|--------|----------|
| 1.1 | Guard split: degraded vs fatal (§4.1) | ☐ | ☐ | |
| 1.2 | Fatal path regression: API key still exits 1 | ☐ | ☐ | |
| 1.3 | Honest `subscriptionAuthOk` (§4.2) | ☐ | ☐ | |
| 1.4 | Explicit no-token spawn error (§4.3) | ☐ | ☐ | |
| 1.5 | Installer: no hard fail on missing env (§4.4) | ☐ | ☐ | |
| 1.6 | Auto-degrade on 2× auth failure (§4.6) | ☐ | ☐ | |
| 1.7 | Degrade marker: write, read-at-boot, clear-on-credential-write (HJ-35) | ☐ | ☐ | |
| 1.8 | `capabilities` on `/api/health` + `pairing` tag (HJ-32) | ☐ | ☐ | |
| 1.9 | Scheduled work suppressed + one alert (§4.7) | ☐ | ☐ | |

### 11.2 Phase 2 — In-UI pairing

| # | Item | Impl | Tested | Evidence |
|---|------|------|--------|----------|
| 2.1 | Full-screen setup takeover (§5.1) | ☐ | ☐ | |
| 2.2 | Arm/disarm window + code generation | ☐ | ☐ | |
| 2.3 | Overwrite + detach warnings (HJ-10/HJ-14) | ☐ | ☐ | |
| 2.4 | `POST /api/fleet/pair` + gates (§5.3) | ☐ | ☐ | |
| 2.5 | HJ-17 lock-to-hub after first use | ☐ | ☐ | |
| 2.6 | `POST /api/fleet/pair/ack` + gate + idempotent disarm (§5.3) | ☐ | ☐ | |
| 2.7 | Caller identity: peer-address branch first, header loopback-only (§7, HJ-37) | ☐ | ☐ | |
| 2.8 | Sibling key payload (HJ-24/HJ-27) | ☐ | ☐ | |
| 2.9 | `invitePeer` capability-directed destination + 404 fallback (HJ-15) | ☐ | ☐ | |
| 2.10 | Hub "Add a machine" + "needs setup" label | ☐ | ☐ | |
| 2.11 | `subscriptionAuthOk` + `capabilities` on `ProbeResult`/`DiscoveredServer` (HJ-9/HJ-32) | ☐ | ☐ | |
| 2.12 | Idle-session respawn on token change (HJ-11) | ☐ | ☐ | |
| 2.13 | Notifications + rejection coalescing (HJ-29/HJ-33) | ☐ | ☐ | |

### 11.3 Phase 3 — Rotation

| # | Item | Impl | Tested | Evidence |
|---|------|------|--------|----------|
| 3.1 | `POST /api/fleet/token` (identity-gated) | ☐ | ☐ | |
| 3.2 | `rotateToken` capability-directed destination + 404 fallback | ☐ | ☐ | |

### 11.4 Functional E2E (§9.3) — the release gate

| Step | Description | Status | Evidence |
|------|-------------|--------|----------|
| 1–3 | Install tokenless, service active, health degraded | ☐ | |
| 4–5 | Takeover UI; hub lists "needs setup" | ☐ | |
| 6–8 | Unarmed reject; arm; wrong-code reject | ☐ | |
| 9–10 | Pair succeeds; joiner authed | ☐ | |
| 11 | **Real turn completes** | ☐ | |
| 12 | Sibling keys present | ☐ | |
| 13 | **Survives reboot** | ☐ | |
| 14 | Rotation reaches Linux + Mac on `:7701` | ☐ | |
| 14b | `:7702` leg — **mocked only, not a live gate** (HJ-38) | n/a | `MOCKED (HJ-38)` |
| 15 | Auto-degrade after 2 failed turns | ☐ | |
| 15b | **Still degraded after a restart** (HJ-35) | ☐ | |
| 16 | Recover by re-pairing | ☐ | |

### 11.5 Release gates

| Gate | Status | Evidence |
|------|--------|----------|
| `bun test` green | ☐ | |
| `typecheck` + `typecheck:web` + `build:web` green | ☐ | |
| Contract golden **unchanged**, `PROTOCOL_VERSION` **not** bumped (HJ-32/§3.5) | ☐ | |
| Security review §8.5 complete | ☐ | |
| Docs updated (README, ARCHITECTURE, server-app §4.0) | ☐ | |
| Rollback documented (§12) | ☐ | |
| **Pushed** — merged, deployed, verified live (HJ-30) | ☐ | |

---

## 12. Rollback

| Phase | Risk | Rollback |
|-------|------|----------|
| 1 | Touches the startup guard **every** machine depends on. | Revert the guard commit. ⚠️ **Any machine relying on degraded boot will then refuse to start** — ensure every fleet member has a valid token in `~/.config/anvil/env` *before* reverting. The reverted daemon ignores `<stateDir>/auth-degraded`, so it is inert, but delete it on any degraded box so a later re-roll-forward doesn't resurrect a stale degraded state. |
| 2 | Additive routes + a new UI state. | Routes are inert while unarmed; reverting removes them. macOS `:7702` is untouched (HJ-5), so existing Mac pairing is unaffected either way. |
| 3 | Changes an existing rotation path. | Revert to `:7702`-only. Linux members then need a token set from their own UI until re-applied. |

Deploy and rollback both run `anvild/scripts/service.sh restart` on the **canonical checkout** — the
daemon does not run from a worktree.

---

## 13. Files touched

| File | Change |
|------|--------|
| `anvild/src/auth/guard.ts` | split fatal vs degraded as `GuardStatus` — note the existing `AuthStatus` name collision with `auth/store.ts` (§4.1) |
| `anvild/src/main.ts` | non-fatal path for absent token; read the degrade marker between `loadPersistedClaudeToken()` and the guard (§4.1, §4.6) |
| `anvild/src/auth/store.ts` | degrade-marker read/write/clear; clear on `setClaudeToken()`; sibling-key writes (§4.6, HJ-24, HJ-35) |
| `anvild/src/agent/env.ts` | explicit no-token error at spawn (§4.3) |
| `anvild/src/agent/driver.ts` | auth-failure classification + consecutive-failure counter (§4.6) |
| `anvild/src/server/identity.ts` | `"pairing"` in `SERVER_CAPABILITIES` (HJ-32) |
| `anvild/src/server/http.ts` | honest `subscriptionAuthOk`; `capabilities` on `/api/health`; `/api/fleet/pair`, `/pair/ack`, `/token`; §7 caller-identity resolution |
| `anvild/src/server/fleet.ts` | arm/lock/disarm window; widen `ProbeResult`/`defaultProbe` (injected seam — test doubles change with it); `invitePeer` capability-directed destination + 404 fallback; rotation fallback |
| `anvild/src/fleet/store.ts` | record `hubServerId` for rotation gating |
| `anvild/src/session/*` | idle-session respawn on token change (HJ-11) |
| `anvild/src/integrations/autostart-gate.ts` | the suppression point for scheduled work while degraded (with `schedule.ts` / `autopilot.ts` as the callers) (HJ-12) |
| `anvild/web/src/…` | setup takeover; arm UI; hub "Add a machine" + "needs setup" — **browser-only in v1** (HJ-36) |
| `anvild/scripts/service.sh` | remove the missing-env-file hard fail; create the dir/file at 700/600 (§4.4) |
| `docs/plans/anvil-protocol.ts` | `subscriptionAuthOk` + `capabilities` on `DiscoveredServer`; `capabilities` on `HealthResponse`. **No `PROTOCOL_VERSION` bump** (HJ-32/§3.5) |
| `anvild/test/contract/` | golden **unchanged** — assert it still matches (no WS wire type moved) |
| `docs/plans/anvil-server-app.md` | note §4.0's premise is lifted for non-Mac joiners |
| `README.md`, `docs/ARCHITECTURE.md` | Linux/headless machines can join a fleet |

macOS `anvil-server/` is untouched (HJ-5). No new scripts (HJ-7/HJ-8). The Android/Apple shells are
untouched in v1 (HJ-36) — they keep their bundled `web/dist` until a separate re-ship.

---

## 14. Open questions

None blocking. Deferred by decision:

| Question | Disposition |
|---|---|
| One-line Linux installer | Rejected — HJ-8, §3.3 |
| Joiner serving a fleet registry to clients | Rejected — HJ-26; revisit if administering from a member becomes common |
| Multi-hub membership | Rejected — HJ-14; single hub with a detach warning |
| Two-daemon integration tests in CI | Rejected — HJ-18; the §9.3 manual gate covers it. Revisit if E2E regressions appear |
| Restricting terminal/git while degraded | Rejected — HJ-25, §8.3 |
| Setup takeover inside the native apps | Deferred — HJ-36. Needs an Android + Apple re-ship with a fresh `web/dist`; track separately once this ships. Until then an app pointed at a degraded daemon fails opaquely |
| A graceful server-side error for pre-takeover app bundles | Deferred with the above — worth doing if app users hit degraded daemons in practice |
| Cryptographically distinguishing the hub from any same-user tailnet peer | Rejected — §8.6. `hubServerId` is anti-confusion, not authentication; changing that means changing `anvil-multi-server.md` §8's trust model |
| Protocol-version negotiation | Out of scope — `[NAT-11]` in `anvil-improvement-program.md`. §3.5 relies on `SERVER_CAPABILITIES` instead |
| Live proof of the `:7702` rotation leg | Rejected — HJ-38, §9.3. Mocked coverage accepted rather than pausing the rollout to hold a Mac on an old daemon. Revisit if a member is ever observed missing a rotation during an upgrade |
