/**
 * [SEC-L1] `git worktree add -b <branch> <path> <base>` takes an agent/client-controlled `base` (and
 * branch = session name) as positional args. They're argv (no shell), but a leading-dash value can be
 * read as a git OPTION. Pin a ref-shape guard that rejects option-injection and obviously-bad refs
 * while allowing the real forms (main, origin/main, a SHA, feature/x).
 */
import { test, expect } from "bun:test";
import { assertSafeRef } from "../../src/session/worktree";

test("assertSafeRef accepts the real ref forms", () => {
  for (const ok of ["main", "origin/main", "feature/thing_1", "release-2.1", "0a1b2c3d", "HEAD"]) {
    expect(() => assertSafeRef(ok, "base")).not.toThrow();
  }
});

test("assertSafeRef rejects option-injection and malformed refs", () => {
  for (const bad of ["-b", "--upload-pack=x", "", "  ", "a b", "foo..bar", "with\tctrl", "back\\slash", "tilde~1", "caret^1", "colon:ref"]) {
    expect(() => assertSafeRef(bad, "base")).toThrow();
  }
});
