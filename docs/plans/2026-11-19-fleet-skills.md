# Fleet skill library (one set of skills for every project on every machine)

**Status:** built · **Owner:** Evan · **Branch:** `skills-install` · **Created:** 2026-11-19 · **Last revised:** 2026-11-19

## Problem

Sessions get skills from two places (`anvild/src/agent/skills.ts`): `~/.claude/skills` on the
machine running the session, and the repo's own `.claude/skills`. To give every project a skill
today you either commit it into every repo or copy it into `~/.claude/skills` on every Mac by hand.
Unattended runs (autopilot planning, the dev pipeline) get **no** skills at all: only the
interactive driver passed `plugins`.

## Goals

1. Add a skill **once** and every session on every fleet machine can use it.
2. Keep it in sync: edits, removals and re-pulls from the source reach every member without anyone
   touching the members.
3. Don't touch project repos (no commits, no dirty trees for the updater to trip on).
4. Keep the daemon as the permission authority: skills load, on-disk settings/permission rules don't.
5. Let unattended runs use the library too, with a per-skill opt-out.

## Non-goals

- A skill marketplace/search. Import takes a git URL or a path; discovery stays with `find-skills`.
- Per-environment skill subsets. A skill is fleet-wide; a repo that needs its own still uses `.claude/skills`.
- Agents, hooks, MCP servers or commands from plugins. The wrappers are skills-only by design.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | The library lives on the **hub** under `<stateDir>/fleet-skills/`, and members hold **replicas** | Same shape as the account roster, prompts and model labels: one writer, no merge conflicts. |
| D2 | **Push** replication: the hub POSTs the whole library to `/api/skills/replica` | Members don't need to know the hub's URL; same transport as Todoist/adb propagation (https→http per member). |
| D3 | Drift check before every push (`GET /api/skills/replica` → hash) | The periodic sweep costs one tiny request per member when nothing changed. |
| D4 | Sweep triggers: every hub-side change, 20 s after boot, every 10 min, "Sync now" | Covers offline members coming back without a reconnect hook. Sweeps are coalesced. |
| D5 | Sessions load the library as a third skills-only plugin, `fleet`, so skills show up as `/fleet:<name>` | Reuses the existing `plugins` mechanism, so `settingSources: []` still holds. |
| D6 | A user skill with the same name as a fleet skill is hidden | Promoting `~/.claude/skills/foo` to the fleet shouldn't show both. Project skills keep their own namespace. |
| D7 | Per-skill `headless` flag (default **on**) gates use in autopilot planning + the dev pipeline | Consistency by default, with an off-switch for skills that shouldn't steer unattended runs. |
| D8 | Import sources: git (URL or `owner/repo`) and a path on the hub; plus inline SKILL.md authoring | Covers "grab a public skill repo", "promote my local skill" and "write one quickly". |
| D9 | Git/local skills are **read-only** in the UI; change them at the source, then **Update** | No fork between the source and the copy. Inline skills are edited in place. |
| D10 | Hard limits: 1 MiB/file, 5 MiB and 200 files/skill; symlinks and dot-entries skipped; paths can't escape | A bad import or a hostile push can't wedge replication or write outside the skill dir. |
| D11 | Replica gating: a daemon with members of its own refuses a push (409); a member with a paired hub only accepts that hub (403) | Anti-confusion. Tailscale is the security boundary (no app-layer auth), matching `/api/fleet/token`. |
| D12 | After a library change, idle session drivers are recycled | The SDK discovers skills at query init. Recycling (same path as a credential change) resumes the conversation with the new set. |

## Design

### Store (`anvild/src/skills/fleet-store.ts`)

```
<stateDir>/fleet-skills/index.json        { role: "hub" | "replica", skills: FleetSkill[] }
<stateDir>/fleet-skills/skills/<name>/…   SKILL.md + supporting files
```

- `saveInline`, `import(source, {ref, subdir, headless})`, `update(name?)`, `remove`, `setHeadless`
  all throw on a replica.
- An import is all-or-nothing: every discovered skill is validated before any is written. Skill dirs
  are found at the root, `*/`, `skills/*/` and `.claude/skills/*/`.
- Writes go to a staging dir, then get renamed into place. `adoptReplica` validates the whole bundle
  before touching disk.
- `hash()` covers content and the headless flag, so a flag flip is a change members receive.

### Loading (`anvild/src/agent/skills.ts`)

- `skillPlugins()` adds the `fleet` source (a whole-dir symlink) next to `user` and `project`.
- `refreshHeadlessSkills()` builds `<stateDir>/skill-plugins/_headless/fleet/skills/` with one
  symlink per headless skill. `headlessSkillOptions()` is spread into `runAgentQuery`
  (`agent/query.ts`) and autopilot's `runQuery`.
- `buildCommandInfo()` tags `fleet:*` commands and reads their descriptions. One shared frontmatter
  parser, which also understands YAML block scalars (`description: >`).

### Wire (protocol 0.10, additive, `PROTOCOL_VERSION` stays 4, capability `fleet-skills`)

- Event `skills { role, hash, skills, members? }`: sent on connect and on every change.
- Commands `skill.list | save | import | update | remove | set_headless | sync`.
- REST `rest.skills.Bundle` / `ReplicaState`. `GET /api/skills/file?name=` serves a SKILL.md to the editor.
- `CommandInfo.source` gains `"fleet"`.

### UI (`anvild/web/src/skills.ts`, Settings → Skills)

The panel lists skills with their source and size and an "also use in autopilot & dev-pipeline runs"
toggle. Actions are Edit/View, Update, Remove, Update all, Import and New skill. It also shows a
per-server sync table with **Sync now**. It's hub-authoritative: a member's own `skills` event is
ignored.

## Validation

- `bun test test/unit/fleet-skills.test.ts`: store, git import/update via a local `file://` repo,
  replication round-trip, traversal rejection, plugin views, headless options reaching
  `runAgentQuery`, `/` menu tagging, block-scalar frontmatter.
- `bun test test/integration/fleet-skills-replication.test.ts`: two real daemons. A save on the hub
  lands on the member's disk, the hashes match, the member refuses edits, removal propagates, and a
  hub refuses a replica push.
- Manual: Settings → Skills on a throwaway daemon. Import `~/.claude/skills/ponytail`, write an
  inline skill, toggle headless (screenshots checked during the build).
- Not yet witnessed: a live SDK session listing `/fleet:<name>` on a real member. It uses the same
  plugin mechanism already proven for `user`/`project`.

## Follow-ups

- Autopilot-spawned *build sessions* are ordinary sessions, so they get every fleet skill no matter
  what `headless` says. Only the headless planning/pipeline queries are filtered. Tighten this if it
  matters.
- An optional "Promote to fleet" action on a `user:` skill in the `/` menu.
