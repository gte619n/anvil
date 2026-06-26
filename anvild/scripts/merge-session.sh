#!/usr/bin/env bash
#
# Worktree-safe PR merge for an anvil session (mirrors src/git/ops.ts `mergePr`).
#   ./scripts/merge-session.sh [--merge|--squash|--rebase]
#
# Run this from inside the session worktree you want to merge. Defaults to --squash.
#
# WHY THIS EXISTS (don't run `gh pr merge --delete-branch` by hand in a worktree):
# `gh pr merge --delete-branch` switches the local checkout to the default branch *before* it
# deletes the remote branch. In a git worktree the default branch is already checked out by the
# canonical clone, so that switch fails, gh aborts the cleanup, and you're left with (a) the
# worktree stranded on the merged branch and (b) the remote branch NOT deleted — exactly the
# "let me delete the remote branch manually" / "couldn't auto-switch to main" warnings.
#
# This script does the same end state without ever moving the checkout off-worktree:
#   1. gh pr merge (no --delete-branch)
#   2. fetch the merged default
#   3. delete the remote branch with a plain push (never touches the checkout)
#   4. roll the worktree onto a fresh <branch>_followup off origin/<default>
#   5. delete the merged branch locally
#
set -euo pipefail

method="--squash"
case "${1:-}" in
  --merge|--squash|--rebase) method="$1" ;;
  "") ;;
  *) echo "usage: $0 [--merge|--squash|--rebase]" >&2; exit 2 ;;
esac

branch="$(git branch --show-current)"
if [ -z "$branch" ]; then
  echo "error: detached HEAD — check out the session branch before merging." >&2
  exit 1
fi

# Resolve the remote default branch (e.g. main) from origin/HEAD.
default="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
if [ -z "$default" ]; then default="main"; fi

echo "→ merging PR for '$branch' ($method)…"
gh pr merge "$method"

echo "→ fetching origin…"
git fetch origin

echo "→ deleting remote branch 'origin/$branch'…"
git push origin --delete "$branch" || echo "  (remote branch already gone — skipping)"

# Pick a free <branch>_followup name.
followup="${branch}_followup"
i=2
while git rev-parse --verify --quiet "refs/heads/$followup" >/dev/null; do
  followup="${branch}_followup_$i"
  i=$((i + 1))
done

echo "→ rolling worktree onto '$followup' (off origin/$default)…"
if git checkout -b "$followup" "origin/$default"; then
  git branch -D "$branch" || true
  echo "✓ merged; worktree now on '$followup', local+remote '$branch' deleted."
else
  echo "⚠ merged + remote deleted, but couldn't roll onto '$followup' (uncommitted changes?)."
  echo "  Worktree stayed on '$branch' — commit/stash, then: git checkout -b $followup origin/$default"
fi
