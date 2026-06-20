# Anvil Multi-Server (Fleet) Architecture

**Version:** 0.1-draft
**Created:** 2026-06-20
**Status:** DESIGN — not started
**Extends:** `anvil-native-architecture.md` (§3 auth, §5 sessions, §6 protocol) and `anvil-protocol.ts` (v0.5)

---

## 0. Summary

Today Anvil is **one daemon, one web client** (the client is served by, and talks only to, its own
daemon — `connect-src 'self'`). This doc designs the jump to **one client managing many servers**:
each Mac runs its own `anvild`, and a single client lists every machine's sessions together and
connects to each over Tailscale.

**Locked decisions (interview 2026-06-20):**
| # | Decision | Choice |
|---|---|---|
| MS-1 | Topology | **One client, many servers** — client holds a server registry, opens one WS per server |
| MS-2 | Auth across Macs | **One Max subscription** — the same `CLAUDE_CODE_OAUTH_TOKEN` on every server (⚠ see §8) |
| MS-3 | Client form (near-term) | **Hub web app** — one designated daemon serves the web client; it fans out to all servers (keeps the web app as the daily driver). Native multi-server client is the eventual ceiling. |

---

## 1. Goal

Drive Claude across several Macs from one place — e.g. a beefy desktop + a laptop + a build box —
each with its own local repos, worktrees, and tools, without juggling N browser tabs. Sessions stay
**server-local** (a worktree lives on a specific machine); the client federates the *view*, not the
work.

---

## 2. Topology

```
                       ┌─────────────────────────────┐
                       │   Client (hub web app or     │
                       │   native): server registry   │
                       └───────┬──────────┬───────────┘
              wss (tailnet)    │          │   wss (tailnet)
            ┌──────────────────┘          └───────────────────┐
            ▼                                                  ▼
   anvild @ mac-mini.ts.net:7701                  anvild @ laptop.ts.net:7701
   (its repos / worktrees / PTYs)                 (its repos / worktrees / PTYs)
```

- Each server is an independent `anvild` with its own state dir, sessions, worktrees, budget, and
  Tailscale HTTPS endpoint (`tailscale serve --https=7701`).
- The client opens **one WebSocket per server** and merges their `session.list`s into one view,
  grouped/labeled by server. No server-to-server traffic; no central database.

---

## 3. Server identity

Each server needs a stable identity so the client can label sessions and persist the registry.

- Add `serverId` (stable, persisted in the state dir) + `serverName` (default: hostname; configurable).
- Surface it two ways:
  - **`GET /api/health`** gains `{ serverId, serverName }` (already the natural "who are you" probe).
  - A **`server.hello`** event sent on WS open (alongside `session.list`/`budget`/`environments`),
    so a connected client knows which server a frame came from without threading it through `fetch`.
- Session ids are already globally unique (`newId`), but the client still **namespaces by
  `serverId`** (a session is addressed as `(serverId, sessionId)`) so two servers can never collide
  in the UI and routing is unambiguous.

---

## 4. Connection model (client)

A **ConnectionManager** in the client owns N `AnvilSocket`s, keyed by `serverId`:

- **Registry**: a list of servers `{ id?, name?, url }` the client knows about. Stored client-side
  (localStorage for the web hub). Add a server by tailnet URL (e.g. `https://laptop.ts.net:7701`);
  the client probes `/api/health` to learn its `serverId`/`serverName` and confirm reachability.
- **Per-server socket**: same protocol as today; each maintains its own seq watermarks, reconnect,
  and attach state **scoped by serverId** (the existing `anvil.seq.*` / `anvil.convo.*` keys gain a
  `serverId` prefix).
- **Aggregation**: the sidebar shows sessions grouped under collapsible **server sections**
  (online/offline badge per server from the connection state). A session's commands route to its
  server's socket. "New session" picks **server → environment → name**.
- **Offline servers**: a server that's asleep/unreachable shows greyed with its last-known sessions
  (from cache) and a reconnect affordance; commands queue or error cleanly.

---

## 5. Client form

### 5.1 Hub web app (near-term, MS-3)

Keep the web client as the daily driver, but let it talk to many servers:

- One Mac is the **hub** — its `anvild` serves the web bundle. The bundle's ConnectionManager
  connects to the hub's own daemon **and** every other server in the registry.
- **CSP**: the page is served by the hub with `connect-src` widened from `'self'` to the tailnet,
  e.g. `connect-src 'self' wss://*.<tailnet>.ts.net:7701 https://*.<tailnet>.ts.net:7701`. (Tailscale
  issues valid per-node certs, so cross-node `wss` is trusted with no mixed-content/cert prompts.)
- Everything else (rendering, reader, terminal, git, push) is unchanged — it just runs against
  whichever server owns the active session.
- Tradeoff: the hub must be up to load the UI (but any server can be the hub; the registry is the
  same everywhere, so you can open the app from whichever machine is awake).

### 5.2 Native client (eventual)

A SwiftUI/Compose client is the cleaner long-term home for fleet management (no CSP gymnastics, a
real server registry, background reconnect, native push). The protocol designed here is identical,
so the hub web app and a future native client are interchangeable front-ends.

---

## 6. Protocol changes (small — the protocol is already per-connection)

- **Add** `serverId`, `serverName` to `HealthResponse`.
- **Add** a `server.hello { serverId, serverName, version, protocolVersion }` event, emitted on WS
  open before `session.list`.
- **No change** to session/command frames — they're already per-connection; the client attaches the
  `serverId` from the socket they arrived on. Bump the protocol doc to v0.6 and note the additions.

---

## 7. Auth & the shared-budget problem (LOAD-BEARING)

MS-2 reuses one `CLAUDE_CODE_OAUTH_TOKEN` on every server. Two consequences:

1. **Concurrency / ToS (must verify first).** It's unconfirmed that one Max subscription may legitimately
   drive Claude Code on multiple machines simultaneously. **Prerequisite experiment (§11.0):** install
   `anvild` on a second Mac with the same token and run concurrent turns on both; watch for auth
   errors / rate-limit / throttling. If it's disallowed or harshly limited, revisit MS-2
   (separate accounts per Mac).
2. **Budget tracking is per-server, but the limit is per-account.** Each server's `BudgetTracker`
   independently believes it owns the full pool (e.g. 20 Opus-hrs), so N servers can collectively
   burn N× the real allotment before any local soft-stop fires — then turns just start failing at
   the account level.
   - **v1 mitigation:** the client **sums budgets across servers** and shows an *aggregate* gauge +
     warning; each server still soft-stops on its own fraction. Good enough to stay aware.
   - **Later:** a shared budget ledger — designate the hub as a coordinator that servers report
     usage to, or a small shared store — so soft-stop reflects true account usage. Out of scope for v1.

Each server independently keeps the §3 invariant (token present, `ANTHROPIC_API_KEY` absent).

---

## 8. Security posture

- **Tailnet is the boundary** (unchanged). Every server binds `127.0.0.1` + `tailscale serve`; only
  tailnet devices reach them. No app-level token yet.
- **Larger blast radius:** the same OAuth token now lives on N Macs — compromise of any one leaks the
  token. Keep `~/.config/anvil/env` `chmod 600`; consider per-machine tokens if/when that's possible.
- The hub web app reaching other nodes is just the browser making tailnet `wss` connections; no new
  inbound surface beyond what `tailscale serve` already exposes per node.

---

## 9. Packaging & install (after the design lands)

Goal: stand up `anvild` on a new Mac in minutes. **Not a DMG** (that's for GUI apps). Options, in
order of preference:

1. **`bun build --compile`** → a single self-contained `anvild` binary (bundles the Bun runtime +
   code + JS deps). Verify the Agent-SDK CLI spawn still resolves when compiled (the SDK launches a
   child via `executable: "bun"`); keep a fallback to "install Bun + run from source" if not.
2. **Install script** (extends `scripts/service.sh`): drop the binary, write the LaunchAgent, prompt
   for the shared token, run `tailscale serve`, set a server name.
3. **`.pkg`** (signed/notarized) if a double-click installer is wanted later.

First-run per machine: (a) the shared `CLAUDE_CODE_OAUTH_TOKEN`, (b) assert no API key, (c)
`tailscale serve --https=7701`, (d) a server name. Bundle `web/dist` for the hub role.

---

## 10. UI sketch

- Sidebar: **server sections** (name + online dot), each listing that server's sessions; collapsed
  for offline servers. A "＋" per server, or a global "＋" that asks which server.
- Header: the active session already shows its title/icon; add a small server chip.
- Budget: per-server gauges + one aggregate "account" gauge (the real ceiling, §7).
- Add-server flow: paste a tailnet URL → probe `/api/health` → save to registry.

---

## 11. Phased plan

**11.0 Prerequisite experiment (gates MS-2):** same token on a 2nd Mac, concurrent turns — confirm
it's allowed and not crippled. *(Do this before building the fleet UI.)*

1. **Server identity** — `serverId`/`serverName` in health + `server.hello`; persist id. (Daemon only; backward-compatible.)
2. **Client ConnectionManager + registry** — multi-socket, serverId-scoped state, add/remove servers, sidebar grouping. (Hub web app: widen CSP.)
3. **Aggregate budget gauge** — sum across servers + warning (§7 v1 mitigation).
4. **Packaging** — `bun build --compile` binary + install script for easy rollout (§9).
5. *(Eventual)* native multi-server client; shared budget ledger.

---

## 12. Open questions / risks

- **[gating] One Max token across machines** — allowed? throttled? (§11.0). Everything else assumes yes.
- **Aggregate budget** — per-server soft-stop can't see account-wide usage until a ledger exists (§7).
- **Compiled-binary Agent-SDK spawn** — confirm the SDK's child-process launch survives `bun --compile` (§9.1).
- **Hub availability** — the web hub needs *a* server up to load the UI; mitigated by any node being able to host it. A native client removes this entirely.
- **Cross-node cert trust** — relies on Tailscale per-node HTTPS certs; verify in-browser `wss://*.ts.net` connects without prompts.
