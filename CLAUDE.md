# Working in this repo

Anvil is a native, multi-device client for Claude Code: a Bun/TypeScript daemon (`anvild`)
supervises Claude Code sessions and streams them as structured events to thin native clients over
Tailscale. Start with [`README.md`](README.md) for the product overview and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system design.

## Orientation — where things live

| Path | What it is |
|------|-----------|
| `anvild/` | The daemon (Bun/TS). `src/` = server + session supervisor + agent driver + pipeline + integrations; `web/` = the PWA web client (its own `tsconfig`, bundled by `web/build.ts`). |
| `app/` | Android client (Kotlin WebView shell + FCM). Bundles the web UI into the APK. |
| `apple/` | iOS + macOS client (Swift WebView shell + APNs, `anvil-app://` custom scheme). |
| `anvil-server/` | macOS menu-bar app that provisions Tailscale and manages the `anvild` lifecycle. |
| `docs/` | `ARCHITECTURE.md`, `plans/` (design docs + the wire protocol `anvil-protocol.ts`), and the improvement program (`plans/anvil-improvement-program.md`). |
| `scripts/`, `anvild/scripts/` | Build/release/signing + service management (`service.sh`, `merge-session.sh`). |

The wire protocol is the source of truth for daemon↔client contracts:
`docs/plans/anvil-protocol.ts` (symlinked as `anvild/protocol.ts`, imported as `@protocol`). A
contract test (`anvild/test/contract/`) pins its `PROTOCOL_VERSION` + event set against a golden.

## Build, test, run

All daemon commands run from `anvild/` (Bun ≥ 1.3.14):

```bash
cd anvild
bun test                 # the full suite (bun:test)
bun run typecheck        # tsc --noEmit over src/ + test/  (does NOT cover web/)
bun run typecheck:web    # tsc over web/  — a SEPARATE tsconfig; run BOTH after editing web/src
bun run build:web        # bundle the PWA to web/dist (see "Common pitfalls")
bun run dev              # run the daemon locally with --watch
bun run start            # run the daemon (src/main.ts)
```

CI (`.github/workflows/ci.yml`) gates every PR on `typecheck` + `typecheck:web` + `build:web` +
`bun test`; the release workflows re-run the same checks before shipping. Keep all four green.

**Running the daemon needs `CLAUDE_CODE_OAUTH_TOKEN`, and it refuses to start if `ANTHROPIC_API_KEY`
or `ANTHROPIC_AUTH_TOKEN` are set** — those outrank the OAuth token and would meter per-token billing
(the §3 guard in `src/auth/guard.ts`). This is the single most surprising local-run failure. The
daemon's security boundary is Tailscale itself — see [`SECURITY.md`](SECURITY.md).

## Common pitfalls

- **Web bundle cache staleness.** After editing `anvild/web/src`, you must re-run `bun run build:web`
  — the daemon serves `web/dist`, not the source. A stale `web/dist` (or a browser/service-worker
  cache; `web/sw.js` is a real SW) shows up as "my UI change didn't take."
- **The Android/Apple apps bundle their own copy of the web UI.** `anvild/web/bundle-native.ts` embeds
  the web client into the native shells, so updating `anvild` never updates a phone's UI — the app
  must be re-shipped. A daemon self-update won't reach installed native clients.
- **The daemon runs sessions with `settingSources: []`** (`src/agent/driver.ts`), so this `CLAUDE.md`
  is NOT auto-loaded into daemon-driven Claude Code sessions. Conventions here guide humans/agents
  editing the repo, not the running agent's context.

## Merging a session's PR

**Do NOT run `gh pr merge --delete-branch` in a worktree.** `--delete-branch` switches the local
checkout to `main` *before* deleting the remote branch. `main` is already checked out by the
canonical clone, so the switch fails, gh aborts, and you're left with the worktree stranded on the
merged branch **and** the remote branch undeleted (the "let me delete the remote branch manually"
/ "couldn't auto-switch to main" warnings).

Instead, run the worktree-safe merge:

```bash
anvild/scripts/merge-session.sh --squash   # or --merge / --rebase
```

It merges (no `--delete-branch`), deletes the remote branch with a plain push, rolls the worktree
onto a fresh `<branch>_followup` off `origin/main`, and deletes the local branch. The daemon's
in-app Merge button does the same thing via `mergePr()` in `anvild/src/git/ops.ts` — prefer either
of those over hand-rolling `gh`. **A worktree can never check out `main`** (git forbids the same
branch in two worktrees); ending on `<branch>_followup` is correct and expected, not an error.

## Verifying before merge

Sessions run inside a **git worktree** under `~/.anvil/worktrees/<session-id>` (or
`.claude/worktrees/...`), branched off `main`. New worktrees get `node_modules` symlinked in from the
canonical checkout (`createWorktree`/`linkDeps` in `anvild/src/session/worktree.ts`), so you **can**
run a real typecheck in-worktree:

```bash
cd anvild && bunx tsc --noEmit       # types (also run `bun run typecheck:web` for web/ edits)
bun run build:web                    # web bundle
bun test                             # the suite
```

If `node_modules` is somehow missing (link failed, older worktree), fall back to the esbuild
syntax check and say so. Deploying the change (`anvild/scripts/service.sh restart`) still happens
on the **canonical checkout** — the daemon runs from there, not from the worktree.
