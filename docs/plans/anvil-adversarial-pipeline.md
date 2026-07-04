# Adversarial multi-model pipeline & the autopilot gates

**Status:** shipped (commits #102 dev pipeline, #103 OpenRouter settings, #105 auto-start gate).
This documents subsystems that previously lived only in code — the OpenRouter/GLM integration, the
adversarial *planning panel*, the adversarial *dev pipeline*, and the gates that decide whether an
autopilot work unit builds unattended. Source of truth is the code; this is the prose map.

Key files: `anvild/src/integrations/adversarial.ts`, `integrations/openrouter.ts`,
`integrations/autostart-gate.ts`, `integrations/autopilot.ts`, `agent/model-roster.ts`,
`agent/env.ts`, `pipeline/*` (`orchestrator.ts`, `phases.ts`, `run.ts`, `metrics.ts`).

## Why two providers

Anvil's interactive sessions run **Claude** through the Agent SDK on the user's Max/Pro subscription
(OAuth token; never a metered API key — see the §3 guard in `auth/guard.ts`). The adversarial work
adds a **second, decorrelated model — GLM** — reached through **OpenRouter's Anthropic-compatible
endpoint ("Anthropic Skin")**. GLM runs through the *same* Agent SDK, so it gets the full
tool/worktree machinery, but billed to OpenRouter, not Anthropic.

Crucially this does **not** reintroduce a metered Anthropic key into the daemon: `agent/env.ts`
builds a per-spawn *child* env that sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (the OpenRouter
key) for the GLM subprocess only. The daemon's own `process.env` is untouched, so the startup guard's
invariant (no Anthropic key in the daemon) still holds. The OpenRouter key is configured in
Settings → Models; absent it, all adversarial features degrade gracefully (they're skipped, never
fatal).

## 1. Adversarial planning panel (`adversarial.ts`)

When autopilot plans a work unit, one or more OpenRouter critic models independently **critique and
score the plan 0–10** (10 = excellent, 0 = fundamentally broken). When a repo root is supplied each
critic runs as a **read-only agent** (repo-reading tools, `MAX_TOOL_ROUNDS = 12`) so it can ground
its critique in the actual code before committing to a verdict; the round cap forces a verdict if the
model keeps calling tools.

- Each critique is `{ score, verdict, objections[] }`, parsed defensively (score clamped to 0–10).
- A model that fails or returns unparseable output becomes an `error` critique **excluded from the
  consensus math**; the panel never throws — planning must not be blocked by a flaky critic.
- `consensusScore` = the mean of the successful scores (undefined if none succeeded).

The panel is **advisory**: it never edits code and never directly blocks a build. Its consensus feeds
the auto-start gate below. Provider routing can be pinned (`ANVIL_ADVERSARIAL_PROVIDER`) to keep the
critic's implicit prompt cache warm across rounds; models default to `ANVIL_ADVERSARIAL_MODELS`.

## 2. Auto-start gates (`autostart-gate.ts`)

Two **pure, SDK-free** gates stand between a freshly-planned unit and an *unattended,
bypass-permission* build (this is the safety net added after the "built an underspecified task"
incident — the planner itself cannot ask the user, so the gates catch what it would otherwise build
blind):

1. **Intake** — is the task well-specified enough to build without asking? A vague task is left
   `needs-clarification` for the user to refine. The parser fails toward *not* wedging everything
   into needs-clarification (it should catch the vague, not become the default).
2. **Plan quality** — `AUTOSTART_MIN_CONSENSUS = 6`: a unit whose adversarial panel scored the plan
   below 6 stays `planned` for manual review (the panel already flagged it as weak). Units with no
   consensus (no OpenRouter key → `consensusScore` undefined) are **not** held on this axis, but the
   intake gate still applies.

Both gates are advisory-to-the-operator by design: they downgrade a unit to a state that needs a
human, rather than silently proceeding.

## 3. Adversarial dev pipeline (`pipeline/`, `model-roster.ts`)

The opt-in dev pipeline (`Supervisor.runDevPipeline`) builds a work unit through **seven phases**,
alternating **author** and **adversary** roles across the two models so an artifact is always
reviewed by a *different* lineage than the one that produced it (the independence rule,
`assertIndependent`). Per `PHASE_ASSIGNMENT`:

| Phase | Author | Adversary | Rationale |
|-------|--------|-----------|-----------|
| P0 intake | GLM | — | cheap classification |
| P1 requirements | GLM | Claude | judgment-stronger model audits |
| P2 design | Claude | GLM | novel design is Claude's edge; critique is checklist-shaped |
| P3 implementation | GLM | — | deterministic checks live in P4 |
| P4 verification | GLM | — | GLM generates adversarial **tests**, not argument |
| P5 validation | Claude | — | blind Claude pre-check; human/proxy owns the gate |
| P6 transfer | GLM | — | release tooling (opens the PR) |

Both models drive through one path (`agent/query.ts` `runAgentQuery`), differentiated only by their
`ModelSpec` (`sdkModel` + env `profile`). Read-only phases use plan mode; write phases (P3, P4) run
with tools enabled and are gated by the pipeline danger list (`agent/pipeline-guard.ts`) so an
unattended run can't take a destructive action. The run persists a trace record on the work unit and
the §6.3 **collusion metric** (`pipeline/metrics.ts`) — the first-pass rejection rate per gate, which
is the alarm for "is the adversary decorative, or is it actually rejecting real work?" Metrics are
saved on every exit (success or failure) so a hard-fought failed run still counts.

## Operational notes

- All of this is **opt-in / off by default without an OpenRouter key**; the interactive
  single-model experience is unaffected.
- The pipeline is unattended and runs a third-party model with write tools — treat GLM as untrusted
  execution. See [`SECURITY.md`](../../SECURITY.md) (SEC-H4) and `agent/pipeline-guard.ts`.
- Scheduled autopilot fires only on the hub, not member-hosted projects; manual "Run autopilot" does
  fan out across the fleet.
