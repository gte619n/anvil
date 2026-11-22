/**
 * Which `solidcraft-cli` binary the daemon runs (agent-cad-and-browser spec §4.2, §4.10).
 *
 * Resolution precedence (highest first):
 *   1. `ANVIL_SOLIDCRAFT_CLI` env — an explicit override (tests point this at the fake server).
 *   2. A **managed** build installed under the daemon state dir by the fleet pin (Track B). Primed
 *      by `setManagedSolidcraftCli()` at boot and again whenever the pin changes.
 *   3. The app bundle a person installed, `/Applications/SolidCraft.app` — how Track A works
 *      before the pin exists.
 *
 * This module is the one seam between the CAD process manager (Track A) and the install/pin code
 * (Track B). Keep it dependency-free.
 */
import { existsSync } from "node:fs";

export const APP_BUNDLE_SOLIDCRAFT_CLI = "/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli";

export interface ManagedSolidcraft {
  path: string;
  version: string;
}

let managed: ManagedSolidcraft | undefined;

/** Point the daemon at a managed build (or clear it with `undefined` to fall back). */
export function setManagedSolidcraftCli(m: ManagedSolidcraft | undefined): void {
  managed = m && m.path.trim() ? { path: m.path.trim(), version: m.version } : undefined;
}

/** The managed build currently in effect, if any. */
export function currentManagedSolidcraft(): ManagedSolidcraft | undefined {
  return managed;
}

export type SolidcraftSource = "env" | "managed" | "app";

export interface ResolvedSolidcraft {
  path: string;
  source: SolidcraftSource;
  /** Known only for a managed build; other sources are asked with `--version` by the caller. */
  version?: string;
}

/** The binary to run, or `undefined` when none is available on this machine. */
export function resolveSolidcraftCli(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): ResolvedSolidcraft | undefined {
  const override = env.ANVIL_SOLIDCRAFT_CLI?.trim();
  if (override) return { path: override, source: "env" };
  if (managed) return { path: managed.path, source: "managed", version: managed.version };
  if (exists(APP_BUNDLE_SOLIDCRAFT_CLI)) return { path: APP_BUNDLE_SOLIDCRAFT_CLI, source: "app" };
  return undefined;
}
