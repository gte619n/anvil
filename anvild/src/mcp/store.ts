import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpIntegration } from "@protocol";
import { newId } from "../util/ids";
import { mcpPreset } from "./presets";
import { MCP_INTEGRATION_KINDS, isStoredIntegration, keyProblem, normalizeTransport, transportProblem } from "./validate";

export type McpIntegrationInput = Omit<McpIntegration, "id">;
export type McpIntegrationFields = Partial<Omit<McpIntegration, "id" | "key" | "kind">>;

export const MCP_STORE_FILE = "mcp-integrations.json";
const MAX_LABEL = 60;

/**
 * Registry of the MCP integrations installed on THIS machine (mcp-integrations spec §4.2). Persisted
 * to `<stateDir>/mcp-integrations.json`; per machine, never hub-synced — an integration describes
 * software on one host. Follows `EnvironmentStore`, with one difference: a corrupt file is renamed to
 * `mcp-integrations.json.corrupt-<ts>` and the store starts empty, so the evidence survives.
 *
 * Every `add`/`update` is validated here; all three mutators throw a plain `Error` with a message fit
 * to show the operator.
 */
export class McpIntegrationStore {
  private readonly file: string;
  private integrations: McpIntegration[] = [];
  /** Set when load() had to quarantine a corrupt file — the path it was moved to. */
  quarantined: string | undefined;

  constructor(
    stateDir: string,
    private readonly clock: () => number = Date.now,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, MCP_STORE_FILE);
    this.load();
  }

  list(): McpIntegration[] {
    return this.integrations.map((i) => ({ ...i }));
  }
  get(id: string): McpIntegration | undefined {
    return this.integrations.find((i) => i.id === id);
  }
  byKey(key: string): McpIntegration | undefined {
    return this.integrations.find((i) => i.key === key);
  }

  /** @throws on a bad key (grammar, reserved, already used), unknown or unavailable kind, or a bad
   *  transport (non-loopback URL, empty command). */
  add(raw: McpIntegrationInput): McpIntegration {
    if (!raw || typeof raw !== "object") throw new Error("integration is required");
    const keyErr = keyProblem(raw.key);
    if (keyErr) throw new Error(keyErr);
    if (this.byKey(raw.key)) throw new Error(`key "${raw.key}" is already used by another integration`);
    if (!MCP_INTEGRATION_KINDS.includes(raw.kind)) throw new Error(`unknown integration kind: ${String(raw.kind)}`);
    if (!mcpPreset(raw.kind)) throw new Error(`the "${raw.kind}" integration is not available on this server`);
    const tErr = transportProblem(raw.transport);
    if (tErr) throw new Error(tErr);
    const integration: McpIntegration = {
      id: newId("mcpi"),
      key: raw.key,
      kind: raw.kind,
      label: cleanLabel(raw.label) || raw.key,
      transport: normalizeTransport(raw.transport),
      exclusive: raw.exclusive === true,
      enabled: raw.enabled !== false,
    };
    this.integrations.push(integration);
    this.save();
    return { ...integration };
  }

  /** `key` and `kind` are immutable (a new key means a new tool prefix: remove and re-add).
   *  @throws on an unknown id or a bad transport. */
  update(id: string, fields: McpIntegrationFields): McpIntegration {
    const i = this.get(id);
    if (!i) throw new Error(`no such integration: ${id}`);
    if (fields.transport !== undefined) {
      const tErr = transportProblem(fields.transport);
      if (tErr) throw new Error(tErr);
      i.transport = normalizeTransport(fields.transport);
    }
    if (fields.label !== undefined && cleanLabel(fields.label)) i.label = cleanLabel(fields.label);
    if (fields.exclusive !== undefined) i.exclusive = fields.exclusive === true;
    if (fields.enabled !== undefined) i.enabled = fields.enabled === true;
    this.save();
    return { ...i };
  }

  /** @returns whether an integration was removed. */
  remove(id: string): boolean {
    const before = this.integrations.length;
    this.integrations = this.integrations.filter((i) => i.id !== id);
    if (this.integrations.length === before) return false;
    this.save();
    return true;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { integrations?: unknown };
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.integrations)) throw new Error("expected { integrations: [...] }");
      const seenKeys = new Set<string>();
      const seenIds = new Set<string>();
      for (const raw of parsed.integrations) {
        // A structurally broken or duplicate row is dropped rather than poisoning the whole file.
        if (!isStoredIntegration(raw) || seenKeys.has(raw.key) || seenIds.has(raw.id)) {
          console.error(`[mcp] ignoring a malformed or duplicate entry in ${this.file}`);
          continue;
        }
        seenKeys.add(raw.key);
        seenIds.add(raw.id);
        this.integrations.push({ id: raw.id, key: raw.key, kind: raw.kind, label: raw.label, transport: raw.transport, exclusive: raw.exclusive, enabled: raw.enabled });
      }
    } catch (e) {
      const dest = `${this.file}.corrupt-${this.clock()}`;
      try {
        renameSync(this.file, dest);
        this.quarantined = dest;
      } catch {
        /* could not move it — still start empty; the next save overwrites it */
      }
      this.integrations = [];
      console.error(`[mcp] ${this.file} is corrupt (${e instanceof Error ? e.message : String(e)}); moved to ${dest} and starting with no integrations`);
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ integrations: this.integrations }, null, 2));
  }
}

function cleanLabel(label: unknown): string {
  return typeof label === "string" ? label.trim().slice(0, MAX_LABEL) : "";
}
