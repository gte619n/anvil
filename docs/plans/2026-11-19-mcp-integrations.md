# MCP integrations: Fusion, SolidCraft and a browser for Anvil sessions

- **Status:** Superseded as plan of record by `2026-11-19-agent-cad-and-browser.md`. The registry
  design here (§4.1 to §4.5, §6, §7, §9) is still authoritative for that spec's Track C, as amended
  by its §4.12. The Fusion and SolidCraft presets and Phase 3 here are dropped. · **Owner:** Evan Ruff · **Branch:** `computer-use`
- **Created:** 2026-11-19 · **Supersedes/extends:** extends the CAD viewer
  (`2026-11-06-cad-viewer.md`); no prior MCP spec

## 1. Objective & non-goals

A session on any fleet machine can be given named external tool servers ("integrations") that the
daemon manages: Autodesk Fusion (its official local MCP server), SolidCraft (headless CAD) and a
browser (Playwright MCP). The operator registers an integration once per machine in Settings,
switches it on per session, approves its tool calls from any device, and sees its screenshots and
CAD exports in the chat. This is how the fleet gets "computer use" for CAD and browsing without
pixel-level screen control.

Non-goals:

- **No pixel-level screen control.** The `anvil-computer` Swift helper (screenshot + mouse and
  keyboard events) is a later spec. Nothing here needs Screen Recording or Accessibility grants.
- **No loading of ambient Claude Code config.** `settingSources: []` stays. `~/.claude.json` and
  `.mcp.json` servers are never read.
- **No arbitrary MCP marketplace.** v1 ships three presets plus a "custom" entry that the operator
  types in by hand. No discovery, no install-from-URL.
- **No integrations for autopilot, team or concierge sessions in v1.** Only ordinary sessions can
  enable one (see §4.3). Unattended CAD in autopilot is a follow-up once approvals are proven.
- **No installing Fusion or SolidCraft.** The daemon detects them; the operator installs them.
- **No app-layer auth.** Tailscale remains the security boundary.

## 2. Context

Today `AgentDriver` accepts only in-process MCP servers (`McpSdkServerConfigWithInstance`,
`anvild/src/agent/driver.ts:82`), and `Supervisor.ensureDriver` picks exactly one by session role
(`anvild/src/session/supervisor.ts:1681`). With `settingSources: []` (`driver.ts:247`) nothing a
user configured for Claude Code on their laptop reaches an Anvil session.

What already exists and is reused:

- **The SDK supports external servers.** `Options.mcpServers` is
  `Record<string, McpServerConfig>`, which includes `McpStdioServerConfig` and
  `McpHttpServerConfig`. `Query` exposes `mcpServerStatus()`.
- **The permission gate sees every tool.** `makePreToolUseHook` (`agent/permissions.ts`) is
  registered for all tools, so `mcp__<server>__<tool>` calls reach `decide()`.
- **Screenshots render.** `toolResultImages` (`agent/map.ts:243`) lifts base64 images off any tool
  result; the supervisor persists them as attachments.
- **CAD files open in the viewer.** `file-offer.ts` already lists STEP, GLB, STL, 3MF and OBJ as
  deliverables, and the web client offers "View CAD" on those cards.
- **Capability gating.** `SERVER_CAPABILITIES` (`server/identity.ts`) plus `serverSupports()` on
  the web side, as used by `claude-cli-update`.

The three servers, as researched on 2026-11-19:

| | Transport | Needs | Notes |
|---|---|---|---|
| Fusion (official) | Streamable HTTP, `http://127.0.0.1:27182/mcp`, no auth | Fusion desktop running with a document open; enabled in Preferences → General → API | Tool list is dynamic and may change between releases. One Fusion instance per machine. |
| SolidCraft | stdio, `solidcraft-cli mcp` | CLI on PATH (the macOS app links it) | Headless, one process per session. Sandboxes file access to the design folder; `--allow-path DIR` widens it. `screenshot` and `export` tools. Six weeks old. |
| Playwright MCP | stdio, `npx @playwright/mcp` | Node | Structured page access; no macOS privacy grants. |

Relevant memories: the daemon is the permission authority (skills load through `plugins` for the
same reason); Tailscale is the accepted boundary; per-user state syncs via the daemon, not
localStorage.

## 3. Inputs & scope

- **In scope:**
  - `anvild/src/agent/driver.ts`, `permissions.ts`, `questions.ts`, `file-offer.ts`
  - new `anvild/src/mcp/` (store, presets, health, lock)
  - `anvild/src/session/supervisor.ts` (wiring only), new `session/mcp-integration-service.ts`
  - `anvild/src/server/identity.ts`, `dispatch.ts`
  - `anvild/protocol.ts` (+ `docs/plans/anvil-protocol.ts` and the protocol golden via regen)
  - `anvild/web/src/settings.ts` and the session header/composer
- **Out of bounds:** `settingSources`; `agent/danger-list.ts` (no MCP danger rules in v1, see §4.4); the §3 agent-env allow-list in `agent/env.ts`; the Update
  API v1; the built-in server names `anvil`, `anvil_team`, `anvil_member`, `anvil_planning`;
  existing tests that back other specs' acceptance rows.
- **Available inputs:** `@anthropic-ai/claude-agent-sdk` types in `node_modules`; a Fusion install
  on the M3 laptop; SolidCraft's DMG; the injected-`queryFn` driver test seam.
- **Assumptions log:**

| # | Assumption | Why | Confirmed |
|---|---|---|---|
| A1 | The SDK accepts stdio and HTTP servers alongside an sdk server with `settingSources: []` | Types allow it | Unconfirmed, Phase 0 |
| A2 | PreToolUse fires for external MCP tools with `tool_name` = `mcp__<key>__<tool>` | True for sdk servers today | Unconfirmed, Phase 0 |
| A3 | Image blocks from external servers arrive in the same `tool_result` shape `toolResultImages` reads | Standard MCP image content | Unconfirmed, Phase 0 |
| A4 | A stdio server inherits the CLI's environment, so it can read the session's Claude token | How Claude Code spawns stdio servers | Unconfirmed, Phase 0; see §6 |
| A5 | Fusion's server works on macOS and exposes an export or script tool | Docs don't say | Unconfirmed, Phase 0 on the M3 |
| A6 | The web client talks to each member directly, so a per-daemon event reaches the UI without hub relay | Same as `environments` | Confirmed in code |
| A7 | An integration that fails to connect does not fail the turn; its tools are just absent. With `alwaysLoad: true` its tools are in the turn-1 prompt, at the cost of up to 5 s of startup | SDK type docs | Unconfirmed, Phase 0 |
| A8 | When the PreToolUse hook throws or times out (3600 s), the call falls through to `canUseTool` rather than being allowed outright | Needed for the fail-closed backstop in §4.4 | Unconfirmed, Phase 0 |
| A9 | Playwright MCP can block a list of origins by flag | Needed for §6 "browser cannot reach the daemon" | Unconfirmed, Phase 0 |
| A10 | No `mcp__*` tool other than the four role servers' is present in a session today | So the unknown-key deny breaks nothing | Unconfirmed, Phase 0 |

## 4. Design

### 4.1 Data model (authoritative)

```ts
// protocol.ts
export type McpIntegrationKind = "fusion" | "solidcraft" | "browser" | "custom";
export interface McpIntegration {
  id: string;              // "mcpi_…"
  key: string;             // server key → tool prefix mcp__<key>__ ; /^[a-z][a-z0-9]{1,23}$/ (no underscores)
  kind: McpIntegrationKind;
  label: string;
  transport:
    | { type: "http"; url: string }                         // loopback only, see §6
    | { type: "stdio"; command: string; args: string[] };
  exclusive: boolean;      // one session at a time on this machine (fusion: true)
  enabled: boolean;        // operator kill switch for the machine
}

export type McpHealth =
  | { state: "ready" }
  | { state: "unavailable"; reason: string }  // port closed, command not found
  | { state: "disabled" };

export interface McpIntegrationStatus extends McpIntegration {
  health: McpHealth;
  heldBy?: string;         // sessionId holding the exclusive lock
  checkedAt: number;
}

export interface McpIntegrationsEvent extends Envelope {
  type: "mcp.integrations";
  integrations: McpIntegrationStatus[];
}

// Session gains:
//   mcpIntegrations?: string[];   // integration ids enabled for this session
//   mcpAllowed?: string[];        // integration ids with "always allow this session" (see §4.4)

// Commands
//   { type: "mcp.integration.add";    integration: Omit<McpIntegration, "id"> }
//   { type: "mcp.integration.update"; id: string; fields: Partial<Omit<McpIntegration, "id" | "key" | "kind">> }
//   { type: "mcp.integration.remove"; id: string }
//   { type: "mcp.integration.check" }                       // re-probe health now
//   { type: "session.set_mcp_integrations"; sessionId: string; ids: string[] }
```

Capability: `"mcp-integrations"` in `SERVER_CAPABILITIES`. The web client hides all of this on a
daemon that doesn't advertise it.

### 4.2 Store, presets, health

- **`mcp/store.ts`, `McpIntegrationStore`** follows `EnvironmentStore`: persisted to
  `<stateDir>/mcp-integrations.json`, per machine, not hub-synced. Integrations describe software
  installed on one machine, so there is nothing to share. A corrupt file is renamed to
  `.corrupt-<ts>` and the store starts empty (new behaviour; `EnvironmentStore` does not
  quarantine).
- **`mcp/presets.ts`** returns the default entry for each kind:
  - `fusion`: http `http://127.0.0.1:27182/mcp`, `exclusive: true`.
  - `solidcraft`: stdio `solidcraft-cli mcp --headless --allow-path {cwd}`, not exclusive.
  - `browser`: stdio `npx -y @playwright/mcp@<pinned> --isolated` plus the origin block from §6,
    not exclusive. The version is pinned in the preset, never `@latest`.
  - `{cwd}` in args is replaced with the session worktree when the driver starts. It is the only
    substitution.
- **`mcp/health.ts`** probes on daemon start, on `mcp.integration.check`, when a client connects,
  on `session.set_mcp_integrations`, before a turn starts on a session that has integrations (so
  a cached result is never older than that turn), and every 60 s while any client is connected:
  - http: TCP connect to the port with a 1 s timeout.
  - stdio: resolve `command` on the daemon's PATH. The probe does not launch the server.
  - Results are broadcast as `mcp.integrations` only when they change.
  - When an integration's health or `enabled` flips, the service drops the idle drivers of every
    session that references it, so their next turn rebuilds with the right set. A session that is
    mid-turn is rebuilt when that turn ends.
- **`session/mcp-integration-service.ts`** owns the store, the health loop, the lock and the
  commands, following `EnvironmentService`. The supervisor keeps thin delegates.

### 4.3 Driver wiring

A pure function in `agent/mcp-external.ts` decides the whole server map, so it can be tested
without a supervisor:

```ts
buildMcpServers(
  session: SessionData,
  roleServer: Record<string, McpSdkServerConfigWithInstance> | undefined,
  integrations: McpIntegrationStatus[],
): { servers: Record<string, McpServerConfig>; skipped: { label: string; reason: string }[] }
```

1. Start from the role server, as today (`anvil`, `anvil_team`, `anvil_member`, `anvil_planning`,
   or none).
2. If the session is an ordinary one (not default, lead, member or planner), add each id in
   `session.mcpIntegrations` that is `enabled` and `ready`, under its `key`.
   - http: `{ type: "http", url, alwaysLoad: true }`. The URL is re-validated here (§6), because
     the store is a plain JSON file that a session's Bash could edit.
   - stdio: wrapped so the server never sees the session's credentials (§6):
     `{ command: "/usr/bin/env", args: ["-i", "PATH=…", "HOME=…", "TMPDIR=…", command, ...args], alwaysLoad: true }`.
3. Anything not added is returned in `skipped`; the supervisor emits one notice line per entry.

`ensureDriver` calls it and passes the result on. The driver's `mcpServers` parameter widens to
`Record<string, McpServerConfig>`. The driver also sets, for every session:

- `strictMcpConfig: true`, so only the servers in this map exist, including for subagents.
- `disallowedTools: ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]`.
  Those built-ins read from MCP servers without an `mcp__` name, so they would skip §4.4.

Integration tools are never added to `allowedTools`.

`session.set_mcp_integrations` persists the list and drops the driver if the session is idle, so
the next turn starts a fresh `query()` with `resume` (the idle-drop used for credential changes,
`supervisor.ts:783`). Mid-turn, the driver is rebuilt when the turn ends and the UI says so.
Switching one off takes effect immediately at the permission gate (§4.4) even mid-turn.

### 4.4 Permissions

`decide()` gains a branch that runs first, before the remembered-allow check at
`permissions.ts:130`. For any tool named `mcp__<key>__…`:

1. If `<key>` is this session's own role server: existing behaviour, unchanged.
2. Else look the key up live (not from a snapshot taken at driver start). If it is not an
   integration in this session's list, or the integration is not `enabled`: deny.
3. If the integration is `exclusive` and another session holds it: deny, naming the holder (§4.5).
4. Under `bypass`: allow. Otherwise, if the integration id is in `session.mcpAllowed`: allow.
5. Otherwise prompt. The options are "Allow once", "Always allow <label> this session" and
   "Deny". "Always" adds the id to `session.mcpAllowed`.
6. On allow, acquire or refresh the exclusive lock (§4.5), then return.

`session.mcpAllowed` is separate from the per-tool `alwaysAllow` set and is cleared for an
integration when it is switched off for the session, updated, removed, or the session is reset.

There is no "follow the autonomy policy" mode in v1. The danger list knows nothing about MCP
inputs, so `mostly-autonomous` would let a Fusion script tool run arbitrary Python unprompted. One
tap per session per integration is the cost.

**Fail-closed backstop.** `makeCanUseTool` (`questions.ts:106`) allows any tool that reaches it,
assuming the hook already decided. It changes to deny every `mcp__*` name. If the hook throws or
times out on an integration call, the call is then denied, not allowed (A8).

Rules match on the server key only. Fusion's tool names are dynamic, so no rule may name a tool.

### 4.5 Exclusive lock

`mcp/lock.ts` holds an in-memory `Map<integrationId, { sessionId, lastActivity }>`.

- **Acquire:** in `decide()`, after the call is approved, as one synchronous check-and-set (no
  `await` between the check and the set). A session parked on a prompt does not hold the lock.
  If another session took it while the prompt was open, the approved call is denied.
- **Applies under `bypass`.** It is a concurrency guard, not a permission.
- **Refresh:** on every approved call and on every `tool.result` from that integration, so a long
  call does not count as idle.
- **Release:** when the holder's consume loop exits (turn end, error or stop), when the session is
  reset or deleted, when the integration is switched off for it, or after 10 minutes with no
  activity.
- A denied second session sees "Fusion is in use by <session title>".
- Not persisted. A daemon restart frees every lock, which is correct because every driver is gone.

Releasing at turn end means two sessions can take turns on one Fusion document. That is intended:
the lock stops interleaved tool calls, not sequential use.

### 4.6 CAD exports become file offers

`deliverablePath` only recognises the built-in write tools. For integration tools it gains a
second rule: if the tool name starts with `mcp__<key>__` for a session integration of kind
`fusion` or `solidcraft`, scan the input's top-level string values for a file path (no URL scheme)
ending in a CAD extension. Browser and custom integrations get no offers, so a Playwright
screenshot filename or a URL ending in `.pdf` never produces a card. `buildFileOffer`
already refuses paths outside the worktree, so nothing else changes. The offer fires after a
non-error result, as today.

The system prompt for a session with a CAD integration gets one added paragraph: save designs and
exports inside the worktree, and export GLB or STEP when the user will want to look at the result.

### 4.7 UX

- **Settings → Integrations** (new card, per server like the Models tab): one row per
  integration with label, health dot and reason, "in use by", an enabled switch, and remove.
  A line under the card says third-party servers run as the daemon's user. "Add" offers the three presets and "Custom".
  - Fusion's row shows the two setup steps when unavailable: open Fusion, tick the MCP box.
- **Session:** a "Tools" control in the session header lists this machine's integrations with a
  switch each. An unavailable one is shown disabled with its reason. A chip in the header shows
  which are on.
- **Chat:** no new components. Tool rows, permission cards, screenshots and CAD cards all exist.
  The permission card shows the integration label instead of the raw `mcp__` name.

### 4.8 File map

| Piece | File |
|---|---|
| Wire types, commands, capability | `anvild/protocol.ts`, `server/identity.ts` |
| Store, presets, health, lock | `anvild/src/mcp/{store,presets,health,lock}.ts` |
| Service | `anvild/src/session/mcp-integration-service.ts` |
| Driver map + config build | `anvild/src/agent/driver.ts`, new `agent/mcp-external.ts` |
| Permission branch + backstop | `anvild/src/agent/permissions.ts`, `questions.ts`, `session/session.ts` |
| File offers | `anvild/src/agent/file-offer.ts` |
| Settings card, session control | `anvild/web/src/settings.ts`, session header module |

## 5. Deliverables & phases

### Phase 0: spike (no product code)

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Script that starts a real `query()` with `settingSources: []`, one sdk server, one stdio server (a 20-line echo server with an image tool) and one http server | ☐ | ☐ | ☐ |
| Record: A1, A2, A3, A4, A7, A8, A10 results and the `mcpServerStatus()` shape; confirm `env -i` wrapping still lets `npx` and `solidcraft-cli` start | ☐ | ☐ | ☐ |
| Confirm the Playwright MCP origin-block flag (A9) and that a blocked daemon URL fails to load | ☐ | ☐ | ☐ |
| On the M3: connect to Fusion, dump its tool list, confirm A5 | ☐ | ☐ | ☐ |
| Run `solidcraft-cli mcp` headless on a Mac mini over SSH with no one logged in; record whether `screenshot` works | ☐ | ☐ | ☐ |

**Acceptance:** the assumptions table in §3 has every row marked confirmed or refuted with
evidence pasted under §10, and any refuted row has a spec change. No later phase starts before
this.

### Phase 1: daemon core

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Protocol types, commands, capability, golden regen | ☐ | ☐ | ☐ |
| `McpIntegrationStore` + presets | ☐ | ☐ | ☐ |
| Service + dispatch + `mcp.integrations` on connect | ☐ | ☐ | ☐ |
| `Session.mcpIntegrations` + `session.set_mcp_integrations` + idle driver drop | ☐ | ☐ | ☐ |
| `buildMcpServers` + `strictMcpConfig` + resource-tool `disallowedTools` | ☐ | ☐ | ☐ |
| Permission branch + `mcpAllowed` + unknown-key deny + `canUseTool` backstop | ☐ | ☐ | ☐ |

**Acceptance** (each clause is one assertion; none needs a live SDK):

- `buildMcpServers` for an ordinary session with a stdio integration `echo` returns
  `servers.echo` with `command: "/usr/bin/env"`, `-i` first in `args`, `{cwd}` replaced, and no
  key matching `/TOKEN|KEY|ANTHROPIC/` anywhere in the config.
- The same call for a concierge session returns only `anvil`.
- An `AgentDriver` built with a capturing `queryFn` passes `strictMcpConfig: true`, the three
  resource tools in `disallowedTools`, and no `mcp__echo__` id in `allowedTools`.
- The hook, under `mostly-autonomous`: `mcp__echo__ping` parks a permission request; answering
  "always" lets `mcp__echo__pong` through with no prompt; switching `echo` off for the session
  then denies `mcp__echo__ping` with no prompt; switching it back on prompts again.
- The hook denies `mcp__other__x`. `canUseTool` denies `mcp__echo__ping`.

### Phase 2: health, lock, UI

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| Health probes + change-only broadcast | ☐ | ☐ | ☐ |
| Exclusive lock + release paths | ☐ | ☐ | ☐ |
| Settings → Integrations card | ☐ | ☐ | ☐ |
| Session "Tools" control + header chip + label on permission cards | ☐ | ☐ | ☐ |

**Acceptance:**

- Service with a fake clock and fake prober: an http integration whose port is closed reports
  `unavailable`, and `buildMcpServers` returns it in `skipped`. When the probe flips to open,
  exactly one `mcp.integrations` event is broadcast and the idle driver of a session that
  references it is dropped (asserted on a fake driver in the supervisor's map, as
  `test/unit/accounts-restart.test.ts` does).
- Lock: session A's approved call acquires; B's call is denied naming A; A's consume loop exits;
  B's next call succeeds. With A parked on a prompt and never approved, B succeeds. Under
  `bypass`, B is still denied while A holds.
- 10 minutes of fake-clock silence from A releases the lock; a `tool.result` at minute 9 does not.

### Phase 3: CAD round trip

| Task | Implemented | Tested | Pushed |
|---|---|---|---|
| `deliverablePath` rule for integration tools | ☐ | ☐ | ☐ |
| CAD system-prompt paragraph | ☐ | ☐ | ☐ |
| Live check on a Mac mini: SolidCraft makes a bracket, exports GLB, card opens in the viewer | ☐ | ☐ | ☐ |
| Live check on the M3: Fusion makes a 10 mm cube from a phone prompt | ☐ | ☐ | ☐ |

**Acceptance:** a `tool.use` for `mcp__solidcraft__export` with input
`{ format: "glb", path: "<cwd>/out/bracket.glb" }` followed by a non-error result emits one
`file.offer` for that file; the same call with a path outside the worktree emits none; an error
result emits none; a browser-integration call with `{ filename: "shot.png" }` emits none.

### Deferred (separate specs)

- `anvil-computer` screen-control helper.
- Integrations for autopilot work units and team members.
- Persistent browser profiles with saved logins.
- Hub fan-out of a preset to every member.

## 6. Constraints

- **Daemon stays the permission authority.** No `settingSources`, no `allowedTools` entry for any
  integration tool, no SDK-side `always_allow`.
- **HTTP integrations are loopback only.** The URL is parsed with `new URL()` and must have scheme
  `http:`, no username or password, and a `hostname` of `127.0.0.1`, `localhost` or `[::1]`.
  Checked on `add`, on `update`, and again every time `buildMcpServers` runs.
- **stdio commands are operator-typed, never model-typed.** No command can set or change an
  integration from inside a session; the `mcp.integration.*` commands are client commands only.
  Adding one is equivalent to granting it the daemon user's shell.
- **stdio servers never see session credentials.** The session env carries the Claude token, or
  the OpenRouter key under the GLM profile (`agent/env.ts`). An `npx` package starts at driver
  start with no per-call gate, so every stdio command is wrapped in `/usr/bin/env -i` with only
  PATH, HOME and TMPDIR. This holds whatever A4 turns out to be.
- **The browser cannot reach the daemon.** The daemon has no per-request auth, so a page that
  injected instructions could otherwise open the Anvil UI and set `bypass` or add a stdio
  integration. The browser preset blocks this daemon's own origins (loopback and tailnet names on
  the daemon port) and every fleet member's. If A9 fails, the browser preset does not ship in v1.
- **Tool output is untrusted.** Web pages and CAD files can carry instructions. The CAD/browser
  system-prompt paragraph says so, and every integration prompts until the operator allows it for
  that session.
- **Backwards compatibility.** New optional `Session` field; new event and commands behind the
  capability. An older client ignores the event. An older member never advertises the capability.
- **Performance.** Health probes are one TCP connect or one PATH lookup each, at most once a
  minute, and stop when no client is connected.
- **Platforms.** macOS daemons. The feature is transport-only, so Linux members work for
  SolidCraft and the browser with no changes.

## 7. Edge cases & failure modes

| Scenario | Expected | Test |
|---|---|---|
| Daemon restarts mid-turn with an integration on | Session list persists; lock map is empty; next turn rebuilds the driver with whatever is healthy | unit: store reload; integration: resume-wire variant |
| Fusion quits mid-session | Tool calls error from the SDK; next probe marks it unavailable; the turn continues; the lock releases on idle timeout | functional: prober flips to closed |
| Integration unavailable when the driver starts | Left out of `mcpServers`; a one-line notice is emitted in the session naming it and the reason | Phase 2 acceptance |
| Health probe itself throws | Treated as `unavailable` with the error text (fail closed: the server is not attached) | unit: health |
| Two clients toggle the same session's list at once | Last write wins; one `session.updated` per write | integration: dispatch |
| Switched on mid-turn | Persisted now; driver rebuilt at turn end; UI shows "applies after this turn" | unit: service |
| Switched off mid-turn | Calls denied at the gate immediately; `mcpAllowed` entry cleared; driver rebuilt at turn end | Phase 1 acceptance |
| Hook throws or times out on an integration call | `canUseTool` denies it (fail closed) | Phase 1 acceptance + A8 |
| Integration removed and re-added under the same key | New id, so no stale "always allow" applies | unit: service |
| `mcp-integrations.json` edited by hand to a non-loopback URL | Rejected at `buildMcpServers`; reported in `skipped` | unit: mcp-external |
| Subagent calls an integration tool | Same hook, same gate; `strictMcpConfig` stops agent frontmatter adding servers | Phase 0 confirms the hook fires for subagents |
| Model reads an MCP resource | The three resource tools are disallowed | Phase 1 acceptance |
| Same integration enabled twice or unknown id in the list | Deduped; unknown ids dropped on load and on set | unit: service |
| `key` collides with a built-in server name or another integration | `add` rejected with a clear error | unit: store |
| Integration removed while sessions reference it | Removed from every session's list; idle drivers dropped; lock released | unit: service |
| Corrupt `mcp-integrations.json` | Quarantined to `.corrupt-<ts>`; empty list; logged | unit: store |
| Permission prompt parked, then the session is reset | Existing `resolveSession` path denies it; lock not acquired | existing + unit: lock |
| Exclusive holder goes silent | Lock released after 10 minutes of no calls | unit: lock, fake clock |
| stdio command exists at probe time but crashes on launch | SDK reports the server failed; tools absent; session notice from `mcpServerStatus()` after init (if A7 holds) | Phase 0 decides the mechanism |
| Export path outside the worktree | No file offer | Phase 3 acceptance |
| SolidCraft CLI updates and writes a newer `.sc` format | Out of Anvil's hands; noted in the Settings row help text | N/A, external |
| **Gamed spec:** integration tools added to `allowedTools` to make prompts "work" | Forbidden by §6; a unit test asserts no `mcp__<key>__` id for an integration appears in `allowedTools` | unit: mcp-external |
| **Gamed spec:** health always reports ready | Phase 2 acceptance requires the closed-port case to drop the server | functional |
| **Gamed spec:** approval branch only handles the three preset keys | Phase 1 acceptance uses a custom key `echo` | functional |
| **Gamed spec:** gate checks a snapshot of the session's list taken at driver start | Phase 1 acceptance switches `echo` off and on between calls | functional |

## 8. Evaluation & verification

- **Technical (unit):** `mcp/store`, `mcp/presets` (substitution, pinned version), `mcp/health`
  (fake prober), `mcp/lock` (fake clock), `agent/mcp-external` (`buildMcpServers`, env wrapping,
  URL re-validation), `agent/permissions` (prompt, bypass, `mcpAllowed`, unknown key, live
  lookup), `agent/questions` (`mcp__*` deny), `agent/file-offer`.
- **Functional:** real store and real service throughout. The supervisor hard-codes the SDK
  `queryFn` (`supervisor.ts:1699`), so nothing is asserted through `ensureDriver`:
  - Phase 1: `buildMcpServers` directly; an `AgentDriver` constructed with a capturing `queryFn`
    (as `test/unit/driver-resume-fallback.test.ts` does); the hook called directly.
  - Phase 2: fake clock + fake prober; fake drivers in the supervisor map; the lock sequence.
  - Phase 3: scripted `tool.use` / `tool.result` messages through `consume()`.
- **Live (advisory, not blocking):** the two Phase 3 machine checks, with a screenshot of the
  phone chat pasted into §10.
- **Done-gate (per phase):** `bun test` (0 fail) · `tsc --noEmit` for daemon and web (exit 0) ·
  `bun run web/build.ts` · the phase's functional scenario, evidence pasted; then a fresh-context
  adversarial reviewer checks the phase against its Acceptance row and can veto.

## 9. Spec-critique gate (before any build)

- **Critique round 1 (2026-11-19, fresh-context agent):** 3 blockers, 8 should-fix, 3 nits. All
  accepted and folded in.

| # | Finding | Resolution |
|---|---|---|
| 1 | Gate fails open: `canUseTool` allows anything the hook didn't decide | `canUseTool` denies `mcp__*`; A8 added (§4.4) |
| 2 | No "next driver": drivers are only dropped on a few events, so a health flip never reached a session; cached health could be stale | Health or `enabled` flip drops idle drivers; probe before a turn (§4.2) |
| 3 | Acceptance rows had no capture point: the supervisor hard-codes `queryFn` | Pure `buildMcpServers`; acceptance rewritten (§4.3, §5, §8) |
| 4 | MCP resource built-ins skip the `mcp__` branch | Disallowed (§4.3) |
| 5 | Branch ran after the remembered-allow check; stale allows survived removal | Branch runs first with live lookup; separate `mcpAllowed`, cleared on change (§4.4) |
| 6 | Lock acquire/refresh/release under-specified | Acquire after approval, refresh on result, release on consume exit, applies under bypass (§4.5) |
| 7 | Token exposure hand-waved | Always `env -i` (§6) |
| 8 | "policy" approval would run Fusion scripts unprompted | "policy" mode removed from v1 (§4.4) |
| 9 | Key grammar allowed `__`; "built-in" was ambiguous | No underscores; "this session's role server"; `strictMcpConfig`; A10 |
| 10 | Loopback check loose (`[::1]`, scheme, userinfo, hand-edited store) | Tightened and re-run at build (§6) |
| 11 | Browser could drive the daemon's own UI | Origin block; preset gated on A9 (§6) |
| 12 | Nits: offer scan too broad; quarantine isn't inherited; `alwaysLoad` | CAD kinds only; noted as new; `alwaysLoad: true` + A7 |

## 10. Open decisions

Defaults assumed unless you object:

1. **`bypass` skips integration prompts too.** It keeps `bypass` meaning one thing. The
   alternative is to make integrations prompt even under bypass.
2. **Every integration prompts until you tap "Always allow this session".** There is no
   unattended mode in v1, which is also why autopilot is excluded.
3. **Integrations are per machine and not hub-synced.** You add Fusion on each Mac that has it.
   Hub fan-out of presets is deferred.
4. **Browser sessions are isolated** (no saved logins) in v1. Saved profiles need a decision about
   which accounts an agent may act as.
5. **Autopilot, team and concierge sessions get no integrations in v1.**
6. **The exclusive lock idles out at 10 minutes and releases at turn end.**
7. **SolidCraft is a preset despite its age.** It is the only one of the three that runs with no
   one logged in. The preset pins nothing, because the CLI is installed by the operator.
8. **Branch stays `computer-use`** even though the screen-control part is deferred.

### Phase 0 evidence

_To be filled in by the spike._
