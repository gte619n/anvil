/**
 * [BE2-33] Shared short-SHA comparison for the update surface. This logic was triplicated verbatim
 * across selfupdate.ts, update-api.ts, and updater/watchdog.ts — and the bare `startsWith` prefix match
 * meant a 1-char (or empty-after-guard) SHA could match anything, which on the update/rollback path is a
 * correctness hazard (a truncated/garbage SHA reported as "same commit" adopts the wrong build as
 * known-good). One dep-free module, plus a minimum-length guard so only a plausibly-abbreviated SHA is
 * ever considered a prefix. Kept intentionally tiny and import-free so the out-of-process watchdog can
 * use it without pulling in the daemon.
 */

/** Git's default abbreviated SHA is 7 hex chars; require at least this many before a prefix match is
 *  trusted, so a stray short/garbage value can't collide with an arbitrary commit. */
const MIN_SHA_LEN = 7;

/** Whether two abbreviated SHAs refer to the same commit (either may be the shorter abbreviation).
 *  Both must be non-empty AND at least MIN_SHA_LEN long for the prefix comparison to be trusted. */
export function shaMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.length < MIN_SHA_LEN || b.length < MIN_SHA_LEN) return a === b; // too short to trust a prefix → exact only
  return a.startsWith(b) || b.startsWith(a);
}

/** Extract the short SHA from a `MAJOR.MINOR+<sha>` version string (the part after `+`); the whole
 *  string when there's no `+`, empty for undefined. Shared by the daemon and the watchdog. */
export function shaOf(version: string | undefined): string {
  if (!version) return "";
  const i = version.indexOf("+");
  return i >= 0 ? version.slice(i + 1) : version;
}
