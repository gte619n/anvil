/**
 * Loop scope guard (loops-circuit spec §4.2, §7 "gamed spec"). Pure + deterministic: given the files a
 * lap touched (`git diff --name-only`, repo-relative), the loop's `scope.allow` globs, and the union of
 * every check's `locks`, decide whether the lap stayed in bounds.
 *
 * Two independent walls, checked in priority order so the more serious verdict wins:
 *   1. check-tampering — the lap edited one of its own check inputs (a locked glob). This is how an
 *      agent could "grade its own homework"; it's the worst failure, so it's reported first.
 *   2. scope-violation — the lap touched a file outside `scope.allow` (when a scope is set).
 * No scope set → only the lock wall applies (an unbounded loop can still not touch its check inputs).
 */
export type ScopeVerdict = "ok" | "scope-violation" | "check-tampering";
export interface ScopeResult {
  verdict: ScopeVerdict;
  offending: string[]; // the files that tripped the wall (for the lap detail)
}

/**
 * Match a repo-relative path against a glob. Supports `**` (any path segments incl. `/`), `*` (any run of
 * non-`/` chars), and `?` (one non-`/` char). A bare directory glob like `src/upload/` (trailing slash)
 * or `src/upload` matches everything under it. Anchored at both ends.
 */
export function globMatch(glob: string, path: string): boolean {
  let g = glob.trim();
  if (g === "" ) return false;
  if (g === "*" || g === "**" || g === "**/*") return true;
  // A directory prefix (trailing slash, or a plain path with no glob metachars) matches the whole subtree.
  if (g.endsWith("/")) g = g + "**";
  else if (!/[*?]/.test(g)) g = g + "/**"; // "src/upload" → its subtree ... but also match the file itself
  const re = globToRegExp(g);
  if (re.test(path)) return true;
  // Also let a plain path glob match the exact file (so "src/a.ts" matches "src/a.ts", not just under it).
  if (!/[*?]/.test(glob.trim())) return glob.trim().replace(/\/+$/, "") === path;
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // `**/` → any leading path segments (incl. none), so `**/x` matches `x` and `a/b/x`.
          i++;
          re += "(?:.*/)?";
        } else {
          // a trailing/standalone `**` → any chars including `/` (e.g. `src/**` matches `src/a/b.ts`).
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Does any glob in `globs` match `path`? */
export function anyGlobMatches(globs: string[], path: string): boolean {
  for (const g of globs) if (globMatch(g, path)) return true;
  return false;
}

/**
 * Evaluate a lap's diff against the scope + check locks.
 * @param diffFiles repo-relative paths the lap touched
 * @param allow     scope.allow globs (undefined/empty = no scope wall)
 * @param locks     union of every check's `locks` globs
 */
export function evaluateScope(diffFiles: string[], allow: string[] | undefined, locks: string[]): ScopeResult {
  // 1. check-tampering wins (most serious).
  const tampered = diffFiles.filter((f) => anyGlobMatches(locks, f));
  if (tampered.length) return { verdict: "check-tampering", offending: tampered };
  // 2. scope-violation (only when a scope is declared).
  if (allow && allow.length) {
    const outside = diffFiles.filter((f) => !anyGlobMatches(allow, f));
    if (outside.length) return { verdict: "scope-violation", offending: outside };
  }
  return { verdict: "ok", offending: [] };
}
