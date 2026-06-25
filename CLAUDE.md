# Working in this repo

Sessions run inside a **git worktree** under `~/.anvil/worktrees/<session-id>` (or
`.claude/worktrees/...`), branched off `main`. `main` itself is checked out by the canonical
clone at `~/Development/zellij-android`. Two worktree facts follow from that and cause most of
the end-of-session friction — handle them as below.

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

New worktrees get `node_modules` symlinked in from the canonical checkout
(`createWorktree`/`linkDeps` in `anvild/src/session/worktree.ts`), so you **can** run a real
typecheck in-worktree:

```bash
cd anvild && bunx tsc --noEmit       # types
bun run build:web                    # web bundle
```

If `node_modules` is somehow missing (link failed, older worktree), fall back to the esbuild
syntax check and say so. Deploying the change (`anvild/scripts/service.sh restart`) still happens
on the **canonical checkout** — the daemon runs from there, not from the worktree.
