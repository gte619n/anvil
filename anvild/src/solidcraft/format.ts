/**
 * The design-format check Anvil enforces itself (agent-cad-and-browser spec §4.14 item 18, §7 row
 * "Script written by a newer format").
 *
 * SolidCraft does not check `about.format` on a script: a format-58 script runs under a build that
 * only knows format 48 and fails, if at all, on some unrelated step. So before a `design.json` is
 * replayed, the daemon compares its format number with the local build's and refuses a newer one in
 * words a person can act on.
 *
 * Pure and dependency-free. The local build's number is read by the CAD process manager (it owns
 * the SolidCraft client) by exporting an empty design; `localFormatNumber` caches that per version.
 */

export const OLDER_BUILD_MESSAGE = "this machine's SolidCraft is older than the design";

/** `"solidcraft/58"` → 58. Undefined when the script carries no readable format. */
export function scriptFormatNumber(script: unknown): number | undefined {
  const about = (script as { about?: { format?: unknown } } | null)?.about;
  const m = typeof about?.format === "string" ? about.format.match(/^solidcraft\/(\d+)$/) : null;
  return m ? Number(m[1]) : undefined;
}

export type FormatCheck = { ok: true } | { ok: false; error: string };

/**
 * May a build that reads formats up to `localFormat` replay this script? A script with no format
 * passes (older exports had none); a script from a newer format is refused.
 */
export function checkScriptFormat(script: unknown, localFormat: number, localVersion?: string): FormatCheck {
  const n = scriptFormatNumber(script);
  if (n === undefined || n <= localFormat) return { ok: true };
  const build = localVersion ? `SolidCraft ${localVersion}` : "the local SolidCraft";
  return { ok: false, error: `${OLDER_BUILD_MESSAGE} (the design is format ${n}; ${build} reads up to ${localFormat})` };
}

const formatByVersion = new Map<string, Promise<number>>();

/**
 * The format number of build `version`, read at most once per version by `read` (which exports an
 * empty design and returns its `about.format` number). A failed read is not cached.
 */
export function localFormatNumber(version: string, read: () => Promise<number>): Promise<number> {
  let p = formatByVersion.get(version);
  if (!p) {
    p = read();
    formatByVersion.set(version, p);
    p.catch(() => formatByVersion.delete(version));
  }
  return p;
}

/** Test seam: forget every cached format number. */
export function resetFormatCache(): void {
  formatByVersion.clear();
}
