# Loops Circuit Build — Decision Log

Decisions made autonomously during implementation of `2026-08-11-loops-circuit-build.md`.
Review after implementation to tweak as needed.

## Format
- **D-NNN** (Phase, area): decision — rationale.

---

## Decisions

- **D-001** (P1, protocol): `anvild/protocol.ts` is a symlink to `docs/plans/anvil-protocol.ts`. Edited the real target (the source of truth). Confirms the spec's "in scope: docs/plans/anvil-protocol.ts".
- **D-002** (P1, protocol): Extended `LoopSummary` with optional display fields (`act`, `rung`, `runnerAt`, `scope`, `environmentId`, `environmentName`) plus `LoopRung`/`LoopStation` types and `draft`/`gated`/`paused` enum members, rather than a client-only view model — so Phase 2's real Loop entity shares the same render contract. No golden regen needed (the golden captures only `type: "..."` wire discriminants, not union-member literals or optional fields). Verified by re-running protocol-surface test later.
- **D-003** (P1, projection): Changed two projection semantics for the circuit model: a paused goal now reports `status: "paused"` (was `"armed"`) and an event proposal reports `status: "gated"` sitting at the gate (was `"waiting"`). Updated the two affected unit tests. Rationale: the circuit reads clearer — a paused loop has no runner, a proposal awaits you at the gate.
- **D-004** (P1, projection): `drafts` input = work units with status `planned` or `needs-clarification` (proposed units keep their own `trigger`-kind row). These render as `kind: "draft"` in the "drafts at your gate" section and open the plan reader.
- **D-005** (P1, review fix): Phase 1 adversarial review (fresh context) flagged that the status renames (D-003) left the still-live Autopilot Loops panel's proposal/paused rows unstyled (no `.loop-gated`/`.loop-paused` CSS) and that new `draft` rows leaked into that panel — both violating §3 "autopilot surface unchanged". Fixed by (a) adding `.loop-gated`/`.loop-paused` rules to app.css (proposal stays purple, as "waiting" was) and (b) filtering `kind === "draft"` out of the Autopilot panel's `activeLoops()`. The Loops home is the only surface that shows drafts. Reviewer's other notes (approved proposal reappears in the Drafts section) accepted as the intended propose→approve→draft lifecycle.
