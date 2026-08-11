# Anvil Specification Template

> Copy this file to `docs/plans/<date>-<slug>.md` for any feature spec. It folds the eight
> specification-engineering components (objective, context, inputs, output, constraints, evaluation,
> edge cases, verification — see the KDnuggets/ROPE framing) into the structure we already use
> (phase tables + executable done-gate + adversarial review), and closes the three gaps that
> framework exposed in our earlier specs: **explicit scope**, **systematic edge-case enumeration**,
> and a **spec-critique gate that runs BEFORE build**, not only at done-time.
>
> Delete the quoted guidance as you fill each section. A section that genuinely doesn't apply gets
> "N/A — <why>", never silence: an empty section reads as "covered" when it isn't.

- **Status:** Draft | Spec-critiqued | Approved | Building | Done · **Owner:** · **Branch:**
- **Created:** · **Supersedes/extends:**

## 1. Objective & non-goals
> One paragraph: the outcome in user-observable terms — what will someone be able to do/see that
> they can't today? Then **non-goals as first-class bullets**: the adjacent things this spec
> deliberately does NOT do. Non-goals are the cheapest defense against specification gaming — an
> agent (or a future you) satisfying the letter of the spec while missing its intent.

## 2. Context
> Why now, prior art in the repo (link files/PRs), decisions already made (link the interview or
> conversation), and relevant memories/incidents. A reader should not need the conversation that
> produced this spec.

## 3. Inputs & scope
> What the work is ALLOWED to touch, and what it must not.
- **In scope (files/modules/systems):**
- **Out of bounds (must not modify):** <!-- e.g. "the protocol golden except via the regen flow", "test files that back an acceptance check" -->
- **Available inputs/tools/data:**
- **Assumptions log:** <!-- every assumption made because the requirement was ambiguous; each entry: assumption · why · who confirmed (or "unconfirmed") -->

## 4. Design
> Data model, architecture, and UX — authoritative shapes (TypeScript for wire/store types), file
> map of where each piece lands, and the patterns being followed (name the existing module being
> mirrored, e.g. "store follows AutopilotScheduleStore").

## 5. Deliverables & phases
> Vertical slices, each independently shippable. One status table per phase:
>
> | Task | Implemented | Tested | Pushed |
> |---|---|---|---|
>
> Each phase ends with an **Acceptance row**: the observable behavior that proves the phase works,
> phrased so it can be encoded as a functional test verbatim.

## 6. Constraints
> Hard requirements that bound every phase: security boundaries (e.g. Tailscale trust model —
> no app-layer auth), budget/model-usage rules, backwards compatibility (protocol golden +
> capability gating for older members), performance ceilings, platforms.

## 7. Edge cases & failure modes
> Systematic, not anecdotal. For each: the scenario · expected behavior · which test covers it.
> Prompts to force coverage — walk each one, write "N/A" only with a reason:
> - Crash/restart mid-operation (what state survives? what resumes? what must never double-apply?)
> - The verifier/check itself errors or is unreachable (fail open or closed — and why)
> - Concurrent/duplicate triggers (idempotency, dedupe)
> - Stale or corrupt persisted state (quarantine behavior)
> - The gamed-spec case: how could an agent satisfy this spec's letter while missing its intent?

## 8. Evaluation & verification
> Both layers, always:
- **Technical:** unit tests for pure logic (list the modules).
- **Functional:** the deterministic lifecycle harness scenario(s) — fake clock/model/judge, real
  store — asserting each phase's Acceptance row end-to-end.
- **Done-gate (per phase):** run and paste evidence — `bun test` (0 fail) · `tsc --noEmit` (daemon
  + web, exit 0) · `bun run web/build.ts` · this phase's functional scenario — then a fresh-context
  **adversarial reviewer** checks the phase against its Acceptance row and can veto. Only after
  both may the phase's table flip to done.

## 9. Spec-critique gate (before any build)
> The shift-left twin of the done-gate. After the spec is drafted and BEFORE Phase 1 starts, a
> fresh-context agent attacks the SPEC itself: missing requirements, untestable acceptance rows,
> unstated assumptions, scope holes, gameable objectives. Findings are logged here with the
> owner's resolution (fix the spec / accept as assumption / defer). The spec is not "Approved"
> until this section shows a critique round.
- **Critique round 1 (date):** findings + resolutions.

## 10. Open decisions
> Defaults chosen without the owner, each marked "default assumed unless you object", so silent
> guesses are visible and reversible.
