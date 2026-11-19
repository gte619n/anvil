/**
 * Track A ↔ Track B wiring for the fleet's SolidCraft pin (merge item (b); spec §4.8, §4.10;
 * decision 40). Kept out of cadwork-service.ts so each side stays small:
 *
 *  - availability: `cad.status` and every `anvil_cad` refusal follow `SolidcraftPinService
 *    .availability()` — a machine off the pin is `{available:false, reason}`;
 *  - on a pin change (any status change of the pin service) `cad.status` is refreshed and, when the
 *    build this machine runs actually changed, every live part is rebuilt from design.json under the
 *    new build, so its refresh rewrites `measured.solidcraft`;
 *  - "Pin back" warning list: the designs whose `measured.solidcraft` is a given version, read from
 *    the part files of every repo and worktree this daemon knows.
 */
import { join } from "node:path";
import type { SolidcraftRewrittenDesign } from "@protocol";
import { listParts } from "../cadwork/partfolder";
import { readPartFile } from "../cadwork/partfile";
import type { CadworkService } from "./cadwork-service";

export interface CadPinRoot {
  /** A repo checkout or session worktree (its `cad/` folder is read). */
  path: string;
  environment?: string;
}

export interface CadPinWiring {
  /** Call whenever the pin service reports a change. Resolves when cad.status is current. */
  onPinChanged(): Promise<void>;
  /** For `mountSolidcraft({ rewrittenDesigns })`. */
  rewrittenDesigns(version: string): SolidcraftRewrittenDesign[];
}

export function wireCadPin(o: {
  cadwork: CadworkService;
  pin: { availability(): Promise<{ available: boolean; reason?: string; pinned?: string }> };
  roots: () => CadPinRoot[];
  serverName?: string;
}): CadPinWiring {
  o.cadwork.setPinSource(() => o.pin.availability());
  let lastVersion: string | undefined;
  let lastAvailable: boolean | undefined;
  const onPinChanged = async (): Promise<void> => {
    const s = await o.cadwork.refreshStatus(); // broadcasts cad.status when it changed
    const moved = lastAvailable !== undefined && s.available && (s.version !== lastVersion || lastAvailable === false);
    lastVersion = s.version;
    lastAvailable = s.available;
    if (!moved) return;
    // The build changed under live parts: restart each from design.json (in its own queue), so the
    // refresh that follows measures under the new build and rewrites measured.solidcraft.
    await Promise.all(o.cadwork.liveParts().map((ref) => o.cadwork.manager.reload(ref).catch(() => undefined)));
  };
  const rewrittenDesigns = (version: string): SolidcraftRewrittenDesign[] => {
    const out: SolidcraftRewrittenDesign[] = [];
    const seen = new Set<string>();
    for (const root of o.roots()) {
      let parts: string[];
      try {
        parts = listParts(root.path);
      } catch {
        continue;
      }
      for (const part of parts) {
        const path = join(root.path, "cad", part);
        if (seen.has(path)) continue;
        seen.add(path);
        const read = readPartFile(path);
        if (read.kind === "ok" && read.file.measured?.solidcraft === version) {
          out.push({ part, version, path, ...(root.environment ? { environment: root.environment } : {}), ...(o.serverName ? { serverName: o.serverName } : {}) });
        }
      }
    }
    return out;
  };
  return { onPinChanged, rewrittenDesigns };
}
