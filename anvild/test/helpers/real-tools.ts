/**
 * Real-tool test helpers (agent-cad-and-browser spec §8.3). Tests under test/real/ drive the REAL
 * SolidCraft / Chrome on the machine and so must be skipped everywhere except a deliberate run:
 *
 *   test.skipIf(!REAL)("…", async () => { … });
 *
 * `REAL` is on only with `ANVIL_REAL_TOOLS=1` (set by `phase-gate <phase> --require-real`, which then
 * fails on any skip). See test/real/README.md.
 */
import { existsSync } from "node:fs";

/** True only in a deliberate real-tool run (`ANVIL_REAL_TOOLS` set to anything non-empty). */
export const REAL = !!process.env.ANVIL_REAL_TOOLS;

/** The SolidCraft CLI to drive: `ANVIL_SOLIDCRAFT_CLI` if set, else the app bundle's binary. */
export const SOLIDCRAFT_CLI = process.env.ANVIL_SOLIDCRAFT_CLI || "/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli";

/** Whether that binary is present on this machine. */
export function hasSolidcraft(): boolean {
  return existsSync(SOLIDCRAFT_CLI);
}
