# Multiple Claude accounts — design

**Date:** 2026-07-25
**Status:** DESIGN — approved 2026-07-26 (revision 2, via md-review-plus; all sections approved, no
changes requested). r1 was approved 2026-07-25 against a stale baseline; §5.3/§7/MA-3/§13 were
rewritten against `origin/main` — see **Baseline** below.
**Extends:** `anvil-native-architecture.md` (§3 auth/billing, §5 sessions, §6 protocol),
`anvil-protocol.ts`, `anvil-multi-server.md` (§3 server identity, §4 connection model — this design
supersedes its **MS-2** "one token on every server" decision), `anvil-server-app.md` (§4 pairing,
§6 fleet administration), `anvil-headless-join.md` (§4.6 auto-degrade, §5.4/§6 capability-routed
credential push, §7/§8 caller-identity gating — this design extends its `/api/fleet/token` payload
rather than adding a parallel one).

**Baseline:** `origin/main` at `507b243`. Revision 1 was written against an older branch and asserted
that the daemon had no hub role, no TS `whois`, and no credential-push endpoint. All three had
already landed with headless-join. Revision 2 builds on `PairedHubStore`, `resolveCallerIdentity`,
`/api/fleet/token` and `restartIdleSessionsForNewToken()` instead of reinventing them; the net effect
is **less** work, concentrated in §7.

---

## 0. Summary

Anvil today holds **exactly one** Claude subscription token. It lives as a single
`CLAUDE_CODE_OAUTH_TOKEN=` line in `~/.config/anvil/env`, it is settable from Settings → Models, and
the Servers tab can push *that one token* to every Mac in the fleet. There is no memory of any other
account: switching means re-running `claude setup-token` on the daemon host and re-pasting an opaque
string, and switching back means doing it again.

This design replaces the single slot with a **roster of labelled accounts**, and makes the account a
property of a **session** rather than of the daemon:

- Register several tokens, each with a memorable label (`work`, `personal`), one marked default.
- Pick the account when starting a session; see it on the session header for its whole life.
- Change a running session's account the way `/login` changes Claude Code's — the conversation
  resumes on the new token.
- The roster replicates across the fleet, so the picker is correct on every Mac, not just the hub.

The design rests on two decisions. First, **`accounts.json` becomes the source of truth and the
default account is mirrored back into the existing env file** — so the launcher, the §3 startup
guard, `service.sh`'s install gate, `Auth.swift`, and every existing client keep working with no
change. Second, **the client routes roster writes to the hub** over the socket it already holds,
rather than inventing a member→hub daemon channel. Both choices are about adding capability without
disturbing load-bearing paths.

The daemon-side half of "which Mac is the hub" is already solved: headless-join added
`PairedHubStore` (`src/server/pairing.ts:153`), which persists the hub's `serverId` on every member.
What remains is **client-side** — `HUB_URL` is still purely positional (`web/src/main.ts:171`, with
`isHub = srv.url === HUB_URL` at `:4218`), so a client loaded from a member's URL still believes that
member is the hub, and its "Update token" button still reports `Updated 0/0 Macs` because
`/api/fleet/rotate` iterates that member's empty `fleet.list()` and `[].every()` is vacuously true.
Surfacing the already-persisted paired hub to the client is a prerequisite for roster writes, and
repairs that as a side effect.

---

## 1. Goals & non-goals

**Goals**

- Register N Claude subscription tokens with human-memorable labels; one is the default.
- Choose the account at session-create; it is visible on the session for its entire life.
- Change a running session's account without losing the conversation (`/login`-equivalent).
- Unattended autopilot runs bill to a predictable, per-repo-configurable account.
- The roster is correct and usable from **any** Mac in the fleet and **any** client origin.
- Zero-touch upgrade: an existing install keeps working with no manual migration.
- The §3 billing invariant is never weakened — a metered `sk-ant-api…` key is still refused
  everywhere, and the daemon still refuses to start with `ANTHROPIC_API_KEY` set.

**Non-goals**

- **Per-account usage accounting.** `src/budget/tracker.ts` is untouched; it continues to report
  per-session cost without attributing it to an account. A session rebound mid-flight genuinely
  splits its usage across two subscriptions and the budget card will not say so. Out of scope.
- **Automatic account discovery.** No reading of Claude Code's own credential store (undocumented,
  platform-specific, Keychain on macOS). Tokens are pasted.
- **Non-Claude providers.** The OpenRouter key (`src/auth/openrouter.ts`) stays a single slot. The
  `AuthProvider` union keeps its shape; only the `"claude"` provider grows a roster.
- **Automatic failover on rate limit.** Anvil will not detect a 429 and hop accounts by itself. The
  switch is a human action. (Noted as a plausible follow-up in §14.)
- **Team member accounts.** A team member session inherits its lead's account; there is no
  per-member picker.

---

## 2. Locked decisions

Interview, 2026-07-25.

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| MA-1 | Roster home across the fleet | **Replicate to every daemon** — hub writable, members hold a full read-only replica | The picker must work on the member you're starting a session on; a hub-only store makes the hub a runtime dependency for every spawn everywhere |
| MA-2 | Write path from a member's origin | **Client routes writes to the hub** over its existing socket | No new daemon→daemon channel and no new inbound auth surface; the client already federates |
| MA-3 | Replication transport | **Extend the existing `/api/fleet/token` credential push** with an `accounts` array — identity-gated, capability-routed | *Revised in r2.* The interview weighed "tailnet-gated new endpoint" against "port `whois` to the daemon first" on the false premise that `whois` was Swift-only. It is not: `resolveCallerIdentity` (`src/server/pairing.ts`) already gates `/api/fleet/token` on `sameUser` **plus** a `hubServerId` match. Extending it is both less work and a stronger gate than r1's choice |
| MA-4 | Storage vs the env file | **Roster is truth; mirror the default into `~/.config/anvil/env`** | Launcher, §3 guard, `service.sh` install gate, `Auth.swift` and old clients all keep working unchanged |
| MA-5 | Session binding | **Pinned at create, rebindable from the header while idle** | The `/login` behaviour, scoped per session — the one thing a multi-session daemon can do that a CLI cannot |
| MA-6 | Resume failure on rebind | **Fall back to a fresh context with a persisted divider** | Degrades to something usable rather than a dead session; reuses `newTopic()`'s existing mechanics |
| MA-7 | Replication trigger | **Auto-push on every mutation; the button becomes "Sync now" (retry)** | An offline member currently misses a push with no record; per-member `rev` makes drift visible |
| MA-8 | Removing an in-use account | **Warn with the list of active sessions, then fall back visibly** | Nothing silent before or after; nothing permanently wedged |
| MA-9 | Unattended runs | **Per-environment account, falling back to the global default** | Only option that separates a nightly run on a work repo from one on a personal repo |
| MA-10 | Token entry | **Label + paste, with a copyable `claude setup-token` command** | The roster is the value; an in-app PTY for setup is new surface for marginal gain |
| MA-11 | Auto-degrade interaction | **Degrade is per-daemon, not per-account; recovery re-seeds the default** | *Added in r2.* `auth/degrade.ts` flips the whole daemon into the setup screen after two consecutive auth-class failures. Making it per-account would mean a machine half-degraded with no screen to show; out of scope (§14) |

> **Revision note.** MA-3 changed in r2. MA-1, MA-2 and MA-4 through MA-10 are unaffected by the
> baseline correction — the client still routes writes to the hub (MA-2), it just now has a
> daemon-persisted hub id to route *to*.

---

## 3. Data model

### 3.1 The store

New module `anvild/src/auth/accounts.ts`, backed by `<stateDir>/accounts.json` (`~/.anvil` by
default — `config.ts:113`), written `0600` with a `0700` parent, matching the existing env-file
discipline.

```ts
export interface ClaudeAccount {
  id: string;          // "acct_…" — stable, generated, never the label
  label: string;       // user-chosen, unique case-insensitively, 1–32 chars
  token: string;       // the sk-ant-oat… subscription token; NEVER leaves the daemon
  createdAt: number;
}

export interface AccountRoster {
  rev: number;             // monotonic; bumped on every mutation. The staleness cursor.
  defaultId: string;       // always references a present account
  accounts: ClaudeAccount[];
  role: "hub" | "replica"; // a replica refuses local mutations
}
```

The roster deliberately does **not** store the hub's identity: `PairedHubStore`
(`src/server/pairing.ts:153`) already persists it to `<stateDir>/pairing.json`, and a second copy
would be a second thing to keep in sync. `role` is the roster's own concern — whether *this* file may
be mutated locally — and is set to `"replica"` the first time a push lands.

`rev` is the whole basis of drift detection: the hub increments it on every mutation, ships it with
every push, and records the last `rev` each member acknowledged. `laptop is at rev 4, hub is at rev
6` is the entire "out of date" computation.

`id` is generated and stable so that renaming a label does not orphan every session bound to it.

### 3.2 Relationship to `~/.config/anvil/env`

The env file remains exactly as it is today, and remains load-bearing in four places:

| Consumer | Location | Behaviour after this change |
|---|---|---|
| launcher sources it every start | `scripts/service.sh:337` (`set -a; . $HOME/.config/anvil/env`) | unchanged |
| install refuses without it | `scripts/service.sh:305` | unchanged |
| boot re-read | `src/auth/store.ts` → `loadPersistedClaudeToken()`, called at `src/main.ts:15` | unchanged, runs *before* the roster loads |
| startup gate | `src/auth/guard.ts:45` → `assertSubscriptionAuth()`, called at `src/main.ts:21` | relaxed — see §4.2 |
| macOS Server.app wizard | `anvil-server/.../Auth.swift` writes the file | unchanged |
| auto-degrade marker | `src/auth/degrade.ts` — `<stateDir>/auth-degraded`, read at boot *before* the guard | unchanged; cleared by `setClaudeToken()`, which the roster routes through (§3.2) |

**Mirroring rule.** Whenever the roster's default account changes — a new default is chosen, the
default's token is replaced, or the default account is removed — the daemon **calls the existing
`setClaudeToken()`** (`src/auth/store.ts:51`) rather than writing the env file itself.

Routing through that function, not around it, is load-bearing. `setClaudeToken()` does three things
the roster must not skip: it rejects a metered `sk-ant-api…` key (§3), it upserts the env line and
`process.env` together, and — added by headless-join — it calls `clearBoundDegradeMarker()`, which is
the **only** way out of auto-degraded mode besides a pair or rotation (`src/auth/degrade.ts`). A
roster that wrote the env file directly would leave a degraded daemon degraded after the user had
plainly fixed the credential.

This means the env file is a **derived cache of the default account**, never an independent source of
truth, and a `sk-ant-oat…` value there always corresponds to some roster entry after migration.

### 3.3 Migration

At boot, after `loadPersistedClaudeToken()` and before `assertSubscriptionAuth()`:

```
if accounts.json is absent or its accounts array is empty:
    tok := process.env.CLAUDE_CODE_OAUTH_TOKEN
    if tok is non-empty and not looksLikeMeteredKey(tok):
        create account { label: "default", token: tok }, mark it default, rev = 1
```

Idempotent, silent, and one-directional — it never runs again once the roster is non-empty. An
existing single-token install therefore comes up with a one-entry roster whose mirrored env line is
byte-identical to what was already there. Nothing to do by hand.

If the env token is absent *and* the roster is empty, the daemon is in the same unconfigured state it
is in today and the §3 guard fails it with the same message.

### 3.4 Session and environment records

`Session` (protocol) gains:

```ts
accountId?: string;       // the account this session's agent spawns under
accountLabel?: string;    // denormalised for display; refreshed on rename
accountMissing?: boolean; // true when accountId no longer resolves (see §5.4)
```

`Environment` (protocol) gains:

```ts
accountId?: string;       // default account for sessions and autopilot runs in this environment
```

`accountLabel` is denormalised deliberately: the session list renders on every client, including ones
connected to a member whose replica may lag, and threading a lookup through every render path to save
a short string is not worth it. It is refreshed from the roster on rename and on session load.

---

## 4. Resolution and the §3 guard

### 4.1 `buildAgentEnv`

`src/agent/env.ts:40` gains one optional field:

```ts
buildAgentEnv({ profile?: ModelProfile; accountId?: string; requireToken?: boolean; src?: … })
```

`requireToken` already exists on `main` (headless-join §8.3 — a tokenless machine must still get a
PTY); `accountId` composes with it and changes nothing about it.

For `profile: "claude"` the token is resolved as:

1. `accountId` given and present in the roster → that account's token.
2. `accountId` given but **absent** from the roster → see §5.4 (fallback + flag), never a silent swap.
3. no `accountId` → the default account's token.
4. no roster at all (dev run, pre-migration) → `src.CLAUDE_CODE_OAUTH_TOKEN`, exactly today's behaviour.

Every existing call site keeps working by passing nothing. The `"glm"` profile is untouched — it
carries `ANTHROPIC_BASE_URL` + the OpenRouter key and deliberately no Claude token, and that stays
true.

Callers that must thread a session through:

| Call site | Change |
|---|---|
| `src/session/supervisor.ts:186` `agentEnv()` | → `agentEnv(s?: SessionHandle)`, resolving `s.data.accountId` |
| `src/session/supervisor.ts:2385` `new AgentDriver(…, this.agentEnv())` | → `this.agentEnv(s)` |
| `src/session/supervisor.ts` `pickIcon` / `classifyBranchKind` | default account (short utility spawns) |
| `src/session/supervisor.ts:2293` `TerminalManager` env | session's account — the PTY belongs to a session; keeps `requireToken: false` |
| `src/agent/query.ts` (pipeline) | accept an optional `accountId` from the caller; default otherwise |
| `src/integrations/autopilot.ts:99` | environment's account, else default (§6) |

### 4.2 The guard — already satisfied on `main`

*Corrected after r2 review: the relaxation this section originally specified had already landed.*

`checkAuth()` (`src/auth/guard.ts`) returns `GuardStatus { subscriptionAuthOk, fatal, reason? }` and
headless-join §4.1 already split the two failure modes: a metered key is **fatal** (the daemon
refuses to start), while a missing token merely reports `subscriptionAuthOk: false` and boots
**degraded** so the machine can be paired from its own UI. `assertSubscriptionAuth()` exits only on
`fatal`.

So there is nothing to relax for booting — the "before" state this section described no longer
exists. Two prohibitions stay exactly as they are: `ANTHROPIC_API_KEY` set → fatal;
`ANTHROPIC_AUTH_TOKEN` set → fatal.

The only remaining change is cosmetic and belongs to §4.1: once the roster resolves tokens,
`subscriptionAuthOk` should consider a non-empty roster, not just the env var. Because the mirroring
rule (§3.2) guarantees a non-empty roster always has a mirrored env line, this is a no-op in every
reachable state — it exists so a hand-edited or unwritable env file doesn't make a perfectly good
roster look unauthenticated. **Net effect on the plan: phase 1 loses the guard task.**

`looksLikeMeteredKey()` (now in `src/auth/env-file.ts`, re-exported from `store.ts`) gates **every**
roster insertion, not just the default, so a metered key can never enter the store by any path — UI,
replication, or migration. `buildAgentEnv` additionally throws `NO_CLAUDE_TOKEN_ERROR` on an
agent spawn with no resolvable token, which the roster path inherits unchanged.

### 4.3 Auto-degrade (added in r2)

`src/auth/degrade.ts` flips the daemon into the setup/pairing screen after
`DEGRADE_AFTER_CONSECUTIVE_AUTH_FAILURES` (2) consecutive auth-class spawn failures, via a durable
`<stateDir>/auth-degraded` marker read at boot *before* the guard. This catches a token that is
well-formed but expired or revoked — which the shape-only guard cannot.

Degrade stays **per-daemon, not per-account** (MA-11). A per-account degrade would leave a machine
half-authenticated with no coherent screen to present, and the recovery UX (the takeover / re-pair
flow) is inherently machine-scoped. Consequences, all deliberate:

- Two consecutive auth failures on **any** account degrade the whole daemon.
- Recovery through the roster is ordinary: adding or replacing a token calls `setClaudeToken()`,
  which clears the marker (§3.2).
- The degrade marker's `masked` preview identifies *which* token was in play, so the Models tab can
  point at the offending roster entry even though the degrade itself is machine-wide.

Per-account degrade is listed as future work (§14).

---

## 5. Session binding

### 5.1 Choosing at create

`SessionCreateCmd` gains `accountId?: string`. The new-session dialog
(`web/src/main.ts`, the `createBtn` handler) gains an Account row beneath Environment, pre-filled
with: the environment's `accountId` if set, else the roster default. The command is sent to the
environment's server exactly as today (`serverOfEnv(env.id)`); no routing changes.

The supervisor stamps `accountId` + `accountLabel` on the session record at creation.

Single-account rosters hide the row entirely — there is nothing to choose.

### 5.2 Display

The session header renders `● <label>` next to the environment/branch. This is the point of the
feature: a session must never be ambiguous about which subscription it is spending.

### 5.3 Rebinding a running session

*Rewritten in r2 — this reuses an existing method rather than adding one.*

Headless-join already shipped **`restartIdleSessionsForNewToken()`** (`supervisor.ts:709`), called
from `adoptCredentials()` whenever a pushed credential lands. It does exactly the teardown this
feature needs, and it already handles the mid-turn case:

```ts
for (const [id, driver] of [...this.drivers]) {
  const status = this.sessions.get(id)?.data.status;
  if (status && status !== "idle") { busy.push(id); continue; }
  this.drivers.delete(id);
  await driver.stop().catch(() => {});
}
// busy sessions get emitError("…login changed while this session was mid-turn. Finish or
// interrupt the turn — the new login applies from the next one.", false)
```

So the new command `session.account.set { sessionId, accountId }` is a **single-session variant** of
it. Rather than duplicating the loop, extract the per-session body into
`restartDriverForNewToken(id): Promise<boolean>` and have both call it:

```ts
async setSessionAccount(id: string, accountId: string): Promise<void> {
  const s = this.require(id);
  const acct = this.accounts.get(accountId) ?? throwUnknownAccount(accountId);
  if (s.data.status !== "idle") throw new Error("finish or interrupt the current turn first");
  s.data.accountId = accountId;
  s.data.accountLabel = acct.label;
  await this.restartDriverForNewToken(id);   // stop + delete; keeps claudeSessionId
  this.persist();
  this.broadcastUpdated(s.data);
  s.emit(<divider: `switched to ${acct.label}`>);
}
```

`claudeSessionId` is **kept**, so `ensureDriver()` (`supervisor.ts:2377`) builds a fresh
`AgentDriver` whose `resume: s.data.claudeSessionId` (`driver.ts:166`) rejoins the same conversation
on the new token. The same teardown is proven by `reset()` (`supervisor.ts:2635`) and
`restartIdleSessionsForNewToken()` — not invented here.

The header control is disabled while the session is not `idle`; the command also rejects
server-side, because a client can be stale. The rejection wording matches the existing mid-turn
message so the two paths read as one behaviour.

**Knock-on:** `restartIdleSessionsForNewToken()` currently restarts idle drivers on *any* credential
push, which was right when the daemon had one token. With a roster, a push that only adds a
*non-default* account must **not** restart every session — nothing they use has changed. It gains a
predicate: restart a session only if the account it resolves to actually changed token.

### 5.4 When an account does not resolve

Two distinct causes, two distinct behaviours, because they mean different things:

**Removed from the roster** (§8.3). The session falls back to the default account, sets
`accountMissing: true`, and the header shows `● work ⚠ was personal`. The badge persists until the
user picks an account explicitly. The §4.2 guard guarantees a default exists, so the fallback always
resolves and work continues.

**Not yet replicated to this member.** The member's replica is behind and genuinely does not hold the
token. Falling back to the default here would bill to the wrong subscription for a reason the user
never chose, so the spawn is **refused** with an actionable error:

> This Mac hasn't received the "personal" login yet. Open Settings → Servers and press Sync now.

The two are distinguishable: a hub roster at `rev` N that lacks the id means removed; a replica
behind the hub's `rev` that lacks the id means unreplicated.

### 5.5 Resume failure

`ensureStarted()` (`driver.ts:153`) already passes `resume`. If the SDK errors on resume, the driver
reports it and the supervisor does what `newTopic()` does at `supervisor.ts:2496`:

```ts
s.data.claudeSessionId = undefined;
s.data.context = undefined;
s.emit(<persisted divider>);
```

with a divider reading:

> **switched to personal** — couldn't carry the conversation across accounts, so this is a fresh
> context. Your worktree and files are untouched.

The divider goes through the normal event log, so it survives reload and syncs to every device. Same
handling for an expired or revoked token, a pruned transcript, or any other resume failure — the
cause differs, the recovery does not.

---

## 6. Environments and unattended runs

`Environment` gains an optional `accountId`, edited in the environment dialog. It does two things:

1. **Pre-selects** the account in the new-session dialog for that environment.
2. **Determines** which account autopilot uses for that environment's runs.

`src/integrations/autopilot.ts:100` currently calls `buildAgentEnv()` bare. It becomes
`buildAgentEnv({ accountId: env.accountId })`, falling through to the default when unset — which is
exactly today's behaviour for every environment that never sets one.

This is the only mechanism that separates unattended usage by repo, and unattended usage is where
surprise spend actually happens: the nightly scheduler fans out across every server with no human
watching.

The autopilot report gains a line naming the account it ran under.

---

## 7. Fleet

*Rewritten in r2. Revision 1 specified building a hub role, a TS caller-identity gate, and a new
`/api/fleet/accounts` endpoint. All three already exist; this section now extends them.*

### 7.1 What already exists

Headless-join (`anvil-headless-join.md`) landed a complete daemon-native credential-distribution
path. The roster rides it rather than paralleling it:

| Capability | Where | What it gives us |
|---|---|---|
| Hub identity on the member | `PairedHubStore` (`src/server/pairing.ts:153`) → `<stateDir>/pairing.json`, 0600 | `{ hubServerId, fleetName, at }`. A member already knows which hub owns it |
| Caller identity in TS | `resolveCallerIdentity` / `PeerTrust` (`src/server/pairing.ts`) | `sameUser` / `unknown` / `otherUser`, mirroring `Tailscale.peerTrust` |
| Credential push, identity-gated | `POST /api/fleet/token` (`http.ts:582`) | Requires `sameUser` **and** `hubServerId === pairedHub.get().hubServerId`. `unknown` is not enough (unlike a coded pair) |
| Credential adoption | `adoptCredentials()` (`http.ts:473`) | Routes through `setClaudeToken()` (so §3 metered rejection applies), plus `openRouterKey` / `todoistToken`, then `authDegrade.recover()`, `broadcastAuthState()`, `restartIdleSessionsForNewToken()` |
| Daemon-native pairing | `/api/fleet/arm`, `/api/fleet/pair`, `/api/fleet/pair/ack` | Join with a 6-digit code, no Server.app required |
| Capability-routed transport | `pushCredential()` + `speaksPairing()` (`src/server/fleet.ts:438`) | `:7701` daemon route when the peer advertises `pairing`; `:7702` Server.app otherwise; 404/405 falls back too. Capabilities are re-probed per member on every rotate |

The credential payload is **already multi-credential** — `FleetPairRequest` and `FleetTokenRequest`
both carry `token`, `todoistToken` and `openRouterKey`. Adding a roster is one more optional field,
not a new channel.

### 7.2 What is still missing

Only the **client-side** half of hub identity. `HUB_URL = daemonBase()` (`web/src/main.ts:171`) is
still positional and `isHub = srv.url === HUB_URL` (`:4218`) still means "the origin that served this
page". Consequences that remain live:

- From a member's URL the Servers tab renders that member as the hub over its own empty `fleet.json`.
- `rotateFleetToken()` (`web/src/main.ts:4308`) posts to that member's `/api/fleet/rotate`, which
  iterates an empty `fleet.list()`; `[].every()` is vacuously `true`, so it returns `ok: true` and
  the UI toasts **"Updated 0/0 Macs."**

The daemon already has the answer and even exposes it: `GET /api/fleet/arm` returns `hubServerId`
(`rest.FleetArmStatusResponse`), and `maybeRenderRepairCard()` (`web/src/main.ts:4370`) already reads
it for the re-pair card. Nothing new needs to be persisted — it needs to be surfaced on the frame the
client already consumes.

`server.hello` (`serverHelloEvent`, `src/server/identity.ts:87`) gains:

```ts
role: "hub" | "member" | "standalone";
hubServerId?: string;   // present when role === "member" (from PairedHubStore)
```

`role` is derived, not stored: `member` when `pairedHub.get()` is non-null, `hub` when `fleet.list()`
is non-empty, else `standalone`. A daemon can be both paired and holding members; `member` wins,
because the question the client is asking is "should I send writes here?".

`hubUrl` is deliberately **not** on the frame. The member knows the hub's `serverId`, not a reachable
URL, and the client already holds a `serverId`-keyed registry of connected servers — resolving id →
socket is the client's job and needs no new server state.

The client then:

- routes roster mutations to the server whose `serverId` matches `hubServerId`, not to `HUB_URL`;
- when loaded from a member origin and not connected to its hub, surfaces "This Mac is part of
  **mac-mini**'s fleet" with a one-click adopt, instead of rendering a bogus empty fleet;
- replaces the `0/0` toast with "This Mac isn't the hub — mac-mini is."

### 7.3 Replication

**No new endpoint.** `FleetPairRequest` and `FleetTokenRequest` gain one optional field:

```ts
accounts?: { rev: number; defaultId: string; entries: { id: string; label: string; token: string; createdAt: number }[] };
```

`adoptCredentials()` grows a branch: when `accounts` is present, persist it as a replica
(`role: "replica"`, `hubServerId` from the same body), then set the default through the existing
`setClaudeToken()` call it already makes. When absent — an older hub — behaviour is bit-for-bit what
it is today.

This inherits, for free: the `sameUser` + `hubServerId` gate, the capability-routed `:7701`/`:7702`
transport with scheme fallback, `authDegrade.recover()`, `broadcastAuthState()`, and
`restartIdleSessionsForNewToken()` (with the r2 predicate from §5.3).

One genuinely new **read** route, because the client must render the picker from a member origin:

```
GET /api/fleet/accounts
  → { rev, defaultId, role: "hub" | "replica", hubServerId?, accounts: [{ id, label, masked, createdAt }] }
```

Masked previews only, never a raw token — matching `src/auth/store.ts`'s existing discipline, and
applying to the WebSocket surface too. Read-only and tailnet-gated like `/api/health`; it discloses
strictly less than the masked preview the Models tab already shows.

**Trigger.** Every hub-side mutation pushes to all members immediately, as does a pair. The hub
records each member's acknowledged `rev` on its `rest.FleetMember` record.

**Staleness.** The Servers tab shows per-member sync state derived from `rev`; the header button
becomes **Sync now**, a retry targeted at members that are behind.

```
┌─ Fleet ──────────────── [↻ Sync now] [+ Add a Mac] ─┐
│ mac-mini    hub · 2 accounts                        │
│ laptop      ⚠ out of date — missing "personal"      │
│ build-box   in sync · 2 accounts                    │
└─────────────────────────────────────────────────────┘
```

**Old members.** Two tiers, both already modelled by `speaksPairing()`:

- A daemon advertising `pairing` but not `accounts` receives the payload and ignores the unknown
  `accounts` field — it keeps working on the default token alone. Its card reads "Update Anvil to use
  multiple accounts."
- A daemon not advertising `pairing` routes to `:7702` as today. `PairRequest` on the Swift side is
  **unchanged**, so no coordinated `Server.app` release is required.

### 7.4 What every Mac ends up holding

Every member holds every token. This widens per-host blast radius over the status quo (where every
Mac holds *the* token) and is justified because the picker must work on the Mac the session runs on.
The gate is unchanged and is not the tailnet-wide one r1 proposed: `/api/fleet/token` requires
`sameUser` **and** a matching `hubServerId`, so a roster push is strictly harder to spoof than r1's
design allowed. Documented in SECURITY.md as part of this change.

---

## 8. Protocol changes

`docs/plans/anvil-protocol.ts` (symlinked as `anvild/protocol.ts`).

### 8.1 New commands and events

```ts
// ── Claude accounts (Settings → Models). Roster is hub-authoritative; members hold replicas. ──
export interface AuthAccountsGetCmd    extends Envelope, Correlated { type: "auth.accounts.get" }
export interface AuthAccountAddCmd     extends Envelope, Correlated { type: "auth.account.add"; label: string; token: string }
export interface AuthAccountRenameCmd  extends Envelope, Correlated { type: "auth.account.rename"; accountId: string; label: string }
export interface AuthAccountReplaceCmd extends Envelope, Correlated { type: "auth.account.replace"; accountId: string; token: string }
export interface AuthAccountRemoveCmd  extends Envelope, Correlated { type: "auth.account.remove"; accountId: string }
export interface AuthAccountDefaultCmd extends Envelope, Correlated { type: "auth.account.default"; accountId: string }

export interface AuthAccountsEvent extends Envelope {
  type: "auth.accounts";
  rev: number;
  defaultId: string;
  role: "hub" | "replica";
  hubServerId?: string;   // present on a replica; sourced from PairedHubStore, not the roster file
  accounts: { id: string; label: string; masked: string; createdAt: number }[];  // never `token`
}

// ── Session rebinding ──
export interface SessionAccountSetCmd extends Envelope, Correlated {
  type: "session.account.set"; sessionId: SessionId; accountId: string;
}
```

`auth.accounts` is broadcast on every mutation, like the existing `auth.status`.

### 8.2 Modified types

| Type | Addition |
|---|---|
| `SessionCreateCmd` (`:930`) | `accountId?: string` |
| `Session` | `accountId?`, `accountLabel?`, `accountMissing?` |
| `Environment` | `accountId?: string` |
| `ServerHelloEvent` | `role: "hub" \| "member" \| "standalone"`, `hubServerId?: string` (§7.2 — **not** `hubUrl`; the client resolves id → socket from its own registry) |
| `rest.FleetMember` | `accountsRev?: number` (last acknowledged) |
| `rest.FleetPairRequest` | `accounts?: { rev, defaultId, entries[] }` — optional; an older joiner ignores it (§7.3) |
| `rest.FleetTokenRequest` | `accounts?: { rev, defaultId, entries[] }` — same shape, same optionality |
| `rest.FleetAccountsResponse` *(new)* | `{ rev, defaultId, role, hubServerId?, accounts: [{ id, label, masked, createdAt }] }` |

`auth.status` / `auth.set` / `auth.clear` (`:1166`–`:1180`) are **kept and remain functional**: they
operate on the default account. An old client that only knows the single-token protocol continues to
work — `auth.set` replaces the default account's token, `auth.status` reports it.

### 8.3 Versioning

`PROTOCOL_VERSION` bumps; `anvild/test/contract/protocol-surface.golden.json` is regenerated via
`test/contract/regen-golden.ts`. `SERVER_CAPABILITIES` (`src/server/identity.ts:84`, currently
`["autopilot", "autopilot-maintenance", "auth", "prompts", "lapo", "pairing", "model-labels"]`) gains
`"accounts"`; the web client gates every new command behind `serverSupports(srv, "accounts")` and
falls back to the single-token UI against an older daemon — the same pattern `renderModelsPanel()`
already uses for `"auth"`. Hub-side, `"accounts"` is the flag that decides whether a member gets the
roster in its credential push or just the default token (§7.3), re-probed per member exactly as
`speaksPairing()` already is.

---

## 9. UI surfaces

### 9.1 Settings → Models (roster)

Replaces the single masked field in `renderModelsPanel()` (`web/src/main.ts:3204`). The OpenRouter
card below it is untouched.

```
Claude accounts                              [+ Add account]
┌────────────────────────────────────────────────────────┐
│ ● work       sk-ant-oat…4f2      default   [⋯]         │
│ ○ personal   sk-ant-oat…9b1                [⋯]         │
└────────────────────────────────────────────────────────┘
   ⋯ = Make default · Rename · Replace token · Remove

ⓘ Managed on mac-mini (the hub). Changes sync to every Mac.
```

The Add dialog takes a label and a token, and shows the exact command to run with a copy button and
the host to run it on:

```
┌─ Add a Claude account ──────────────────┐
│ Label  [ personal                     ] │
│                                         │
│ On mac-mini, run:                       │
│   claude setup-token            [copy]  │
│ then paste the sk-ant-oat… token below. │
│ Token  [ •••••••••••••••••••••••••••• ] │
│                    [ Cancel ]  [ Add ]  │
└─────────────────────────────────────────┘
```

Validation: non-empty label, unique case-insensitively, ≤32 chars; token non-empty and not
`sk-ant-api…` (reusing `looksLikeMeteredKey`, with today's §3 error text).

Removal shows the active sessions bound to the account:

```
┌─ Remove "personal"? ────────────────────┐
│ 3 active sessions use this account:     │
│   · anvil / feat/tokens                 │
│   · anvil / fix-sync                    │
│   · dotfiles / cleanup                  │
│ They'll fall back to "work".            │
│                 [ Cancel ]  [ Remove ]  │
└─────────────────────────────────────────┘
```

### 9.2 New-session dialog

An Account row beneath Environment, pre-filled per §5.1, hidden when the roster has one entry.

### 9.3 Session header

`anvil · feat/tokens · ● work [▾]` — the dropdown rebinds, disabled while running with the tooltip
"finish or stop the current turn first". After a fallback: `● work ⚠ was personal`.

### 9.4 Settings → Servers

Per-member sync state and the renamed **Sync now** button (§7.3). A non-hub origin shows
"This Mac isn't the hub — **mac-mini** is" with a button to switch context, instead of an empty fleet.

### 9.5 Environment dialog

An optional Account row, described as "used for scheduled autopilot runs and pre-selected for new
sessions."

---

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Token looks like `sk-ant-api…` | Rejected at every entry point (UI, replication, migration) with today's §3 message |
| Duplicate label | Rejected with "an account called 'work' already exists" |
| Remove the last account | Rejected — the §3 guard requires at least one |
| Remove the default with others present | Requires choosing a new default first, in the same dialog |
| Session's account removed | Fall back to default, `accountMissing: true`, persistent header badge (§5.4) |
| Session's account not yet replicated | Spawn refused with a Sync now prompt (§5.4) |
| Resume fails after rebind | Fresh context + persisted divider (§5.5) |
| Rebind while running | Rejected client-side (disabled) and server-side (stale client) |
| Member offline during push | Marked out of date; retried on next mutation and by Sync now |
| Member advertises `pairing` but not `accounts` | Gets the credential push without the roster and keeps working on the default token; "Update Anvil to use multiple accounts" on its card |
| Member advertises neither (pre-`pairing` daemon) | Routes to `:7702` unchanged via `pushCredential()`; Swift `PairRequest` untouched |
| Roster push rejected `untrusted tailnet user` / `unknown hub` | Surfaced per member on its card; not retried blindly — it is an answer, not a transport failure (`pushCredential`'s existing rule) |
| Env file unwritable during mirror | Roster mutation still succeeds; warn "won't survive a restart", reusing the existing `persistWarn` pattern (`web/src/main.ts:3219`) |
| Non-hub daemon asked to fan out | Explicit "this Mac isn't the hub" instead of `Updated 0/0 Macs` |
| `accounts.json` corrupt | Treated as empty and re-seeded from the env token, matching `FleetStore`'s corrupt-file handling |

---

## 11. Security

- Raw tokens **never** cross the wire to a client. Every read path returns `{ id, label, masked }`.
  The only place a raw token travels is hub → member daemon over the tailnet, and hub → env file.
- `accounts.json` is `0600` in a `0700` directory, same as the env file.
- The §3 invariant is unweakened: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` still refuse startup,
  and metered keys are refused at every insertion point.
- `buildAgentEnv` still constructs the child environment as an explicit allow-list, so exactly one
  Claude token reaches a spawn and no other credential leaks in.
- Every member holding every token is a real change in per-host blast radius (§7.4) and gets a
  paragraph in SECURITY.md.
- The replication endpoint is write-only for tokens: a caller can push a roster but can never read
  one back in plaintext.
- The roster push inherits `/api/fleet/token`'s **identity** gate — `sameUser` via
  `resolveCallerIdentity`, plus `hubServerId === pairedHub.get().hubServerId`, with `unknown` trust
  refused. This is strictly stronger than the plain tailnet gate revision 1 specified, and stronger
  than the Todoist replication landing point next to it.
- `GET /api/fleet/accounts` is read-only and returns masked previews only, so it discloses no more
  than the Models tab already does.

---

## 12. Testing

**Unit (`bun:test`), the bulk of the coverage:**

- `accounts.test.ts` — add/rename/replace/remove/set-default; `rev` monotonicity; metered-key
  rejection; duplicate labels; last-account and default-removal guards; corrupt-file recovery.
- `accounts-migration.test.ts` — env token + empty roster seeds one default; idempotent on second
  boot; no-op when the roster is populated; metered env value never seeded.
- `accounts-mirror.test.ts` — default change rewrites the env line; non-default mutations do not;
  unwritable file surfaces a warning without failing the mutation.
- `agent-env.test.ts` (extend) — resolution order of §4.1; `"glm"` profile still carries no Claude
  token; missing `accountId` falls back correctly.
- `auth.test.ts` (extend) — `subscriptionAuthOk` is true on env-token-only and on roster-only;
  `fatal` still true on `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`; a missing token is still
  non-fatal (degraded boot, headless-join §4.1).
- `accounts-replication.test.ts` — `adoptCredentials()` persists a pushed roster as a replica;
  an absent `accounts` field leaves today's behaviour bit-for-bit unchanged; `rev` comparison marks a
  member stale; a peer without the `accounts` capability is sent the default token only; injectable
  transport, no real tailnet (following `fleet.ts`'s existing `RunTailscale`/`Probe`/`fetchImpl`
  injection pattern).
- `pairing.test.ts` (extend) — the `sameUser` + `hubServerId` gate still rejects a roster push from
  an unpaired or wrong hub; `unknown` trust is still refused on `/api/fleet/token`.
- `identity.test.ts` (extend) — `role` derivation (`member` when paired, `hub` when it has members,
  else `standalone`; `member` wins when both) and `hubServerId` in `server.hello`; `"accounts"` in
  `SERVER_CAPABILITIES`.
- `auth-degrade.test.ts` (extend) — a roster mutation that routes through `setClaudeToken()` clears
  the degrade marker; one that does not touch the default leaves it alone (§3.2 / §4.3).
- `accounts-restart.test.ts` — the §5.3 predicate: a push that adds a *non-default* account
  restarts **no** drivers; one that changes a session's resolved token restarts exactly that session;
  a mid-turn session is left alone and gets the existing error message.
- `contract/protocol-surface.test.ts` — regenerated golden, `PROTOCOL_VERSION` bumped.

**Integration:**

- Supervisor rebind: driver stopped and deleted, `claudeSessionId` preserved, next
  `ensureDriver` builds with the new token (fake `queryFn`).
- Resume-failure path: forced error nulls `claudeSessionId` and emits the divider.
- Removal fallback: session gets `accountMissing`, spawns on the default.

**Web:** `typecheck:web` + `build:web` + the headless smoke seeds a two-account roster and renders
the Models roster, the create-dialog picker, and the header control.

**Manual, on the real fleet** (the parts no unit test reaches): a genuine second subscription token,
a genuine mid-session switch, and a genuine member Mac going offline across a mutation.

**Phase 0 spike, gating phase 4:** two real tokens, one session, swap accounts, prompt again. Confirm
whether the Claude Code CLI will `--resume` a conversation created under a different account. If it
refuses, phase 4 still ships — the fresh-context path (§5.5) simply becomes the norm rather than the
exception, and the divider copy is adjusted to say so plainly.

**All four CI gates green before each commit:** `bunx tsc --noEmit`, `bun run typecheck:web`,
`bun run build:web`, `bun test`.

---

## 13. Rejected alternatives

| Rejected | Why |
|---|---|
| **Hub-only roster, members fetch at spawn** | Makes the hub a hard runtime dependency for starting any session anywhere; hub down = laptop cannot spawn |
| **Member daemon proxies writes to the hub** | Invents an inbound member→hub authenticated channel with no precedent; today's pairing gate lives on the *member* side |
| **Per-daemon rosters, no sync** | Configure N times, and drift is invisible — the exact failure the current fleet already has |
| **Replicate over the `:7702` Server.app listener** | Requires the macOS menu-bar app on every member; excludes headless and Linux. Already solved upstream — `pushCredential()` routes by capability and keeps `:7702` only as the pre-`pairing` fallback |
| **A new `POST /api/fleet/accounts` write endpoint** *(r1's choice)* | A second credential channel beside `/api/fleet/token`, with a weaker gate. Extending the existing payload inherits the `sameUser` + `hubServerId` gate, the capability routing, the scheme fallback and the degrade-recovery side effects for free |
| **Building a hub role in the daemon** *(r1's plan)* | Already exists as `PairedHubStore`. Only the client-side surfacing was missing |
| **Porting `whois` to the daemon** *(r1 listed this as rejected)* | Not a rejection — `resolveCallerIdentity` shipped with headless-join and is the status quo |
| **A bespoke driver teardown for account switching** *(r1's §5.3)* | `restartIdleSessionsForNewToken()` already does it, including the mid-turn message. r2 extracts a per-session variant instead of duplicating the loop |
| **Per-account auto-degrade** | Leaves a machine half-authenticated with no coherent screen; the takeover/re-pair recovery flow is inherently machine-scoped (MA-11) |
| **Retire `CLAUDE_CODE_OAUTH_TOKEN` from the env file** | Touches the install gate, the launcher template, `Auth.swift` and the headless-join docs in one change, for cleanliness alone |
| **Env file holds the default, roster holds extras** | Two stores, two shapes; the default would have no label and could not be renamed |
| **Global `/login` parity only** | Cannot keep two concurrent sessions on different accounts — the one thing a multi-session daemon offers over the CLI |
| **No pinning; sessions follow the current default** | Flipping the default silently re-bills every session; "which account is this session on" has no stable answer |
| **Pinned and immutable** | Cheap to allow rebinding (§5.3 reuses `reset()`'s teardown), and rebinding is the behaviour actually asked for |
| **Refactor all credential fan-outs onto one `fleet/sync.ts`** | A day of refactor touching the working `:7702` path, inside an already sizable feature. Revisit once there are three consumers |
| **In-app PTY for `claude setup-token`** | `TerminalManager` is keyed by session id (`supervisor.ts:2114`); a session-less settings terminal is new surface, not reuse |
| **Auto-import the host's Claude credentials** | Undocumented, platform-specific store (Keychain on macOS); reverse-engineering a private format that can change under us |

---

## 14. Future work (explicitly not in this design)

- Per-account usage attribution in `src/budget/tracker.ts`, and a "usage by account" card.
- Automatic failover when an account hits its limit — needs reliable 429/limit detection first.
  Note `auth/degrade.ts` already distinguishes auth-class failures from rate-limit ones, so the
  signal exists; the policy does not.
- Per-account auto-degrade, so one expired token doesn't present the whole machine as logged out
  (MA-11).
- Generalising the credential fan-out once a third consumer appears (§13).
- Per-team-member accounts.
- Resolving an account's email from its token, so labels could be verified rather than trusted.

---

## 15. Phase tracking

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 0 | **Spike:** does the Claude Code CLI `--resume` a conversation across accounts? Gates phase 4's copy, not its existence | pending | no | no |
| 1 | `AccountStore` + `accounts.json` + migration from the env token + default-mirroring **through `setClaudeToken()`** (§3.2, preserves degrade-marker clearing). *No guard work — already satisfied on `main` (§4.2).* Server-only, no UI | pending | no | no |
| 2 | Protocol: `auth.accounts.*`, `session.account.set`, `Session`/`Environment`/`server.hello` additions, `"accounts"` capability, `PROTOCOL_VERSION` bump + golden regen | pending | no | no |
| 3 | Hub-side roster CRUD + Settings → Models roster UI (add / rename / replace / remove / set default) | pending | no | no |
| 4 | Session binding: `accountId` at create, `agentEnv(s)` threading, create-dialog picker, session-header display | pending | no | no |
| 5 | Rebinding: extract `restartDriverForNewToken()` from `restartIdleSessionsForNewToken()` + the non-default-account predicate (§5.3), `session.account.set`, resume-failure divider, removal fallback + `accountMissing` badge | pending | no | no |
| 6 | Hub identity, **client-side only**: derive `role`/`hubServerId` in `server.hello`, route roster writes by `serverId`, adopt-your-hub card from a member origin, replace the `0/0` toast. *(`PairedHubStore` already persists the hub — nothing new server-side)* | pending | no | no |
| 7 | Replication: `accounts?` on `FleetPairRequest`/`FleetTokenRequest`, the `adoptCredentials()` branch, `GET /api/fleet/accounts`, auto-push on mutation and pair, per-member `rev`, Servers-tab sync state + Sync now, `accounts`-capability tiering. *(no new write endpoint; inherits the existing gate + transport routing)* | pending | no | no |
| 8 | Environment `accountId` + autopilot resolution + autopilot report line | pending | no | no |
| 9 | Docs: `SECURITY.md` blast-radius note, `anvil-multi-server.md` MS-2 superseded, `README`/`anvild/README` token setup | pending | no | no |

Phases 1–5 are a complete, shippable single-server feature. Phases 6–8 layer the fleet on top.
