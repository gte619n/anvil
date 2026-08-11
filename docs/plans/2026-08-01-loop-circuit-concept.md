# The Loop Circuit — reconceiving Autopilot + Loops as one visual idea

- **Status:** Concept v2 (supersedes the direction of `2026-08-01-loops-first-class.md`; that spec's store/protocol/testing machinery still applies, re-scoped to this model)
- **Date:** 2026-08-01 · **Branch:** `loops` · **Interactive mock:** `anvild/web/preview/loops-preview.html`

## 1. The diagnosis

What we have works but reads as four systems: autopilot cards + schedule, `/goal` chips, event proposals, and a pipeline trace — four vocabularies for one idea. A user can't answer "what is running, why, and when does it stop?" without learning all four. The v1 spec made Loops a first-class *entity* but kept the fragmented *mental model* (wizard forms over many primitives).

## 2. The one mental model

> **A loop is a task with a check. A task without a check is just hope.** (agentic-loop field guide)

Everything autonomous in Anvil becomes **one entity drawn one way** — a circuit:

```
   Trigger ──▶ Act ──▶ Check ──▶ 🔒 gate ──▶ Ship
               ▲          │
               └──────────┘  "lap 3 of 10 · until check passes"
```

- **Trigger** — manual, schedule, event (CI/webhook/Todoist), or another loop finishing.
- **Act** — one bounded change per lap (a worktree session, the dev pipeline, a shell/skill).
- **Check** — a fixed, mechanical verdict each lap (command exit / metric / LLM judge). Same check every lap.
- **Gate (🔒 = you)** — the human approval point. **Autonomy is not a setting — it is WHERE the gate sits on the circuit:**

| Rung | Gate position | Meaning |
|---|---|---|
| **Suggest** | after Check | read-only; each lap ends in a report |
| **Draft** | before PR | writes to a branch; you open the PR |
| **PR** | before merge | opens a verified PR; you merge |
| **Ship** | no gate | merges on green |

- **Ship** — the exit: report, branch, PR, or merge, per rung.
- **Three hard stops on every loop, non-negotiable:** max laps, token/time budget, no-progress detection (2 identical laps halts it).

### 2.1 Contract v2 — scope and check integrity (specification-engineering additions)

A Loop **is** a specification, and the intake conversation is specification engineering operationalized (Objective→Act, Verification→Check, Constraints→hard stops, Context→Trigger). Two components the 8-part spec framework exposes as missing from v1:

- **Scope (the fifth slot).** What Act may touch and what it must not — elicited at intake ("only `src/upload/`; don't touch the test harness itself") and rendered on the circuit under the Act station. Non-goals are part of the slot. A lap whose diff leaves scope **fails that lap** with a scope-violation verdict (it doesn't kill the loop; the runner gets the violation as feedback, like any failed check).
- **Check integrity (anti-gaming).** "Make the tests pass" is gameable by editing the tests. Rules:
  1. **Frozen at arm** — the check is part of the armed `configRevision`; changing it requires pause-to-edit, never a lap.
  2. **Maker–checker separation** — the check is evaluated outside the actor session (separate judge/spawn), never by the model that did the work.
  3. **Check-input guard** — files that back the check (the test files a `command` check runs, the check's config) are implicitly out of scope for Act; a lap that modifies them fails with a check-tampering verdict. Legitimate test changes happen by pausing and re-arming with the human's eyes on the new check.

**Autopilot is not a separate system.** It is simply a built-in loop: *Trigger =* nightly / Todoist label · *Act =* turn new tasks into loop drafts · *Check =* every task triaged · *Gate =* Suggest (drafts wait for you). Work units, goal chips, proposals, and the pipeline trace all collapse into loops, laps, gates, and the circuit.

## 3. How everything maps

| Today | Becomes |
|---|---|
| Autopilot nightly run + schedule card | the **Todoist-intake loop** (visible in the same list as everything else) |
| Work unit ("planned/building/review…") | a **loop draft** → an armed loop; its status = where the runner-dot is on the circuit |
| `/goal` + iterations + judge | the **Check** station + the lap counter (`goal.iterations` = laps) |
| `proposed` / propose-don't-run | the runner **waiting at the gate** |
| Adversarial hold / auto-start gates | gate placement + the Check verdict |
| Pipeline phases + loopbacks | the **Act** station's internal detail; loopbacks are laps |
| autoStart / usePipeline / maxAutoStart flags | the **autonomy rung** (one dial, visual) |

## 4. The authoring flow — the LLM leads

No form wizard. The user starts with **a prompt (or a Todoist task flows in)** and Claude *is* the loop engineer:

1. User types the outcome ("Fix the flaky upload test") or taps a waiting Todoist task.
2. Claude asks the few questions that matter — **check first** ("how will we know it's done? I suggest `bun test ×10` green"), then scope ("I'll stay inside `src/upload/`"), then hard stops, then gate position — each with one-tap suggested answers. The **circuit diagram builds live above the chat**: stations light up as they're specified. The circuit *is* the completeness meter.
3. **"Still ambiguous":** before the preview, Claude volunteers what it could NOT pin down ("I assumed the flake is timing-related — if it's env-specific this check won't catch it"). Each ambiguity is resolved with a tap or **explicitly accepted as an assumption** (logged on the loop, visible on its page). The spec-gaming failure mode dies here, not in a post-mortem.
4. **Intent preview**: the finished circuit + "first lap is a dry-run (sandboxed, no side effects)". Arm.
5. New loops start gated (Suggest/PR); **autonomy is earned** — after N clean gated laps, Claude proposes moving the gate right (progressive delegation), never silently.

## 5. Monitoring — at a glance means literally at a glance

- **Home list:** every loop is a row with a **mini-circuit glyph** — the same four dots + return arc, the runner-dot's position and color showing state, the lock showing the gate. You read the whole fleet's activity without words.
- **Loop page:** the full circuit with the runner animating between Act ⇄ Check; the three hard-stop bars (laps, budget, no-progress); **lap history** (one row per lap: what it did + the check's verdict); the autonomy ladder; and a loop-scoped "Ask Claude" chat for tuning (widen budget, change the check…).
- **Gate moments are the notification surface:** "at your gate" is the one state that needs you; failure/auto-pause pushes and a daily digest cover the rest.

## 6. Research grounding

- **Loop anatomy + hard stops + maker–checker:** the [agentic-loop field guide](https://dev.to/truongpx396/the-agentic-loop-a-practical-field-guide-mnc) (trigger/inputs/action/check/stop; max-iterations + budget + no-progress as non-negotiable; verifier separate from maker — our Check judge/deterministic checks stay independent of the acting session).
- **[Anthropic's loop-engineering guide](https://claude.com/blog/getting-started-with-loops):** clear success/stop criteria; second-agent review; start with the simplest loop and add machinery only when a failure forces it — hence dry-run-first and manual-trigger-first defaults.
- **Agentic UX patterns:** Intent Preview, Autonomy Dial, Explainable Rationale, Action Audit, Escalation Pathway ([Smashing Magazine](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)); progressive delegation — autonomy earned through demonstrated reliability ([agent UX surveys](https://fuselabcreative.com/ui-design-for-ai-agents/)).
- **Specification engineering:** the 8-component spec framework and specification-gaming failure mode ([KDnuggets](https://www.kdnuggets.com/specification-engineering-the-new-skill-after-prompt-engineering), backed by the 2024 ROPE study) — drives Contract v2 (§2.1: the Scope slot + check integrity) and the intake's "still ambiguous" step. The catalog incident was this failure mode in the wild.

## 7. What carries over from the v1 spec

The v1 spec's **infrastructure decisions stand** (LoopStore atomic persistence, hub-authoritative catalog + execute-where-the-env-lives, `loops` capability, checkpoint/resume semantics, the deterministic functional test harness, and the executable done-gate + adversarial reviewer). What changes is the **product model on top**:

- One entity (`Loop`) replaces the work-unit-vs-loop split; work units become loop drafts.
- The wizard becomes the **Claude-led intake conversation** with the live circuit.
- The Loops view becomes the **home surface**; the autopilot grid folds into it.
- The autonomy rung replaces autoStart/usePipeline/propose flags.
- The v1 phase tables get re-cut against this model before build (Phase 1 = circuit renderer + Loop entity + manual lap + check verdicts + gate; then intake conversation; then triggers; then fleet/resume).
- The re-cut spec follows **`docs/plans/SPEC-TEMPLATE.md`** (the specification-engineering standard): explicit inputs/scope, systematic edge-case enumeration, and a **spec-critique gate before Phase 1** in addition to the per-phase done-gate.

## 8. Open questions for Evan

1. Naming: "laps" for iterations — keep, or plain "attempts"?
2. Does the Todoist-intake loop *replace* the autopilot card grid outright, or do cards remain as the drafts' detail view inside the Loops home?
3. Gate-promotion cadence: suggest after 3 clean laps — right threshold?
