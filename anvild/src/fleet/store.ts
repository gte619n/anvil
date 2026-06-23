import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { rest } from "@protocol";

/**
 * The hub's record of the Macs it has paired into the fleet (anvil-server-app.md §6), persisted to
 * `<stateDir>/fleet.json`. This is the source of truth for *administration* (who gets a rotated
 * token) and is what the clients render in the Fleet UI. Distinct from discovery (who's reachable on
 * the tailnet right now) and from the client's session-connection registry.
 */
export class FleetStore {
  private readonly file: string;
  private members: rest.FleetMember[] = [];

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "fleet.json");
    this.load();
  }

  list(): rest.FleetMember[] {
    return [...this.members];
  }

  /** Add or update a member (keyed by serverId; also dedups by host). */
  upsert(m: rest.FleetMember): void {
    this.members = this.members.filter((x) => x.serverId !== m.serverId && x.host !== m.host);
    this.members.push(m);
    this.save();
  }

  remove(serverId: string): void {
    this.members = this.members.filter((m) => m.serverId !== serverId);
    this.save();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.members = (JSON.parse(readFileSync(this.file, "utf8")).members ?? []) as rest.FleetMember[];
    } catch {
      this.members = []; // corrupt — start empty
    }
  }
  private save(): void {
    writeFileSync(this.file, JSON.stringify({ members: this.members }, null, 2));
  }
}
