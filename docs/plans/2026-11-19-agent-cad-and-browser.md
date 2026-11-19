# Agent CAD (SolidCraft) and browser for Anvil sessions

- **Status:** Building (owner said "implement everything" on 2026-11-19; decisions in the `-DECISIONS.md` file beside this one) · **Owner:** Evan Ruff · **Branch:** `computer-use`
- **Created:** 2026-11-19
- **Supersedes/extends:** supersedes `2026-11-19-mcp-integrations.md` as the plan of record. That
  file's registry design (its §4.1 to §4.5, §6, §7 and its critique table) stays authoritative for
  Track C here, as amended in §4.9. Extends the CAD viewer (`2026-11-06-cad-viewer.md`) and the
  managed Claude CLI (`2026-11-10-managed-claude-cli-updates.md`).

## 1. Objective & non-goals

Three outcomes, shipped in this order:

- **Track A, CAD.** In any project repo, a session can design a parametric part in SolidCraft.
  You watch it build in the CAD viewer on your phone, change named parameters yourself with no
  model turn, and the part cannot be released for manufacture until its measured geometry matches
  numbers that were written down before it was built.
- **Track B, fleet version.** Every machine runs the same SolidCraft build. The hub advances the
  pinned build on its own, but only after every committed design in the fleet rebuilds to the same
  numbers under the new build. Autopilot can then produce parts unattended.
- **Track C, browser.** A session can drive a visible Chrome with a dedicated, persistent agent
  profile: research, fetch vendor part models into a quarantine folder, act in sites you have
  logged it into (asking before anything that submits), and test Anvil's own UI against a
  throwaway daemon.

Non-goals:

- **No Fusion in v1.** No Fusion MCP integration and no SolidCraft-to-Fusion translator. A Fusion
  design enters only as an exported STEP file, which arrives as one solid with no history.
- **No bot-detection evasion.** No fingerprint spoofing, stealth browser builds or CAPTCHA
  solving. A bot check is handed to a human.
- **No pixel-level screen control.** The `anvil-computer` helper stays deferred.
- **No assemblies, drawings, surfaces or CAM.** SolidCraft cannot script components or joints yet
  and has no drawings. A requirement that needs them is reported as a gap, never approximated.
- **No automatic git commits** of design files.
- **No team-session CAD.** Ordinary sessions in Track A; autopilot work units from Phase B3.
- **No app-layer auth.** Tailscale remains the boundary. The browser is kept away from live
  daemons by a network block, not by adding logins.
- **No loading of ambient Claude Code config.** `settingSources: []` stays.

## 2. Context

### 2.1 What exists

- **Sessions get tools only from the daemon.** `AgentDriver` takes in-process MCP servers
  (`anvild/src/agent/driver.ts:82`); `Supervisor.ensureDriver` picks one by role
  (`session/supervisor.ts:1681`). The PreToolUse hook (`agent/permissions.ts`) gates every tool.
- **Images and CAD files already reach the chat.** `toolResultImages` (`agent/map.ts:243`) lifts
  screenshots off tool results; `agent/file-offer.ts` turns STEP/GLB/3MF writes into cards with
  "View CAD"; `web/src/cad.ts` (`openCadViewer`) renders them.
- **Autopilot has a validation gate.** `EnvironmentValidation.commands` (`protocol.ts:171`) must
  are run only by the opt-in dev pipeline (`pipeline/daemon-adapters.ts`), whose implementer is a
  bare `runAgentQuery` with no tool servers. The usual "Go" path (`startPlan`,
  `session/autopilot-service.ts:1037`) hands off to an ordinary session at `bypass` with a goal
  armed, and the daemon runs no validation there. Interactive planner sessions are a separate role
  (`workUnitRole === "planner"`) with a `save_plan(plan, ready)` tool that takes Markdown.
- **The agent runs as the daemon's user.** Its Bash can read and write anything the daemon can,
  including `<stateDir>`. Every protection below is a guard against the agent taking the easy
  path, backed by denials on known routes. It is not a sandbox (§6).
- **Managed binaries have a pattern.** The managed Claude CLI installs into `<stateDir>`, is
  checked every 4 h, and is fanned out from the hub (`server/fleet-cli-rollout.ts`).
- **Capabilities gate UI.** `SERVER_CAPABILITIES` (`server/identity.ts:86`) is a static list,
  pinned by `identity.test.ts`; the web side uses `serverSupports()`.

### 2.2 SolidCraft, as tested on the M4 on 2026-11-19 (v0.44.1)

- `solidcraft-cli mcp --headless --allow-path DIR` is a stdio MCP server, one design session per
  process. A Python client drove it with plain JSON-RPC lines, so the daemon can be its client.
- The reference plate (16 commands in one `batch`) built, rebuilt after `set_parameter L=120`,
  and measured 35,335.2 mm³, the documented figure.
- `export` wrote STEP, GLB and 3MF; `screenshot` returned a PNG; `inspect_design` returns the
  parameter list (`name`, `expression`, `value`, `unit`, `error`).
- `solidcraft-cli script design.sc --out x.json` (and the `timeline.export_script` command)
  writes the history as a replayable JSON command list tagged `"format": "solidcraft/58"`.
  It omits appearances, folders and named views, and cannot express components or joints.
- `.sc` is a zip (binary to git). A build refuses files written by a newer format.
- File access is limited to allowed folders. No network access.
- Commands that exist: `inspect.interference`, `inspect.draft`, `material.assign`. There is no
  wall-thickness measurement.
- Upstream warns that a cut that misses still reports success, and that a "Boolean retry" warning
  can leave wrong geometry with no error.
- The binary is signed and notarized (Developer ID team `G5QA5U5X2S`). Releases ship daily.
- `list_commands` unfiltered is over 100 KB; `body_topology` is 25 to 45 KB.

### 2.3 Decisions from the owner interview (2026-11-19)

| # | Topic | Decision |
|---|---|---|
| D1 | v1 CAD tool | SolidCraft. Fusion deferred. |
| D2 | Fleet version | Hub-pinned, auto-advancing after a gate. |
| D3 | Upgrade gate | Replay every committed design; any drift in volume, bounding box or face count holds the pin and notifies. |
| D4 | Source of truth | The JSON script is committed. `.sc` and exports are regenerated and git-ignored. |
| D5 | Where designs live | Inside existing project repos. |
| D6 | Part purposes | 3D-printed, and machined or sent to a shop. |
| D7 | How the agent edits | Through a live SolidCraft session; the daemon writes the script. |
| D8 | Geometry proof | The agent states expected numbers first; the daemon compares after the build and blocks on mismatch. |
| D9 | Gate integrity | Expectations lock once recorded; only the owner can change them. |
| D10 | Autonomy | SolidCraft tools follow the session's autonomy setting, like file edits. |
| D11 | Unattended | Autopilot may do CAD behind the geometry gate. Teams excluded. |
| D12 | Preview | The viewer refreshes after every change, with a pause switch and a manual reload. |
| D13 | Parameters | A panel in the viewer edits parameters directly, with no model turn. |
| D14 | Two writers | One daemon-owned SolidCraft process per design; agent and panel both go through it. |
| D15 | Inputs | Text with dimensions; phone photo or sketch; STEP of things to fit; STEP exported from Fusion. |
| D16 | No dimensions | The agent must ask for key dimensions first; picture match is advisory. Autopilot cannot run these. |
| D17 | Capability gap | Stop and report. Autopilot flags the unit. |
| D18 | Design rules | A rules file per repo; hard checks on what can be measured, advisory on the rest. |
| D19 | Release | STEP (plus 3MF for printed parts) and a generated spec sheet labelled "not a drawing". |
| D20 | Merges | Rebuild and re-gate every changed design after a merge. |
| D21 | Commits | Never automatic. |
| D22 | Process limits | Idle shutdown at 10 min, rebuilt from the script; cap of 4 per machine, extra designs queue. |
| D23 | v1 scope | Registry and browser stay in v1; Fusion is the only deferral. |
| D24 | Browser uses | Test Anvil's UI; fetch vendor models and datasheets; logged-out research; act in logged-in accounts. |
| D25 | Browser approval | Per site, per session. Logins persist across sessions; approvals do not. |
| D26 | Browser view | Headed on the machine's desktop. |
| D27 | Identity | One dedicated agent profile per machine. |
| D28 | Hard stops | On logged-in sites, submit-type actions always ask, even under bypass. |
| D29 | Shared screen | One browser per machine, sessions take turns; headless fallback for logged-out browsing when there is no desktop session. |
| D30 | Downloads | A git-ignored quarantine folder the agent may read; copying into the repo is a separate step. |
| D31 | UI test target | A throwaway daemon the session starts; live daemons stay blocked. |
| D32 | Bot checks | Try official part sources first, then pause and hand the page to the owner. |
| D33 | Part sources | DigiKey API, Mouser API, SnapEDA / TraceParts. |
| D34 | Ship order | CAD, then the pin, then the browser. |
| D35 | Rollout guard | A capability flag per phase, switched on per machine. |
| D36 | Real-tool tests | Fakes in CI; real tools on the M4 as a required gate. |

## 3. Inputs & scope

- **In scope:**
  - new `anvild/src/cadwork/` (process manager, MCP client, design store, expectations, gate,
    rules, release, verify)
  - new `anvild/src/agent/cad-tools.ts`; `agent/driver.ts`, `permissions.ts`, `questions.ts`
  - `anvild/src/session/supervisor.ts` (wiring), new `session/cadwork-service.ts`
  - new `anvild/src/solidcraft/` (install, pin, replay gate); `server/fleet-*.ts` additions
  - `anvild/src/integrations/autopilot*.ts` (CAD validation step, planner expectations)
  - Track C: everything listed in the superseded spec's §3, plus new `anvild/src/browser/`
  - `anvild/protocol.ts`, the protocol golden via `test/contract/regen-golden.ts`
  - `anvild/web/src/cad.ts`, new `web/src/cad-params.ts`, `settings.ts`, session header
- **Out of bounds:** `settingSources`; the agent-env allow-list in `agent/env.ts`; the Update API
  v1; `src/cad/` conversion code except where a phase names it; tests that back other specs.
- **Available inputs:** SolidCraft 0.44.1 at `/Applications/SolidCraft.app` on the M4; the spike
  files in `/tmp/sc-spike`; the injected-`queryFn` driver seam; `test/golden` (Playwright).
- **Assumptions log:**

| # | Assumption | Confirmed |
|---|---|---|
| S1 | The daemon can hold a long-lived `solidcraft-cli mcp` process and send it requests from two callers in sequence | Confirmed by the spike for one caller; sequencing is ours |
| S2 | `timeline.export_script` output replays to the same volume, bounding box and face count | Phase A0 |
| S3 | A design with an imported STEP reference body can be exported as a script and replayed, with the STEP path relative to the script | Phase A0. If false, see §7 "reference bodies" |
| S4 | Cylindrical faces in `body_topology` give hole diameters and axes reliably enough for a hole table | Phase A0 |
| S5 | A script written by format N replays under format N+1 | Phase B0, across two real releases |
| S6 | The standalone `solidcraft-cli-<v>-macos-universal.zip` runs from an arbitrary folder and passes `codesign --verify` and `spctl` | Phase B0 |
| S7 | `solidcraft-cli mcp` works over SSH with no one logged in (CPU or Metal renderer) | Phase A0, on the M1 |
| S8 | All of A1 to A10 in the superseded spec | Phase C0 |
| S9 | Playwright MCP can attach to installed Chrome with a given profile folder, use a proxy, and reports the page URL in every result | Phase C0 |
| S10 | A daemon can start from a worktree on a chosen port with an empty state folder and no credentials | Phase C0 |
| S11 | DigiKey and Mouser APIs return datasheet and model links under terms that allow this use; SnapEDA or TraceParts has a usable API | Phase C0. A source that fails is dropped |

## 4. Design

### 4.1 Design files in a repo

A repo opts in by having a `cad/` folder. Each part is one folder:

```
cad/
  rules.json                 # manufacturing processes (§4.6), committed
  <part>/
    design.json              # SolidCraft command script. THE source of truth. Committed.
    part.json                # expectations, process, material, last measurement. Committed.
    refs/*.step              # bodies the part must fit. Committed.
    .cache/                  # git-ignored: design.sc, preview-<rev>.glb, exports
    release/                 # git-ignored: release packs (§4.7)
```

`<part>` matches `/^[a-z0-9][a-z0-9-]{0,39}$/`. The daemon adds `cad/*/.cache/` and
`cad/*/release/` to the worktree's `.git/info/exclude`; it never edits `.gitignore`.

```ts
// part.json (authoritative shape)
interface PartFile {
  schema: 1;
  process: string;                    // id in cad/rules.json, e.g. "fdm-0.4"
  material?: string;
  status: "concept" | "dimensioned";  // concept: built from a picture, dimensions unconfirmed
  ownerParams?: Record<string, number>;   // values the owner typed on a dimensions card (§4.5)
  expectations?: {
    lockedAt: string;                 // ISO time
    lockedBy: "owner" | "planner" | "agent-initial";   // informational; the lock store decides
    bbox: [Expr, Expr, Expr];         // mm, sorted ascending so orientation does not matter
    volume: Expr;                     // mm³
    bodies: number;
    holes: { diameter: Expr; count: number }[];
    tolerance: { length: number; volumeRel: number };  // defaults 0.01 mm, 0.001
    noInterferenceWith?: string[];    // file names in refs/
  };
  measured?: {                        // written by the daemon only
    at: string; solidcraft: string; scriptSha: string;
    bbox: [number, number, number]; volume: number; faces: number; bodies: number;
    holes: { diameter: number; count: number }[];
    warnings: string[];
  };
}
type Expr = number | string;          // string: arithmetic over the design's parameter names
```

`Expr` strings are evaluated by a small evaluator in the daemon (`+ - * / ^ ( )`, `pi`, numbers,
parameter names; nothing else). A formula is what lets a parameter change from the panel re-derive
the expected value without trusting the measurement.

**Lock store (`<stateDir>/cadwork/locks.json`, `cadwork/locks.ts`).** `part.json` is a file the
agent can write, so nothing in it proves approval. For each (repo, part) the daemon keeps, outside
the repo: the sha256 of the approved `expectations` block, who approved it, the approved
*evaluated* numbers, the approved `ownerParams`, and the sha256 of the approved `cad/rules.json`.
The gate trusts `part.json` and `rules.json` only when their hashes match the store. A mismatch
(a hand edit, a fresh clone, another machine, a merge) makes the part `unverified` and raises an
**adopt card** showing the values; the owner's Approve records the new hashes. The repo key is
the remote URL when there is one, else the repo's real path.

### 4.2 Process manager (`cadwork/manager.ts`)

- **Key:** `realpath(worktree) + "/cad/" + part`. One `solidcraft-cli mcp --headless --compact
  --allow-path <worktree>/cad/<part>` process per key, owned by the daemon (D14).
- **Start:** if `design.json` exists, replay it; otherwise `new_design`.
- **Serial queue per process.** Every request, from the agent's tools or from the panel, goes
  through one FIFO queue. Each mutating request is followed by the script write of §4.3 before
  the next request starts; measuring and previewing follow as their own queued job.
- **Limits (D22):** a process exits after 10 minutes with an empty queue. At most 4 live per
  machine (`ANVIL_CAD_MAX_PROCS`); a fifth design waits for a slot, and its caller sees "waiting
  for a CAD slot". Idle processes are evicted first when a slot is needed.
- **Crash or kill:** the pending request fails with the stderr tail; the next request restarts
  the process and replays `design.json`. Nothing is lost beyond the failed call, because the
  script is rewritten after every change.
- **Binary:** the pinned build once Track B lands; before that, `ANVIL_SOLIDCRAFT_CLI` or
  `/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli`.
- **Environment:** started with `env -i` and PATH, HOME, TMPDIR only.
- **Disk changes:** the manager records the sha of the `design.json` it last wrote.
  - Checked when a request is **dequeued** (not when it arrives): if the file differs (a hand
    edit, a checkout, a merge), the process is restarted from disk first and the caller is told
    the design was reloaded.
  - Checked again **immediately before the rename** in post-step 1: if the file changed while the
    request ran, the daemon does not overwrite it. It writes `.cache/design.conflict.json`, sets
    the part `fail` with "design changed on disk during a change", and tells the caller. Rebuild
    (disk wins) clears it.

### 4.3 Post-step after every change

After any successful mutating request (`execute`, `batch`, `set_parameter`, `undo`, `redo`,
reference import), inside the same queue slot and before the next request starts:

1. **Script write (always, synchronous).** Runs `timeline.export_script` and writes `design.json`
   atomically (temp file + rename), subject to the disk check in §4.2. The part's state becomes
   `unverified`.

Then, as a separate queued job (the **refresh**):

2. Measures (`measure`, plus hole extraction from `body_topology`) and collects feature warnings.
3. Evaluates the gate (§4.5) and writes `part.json.measured`.
4. Exports `.cache/preview-<rev>.glb` and deletes previews older than the last 3.
5. Broadcasts `cad.design` (§4.8).

The refresh is debounced to at most once per 500 ms during a burst, and always runs when the
queue drains. It is **forced to run synchronously first** by `check_part`, `export_part`,
`release_part`, `cad.param.set` and `verify`, so none of them ever acts on a stale measurement.

### 4.4 Agent tools (`agent/cad-tools.ts`, server name `anvil_cad`)

An in-process SDK server, added to an ordinary session's server map when the capability is on and
the session's worktree is a git repo. It is not an external MCP server, so none of the registry
machinery applies.

| Tool | Does | Notes |
|---|---|---|
| `open_part { part }` | Selects (or creates) the part the following calls address | Creates the folder; never takes a path |
| `record_expectations { part, process, expectations }` | Writes and locks expectations | Allowed once, for a part with none; see §4.5 |
| `request_dimensions { part, proposed }` | Shows the owner a card of named dimensions with editable numbers | The owner's typed values come back; see §4.5 |
| `propose_expectations { part, expectations, reason }` | Asks the owner to change locked expectations | Parks a card showing old and new |
| `execute`, `batch`, `set_parameter`, `check_parameters`, `undo`, `redo` | Passed through to the part's process | Refused for a `dimensioned` part with no expectations |
| `inspect_design`, `measure`, `body_topology`, `screenshot`, `compare_picture`, `list_commands`, `describe_command`, `skill_reference` | Passed through, read-only | `list_commands` requires a filter |
| `import_reference { part, file }` | Copies a STEP from the worktree or the download quarantine into `refs/` and imports it as a fixed body | Adds it to `noInterferenceWith` |
| `check_part { part }` | Returns the gate result in full | Same data as the card |
| `export_part { part, formats }` | Writes exports into `.cache/exports/` and offers them as cards | The service emits `file.offer` itself; `deliverablePath` only knows the write tools |
| `release_part { part }` | Builds the release pack (§4.7) | Refused unless the gate passes |
| `report_gap { part, feature, detail }` | Marks the part blocked on an unsupported feature (D17) | Ends in a card; autopilot blocks the unit |

Not exposed: SolidCraft's `open`, `save`, `export`, `new_design`, `crash_reports` and the bridged
tools. The daemon owns paths and files.

**Permissions (D10).** `isReadOnly` learns the read-only `mcp__anvil_cad__*` names. The mutating
ones follow the session's autonomy policy like `Edit`.

A new **protected check** runs at the top of `decide()`, before the remembered-allow lookup
(`permissions.ts:130`) and before the `bypass` short-circuit. It has two lists:

- **Always prompt, with no "always allow" option:** `propose_expectations`, `release_part`,
  adopt cards, and `Edit`/`Write` to `cad/rules.json`. In an autopilot builder session (§4.11)
  these are denied instead, because no one is there to answer.
- **Always deny:** `Edit`/`Write`/`NotebookEdit` to `cad/*/part.json` (use the tools); and Bash
  commands that mention `<stateDir>/cadwork`, `<stateDir>/solidcraft`, `<stateDir>/browser-profile`
  or `solidcraft-cli`, or pass `--remote-debugging-port` or `--user-data-dir`.

The Bash patterns are a tripwire, not a wall: a determined command can avoid them. The lock store
is what the gate relies on, and §6 states the remaining risk.

**System prompt.** A session with the server gets one paragraph: work on one part at a time;
record expectations before modeling; name every driving dimension as a parameter; never state a
part is done while the gate fails; call `report_gap` instead of approximating; fetch
`skill_reference` before the first build.

### 4.5 Expectations and the geometry gate (`cadwork/gate.ts`)

**Lifecycle.**

- **Text with dimensions:** the agent calls `record_expectations` before its first modeling call.
  That is the only time an agent may set them. The daemon checks the tolerance caps (§10 item 9),
  writes the block, and records its hash and evaluated numbers in the lock store. Modeling calls
  on a `dimensioned` part without expectations are refused, so it cannot build first and describe
  afterwards.
- **Picture with no dimensions (D16):** the part starts as `concept`. The agent may model, and
  the picture-compare score is shown as advisory. Before any export or release it must call
  `request_dimensions` with its proposed named dimensions. The owner edits the numbers on a typed
  card and submits; the daemon stores exactly those numbers as `ownerParams` (in the file and the
  lock store) and applies them to the design. The agent then records expectations once, and the
  part becomes `dimensioned`. `AskUserQuestion` is not used for this, because its answers are
  labels the agent wrote.
- **Changing them (D9):** only through `propose_expectations`, approved on a card showing each
  old and new value and the agent's reason. A denied proposal changes nothing.
- **Formulas cannot be used to move the target.** The lock store holds the evaluated numbers the
  owner last accepted. If an agent's change (a `set_parameter`, or any command that alters a
  parameter) makes a locked expectation evaluate to a different number, the gate fails with
  "expected value moved without owner approval", listing old and new. Only two things update the
  accepted numbers: an approved proposal, and the owner's own edit in the parameters panel.
- **Parameter panel:** a change re-evaluates the `Expr` formulas with the new values and, being
  the owner's action, updates the accepted numbers. A plain-number expectation stays as it was,
  so a panel change that should have moved it fails the gate visibly, which is correct.
- **Autopilot:** see §4.11.

**Result.**

```ts
interface GateResult {
  state: "pass" | "fail" | "unverified" | "concept" | "gap";
  checks: { id: string; expected: number | string; measured: number | string; ok: boolean; hard: boolean }[];
  warnings: string[];                 // SolidCraft feature warnings, e.g. "Boolean retry"
  needsAdoption?: "expectations" | "rules" | "ownerParams";
  staleBuild: boolean;                // measured under a different SolidCraft version
}
```

- Hard checks: lock-store hashes match; tolerances within the caps (re-checked here, not only
  when recorded); accepted numbers unmoved; sorted bounding box; volume; body count; hole table;
  no interference with each reference (`inspect.interference`); and the hard rules of §4.6.
- A SolidCraft "Boolean retry" warning does not fail the gate by itself, but it is listed, and
  the volume check is the backstop upstream recommends.
- `unverified`: no measurement yet, `measured.scriptSha` differs from the current script, or an
  adoption is pending.
- The gate never writes expectations.

**What the gate blocks.** `release_part`; `export_part` for a `concept` part; an autopilot unit
(§4.11). It does not stop a turn from ending. The part card shows the state, and a failed gate at
turn end adds a one-line notice to the transcript.

### 4.6 Rules file (`cad/rules.json`, `cadwork/rules.ts`)

```ts
interface RulesFile {
  schema: 1;
  processes: {
    id: string;                       // "fdm-0.4", "cnc-3axis"
    kind: "fdm" | "cnc";
    envelope: [number, number, number];   // bed or travel, mm
    drills?: number[];                // allowed hole diameters, mm (cnc)
    holeTolerance?: number;           // default 0.05
    minWall?: number;                 // advisory
    minInsideRadius?: number;         // advisory (cnc)
    generalTolerance?: string;        // printed on the spec sheet, e.g. "ISO 2768-m"
    material?: string;
  }[];
}
```

- **Hard:** the sorted bounding box fits the sorted envelope; for `cnc`, every hole diameter is
  within `holeTolerance` of a listed drill.
- **Advisory (shown, never blocking):** `minWall` and `minInsideRadius`. SolidCraft cannot measure
  wall thickness, and the card says so in plain words.
- The file's hash must match the lock store; after any change the gate is `unverified` until the
  owner adopts it on a card showing the diff. An agent `Edit` to it always prompts (§4.4).
- A part whose `process` is not in the file fails the gate with "unknown process". A repo with a
  `cad/` folder and no `rules.json` gets a starter file proposed by the agent, not invented
  silently: writing it is an ordinary file edit the owner sees.

### 4.7 Release pack (`cadwork/release.ts`)

`release_part` forces a refresh, requires `state: "pass"` and `status: "dimensioned"`, and
prompts every time. The service emits the file cards itself. It writes `cad/<part>/release/<part>-<scriptSha7>/`:

- `<part>.step`, and `<part>.3mf` when the process is `fdm`
- `iso.png`, `front.png`, `top.png`, `right.png`
- `spec-sheet.md` and a self-contained `spec-sheet.html`, headed **"Not a drawing"**:
  part name, script sha, SolidCraft version, process, material, general tolerance, overall
  dimensions, the parameter table, the hole table (diameter, count, centre positions), the gate
  checks with expected and measured values, advisory warnings, and the four views.
- `manifest.json` with a sha256 for every file and an HMAC over them made with a per-machine
  key in `<stateDir>/cadwork/`. The "Released" badge on the part card is shown only for a pack
  whose HMAC the daemon can verify, so a hand-assembled folder is not presented as a release.

A PDF is produced only once Track C can print the HTML; until
then the HTML is the printable form.

### 4.8 Protocol

```ts
export interface CadParam { name: string; expression: string; value: number; unit: string; error?: string }

export interface CadDesignEvent extends Envelope {
  type: "cad.design";
  cwd: string;            // worktree
  part: string;
  rev: number;            // increments on every refresh
  preview?: string;       // worktree-relative path of the newest GLB
  params: CadParam[];
  gate: GateResult;
  busy: boolean;          // a request is running or queued
  by: "agent" | "panel" | "reload";
}

// Commands
//   { type: "cad.parts.list"; cwd: string }                       → reply: parts with gate state
//   { type: "cad.param.set"; cwd: string; part: string; name: string; expression: string }
//   { type: "cad.design.refresh"; cwd: string; part: string }     // rebuild from design.json
//   { type: "cad.expectations.respond"; requestId: string; approve: boolean }
```

**Capabilities (D35).** `SERVER_CAPABILITIES` becomes a function of config:
`serverCapabilities(config)` returns the static list plus each of `cad-work` (Track A),
`solidcraft-pin` (Track B), `mcp-integrations` and `browser` (Track C) that the new
`ANVIL_FEATURES` env var lists. `identity.test.ts` is updated to pin the base list and test the
function. The env is read at startup, so a flag changes only with a daemon restart and no live
re-hello is needed.

**Availability is separate from capability.** A machine can advertise `cad-work` and still be
unable to do CAD right now (no binary, or off the fleet pin). That is carried by a
`cad.status` event `{ available: boolean; reason?: string; version?: string; pinned?: string }`,
and the `anvil_cad` tools refuse with the reason. Nothing has to be withdrawn from a live driver.

### 4.9 Web UI

- **Part card** in the chat (one per part touched in a turn, updated in place): name, gate state
  with the failing checks listed, a thumbnail, "Open" and, when passing, "Release".
- **Viewer (D12).** `openCadViewer` tears down the renderer and resets the camera today
  (`web/src/cad.ts:417`, `:1217`), so live mode needs a new in-place path: `replaceModel(url)`
  swaps the scene's model and leaves the renderer, camera, section plane and measurements alone.
  Live mode for a part:
  - **Follow** switch, on by default: each `cad.design` event with a new `rev` swaps the model in
    place and keeps the camera, section and measurement state.
  - **Paused:** the model stays put; a badge shows how many revisions behind it is; **Reload**
    jumps to the newest.
  - **Rebuild** sends `cad.design.refresh`, for when the script was edited by hand.
  - A busy indicator while `busy` is true.
- **Parameters panel (D13, new `web/src/cad-params.ts`).** Lists `params`; editing a value sends
  `cad.param.set`. Shows the SolidCraft error for a bad expression and leaves the old value. The
  gate strip under the panel updates from the same event. Edits are allowed during an agent turn;
  they queue behind the agent's current call, and the agent's next tool result carries a note
  naming the parameter the owner changed.
- **Expectation change card:** old and new values side by side, the agent's reason, Approve / Deny.
- **Settings → CAD:** SolidCraft version and source on each machine, the pin, the last replay
  gate result, live process count.
- **Track C UI** is the superseded spec's §4.7 plus the items in §4.12.

### 4.10 SolidCraft install and pin (Track B, `anvild/src/solidcraft/`)

- **Managed install (`install.ts`).** `<stateDir>/solidcraft/<version>/solidcraft-cli`,
  downloaded from the project's GitHub release asset. Before first use it must pass all of:
  the sha256 the hub recorded for that version; `codesign --verify --strict`; a Team ID equal to
  the pinned constant `G5QA5U5X2S`; `spctl` acceptance. A failure deletes the folder.
- **Pin (`pin.ts`).** The hub stores `{ version, sha256, pinnedAt, previous }` and broadcasts it.
  Each member installs that exact version and reports `ready` or an error. A machine that is not
  on the pinned version reports `cad.status { available: false }` and refuses every `anvil_cad`
  call (§4.8), so no design is ever written by a build the rest of the fleet cannot read.
- **Candidate (`candidate.ts`).** Every 4 h the hub lists releases and takes the **newest one
  that qualifies**: a full release (not a nightly), published at least 48 h ago, newer than the
  pin, and not previously rejected. Releases ship daily, so "the latest" would never be old
  enough. At most one advance per 24 h.
- **Replay gate (`replay.ts`, D3).** For a candidate, every machine installs it beside the pinned
  build (not in place of it) and, for each environment it hosts:
  - fetches, then reads `cad/` from `origin/<defaultBase>` (or the local `defaultBase` when there
    is no remote) into a temporary folder with `git show`, never from whatever the checkout
    happens to be on;
  - replays every `design.json` there with `solidcraft-cli eval` under **both** the pinned build
    and the candidate, and compares the two results: volume, sorted bounding box, face count and
    body count, within the part's own tolerance. Comparing the two builds, not the committed
    `measured` block, means a stale `part.json` cannot reject every candidate;
  - also replays designs in open session worktrees, as advisory: differences are listed on the
    Settings card but do not hold the pin.

  Outcomes:
  - All machines that host designs pass: the hub advances the pin; machines switch;
    `measured.solidcraft` is refreshed on each part's next refresh.
  - Any difference, or a script that replays under the pin but errors under the candidate: the
    pin holds, the candidate is recorded as rejected with the per-part differences, and a push
    notification names the first failing part. A rejected version is not retried.
  - A script that already fails under the pinned build is reported and ignored for the decision.
  - A machine that hosts designs and is unreachable holds the pin. The Settings card says which.
- **Manual controls:** "Check now", "Advance anyway" (with the differences shown), and "Pin
  back" to `previous`. Pinning back warns that scripts already rewritten by the newer build may
  not open, and lists them (those whose `measured.solidcraft` is the newer version).
- Routes follow the managed-CLI posture: tailnet-gated, reject proven `otherUser`, JSON content
  type on POSTs.

### 4.11 Merge guard and autopilot (D20, D11)

- **`cadwork/verify.ts`, runnable as `bun anvild/src/cadwork/verify-cli.ts [--changed-since REF]`.**
  For each selected part: replay `design.json` in a fresh process, measure, evaluate the gate
  (including the lock-store checks). Exit 0 only if every part is `pass` (or `concept`, which is
  reported but does not fail). It also fails when `measured` in `part.json` disagrees with what
  the replay produced, which catches a text merge that rebuilt to something neither branch
  intended.
- **Use in merges:** the session system prompt tells the agent to run it after any merge or
  rebase that touches `cad/`. A repo can add it to `EnvironmentValidation.commands`.

**Autopilot (Phase B3).** There are two build paths, and they are handled differently.

- **"Go" / auto-start (`startPlan`).** This is the supported CAD path. It already creates an
  ordinary session, which gets `anvil_cad` like any other.
  - `handoffCreate` gains `workUnitRole: "builder"` and `workUnitId`, stamped on the session.
  - **Expectations come from the plan.** `WorkUnit` gains
    `cadExpectations?: Record<part, { process: string; expectations: PartFile["expectations"] }>`.
    They are set by a new structured tool on the interactive planner server,
    `save_cad_expectations`, which always prompts the owner (the planner session is interactive,
    so someone is there). At `startPlan` the daemon writes them into the worktree's `part.json`
    files and the lock store before the builder's first turn.
  - **A builder session cannot set or move them.** `record_expectations` is refused for a part
    the plan covers and for any part that already has expectations; `propose_expectations`,
    `request_dimensions`, adopt cards and `rules.json` edits are denied without a card.
  - **Verify hook.** When a builder session's turn ends, and again when its goal resolves, the
    daemon runs verify on every part the worktree's diff touches. A `fail`, `gap`, pending
    adoption, or a touched part with no plan expectations sets the unit to `blocked` with the
    reason and reports the goal as unmet. A pass stamps `cadVerified: { at, parts }` on the unit,
    shown on its card. The unit's other status transitions are unchanged.
  - Nightly planning is a plain query with no tools, so it cannot supply expectations. A nightly
    unit that needs CAD stays blocked on "needs dimensions" until an interactive planning session
    supplies them.
- **Dev pipeline.** Its implementer has no tool servers and gets none in v1, so it cannot model.
  If its diff touches `cad/` anyway, the daemon prepends the verify function to the pipeline's
  `checks`, so a broken or unapproved design cannot ship as `review`. This step is added in code
  and cannot be removed by editing the repo's validation config.

### 4.12 Track C amendments to the superseded spec

The registry (store, health, lock, `buildMcpServers`, permission branch, `canUseTool` backstop,
`strictMcpConfig`, `env -i`) is built as specified there. Changes:

- **Presets:** `browser` and `custom` only. No `fusion`, no `solidcraft`.
- **Browser preset (D26, D27, D29).**
  - Attaches Playwright MCP to the installed Chrome with a dedicated profile at
    `<stateDir>/browser-profile`, headed, `exclusive: true`.
  - **Required Chrome flags** (asserted by the argument allow list): `--proxy-server` pointing at
    the daemon's proxy; `--proxy-bypass-list=<-loopback>` (Chrome otherwise skips the proxy for
    loopback); `--disable-quic`; `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
    C0 confirms each still behaves as described.
  - **Desktop check:** headed mode needs a logged-in desktop session. Without one, the preset
    runs headless with a throwaway profile, and any navigation to a site on the machine's
    "logged-in sites" list is refused.
  - **One-time login** is done by the owner at the desk or over Screen Sharing. Settings →
    Integrations has "Open agent browser" for that, and a list of logged-in sites the owner
    maintains by hand.
- **Network block (`browser/proxy.ts`).** The browser's only route out is a loopback forward
  proxy run by the daemon. It refuses loopback, RFC 1918, link-local and tailnet addresses and
  every fleet member's name, by resolved address, on every connection. It is a block list, not an
  allow list, so page subresources do not prompt.
- **Per-site approval (D25, replaces "one tap for the whole server").**
  - Only `http:` and `https:` targets are allowed at all. `file:`, `chrome:`, `data:`,
    `view-source:`, `javascript:` and anything else are denied, both at the navigation gate and in
    the post-result URL check (`about:blank` is the one exception).
  - The gate reads the target of every navigation tool call. A registrable domain not yet allowed
    for this session prompts: Allow once / Allow <site> this session / Deny.
  - After every browser tool result the daemon reads the page URL the server reports. If the page
    ended up on a domain that is not allowed (a redirect or a click), the next browser call is
    held behind the same prompt; Deny sends the page to `about:blank`.
  - Approvals live in the session and die with it. Cookies live in the profile and persist.
- **Logged-in sites.** A site counts as logged in if the profile holds cookies for it or the
  owner listed it. The daemon reads cookie domains over its own debugging connection to the
  browser (C0 confirms how). If that cannot be done reliably, every site in the headed profile is
  treated as logged in.
- **Hard stops (D28).** Inverted to an allow list, because "is this click a submit?" cannot be
  decided from what the model says it is clicking. On a logged-in site, only these run without a
  prompt once the site is allowed: page snapshots and screenshots, scrolling, waiting, tab
  listing, and a navigation tool call to an `https` URL on the same site. **Everything else
  prompts with a page screenshot, with no "always allow", under any policy including `bypass`:**
  every click, key press, typed text, form fill, selection, drag and dialog response. This will
  prompt a great deal; that is the accepted direction (D28).
- **Uploads and script evaluation, on every site.** A file-upload call always prompts, and its
  paths must resolve inside the session's worktree. Script-evaluation tools are denied except
  when the page is the session's own throwaway test daemon.
- **Downloads (D30).** Saved to `<worktree>/.anvil-downloads/` (added to `.git/info/exclude`).
  Limits: 200 MB per file; extensions `step stp iges igs 3mf stl pdf zip png jpg jpeg csv json
  txt`. Anything else is deleted and reported. Files there are never executed and get no file
  card; `import_reference` and an explicit copy are the only ways out.
- **Hand-off (D32, `agent/human-tools.ts`).** A tool `request_human { reason }` parks a card with
  the current page screenshot and an "I've cleared it" button. The system prompt tells the agent
  to call it on any bot check or CAPTCHA and never to attempt one. Autopilot blocks the unit.
- **No evasion.** The preset passes no flag whose purpose is to hide automation, and no stealth
  plugin is added. A unit test asserts the preset's argument list against an allow list.
- **Throwaway test daemon (D31, `agent/testdaemon-tools.ts`).** `start_test_daemon` builds the
  session's worktree and starts it with a complete, explicit environment and nothing inherited:
  `ANVIL_HOST=127.0.0.1` (the default would bind the tailnet address, `config.ts:106`),
  `ANVIL_PORT=<random>`, a new temporary `HOME`, and `ANVIL_STATE_DIR` and `ANVIL_CLONES_DIR`
  inside it. The temporary home matters: with the real one the daemon would read
  `~/.config/anvil/env`, the push keys and the updater's files. The proxy allows that one
  loopback port for that one session. The process is killed when the turn ends or after
  15 minutes, and the temporary home is deleted.
- **Part sources (D33, `integrations/parts/`).** Built-in tools `parts_search` and
  `parts_fetch { url }` backed by DigiKey and Mouser (keys entered in Settings, stored and
  synced the way the OpenRouter key is) and whichever of SnapEDA / TraceParts passes S11. Fetched
  files go to the download quarantine under the same limits. The system prompt says to try these
  before the browser for part models.

### 4.13 File map

| Piece | File |
|---|---|
| Stdio MCP client | `anvild/src/cadwork/mcp-client.ts` |
| Process manager, queue, post-step | `cadwork/manager.ts`, `cadwork/poststep.ts` |
| Part files, evaluator | `cadwork/partfile.ts`, `cadwork/expr.ts` |
| Gate, rules, holes | `cadwork/gate.ts`, `cadwork/rules.ts`, `cadwork/holes.ts` |
| Release, verify | `cadwork/release.ts`, `cadwork/verify.ts`, `cadwork/verify-cli.ts` |
| Agent tools | `agent/cad-tools.ts` |
| Service, commands | `session/cadwork-service.ts`, `server/dispatch.ts` |
| Install, pin, candidate, replay | `solidcraft/{install,pin,candidate,replay}.ts`, `server/fleet-solidcraft.ts` |
| Viewer live mode, params | `web/src/cad.ts`, `web/src/cad-params.ts` |
| Browser | `browser/{preset,proxy,sites,hardstops,downloads}.ts` |
| Fake SolidCraft | `anvild/test/fixtures/fake-solidcraft.ts` |
| Phase gate runner | `anvild/test/tools/phase-gate.ts`, `anvild/test/phase-manifest.json` |

### 4.14 Amendments from the spikes (these override the text above)

Evidence: `2026-11-19-agent-cad-and-browser-evidence/A0-spike.md` and `B0-spike.md`. Implementers
read those files for exact request and reply shapes.

**From A0 (SolidCraft behaviour):**

1. **Process start.** `solidcraft-cli mcp --headless --compact --allow-path <part dir>
   --require-allow-path [--in <abs design.json>]`, all paths absolute, environment `PATH`,
   `HOME`, `TMPDIR` and `SOLIDCRAFT_GPU=cpu`. Replay is `--in`, not a `batch`. `--in` starts even
   when features fail, so the manager reads the timeline straight after start.
2. **Failed features are a hard gate check.** A parameter change that breaks a feature returns
   success and keeps the change, `measure` then reports partial geometry, and `eval` exits 0. The
   refresh reads `inspect_design {timeline:"summary"}` and the gate fails if any feature has an
   `error`. `verify` and the replay gate apply the same rule to `eval`'s `timeline[].error` and
   `params[].error`, never the exit code alone.
3. **Measure design bodies only.** `measure {}` includes imported reference bodies. The refresh
   lists bodies with their creating feature, drops those created by a `BaseFeature` (an import),
   and measures the rest with `inspect.measure {bodies:[…]}`; volume is their sum and the
   bounding box their union.
4. **Reference bodies travel inside the script.** `file.insert_step` embeds the whole STEP text in
   `design.json`, with no path. `refs/*.step` is the import source and the human-readable copy.
   A reference is capped at 5 MB. The gate reports `refs/x.step` as changed when its sha256
   differs from the sha256 of the embedded text (state `unverified`, "reference changed; re-import").
   Reference body names come from the insert reply's `created_bodies`.
5. **Undo and redo revert one agent request.** A `batch` is many SolidCraft undo steps and a
   partial undo can re-open a sketch. The manager records the undo depth before each mutating
   request and, for the agent's `undo`, calls SolidCraft's `undo` until the depth is back to the
   recorded value; `redo` mirrors it.
6. **Parameter edits use `parameters.change {changes:{name:expr}}`**, for both the panel and the
   agent's `set_parameter`. Plain `set_parameter` silently creates an unknown name; this form
   refuses it. Creating a parameter is done with `parameters.add` through `execute` or `batch`.
7. **Hole table.** Built from `body_topology {faces:"cylinders"}` plus `view.pick` rays, by the
   algorithm in the A0 evidence. One row is one coaxial concave stack keyed by its smallest
   diameter, so a counterbored hole is one row. Countersinks and slots are not holes. The
   `holes` expectation gains an optional `kind: "through" | "blind"`.
8. **`scriptSha` is the sha256 of the canonical `commands` array only.** `about.version` changes
   with every SolidCraft release and must not make a design look modified. The daemon takes the
   script from the `timeline.export_script` reply and writes the file itself, with sorted keys
   and a stable `about` block (`design` = the part name).
9. **The live process never calls `save`, `open` or `new_design {name}`.** `.cache/design.sc` is
   not kept in v1; nothing needs it.
10. **Sandbox wording.** SolidCraft can also write its own recovery folder and a per-process
    temp folder. That is accepted; "only the part folder" means "nothing else in the repo".
11. **Corrections to §2.2:** `body_topology` is 16 KB compact (2 KB in cylinders mode);
    unfiltered `list_commands` is 393 KB; `describe_command` takes `id`; the plate is
    23,335.2 mm³ at L=80 and 35,335.2 mm³ at L=120.
12. **"Boolean retry" warnings** could not be produced on 0.44.1. That path is tested with the
    fake server only.
13. **S7 (M1 over SSH with no one logged in) is open**, awaiting the owner. The CPU renderer
    removes the dependence on a GPU session.

**From B0 (install and replay):**

14. **Verification before first execution** is the six-step sequence in the B0 evidence. The
    notarization step is `spctl -a -vv -t install`, requiring `source=Notarized Developer ID`.
    `spctl -t execute` rejects a correct bare CLI and is not used. The Team ID is enforced with a
    `codesign -R` requirement string, not by parsing text. A notarization failure is retried
    (it needs a network lookup the first time) before the folder is deleted; if Gatekeeper
    assessments are disabled the result is "cannot verify", which is a failure.
15. **Zip handling.** Extract into a new empty folder, reject absolute paths, `..` and symlinks,
    strip the one top-level folder, and run only `solidcraft-cli`.
16. **Candidate selection.** Tag matches `^v\d+\.\d+\.\d+$`, `prerelease` and `draft` are both
    false, sorted by `published_at` (the API order is not reliable), paged. The sha256 comes from
    the asset's `digest` and must equal the release's `SHA256SUMS.txt` line.
17. **Replay comparison.** Compare `body_count`, per-body `faces`, `volume_mm3` and the sorted
    bounding box. Do not compare `edges`, `kernel.*`, `ms` or `area_mm2` (edge counts differed
    between kernels for identical geometry). Volume tolerance is 1e-6 relative; adjacent releases
    differed by 5e-12.
18. **Anvil enforces the format number itself.** SolidCraft does not check `about.format` on a
    script. The manager and `verify` refuse a `design.json` whose format number is higher than
    the local build's ("this machine's SolidCraft is older than the design"). The local build's
    number is read once per version by exporting an empty design.
19. **Disk.** Each version is about 0.5 GB. Only the pinned, previous and candidate versions are
    kept.

**From C0 (SDK, browser, test daemon, part sources).** Evidence: `C0-spike.md`.

20. **Pinned versions.** `@playwright/mcp@0.0.86`, run as `npx -y`, attached to installed Chrome
    with `--browser chrome`.
21. **Preset flags.** `--user-data-dir <stateDir>/browser-profile` (headed) or `--isolated
    --headless` (fallback), `--proxy-server`, `--output-dir`, `--file-paths absolute`,
    `--no-webmcp`, no `--caps`, never `--proxy-bypass`. Extra Chrome arguments go through
    `--config` (`browser.launchOptions.args`): `--proxy-bypass-list=<-loopback>`, `--disable-quic`,
    `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
22. **No evasion, made real.** Playwright adds `--disable-blink-features=AutomationControlled`
    by default, which hides automation from pages. The preset removes it with
    `ignoreDefaultArgs`. The real suite asserts that `navigator.webdriver` is true in the launched
    browser, and the unit test asserts the generated config.
23. **The proxy is the only network control.** `--blocked-origins` is not used. Chrome sends
    hostnames unresolved, so the proxy resolves, checks, and connects to the address it checked.
    A refused request appears to the agent as a page with `HTTP status: 403`, not as a failed
    load; C2's acceptance reads "the target is never contacted and the result shows 403".
24. **Tool classification is closed.** The gate knows the 25 default tools by class (table in
    the C0 evidence). Any other `mcp__browser__*` tool is denied. `browser_tabs` with
    `action:"new"` and a `url` is a navigation and goes through the site gate. A `filename`
    argument that is absolute or contains `..` is denied. `browser_run_code_unsafe` is always
    denied; `browser_evaluate` only on the session's own test daemon.
25. **Page URL tracking.** The daemon reads the `- Page URL:` line under `### Page` when a result
    has one; absent means unchanged. A result with more than one `### Page` block holds the next
    call behind a prompt, because page-controlled text sits in the same result.
26. **Schemes.** The gate denies everything but `http:` and `https:` before the call reaches the
    server. This matters because the server itself ran a `javascript:` URL.
27. **Scrolling.** There is no scroll tool. On a logged-in site, `browser_press_key` with
    `PageDown`, `PageUp`, `Home` or `End` is allowed without a prompt; every other key prompts.
28. **Logged-in sites (replaces "has cookies").** Most sites set a cookie on first visit, so
    cookies cannot define "logged in". A site is logged in when the owner listed it, or when the
    profile gained cookies for it during an owner-run "Open agent browser" session (the daemon
    compares the profile's cookie hosts before and after that session, reading the cookie
    database read-only). Cookies gained during agent sessions do not count.
29. **"Open agent browser"** launches Chrome with the same profile folder and the same
    `--password-store=basic --use-mock-keychain` flags Playwright uses, so logins made there are
    readable by the agent's browser. Those flags mean the profile's cookies are not protected by
    the Keychain; this is part of the accepted same-user risk (§6).
30. **Downloads.** Playwright writes downloads, snapshots, screenshots and console logs into one
    output folder. That folder is `<worktree>/.anvil-browser/`. `downloads.ts` watches it,
    moves real downloads (named in a `Downloaded file … to …` result line, which can arrive one
    result late) into `<worktree>/.anvil-downloads/`, and applies the extension and size limits
    there, deleting what fails. Both folders are git-excluded.
31. **Startup cost.** A stdio server that hangs blocks session start for about 27 s, not 5 s, and
    the PATH-only health probe cannot see that. The registry therefore also records a server
    that reported `failed` at session init and marks it unavailable until the next probe.
32. **Backstop wording.** On a hook timeout the CLI blocks the call itself; `canUseTool` is the
    backstop for a hook that throws or returns no decision.
33. **Test daemon environment.** The exact list is in the C0 evidence and adds `ANVIL_WEB_DIR`,
    `ANVIL_BASE_URL` and `ANVIL_LAPO_DISABLE=1`. The web bundle is built with `ANVIL_BUILD_OUT`
    into the temporary home, so the worktree is not written.
34. **Desktop check.** `scutil State:/Users/ConsoleUser` names the daemon's user with
    `kCGSSessionOnConsoleKey` true. If a headed launch still fails, fall back to headless.
35. **Part sources (changes D33).** v1 ships DigiKey and Mouser connectors, which return
    datasheets and product data. SnapEDA is dropped: its site terms bar automated access.
    TraceParts is deferred: it is the only one with STEP files through an API, and its key
    takes days to approve. So v1 has no confirmed API route to STEP models; those go through the
    browser and the hand-off card.

**From the owner's review of the decision log (2026-11-19). These override everything above,
including the interview table in §2.3 where noted.**

36. **Part sources (revises item 35 and D33).** v1 ships DigiKey, Mouser **and TraceParts**
    connectors. All keys are entered in Settings the way the LLM keys are, stored and synced the
    same way. A connector with no key is skipped with a note. TraceParts is built against its
    documented API with recorded fixtures and stays inactive until the owner enters a key; its
    request email is a Settings field. SnapEDA stays dropped.
37. **Automation flag (reverses item 22).** The preset leaves Playwright's defaults alone: it
    neither strips the default `AutomationControlled` flag nor adds anything. Anvil still adds no
    stealth patches, fingerprint spoofing, CAPTCHA solving or proxy rotation; the argument allow
    list test asserts that nothing beyond the listed flags is passed.
38. **Logged-in rule confirmed** as item 28 (owner list, plus sites logged into through "Open
    agent browser").
39. **CPU rendering confirmed** (item 1).
40. **Same-user risk accepted for v1** (§6, §10 item 12).
41. **Nightly planner may propose expected numbers (revises §4.11 and §10 item 13).** The nightly
    planner writes proposed `cadExpectations` into the plan. They are not locked: the unit shows
    a card with the numbers, and it cannot start (by "Go" or auto-start) until the owner approves
    them. Approval locks them exactly as an interactive `save_cad_expectations` does.
42. **Approvals sync through the hub (revises §4.1 lock store and §10 item 11).** The lock store
    is hub-authoritative: an approval or adoption on any machine is sent to the hub, stored
    there, and broadcast to every member, following the environments/Todoist sync pattern. Each
    machine keeps a local copy for offline use. A part approved on the M4 needs no adopt card on
    the M1. A member that cannot reach the hub uses its last copy and queues its own approvals.
43. **Site approvals persist fleet-wide (revises D25).** A site the owner allows is allowed for
    every session on every machine until removed in Settings → Integrations. The list is
    hub-synced like item 42. The prompt options become "Allow once" / "Always allow <site>" /
    "Deny".
44. **Logged-in sites can be unlocked, fleet-wide and persistently (revises D28 and §4.12 hard
    stops).** Each logged-in site has an "unlocked" switch in Settings (and an "Unlock <site>"
    option on the hard-stop card). While a logged-in site is locked, every click, key press and
    form action asks, as specified. Once unlocked, **nothing on that site asks**, in any session
    on any machine, including checkout and payment pages. The owner chose this knowing it allows
    orders to be placed unprompted; removing the unlock in Settings is the only brake. The unlock
    list is hub-synced. Upload and script-evaluation rules (all sites) are unchanged.
45. **Reference STEP cap is 50 MB (revises item 4).** Design scripts that embed large references
    will be tens of MB in git; the part card shows the script size when it exceeds 5 MB.
46. **Phase gate dirty-tree rule stays as built** (docs Markdown may be uncommitted during a run).

## 5. Deliverables & phases

Status columns: **Impl** (code merged to the branch), **Tested** (the phase's listed tests pass
under `phase-gate`), **Pushed** (on `origin`, with the commit sha written in §11). A box is
ticked only by the rule in §8.4. Symbols: ☐ not started, ◐ in progress, ☑ done.

### Track A: CAD

#### Phase A0: spike (no product code)

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| Script round trip: build, export script, replay in a new process, compare numbers (S2) | ☐ | ☐ | ☐ |
| Reference STEP import, script export, replay with a relative path (S3) | ☐ | ☐ | ☐ |
| Hole extraction from `body_topology` on the plate and on a part with a blind hole and a boss (S4) | ☐ | ☐ | ☐ |
| Headless over SSH on the M1 with no one logged in, including `screenshot` (S7) | ☐ | ☐ | ☐ |
| Two interleaved callers on one process: confirm strict request/response ordering (S1) | ☐ | ☐ | ☐ |

**Acceptance:** §11 holds the commands and output for each row, each assumption is marked
confirmed or refuted, and every refuted one has a spec change merged before A1 starts.

#### Phase A1: process manager, part files, agent tools

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `mcp-client.ts` + `fake-solidcraft.ts` | ☐ | ☐ | ☐ |
| Manager: keying, queue, idle exit, cap, crash restart, disk-change reload | ☐ | ☐ | ☐ |
| Post-step step 1 (script write) | ☐ | ☐ | ☐ |
| `anvil_cad` server: `open_part`, pass-through tools, `export_part` | ☐ | ☐ | ☐ |
| Permission classes; capability `cad-work` behind `ANVIL_FEATURES` | ☐ | ☐ | ☐ |

**Acceptance:**

- A session calls `open_part {part:"plate"}` then the 16-command batch: `cad/plate/design.json`
  exists and replays, in a fresh process, to the same volume the live process reports.
- Killing the process between two calls: the second call succeeds and the design is intact.
- With a cap of 1, a second part's first call waits and then succeeds when the first goes idle.
- Editing `design.json` on disk, then calling `measure`: the result reflects the edited file.
- `open_part {part:"../x"}` is refused. Under `allowlist`, `measure` does not prompt and
  `execute` does.
- With `cad-work` absent from `ANVIL_FEATURES`, the session has no `anvil_cad` server.

#### Phase A2: expectations, gate, rules

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `expr.ts` evaluator | ☐ | ☐ | ☐ |
| `partfile.ts`, `locks.ts`, `record_expectations`, `propose_expectations` + card, adopt card | ☐ | ☐ | ☐ |
| Protected check in `decide()` (always-prompt and always-deny lists) | ☐ | ☐ | ☐ |
| `holes.ts`, `gate.ts`, refresh steps 2 and 3, `check_part` | ☐ | ☐ | ☐ |
| `rules.ts` hard and advisory checks | ☐ | ☐ | ☐ |
| Part card in chat | ☐ | ☐ | ☐ |

**Acceptance:**

- Modeling on a `dimensioned` part before `record_expectations` is refused.
- Plate with expectations `volume: "L*W*T - …"` (the documented formula) and holes
  `[{diameter: 3.4, count: 4}]`: gate `pass`. Removing the pattern feature: gate `fail` naming
  the hole count and the volume.
- A second `record_expectations` is refused. `propose_expectations` parks a card; Deny leaves
  `part.json` byte-identical; Approve rewrites it and updates the lock store.
- `propose_expectations` prompts under `bypass`, and still prompts after an earlier "always
  allow" answer for another tool; its card offers no "always allow".
- An `Edit` to `cad/plate/part.json` is denied under `bypass`. Rewriting the file's expectations
  on disk directly (as Bash would) makes the gate `unverified` with `needsAdoption:
  "expectations"`, including when the edit sets `lockedBy: "owner"`; adopting on the card
  restores `pass`.
- Expectations `bbox: ["L","W","T"]`: an agent `set_parameter L=120` gives `fail` with "expected
  value moved without owner approval"; the same change through `cad.param.set` gives `pass`.
- Tolerance edited on disk to 1.0 and adopted is still `fail` on the cap check.
- Changing `cad/rules.json` on disk gives `unverified` with `needsAdoption: "rules"`.
- Envelope smaller than the part: `fail` on the envelope check. `minWall` set: an advisory line,
  state still `pass`.

#### Phase A3: live preview and parameters panel

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| Post-step steps 4 and 5, debounce, preview pruning | ☐ | ☐ | ☐ |
| `cad.design`, `cad.parts.list`, `cad.param.set`, `cad.design.refresh` | ☐ | ☐ | ☐ |
| `replaceModel` in `cad.ts`; live mode: Follow, Paused + badge, Reload, Rebuild | ☐ | ☐ | ☐ |
| Playwright spec that loads the real web bundle (not the standalone golden harness page) | ☐ | ☐ | ☐ |
| Parameters panel, gate strip, error display | ☐ | ☐ | ☐ |
| Owner-change note on the agent's next tool result | ☐ | ☐ | ☐ |

**Acceptance:**

- Ten mutating calls in 200 ms produce ten script writes, at most two `cad.design` events, and
  the last event's `rev` matches the final state.
- `cad.param.set L=120` with no session turn running: one `cad.design` with `by:"panel"`, the new
  volume, and `design.json` containing the new expression. No model query is made (the capturing
  `queryFn` records zero calls).
- A bad expression returns the SolidCraft error and changes neither file.
- A panel edit queued during an agent call runs after it, and the agent's following tool result
  contains "owner changed L".
- A change made to `design.json` on disk while a request is running is not overwritten:
  `.cache/design.conflict.json` exists and the part is `fail` with the conflict message.
- Playwright, against the real built bundle with a stubbed socket: with Follow on, a new `rev` swaps the mesh and the camera
  matrix is unchanged; with Paused, the mesh is unchanged and the badge reads "1 behind"; Reload
  swaps it.

#### Phase A4: inputs, gaps, release

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `import_reference` + interference check in the gate | ☐ | ☐ | ☐ |
| `concept` parts: picture compare advisory, `request_dimensions` typed card, promotion to `dimensioned` | ☐ | ☐ | ☐ |
| `report_gap` + card | ☐ | ☐ | ☐ |
| `release.ts` + `release_part` + cards | ☐ | ☐ | ☐ |

**Acceptance:**

- A part that overlaps its reference body: gate `fail` on interference; moved clear: `pass`.
- A `concept` part: `export_part` and `release_part` refused. After the owner submits the
  dimensions card with `L=95`, `ownerParams.L` is 95 in the file and the lock store and the
  design's `L` is 95, whatever value the agent proposed; after `record_expectations` the part is
  `dimensioned`.
- `report_gap` sets state `gap`; `release_part` is refused.
- `release_part` on a passing part writes exactly the files in §4.7; `manifest.json` hashes
  match and its HMAC verifies; the sheet contains the string "Not a drawing", every parameter, and
  one hole-table row per distinct diameter; one `file.offer` is emitted per file. On a failing
  part it writes nothing. A copied folder with an edited STEP does not get the "Released" badge.

#### Phase A5: merge guard

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `verify.ts` + `verify-cli.ts` | ☐ | ☐ | ☐ |
| System-prompt rule for merges touching `cad/` | ☐ | ☐ | ☐ |

**Acceptance:** in a fixture repo, two branches each change a different parameter of one part.
After a clean text merge, `verify-cli` exits non-zero because `measured` no longer matches the
replay. After the refresh runs on the merged script and the result passes, it exits 0. A
`part.json` whose expectations do not match the lock store exits non-zero.

### Track B: fleet version and autopilot

#### Phase B0: spike

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| Standalone zip runs from `<stateDir>`, passes `codesign` and `spctl` (S6) | ☐ | ☐ | ☐ |
| A script from the previous release replays under the current one (S5) | ☐ | ☐ | ☐ |

**Acceptance:** as A0.

#### Phase B1: managed install and pin

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `install.ts` with the four verifications | ☐ | ☐ | ☐ |
| `pin.ts`, hub broadcast, member apply, `cad-work` withdrawn off-pin | ☐ | ☐ | ☐ |
| Settings → CAD card; "Pin back" | ☐ | ☐ | ☐ |

**Acceptance:** with a fake downloader: a zip whose sha differs is deleted and reported; one with
the wrong Team ID is deleted and reported; a good one becomes the manager's binary. A member on a
different version emits `cad.status { available: false }` and its `anvil_cad` tools refuse with
the reason. In the fleet simulator (`test/integration/fleet-sim.test.ts`), setting the pin on
the hub brings two members to `ready`.

#### Phase B2: replay gate and auto-advance

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `candidate.ts` (age, release type, rate limit) | ☐ | ☐ | ☐ |
| `replay.ts` on each machine, hub aggregation | ☐ | ☐ | ☐ |
| Hold, reject, notify; "Advance anyway" | ☐ | ☐ | ☐ |

**Acceptance (fake clock, fake SolidCraft with a per-version behaviour table):**

- With releases 10, 30 and 50 hours old, the 50-hour one is chosen; with only 10 and 30, none is.
- `part.json.measured` deliberately stale: the candidate still passes, because the comparison is
  pinned build against candidate.
- The local checkout is on a feature branch with a different design: the replay reads
  `origin/<defaultBase>`.
- All parts identical: the pin advances once, and not again within 24 h.
- One part's volume differs by more than its tolerance: the pin holds, the candidate is recorded
  rejected with that part's old and new numbers, one notification is sent, and the next check
  does not retry it.
- A member hosting designs is unreachable: the pin holds and the card names the member.
- During evaluation the pinned build keeps serving sessions (the candidate is installed beside it).

#### Phase B3: autopilot CAD

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `workUnitRole: "builder"` + `workUnitId` on handoff; `WorkUnit.cadExpectations`, `cadVerified` | ☐ | ☐ | ☐ |
| `save_cad_expectations` on the planner server (always prompts) | ☐ | ☐ | ☐ |
| `startPlan` applies plan expectations to files and lock store | ☐ | ☐ | ☐ |
| Builder restrictions in the protected check and `cad-tools` | ☐ | ☐ | ☐ |
| Verify hook at builder turn end and goal resolution | ☐ | ☐ | ☐ |
| Verify prepended to dev-pipeline `checks` when the diff touches `cad/` | ☐ | ☐ | ☐ |

**Acceptance (autopilot service with fake handoff and fake SolidCraft):**

- `startPlan` on a unit with `cadExpectations.plate`: the new session carries
  `workUnitRole: "builder"`, and the worktree's `cad/plate/part.json` and the lock store hold the
  plan's expectations before the first turn.
- Builder builds a passing part: at turn end the unit has `cadVerified` and is not `blocked`.
- Builder's part fails the gate, or it calls `report_gap`, or it touches a part the plan did not
  cover: the unit is `blocked` with the matching reason and the goal reports unmet.
- In a builder session, `propose_expectations`, `request_dimensions` and an `Edit` to
  `cad/rules.json` are denied and no card is emitted.
- Dev pipeline with a diff touching `cad/` and a failing design maps to `blocked`; removing the
  repo's `EnvironmentValidation` does not change that.

### Track C: registry and browser

#### Phase C0: spike

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| Superseded spec's Phase 0 rows, minus Fusion and SolidCraft | ☐ | ☐ | ☐ |
| Playwright MCP: attach to Chrome with a profile, proxy, page URL in results (S9) | ☐ | ☐ | ☐ |
| Daemon from a worktree on a random port, empty state, no credentials (S10) | ☐ | ☐ | ☐ |
| Part-source APIs and terms (S11) | ☐ | ☐ | ☐ |

**Acceptance:** as A0. If S9's proxy or URL reporting fails, C2 does not start until §4.12 is
redesigned and re-critiqued.

#### Phase C1: registry core

The superseded spec's Phases 1 and 2, with its acceptance rows unchanged, using the `echo`
fixture. Tasks and status are tracked here:

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| Protocol, store, service, `buildMcpServers`, `strictMcpConfig`, resource tools disallowed | ☐ | ☐ | ☐ |
| Permission branch, `mcpAllowed`, unknown-key deny, `canUseTool` backstop | ☐ | ☐ | ☐ |
| Health, idle-driver drop on flip, exclusive lock | ☐ | ☐ | ☐ |
| Settings → Integrations, session Tools control | ☐ | ☐ | ☐ |

#### Phase C2: browser preset, network block, per-site approval

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `preset.ts`: headed with profile; desktop check; headless fallback; argument allow list | ☐ | ☐ | ☐ |
| `proxy.ts` block list by resolved address | ☐ | ☐ | ☐ |
| `sites.ts`: navigation gate, post-result URL check, hold and `about:blank` | ☐ | ☐ | ☐ |

**Acceptance:**

- Through the proxy, requests to `127.0.0.1`, a `10.x` address, a tailnet address, and a public
  name that resolves to `127.0.0.1` are all refused; a public address is allowed.
- Real suite, real Chrome launched with the preset's flags: a page fetch to
  `http://127.0.0.1:<live daemon port>` and to the daemon's tailnet address both fail.
- Navigation to `file:///etc/hosts`, `chrome://settings` and a `data:` URL is denied.
- First navigation to `a.test` prompts; "this session" lets a second `a.test` navigation through
  and still prompts for `b.test`. A new session prompts for `a.test` again.
- A tool result reporting a page on unapproved `c.test` holds the next browser call behind a
  prompt; Deny issues a navigation to `about:blank`.
- No desktop session: the built config is headless with a temporary profile, and a navigation to
  a listed logged-in site is denied.
- The preset's arguments are a subset of the allow list.

#### Phase C3: logged-in sites, hard stops, downloads, hand-off

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| Logged-in sites list + "Open agent browser" | ☐ | ☐ | ☐ |
| `hardstops.ts` | ☐ | ☐ | ☐ |
| `downloads.ts` quarantine and limits | ☐ | ☐ | ☐ |
| `request_human` + card | ☐ | ☐ | ☐ |

**Acceptance:**

- On a logged-in site under `bypass`: a snapshot, a scroll and a same-site navigation do not
  prompt; a click, a key press and a form fill each prompt with a screenshot attached and no
  "always allow" option. On an allowed site with no cookies and not listed, a click does not
  prompt.
- A site becomes logged-in when the profile gains a cookie for it, with no list edit.
- An upload of a path outside the worktree is denied; inside it, it prompts. A script-evaluation
  call on a public site is denied.
- A 1 KB `part.step` download lands in `.anvil-downloads/` with no file card; a `.dmg` is deleted
  and reported; a file over the limit is deleted and reported.
- `request_human` parks until `I've cleared it`; in an autopilot unit it blocks the unit.

#### Phase C4: throwaway test daemon

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| `start_test_daemon`, lifetime, proxy exemption | ☐ | ☐ | ☐ |

**Acceptance:** the started process's environment is exactly the listed variables plus PATH and
TMPDIR, with `ANVIL_HOST=127.0.0.1` and `HOME` a new temporary folder; it listens on loopback
only (a connection to the tailnet address on that port is refused); its port is reachable through
the proxy from that session only. A second session's browser is refused on that port.
The live daemon's port stays refused for both. The process and its temporary home are gone after the turn ends.

#### Phase C5: part sources

| Task | Impl | Tested | Pushed |
|---|---|---|---|
| DigiKey and Mouser connectors, keys in Settings | ☐ | ☐ | ☐ |
| SnapEDA / TraceParts connector (whichever passed S11) | ☐ | ☐ | ☐ |
| `parts_search`, `parts_fetch` into quarantine | ☐ | ☐ | ☐ |

**Acceptance (recorded HTTP fixtures):** a search returns normalized results from each configured
source; a source with no key is skipped with a note, not an error; `parts_fetch` of a STEP link
lands in the quarantine under the download limits; a non-allowed type is refused.

### Deferred

Fusion MCP integration; SolidCraft-to-Fusion translator; `anvil-computer` screen control; team
CAD; assemblies; PDF spec sheets before Track C; per-environment browser profiles; persistent
site approvals.

## 6. Constraints

- **Daemon is the permission authority.** No `allowedTools` entry for any CAD or integration
  tool. The always-prompt cases (`propose_expectations`, `release_part`, hard stops) are enforced
  in `decide()` ahead of both the remembered-allow lookup and the `bypass` short-circuit, and
  their prompts offer no "always allow".
- **The gate cannot be satisfied by the agent editing its own target.** Approval lives in the
  lock store, outside the repo; the gate trusts repo files only when their hashes match it.
- **Same-user limit, stated plainly.** The agent's Bash runs as the daemon's user, so it could in
  principle rewrite the lock store, the browser profile or the release key. The protected check
  denies the known routes and the Bash patterns act as a tripwire, but this is not a sandbox.
  Closing it properly needs the daemon to run agent shells as a different OS user, which is out
  of scope here and recorded in §10 for the owner to accept.
- **SolidCraft only touches its part folder.** `--allow-path` is the part folder, never the
  worktree root, and `--allow-any-path` is never passed (unit-asserted).
- **Downloaded binaries are verified four ways** before execution (§4.10), with the Team ID as a
  constant in source.
- **Fleet format safety.** A machine off the pin refuses every `anvil_cad` tool call.
- **Browser cannot reach a daemon** other than its own throwaway one, enforced by resolved
  address at the proxy.
- **No evasion of bot detection**, enforced by the argument allow list test.
- **Credentials:** SolidCraft, Chrome, Playwright MCP and the test daemon all start from `env -i`.
- **Backwards compatibility:** all new protocol is additive and capability-gated; an older
  member or the bundled Android UI ignores it. New UI reaches the phone only with a new APK.
- **Performance:** script write plus refresh for the reference plate under 1 s on the M4 (measured in the real
  suite, recorded not asserted); debounce bounds event rate at 2 per second per part.
- **Token cost:** `--compact` on; unfiltered `list_commands` refused; `body_topology` is never
  called by the daemon on the agent's behalf except inside the refresh, whose output the agent
  does not see.
- **Platforms:** macOS daemons. Track C headed mode needs a desktop session.

## 7. Edge cases & failure modes

| Scenario | Expected | Test |
|---|---|---|
| Daemon restarts mid-turn | Processes are gone; the next call replays `design.json`; at most the in-flight call is lost | A1 unit: manager |
| Crash during script write | Temp file + rename, so the old script survives intact | A1 unit: poststep |
| SolidCraft hangs | A per-request timeout (120 s, 600 s for `batch`) kills the process; the call fails with a clear error; next call restarts | A1 unit |
| Gate code throws | State `unverified`, never `pass` (fail closed) | A2 unit |
| Two sessions on two worktrees of one repo, same part | Different keys, different processes; reconciled by git and A5 | A5 functional |
| Two clients send `cad.param.set` at once | Queued in arrival order; two events | A3 functional |
| Panel edit while the cap is full | Waits for a slot; UI shows "waiting for a CAD slot" | A3 unit |
| `part.json` corrupt or wrong schema | Part state `unverified` with the parse error; no overwrite | A2 unit |
| `design.json` fails to replay | Process starts empty, state `fail` with the failing command index; the file is not overwritten until a mutating call succeeds | A1 functional |
| Script written by a newer format | Replay error is surfaced as "this machine's SolidCraft is older than the design" | B1 unit |
| Reference bodies cannot be scripted (S3 false) | Fallback: references are re-imported by the daemon at process start from `refs/`, outside the script | A0 decides; A4 |
| Feature warning "Boolean retry" with numbers still matching | `pass` with the warning listed | A2 unit |
| Cut that misses (success reported, volume unchanged) | Volume check fails | A2 functional |
| Owner denies an expectation change | Nothing written; the agent is told it was denied | A2 acceptance |
| Candidate build crashes on replay | Counts as a failure for that part; pin holds | B2 unit |
| Hub restarts mid-evaluation | Evaluation restarts from scratch on the next check; no partial advance | B2 unit |
| Pin back after scripts were rewritten | Warned, affected parts listed; no automatic rewrite | B1 unit |
| GitHub unreachable | Candidate check is skipped; pin unchanged | B2 unit |
| Proxy process dies | Browser has no route out (fail closed); health reports unavailable | C2 unit |
| DNS rebinding to a private address | Refused, because the check is on the resolved address per connection | C2 acceptance |
| Page navigates by itself to an unapproved site | Next call held; Deny goes to `about:blank` | C2 acceptance |
| Hard-stop prompt times out | Denied | C3 unit |
| Test daemon outlives the turn | Killed at turn end and by a 15-minute timer | C4 acceptance |
| **Gamed:** agent sets expectations after measuring | Modeling is refused before expectations exist; later changes need the owner | A2 acceptance |
| **Gamed:** agent edits `part.json` (Edit, or Bash) | Edit is denied; any other write leaves a hash the lock store does not know, so the part is `unverified` until the owner adopts it | A2 acceptance |
| **Gamed:** agent writes expectations as bare parameter names, then changes the parameters | Accepted numbers are held in the lock store; the gate fails on "moved without owner approval" | A2 acceptance |
| **Gamed:** expectations so loose anything passes (e.g. tolerance 1.0) | Caps are checked by the gate on every evaluation, not only when recorded | A2 acceptance |
| **Gamed:** agent loosens `rules.json` | Edit always prompts; any change needs adoption | A2 acceptance |
| **Gamed:** agent runs `solidcraft-cli` from Bash and hand-builds a release folder | Bash pattern denies the obvious route; a pack without a valid HMAC gets no "Released" badge | A4 acceptance |
| **Gamed:** agent answers an "always prompt" card once with "always allow" | Those cards have no such option, and the check runs before the remembered-allow lookup | A2 acceptance |
| Fresh clone or another machine opens an approved part | `unverified` with an adopt card; one tap per part per machine | A2 unit |
| Chrome ignores the proxy for loopback | Prevented by `--proxy-bypass-list=<-loopback>`; proven with real Chrome | C2 acceptance |
| Session Bash launches Chrome on the agent profile | Denied by the protected Bash patterns; residual risk per §6 | C2 unit |
| **Gamed:** preview "refresh" implemented as reopening the viewer | A3 golden asserts the camera matrix is unchanged | A3 golden |
| **Gamed:** replay gate compares a build with itself | B2 uses a fake with a per-version table where versions differ | B2 acceptance |
| **Gamed:** real-tool suite silently skipped | `phase-gate --require-real` fails on any skip | §8 |
| **Gamed:** a named test exists but asserts nothing | `phase-gate` reads the JUnit report and fails any named test with zero assertions | §8 |
| **Gamed:** PASS block typed by hand | The reviewer re-runs `phase-gate` at the pushed sha on a clean checkout | §8 |

## 8. Evaluation & verification

### 8.1 Technical (unit)

`cadwork/expr`, `partfile`, `holes`, `gate`, `rules`, `release` (file list and manifest),
`manager` (fake process, fake clock), `poststep` (debounce, atomic write), `verify`;
`solidcraft/install` (fake downloader and fake verifier), `candidate`, `replay`;
`agent/cad-tools` (path refusal, permission classes); Track C units as listed per phase.

### 8.2 Functional (deterministic, CI)

Real stores and services; SolidCraft replaced by `fake-solidcraft.ts`, a stdio MCP server that
keeps parameters and a feature list and computes `measure` from a small table of closed-form
solids (box, plate with holes), so a missing feature changes the numbers the way the real kernel
would. One scenario file per phase, each asserting that phase's Acceptance bullets one to one:

- `test/integration/cad-a1-manager.test.ts` … `cad-a5-verify.test.ts`
- `test/integration/solidcraft-b1-pin.test.ts`, `-b2-replay.test.ts`, `autopilot-b3-cad.test.ts`
- `test/integration/browser-c2-sites.test.ts` … `parts-c5.test.ts`
- Web: jsdom boot test for the parameters panel; a Playwright spec that loads the real built
  bundle for viewer live mode. The existing `test/golden` harness page does not import
  `web/src/cad.ts`, so it cannot prove the product's camera is kept.

### 8.3 Real-tool suite (the M4, required)

`test/real/*.test.ts`, run with `ANVIL_REAL_TOOLS=1`, skipped elsewhere (D36):

- **A:** the plate end to end through the real manager: script round trip, `L=120` giving
  35,335.2 mm³ within tolerance, gate pass, gate fail after removing the pattern, release pack
  files present, kill-and-recover.
- **B:** install the current release zip into a temp state folder and pass all four
  verifications; replay the repo's fixture designs under it.
- **C:** real Chrome through the real proxy against a local fixture site: per-site prompt, hard
  stop on a form submit, download into quarantine, refusal of the live daemon port.

Each track also has one **owner-witnessed check**, recorded in §11 with a screenshot: A, a part
built from a phone prompt, a parameter changed in the panel on the phone, the release pack
opened; B, a real pin advance across two machines; C, a logged-in site action stopped by a
hard-stop prompt on the phone. These three are the only steps an agent cannot complete alone,
and a phase waiting on one is marked ◐ with "awaiting owner", never ☑.

### 8.4 How an agent verifies before marking anything done

`anvild/test/phase-manifest.json` maps each phase id to: its test files, the named tests that
correspond to each Acceptance bullet, and whether the real suite is required.

`bun anvild/test/tools/phase-gate.ts <phase> [--require-real]` then:

1. Refuses to run on a dirty working tree.
2. Fails if any listed test file or named test does not exist (a bullet with no test is not done).
3. Runs `bun test --reporter=junit` on the phase's files and reads the report: every named test
   must be present, passed, not skipped, and have at least one assertion.
4. Runs the whole suite (`bun test`), `tsc --noEmit` for daemon and web, and `bun run web/build.ts`.
5. Runs the phase's Playwright specs, if it lists any. `bun test` does not run them and CI does
   not either, so this is the only place they gate.
6. With `--require-real`, runs the phase's real tests and fails on any skip.
7. Prints a summary block with the git sha, the SolidCraft version, per-step counts and a final
   `PHASE <id>: PASS` or `FAIL` line.

Rules for the status tables:

- **Impl** is ticked when the code is committed on the branch.
- **Tested** is ticked only after `phase-gate <phase> --require-real` prints `PASS` on the M4,
  and that summary block is pasted into §11 under the phase.
- **Pushed** is ticked only after `git push` succeeds and
  `git rev-parse origin/computer-use` equals the sha in the pasted block. The sha is written in §11.
- A fresh-context adversarial reviewer then checks out the pushed sha into a clean worktree,
  **runs `phase-gate` itself** and compares its output with the pasted block, then reads the
  Acceptance bullets against the named tests and can veto (for example, a test that asserts
  something other than its bullet). A veto unticks **Tested**.
- Nobody edits `phase-manifest.json` in the same commit that makes its tests pass, except to add
  entries; removing or renaming a named test needs the reviewer's sign-off recorded in §11.

### 8.5 Definition of done

A phase is done when all three columns are ☑ for every row, its `PASS` block and pushed sha are
in §11, the reviewer has not vetoed, and its capability flag is still off by default.

The feature is done when every phase is done, the three owner-witnessed checks are recorded,
`docs/` describes the `cad/` layout and the rules file for a repo owner, the flags are on for the
whole fleet, and §10 has no open decision left unanswered.

## 9. Spec-critique gate (before any build)

- **Critique round 1 (2026-11-19, fresh-context agent):** 5 blockers, 6 should-fix, 1 nit. All
  accepted and folded in.

| # | Finding | Resolution |
|---|---|---|
| 1 | Autopilot CAD had no host: "Go" runs no validation, the dev pipeline has no tools, `save_plan` is Markdown | §4.11 rewritten around `startPlan` with a `builder` role, plan-carried expectations, a verify hook, and a pipeline check; B3 re-scoped |
| 2 | Gate provenance lived in agent-writable files (`lockedBy`, `.cache` sha, tolerances, `rules.json`) | Lock store in `<stateDir>`, adopt cards, caps re-checked in the gate, protected check (§4.1, §4.4, §4.5, §4.6) |
| 3 | Formula expectations moved with agent-set parameters | Accepted numbers held in the lock store; only owner actions update them (§4.5) |
| 4 | Browser containment: loopback proxy bypass, WebRTC, non-http schemes, uploads, Bash-launched Chrome | Required flags, scheme deny, upload and evaluation rules, protected Bash patterns (§4.12) |
| 5 | Throwaway daemon would bind the tailnet address and read the real home | Explicit environment with loopback host and temporary home (§4.12, C4) |
| 6 | "Always prompt" defeated by remembered allows | Protected check runs first; no "always allow" on those cards (§4.4) |
| 7 | Replay gate: stale `measured` rejects everything; branch unspecified; "latest ≥ 48 h" never qualifies | Pinned-vs-candidate comparison, `origin/<defaultBase>`, newest eligible release (§4.10) |
| 8 | Hard-stop heuristic trusted the model's description; hand-kept list | Inverted to an allow list; cookies define logged-in (§4.12) |
| 9 | Capabilities are a static const; no `ANVIL_FEATURES`; cached drivers | Capability function at startup; separate `cad.status` availability (§4.8) |
| 10 | Queue contradictions; clobbered disk edits; no card path; D16 had no mechanism | Script write vs refresh split, double disk check, service-emitted offers, typed dimensions card (§4.2 to §4.5) |
| 11 | Phase gate could pass without verifying; golden harness doesn't load the product | JUnit parsing, zero-assertion failure, Playwright step on the real bundle, reviewer re-runs (§8.4, A3) |
| 12 | `fleet-sim` path; simpler CLI routes; hand-made release packs | Path fixed; `eval` used for replay; manifest HMAC (§4.7, §4.10) |

## 10. Open decisions

Defaults assumed unless you object:

1. **The script is rewritten after every change**, not only at the end of a turn (D7 said per
   turn). It makes panel edits and crash recovery work; the file is not committed either way.
2. **An agent may set expectations once, for a part that has none.** After that only you can
   (or the planner, in autopilot). The alternative is that you approve even the first set.
3. **`release_part` always asks**, even under bypass.
4. **A candidate SolidCraft build must be 48 hours old** and a full release before the fleet
   will consider it, and the pin moves at most once a day.
5. **An unreachable machine that hosts designs holds the pin** indefinitely, with a manual
   override.
6. **Spec sheets are Markdown and HTML** until the browser track can print a PDF.
7. **Browser hard stops over-prompt by design** on logged-in sites (every button click).
8. **Downloads are capped at 200 MB** and a fixed list of file types.
9. **Tolerances default to 0.01 mm and 0.1% volume**, and an agent cannot record anything looser
   than 0.1 mm or 1%.
10. **Module name `cadwork/`** for the new daemon code, to keep it apart from the viewer's
    `src/cad/`.
11. **Approval is per machine.** A part approved on the M4 shows an adopt card the first time it
    is opened on the M1 (one tap). Syncing the lock store through the hub is deferred.
12. **Accepted risk: the agent runs as the daemon's user** (§6). The guards stop the easy routes,
    not a determined one. Running agent shells as a separate OS user would close it and is a
    separate project.
13. **Autopilot CAD needs an interactive planning session** to supply the expected numbers. A
    nightly-planned unit that needs CAD waits, blocked on "needs dimensions".
14. **On logged-in sites every click and keystroke asks**, with no "always allow". If that makes
    logged-in work unusable in practice, the fallback to discuss is a per-site, per-session
    unlock.
15. **The dev pipeline cannot model in v1.** It only refuses to ship a broken design.

## 11. Evidence log

_One subsection per phase: the `phase-gate` summary block, the pushed sha, spike output, reviewer
verdict, and owner-witnessed screenshots. Empty until Phase A0._
