# Decision log: agent CAD and browser

Decisions made during autonomous implementation of `2026-11-19-agent-cad-and-browser.md`, for
owner review afterwards. Newest at the bottom. Each entry: what was decided, why, and what it
would take to reverse.

| # | Date | Phase | Decision | Why | To reverse |
|---|---|---|---|---|---|
| 1 | 2026-11-19 | all | The spec's 15 open decisions (§10) are taken as written. | Owner said to proceed without questions. | Each is listed in §10 with its alternative. |
| 2 | 2026-11-19 | all | Build runs as three parallel chains: Track A in the main worktree; Tracks B (B0 to B2) and C in nested git worktrees under `.wt/` (git-excluded), merged into `computer-use` by the orchestrator. B3 runs after A and B merge. | Owner asked for speed; tracks share few files once a common foundation is committed. | None needed; it is process only. |
| 3 | 2026-11-19 | all | Subagents report their decisions; only the orchestrator writes this file. | Avoids merge conflicts on the log across worktrees. | n/a |
| 4 | 2026-11-19 | all | A shared foundation lands first, before the chains fork: `serverCapabilities(config)` + `ANVIL_FEATURES`, the protected-check scaffold in `decide()`, `phase-gate.ts` + `phase-manifest.json`, and `fake-solidcraft.ts`. | These are the files all three tracks touch; landing them once keeps merges small. | n/a |
| 5 | 2026-11-19 | A0, S7 | The "headless on the M1 over SSH with no one logged in" check is not run by the agent. It is recorded as awaiting the owner; the M4 run from a non-GUI shell stands in. | The agent has no known SSH route to the M1 and should not probe the network for one. | Run the A0 spike script on the M1 and paste the output into §11. |
| 6 | 2026-11-19 | all | The three owner-witnessed checks (§8.3) stay "awaiting owner"; phases that depend only on them are marked ◐, not ☑. | The spec forbids an agent from ticking them. | Owner performs them. |
| 7 | 2026-11-19 | A0 | Reference STEP bodies travel inside `design.json` (SolidCraft embeds the STEP text). No separate re-import path. References capped at 5 MB. | The spike showed scripts record no file path; this is how the tool works. | Lower or raise the cap; nothing else to reverse. |
| 8 | 2026-11-19 | A0 | SolidCraft runs with the CPU renderer (`SOLIDCRAFT_GPU=cpu`). | First GPU frame cost 5.6 s per process versus 34 ms on CPU, and GPU access with no one logged in is unproven. CPU renders lack surface-analysis colours and highlights. | Remove the env var. |
| 9 | 2026-11-19 | A0 | A failed timeline feature fails the geometry gate, as a new hard check. | SolidCraft reports success and measures partial geometry when a feature breaks. | n/a (safety). |
| 10 | 2026-11-19 | A0 | A counterbored hole is one row in the hole table, keyed by its smallest diameter; countersinks and slots are not holes. | That is what can be extracted reliably. | Change `holes.ts` grouping. |
| 11 | 2026-11-19 | A0 | The agent's `undo` reverts its whole previous request, not one SolidCraft undo step. | A batch is many undo steps, and a partial undo can leave a sketch open. | Expose raw undo instead. |
| 12 | 2026-11-19 | A0 | `.cache/design.sc` is not written in v1. | Nothing needs it; the script is the truth and saving renames the live design. | Add a `run --save` step. |
| 13 | 2026-11-19 | B0 | Notarization is checked with `spctl -t install`; the spec's original `spctl` form rejects valid command-line binaries. | Spike evidence. | n/a. |
| 14 | 2026-11-19 | B0 | Replay gate volume tolerance is 1e-6 relative, not the part's own tolerance. | D3 asks for any drift to hold the pin; adjacent releases differed by 5e-12, so 1e-6 is strict without tripping on float noise. | Change one constant in `replay.ts`. |
| 15 | 2026-11-19 | B0 | Anvil itself refuses a design whose format number is newer than the local SolidCraft build. | SolidCraft does not check the format of scripts, only of `.sc` files, so an older machine could silently misread a newer design. | Remove the check. |
| 16 | 2026-11-19 | B0 | Only the pinned, previous and candidate SolidCraft versions are kept on disk. | Each is about 0.5 GB. | Change the prune rule. |
| 17 | 2026-11-19 | C0 | **Changes interview decision D33.** v1 part-source connectors are DigiKey and Mouser only. SnapEDA is dropped and TraceParts deferred. | SnapEDA's site terms bar automated access. TraceParts needs a key that takes days to approve and an email per request. Neither DigiKey nor Mouser is confirmed to return STEP files, so v1 has no API route to 3D models; those go through the browser and hand-off. | Apply for a TraceParts key and add a connector. |
| 18 | 2026-11-19 | C0 | **Changes the critique's "has cookies means logged in" rule.** A site is logged in when the owner lists it, or when it gained cookies during an owner-run "Open agent browser" session. | Most sites set a cookie on first visit, so the cookie rule would mark nearly every site as logged in and every click would prompt everywhere. | Switch `sites.ts` to treat any cookie as logged in. |
| 19 | 2026-11-19 | C0 | The browser preset strips Playwright's default flag that hides automation from web pages. | The spec forbids evasion, and Playwright applies that flag by default. Some sites will detect the browser sooner as a result. | Remove the `ignoreDefaultArgs` entry. |
| 20 | 2026-11-19 | C0 | Playwright MCP is pinned at 0.0.86. | The version the spike verified. | Bump the constant and re-run the C real suite. |
| 21 | 2026-11-19 | C0 | On logged-in sites, PageDown, PageUp, Home and End are allowed without a prompt as "scrolling". | Playwright MCP has no scroll tool. | Remove the key allow list. |
| 22 | 2026-11-19 | C0 | Cookie hosts are read from the profile's cookie database, read-only. Chrome's remote-debugging port is not opened. | The debugging port would give any local process control of the logged-in browser. | n/a. |
| 23 | 2026-11-19 | C0 | The browser's working folder is `<worktree>/.anvil-browser/`; real downloads are moved from there into the quarantine. | Playwright mixes downloads with its own snapshots and logs in one folder. | n/a. |
| 24 | 2026-11-19 | C0 | Disclosure: the browser spike ran 11 short queries on the daemon's Claude subscription token (about $0.19 list-price equivalent) to test the SDK assumptions. | It was the only way to run those checks for real; the repo's own smoke test documents the same route. | n/a. |
| 25 | 2026-11-19 | C0 | A bug found in passing is left for the browser track to fix in C4: `parseTailscalePeers` throws an unhandled rejection when `tailscale` prints non-JSON. | It only shows when the daemon starts without `ANVIL_BASE_URL`, which the test daemon avoids, but the fix is small. | n/a. |
| 26 | 2026-11-19 | F0 | A "Foundation" phase (F0) was added ahead of the spec's phases, with its own gate entry. It passed at `94fb28c` (73 named tests; full suite 1436 pass, 0 fail). | Shared pieces had to land before the tracks forked. | n/a. |
| 27 | 2026-11-19 | F0 | **Looser than the spec:** the phase gate's "clean tree" rule blocks any change under `anvild/` and any tracked non-doc change, but lets edited Markdown under `docs/` and untracked files outside `anvild/` through. | The orchestrator edits the spec and this log while gates run. Code and tests are still required to be committed. | Tighten `phase-gate.ts` to refuse any dirty file. |
| 28 | 2026-11-19 | F0 | The gate records the commit at the start and fails if HEAD moves during the run. | A first run reported a commit other than the one it had tested. | n/a. |
| 29 | 2026-11-19 | F0 | Unknown names in `ANVIL_FEATURES` log a warning and are ignored; the daemon still starts. | A machine one release behind should still boot. | Make it a startup error. |
| 30 | 2026-11-19 | F0 | A protected permission rule that throws is treated as a denial. | A buggy rule should fail closed. | n/a. |
| 31 | 2026-11-19 | F0 | Always-prompt cards show a custom Allow label but not the reason text. | The permission request on the wire has no field for a reason, and the foundation did not change the protocol. Later phases add one where a card needs it. | Add a `reason` field to `permission.request`. |
| 32 | 2026-11-19 | F0 | The fail-closed backstop denies external tool calls that are not in the session's own built-in tool list, not every `mcp__` name. | Built-in tools (concierge, team, planning) could reach the same code path on a hook timeout and must keep working. | n/a. |
| 33 | 2026-11-19 | all | Adversarial reviews for Tracks B and C run at the track-branch commit. The "Pushed" column for those phases is ticked after the track merges into `computer-use`, following one more full gate run on the merged tip. | The tracks build on separate branches for speed. | n/a. |
| 34 | 2026-11-19 | all | The orchestrator added one small file itself before the tracks forked: `anvild/src/solidcraft/binary.ts`, the single place that decides which SolidCraft binary runs. | Tracks A and B both need it; creating it once avoids a merge conflict. | n/a. |

## Owner review, 2026-11-19 (first pass)

The owner was interviewed on the entries above that changed an interview answer or carried risk.
Outcomes, now folded into the spec as §4.14 items 36 to 46:

| Entry | Owner's call | Effect |
|---|---|---|
| 17 (part sources) | **Changed.** Add the TraceParts connector now; all keys entered in Settings like the LLM keys. | C5 builds three connectors. SnapEDA stays dropped. |
| 19 (strip Playwright's automation-hiding flag) | **Reversed.** Leave Playwright's default. The owner also asked for "as stealthy as possible"; that was declined beyond the default (no stealth patches, fingerprint spoofing, CAPTCHA solving or proxy rotation). | C2 does not use `ignoreDefaultArgs`. |
| 18 (logged-in rule) | Confirmed. | none |
| 8 (CPU renderer) | Confirmed. | none |
| Spec §10 item 12 (agent runs as the daemon's user) | Accepted for v1. | none |
| Spec §10 item 13 (autopilot CAD needs interactive planning) | **Changed.** The nightly planner may propose numbers; the unit cannot start until the owner approves them on a card. | B3 scope grows. |
| Spec §10 item 11 (approvals per machine) | **Changed.** Sync approvals through the hub. | A2 builds a hub-synced lock store. |
| Spec §10 item 14 (every click asks on logged-in sites) | **Changed.** Logged-in sites can be unlocked, persistently and fleet-wide; once unlocked nothing on that site asks, including checkout and payment pages. | C3 scope changes; D28 revised. |
| D25 (site approvals per session) | **Changed.** Site approvals persist fleet-wide until removed in Settings. | C2 scope changes. |
| 7 (5 MB reference cap) | **Changed** to 50 MB. | A4. |
| 27 (gate lets docs be uncommitted) | Confirmed as built. | none |

## Build decisions, continued

| # | Date | Phase | Decision | Why | To reverse |
|---|---|---|---|---|---|
| 35 | 2026-11-19 | B1 | The hub installs a new SolidCraft build on itself first; if that fails, no pin is recorded and no member is contacted. | A bad version-and-hash pair should never reach the fleet. (The Claude CLI rollout installs the hub last.) | Reorder in `fleet-solidcraft.ts`. |
| 36 | 2026-11-19 | B1 | A corrupt pin file leaves the machine reporting CAD unavailable until a pin is set again. | Treating it as "no pin" would silently lift the fleet's version guard. | Treat corrupt as absent. |
| 37 | 2026-11-19 | B1 | A member that was offline when the pin moved is brought up to date by a 10-minute reconcile timer on the hub, not immediately on reconnect. | Simplest reliable mechanism. Until then it believes itself on the old pin. | Trigger reconcile on member reconnect. |
| 38 | 2026-11-19 | B1 | The installer uses its own strict zip reader, not `unzip`, and refuses symlinks, `..`, absolute paths and duplicate entries. | One parser checks and writes the names, so there is no gap between check and extraction. | n/a. |
| 39 | 2026-11-19 | B1 | At daemon start the installed build is trusted from a marker file; signature checks are not re-run on every boot. | Keeps start-up fast and offline. Same-user risk already accepted. | Re-verify on boot. |
| 40 | 2026-11-19 | B1 | **B1 was vetoed by its reviewer.** Reason 1: a wrong hash for the already-pinned version deleted the working install while status still said "ready". Reason 2: the "CAD unavailable when off the pin" bullet had no real test, because the event and tool refusal live in Track A. Fixes for the first (and four smaller findings) were sent to the Track B agent. The second is deferred to the merge: B1 stays "in progress" until a post-merge test shows an off-pin machine emitting `cad.status {available:false}` and an `anvil_cad` call refusing with the reason. | Spec §8.4: a bullet with no test is not done. | n/a. |
| 41 | 2026-11-19 | B1 | `test/contract/regen-golden.ts` is broken on main (it imports a test file outside the runner), so protocol golden changes are edited by hand on each track. | Found during B1; not caused by this work. Track B was asked to fix it if quick. | n/a. |
| 42 | 2026-11-19 | C1 | C1 passed its adversarial review. Six findings were sent to the Track C agent to fix alongside C2, the main one being that a permission card left open while an integration was edited could still be answered "always" and apply to the edited definition. | Reviewer reproduced it; only a client (the owner) can trigger it, never the model. | n/a. |
| 43 | 2026-11-19 | C1 | When a tool server fails at session start it is held as unavailable until the owner presses Check or edits or toggles that integration. The spec said "until the next probe". | A probe runs before every turn, so the literal rule would clear the hold at once and stall each session start for about 27 s again. | Clear holds on the timer probe. |
| 44 | 2026-11-19 | C1 | Any session that belongs to an autopilot work unit or a team is denied integrations, slightly stricter than the spec's list of roles. | Simpler and safer; re-checked live at each call. | Loosen `isOrdinarySession`. |
| 45 | 2026-11-19 | C1 | Sessions with integrations switched on probe their health before each turn, adding up to 1 s before the prompt is delivered. | Keeps the attached set current without a background poll per session. | Drop the before-turn probe. |
| 46 | 2026-11-19 | C1 | The iOS and Android native clients were not updated for the new events; they show the raw tool name on permission cards. The web UI (also bundled in the Android app) is updated. | Native work is outside this spec. | Add native support later. |
| 47 | 2026-11-19 | C1 | The Custom integration form splits the typed command line in the browser (quotes and backslashes, no shell expansion). | Operators type a command line; the daemon stores command and arguments separately. | n/a. |
