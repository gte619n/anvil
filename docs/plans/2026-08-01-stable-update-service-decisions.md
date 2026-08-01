# Decision Log — Stable Update Service Implementation

Companion to `2026-08-01-stable-update-service.md`. Every non-trivial implementation decision made
autonomously during the build is recorded here for later review. Format: `DL-N · area · decision · why`.

Interview-locked decisions (D1–D24) live in the spec §3 and are not repeated here; this log captures
the finer-grained choices made while turning that spec into code.

---

- **DL-1 · Module layout.** New daemon-side modules under `anvild/src/daemon/`:
  `update-state.ts` (on-disk state: pre-pull SHA, target, known-good, boot markers),
  `update-api.ts` (the frozen v1 logic layer that wraps selfupdate+state),
  and `updater/` (the separate watchdog: `watchdog.ts` logic + `main.ts` entrypoint).
  *Why:* keeps the stable surface (update-api, updater) physically separate from the churny daemon
  code it drives, mirroring the stable/unstable split in spec §4.2.

- **DL-2 · Protocol home.** Types added to `anvild/protocol.ts` (the real `@protocol` module), not the
  docs copy `docs/plans/anvil-protocol.ts` (reference only). Added `UPDATE_API_VERSION`,
  `ServerHelloEvent.updateApiVersion`, `HealthResponse.{webBundleOk,updateApiVersion}`, and a
  `rest.update` namespace for the v1 request/response shapes. *Why:* single source of truth the code
  actually imports; additive-only so `PROTOCOL_VERSION` stays 3 (matches the "pairing"/capabilities
  precedent in identity.ts).

- **DL-3 · updateApiVersion starts at 1, independent of PROTOCOL_VERSION.** *Why:* spec D12 wants the
  update surface versioned on its own axis so it can stay frozen across daemon protocol bumps.

- **DL-4 · Frozen REST surface is `/api/update/v1/{check,apply,status}`.** The legacy
  `/api/daemon/update` + WS `daemon.update` are kept and now delegate to the same logic layer.
  *Why:* spec §4.3 back-compat; native macOS menu + scripts keep working through one hop.

- **DL-5 · CORRECTS DL-2: `anvild/protocol.ts` is a symlink to `docs/plans/anvil-protocol.ts`.** They
  are the SAME file (the `@protocol` alias resolves through the symlink). Edited the real target. The
  "docs copy vs real module" distinction in the spec was wrong — there is one file.

- **DL-6 · Advertise BOTH `updateApiVersion` (field) and a `stable-update` capability.** *Why:* the
  field is the precise version a hub routes on, but existing fleet code already gates features off the
  `capabilities[]` list (identity.ts) — adding the tag lets that machinery treat "speaks the stable
  updater" uniformly with every other capability, and gives the web UI a one-liner feature check.

- **DL-7 · `applyUpdateToTarget` uses `git checkout --detach <sha>` (refusing a dirty tree), not
  `pull --ff-only`.** *Why:* spec D13 demands landing the EXACT pinned SHA so the whole fleet converges
  to an identical build; fast-forwarding to a moving branch tip can't guarantee that. Rollback uses
  `git reset --hard <prePullSha>`. Local commits / dirty tree fail loudly and are never clobbered
  (addresses spec OQ3, the dev-box false-rollback risk).

- **DL-8 · `/api/fleet/update` identity posture mirrors `/api/fleet/rotate`** (reject a PROVEN other
  tailnet user, stay permissive when identity is unprovable) rather than being fully ungated.
  *Resolves spec OQ1* pragmatically: a hub-initiated fleet-wide update is a powerful mutation like
  rotate, so it takes rotate's guard — not full identity-gating (which rotate itself deliberately
  avoided to not fail an operator when whois is momentarily down). Flag for review.

- **DL-9 · Legacy `supervisor.daemonUpdate` now delegates to `updateApply({})`.** *Why:* one code path;
  crucially the legacy trigger now ALSO records the pre-pull SHA, so a bad update started from the
  macOS menu is still rollback-able by the watchdog. v1 phases map back to `check|up-to-date|updated|error`.

- **DL-10 · Boot resilience is genuinely "both" (spec D5).** `settleAfterBoot` (in-daemon, cooperative:
  adopts the new SHA as known-good once up) + the separate Bun watchdog (out-of-process backstop for
  "never came up"). Both key off the same `webBundleOk` smoke signal on `/api/health` (spec D14).

- **DL-11 · The watchdog reuses `selfupdate.scheduleRestart` to restart the DAEMON** (not itself). It's
  its own launchd/systemd unit (`com.anvil.anvil-updater`) with its own launcher exporting
  `ANVIL_MANAGED`/`ANVIL_PORT` but NO Claude token — it never talks to Anthropic. *Why:* smallest stable
  surface; the daemon's restart mechanics already exist and are proven.

- **DL-12 · The watchdog arms off the shared `update-state.json`, not a private channel.** It reacts to
  `phase:"restarting"`; a healthy landing (health = target SHA + webBundleOk) disarms and adopts the new
  known-good; gate-elapsed → `rollbackTo(prePullSha)` + restart. *Why:* one source of truth shared with
  the in-daemon path; the watchdog needs zero cooperation from a possibly-broken daemon beyond /api/health.

- **DL-13 · Self-bootstrap (D15) = daemon shells `service.sh install-updater` once on boot** when managed
  and the unit file is absent (`src/daemon/updater/arm.ts`), detached + best-effort. New `install-updater`
  subcommand installs ONLY the watchdog unit (no daemon touch, no web build), so it's a cheap idempotent
  hop. *Why:* an existing fleet updates through the OLD path first; after one reboot every host is on the
  stable path with no manual per-host toil.

- **DL-14 · Web UI: a dedicated `#fleet-rollout-status` panel inside the Fleet section**, plus the hub-only
  "Update fleet" button next to "Sync now". *Deviates slightly from spec D16's "extend existing cards":*
  the cards are keyed by URL while rollout members are keyed by serverId, so a compact per-member progress
  panel (name · state · rollback indicator · hub-last tag) in the same section is the lower-risk, equally
  legible realization. Per-card "Update Anvil" is untouched. Flag for review.

- **DL-15 · `applyUpdateToTarget` runs `git fetch` before the checkout** so a pinned SHA that only exists
  on the remote is fetch-first-then-checkoutable. Combined with the dirty-tree refusal (DL-7), a hub can
  pin a tip that a member hasn't fetched yet and the member still lands on it deterministically.
