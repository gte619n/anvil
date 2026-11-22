/**
 * Part-source keys (Phase C5, §4.14 item 36): entered in Settings, stored the way the OpenRouter key
 * is — a `NAME=value` line in the launcher env file (mode 0600), shown to clients only as a masked
 * preview — and pushed from the hub to members with the fleet's credentials.
 *
 * Unlike the OpenRouter key the values are NOT put in this process's environment: every read goes to
 * the file, so a key never reaches a child process through `process.env`, and two daemons in one test
 * process keep separate keys. (The launcher sources the file at start, so a key can still be in
 * `process.env`; `clear` removes it there too, and nothing here reads it.)
 */
import { envFileHasKey, readEnvKey, removeEnvLine, upsertEnvLine } from "../../auth/env-file";
import type { PartSourceId, PartSourceStatus } from "@protocol";

export interface PartKeyField {
  name: string;
  label: string;
}

/** Each source's fields, in the order Settings shows them. All are required for the source to be on. */
export const PART_KEY_FIELDS: Readonly<Record<PartSourceId, readonly PartKeyField[]>> = {
  digikey: [
    { name: "DIGIKEY_CLIENT_ID", label: "Client ID" },
    { name: "DIGIKEY_CLIENT_SECRET", label: "Client secret" },
  ],
  mouser: [{ name: "MOUSER_API_KEY", label: "Search API key" }],
  traceparts: [
    { name: "TRACEPARTS_TENANT_UID", label: "Tenant UID" },
    { name: "TRACEPARTS_API_KEY", label: "API key" },
    { name: "TRACEPARTS_EMAIL", label: "Request email" },
  ],
};

export const PART_SOURCE_LABELS: Readonly<Record<PartSourceId, string>> = { digikey: "DigiKey", mouser: "Mouser", traceparts: "TraceParts" };
export const PART_SOURCE_IDS: readonly PartSourceId[] = ["digikey", "mouser", "traceparts"];
export const ALL_PART_KEY_NAMES: readonly string[] = PART_SOURCE_IDS.flatMap((id) => PART_KEY_FIELDS[id].map((f) => f.name));

const NOTES: Readonly<Record<PartSourceId, string>> = {
  digikey: "Create an app with the Product Information v4 API at developer.digikey.com (client credentials). Limit: 120 calls a minute, 1000 a day.",
  mouser: "Request a Search API key at mouser.com/api-search. Limit: 30 calls a minute, 1000 a day.",
  traceparts: "TraceParts gives STEP models. Its API key is issued on request (it can take days); it stays off until the tenant UID, the API key AND the email that CAD requests are sent under are all entered.",
};

/**
 * The preview a client is shown: the last four characters only. (The OpenRouter key's `mask` shows
 * the first eight and the last four, which for a 16-character DigiKey secret would be most of it.)
 */
export function maskPartKey(value: string): string {
  const t = value.trim();
  return t.length >= 12 ? `••••${t.slice(-4)}` : "•".repeat(Math.max(4, t.length));
}

export function isPartSourceId(v: unknown): v is PartSourceId {
  return typeof v === "string" && (PART_SOURCE_IDS as readonly string[]).includes(v);
}

export class PartKeyStore {
  constructor(readonly file: string) {}

  get(name: string): string | undefined {
    const v = readEnvKey(this.file, name)?.trim();
    return v ? v : undefined;
  }

  /** The source's fields, name → value (unset ones absent). */
  values(source: PartSourceId): Record<string, string | undefined> {
    return Object.fromEntries(PART_KEY_FIELDS[source].map((f) => [f.name, this.get(f.name)]));
  }

  configured(source: PartSourceId): boolean {
    return PART_KEY_FIELDS[source].every((f) => !!this.get(f.name));
  }

  /**
   * Set some of a source's fields. Unknown names are refused (nothing is written); empty values are
   * skipped. Returns the names that were written.
   */
  set(source: PartSourceId, values: Readonly<Record<string, unknown>>): string[] {
    const known = new Map(PART_KEY_FIELDS[source].map((f) => [f.name, f]));
    const writes: [string, string][] = [];
    for (const [name, raw] of Object.entries(values ?? {})) {
      if (!known.has(name)) throw new Error(`${name} is not a ${PART_SOURCE_LABELS[source]} field`);
      if (typeof raw !== "string") throw new Error(`${known.get(name)!.label} must be text`);
      const v = raw.trim();
      if (!v) continue;
      if (/[\r\n\0]/.test(v)) throw new Error(`${known.get(name)!.label} cannot contain a line break`);
      if (name === "TRACEPARTS_EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error("Request email must be an email address");
      writes.push([name, v]);
    }
    for (const [name, v] of writes) upsertEnvLine(this.file, name, v);
    return writes.map(([n]) => n);
  }

  clear(source: PartSourceId): void {
    for (const f of PART_KEY_FIELDS[source]) {
      removeEnvLine(this.file, f.name);
      delete process.env[f.name];
    }
  }

  /** Every set field, for the hub's credential push. */
  fleetPayload(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of ALL_PART_KEY_NAMES) {
      const v = this.get(name);
      if (v) out[name] = v;
    }
    return out;
  }

  /** Adopt a hub's push: present known names overwrite, anything else is ignored. Returns what was written. */
  adopt(payload: unknown): string[] {
    if (!payload || typeof payload !== "object") return [];
    const written: string[] = [];
    for (const id of PART_SOURCE_IDS) {
      const mine: Record<string, unknown> = {};
      for (const f of PART_KEY_FIELDS[id]) {
        const v = (payload as Record<string, unknown>)[f.name];
        if (typeof v === "string" && v.trim()) mine[f.name] = v;
      }
      if (!Object.keys(mine).length) continue;
      try {
        written.push(...this.set(id, mine));
      } catch {
        /* a bad value from the hub is skipped, like a bad pushed OpenRouter key */
      }
    }
    return written;
  }

  status(source: PartSourceId): PartSourceStatus {
    const fields = PART_KEY_FIELDS[source].map((f) => {
      const v = this.get(f.name);
      return { name: f.name, label: f.label, set: !!v, ...(v ? { masked: maskPartKey(v) } : {}) };
    });
    const configured = fields.every((f) => f.set);
    return { id: source, label: PART_SOURCE_LABELS[source], configured, fields, note: NOTES[source] };
  }

  /** Whether the file carries any part-source line (for a quick "nothing to do"). */
  any(): boolean {
    return ALL_PART_KEY_NAMES.some((n) => envFileHasKey(this.file, n));
  }
}
