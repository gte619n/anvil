/** [C5] Unit: part-source keys — stored in the env file like the OpenRouter key, masked, pushed. */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PART_KEY_FIELDS, PartKeyStore, maskPartKey } from "../../src/integrations/parts/keys";
import { KEYS, SECRET_VALUES } from "../helpers/parts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-c5-keys-"));
  file = join(dir, "env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PartKeyStore", () => {
  test("[C5] keys: DigiKey client id + secret, Mouser key, TraceParts tenant uid + key + email are NAME=value lines in the env file (0600), read at use time, never put in process.env", () => {
    expect(Object.fromEntries(Object.entries(PART_KEY_FIELDS).map(([k, v]) => [k, v.map((f) => f.name)]))).toEqual({
      digikey: ["DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET"],
      mouser: ["MOUSER_API_KEY"],
      traceparts: ["TRACEPARTS_TENANT_UID", "TRACEPARTS_API_KEY", "TRACEPARTS_EMAIL"],
    });
    const store = new PartKeyStore(file);
    expect(store.set("mouser", { MOUSER_API_KEY: ` ${KEYS.MOUSER_API_KEY} ` })).toEqual(["MOUSER_API_KEY"]);
    expect(readFileSync(file, "utf8")).toBe(`MOUSER_API_KEY=${KEYS.MOUSER_API_KEY}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(process.env.MOUSER_API_KEY).toBeUndefined();
    expect(new PartKeyStore(file).configured("mouser")).toBe(true);
    // A second store over the same file sees a change made by the first (no cached copy).
    store.set("digikey", { DIGIKEY_CLIENT_ID: KEYS.DIGIKEY_CLIENT_ID });
    expect(new PartKeyStore(file).configured("digikey")).toBe(false);
    store.set("digikey", { DIGIKEY_CLIENT_SECRET: KEYS.DIGIKEY_CLIENT_SECRET, DIGIKEY_CLIENT_ID: "" }); // empty = leave as is
    expect(store.values("digikey")).toEqual({ DIGIKEY_CLIENT_ID: KEYS.DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET: KEYS.DIGIKEY_CLIENT_SECRET });
    expect(() => store.set("mouser", { DIGIKEY_CLIENT_ID: "x" })).toThrow(/not a Mouser field/);
    expect(() => store.set("traceparts", { TRACEPARTS_EMAIL: "not-an-email" })).toThrow(/email address/);
    expect(() => store.set("mouser", { MOUSER_API_KEY: "a\nEVIL=1" })).toThrow(/line break/);
    store.clear("digikey");
    expect(store.configured("digikey")).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("DIGIKEY");
  });

  test("[C5] keys are masked to the last four characters in the status clients see; TraceParts is configured only with all three fields", () => {
    const store = new PartKeyStore(file);
    store.set("traceparts", { TRACEPARTS_TENANT_UID: KEYS.TRACEPARTS_TENANT_UID, TRACEPARTS_API_KEY: KEYS.TRACEPARTS_API_KEY });
    const st = store.status("traceparts");
    expect(st).toMatchObject({ id: "traceparts", label: "TraceParts", configured: false });
    expect(st.fields).toEqual([
      { name: "TRACEPARTS_TENANT_UID", label: "Tenant UID", set: true, masked: "••••3e4f" },
      { name: "TRACEPARTS_API_KEY", label: "API key", set: true, masked: "••••TSRQ" },
      { name: "TRACEPARTS_EMAIL", label: "Request email", set: false },
    ]);
    expect(st.note).toMatch(/stays off until the tenant UID, the API key AND the email/);
    store.set("traceparts", { TRACEPARTS_EMAIL: KEYS.TRACEPARTS_EMAIL });
    expect(store.status("traceparts").configured).toBe(true);
    expect(maskPartKey("short")).toBe("•••••");
    const text = JSON.stringify(["digikey", "mouser", "traceparts"].map((id) => store.status(id as never)));
    for (const s of SECRET_VALUES) expect(text).not.toContain(s);
  });

  test("[C5] the hub's push payload carries every set key; a member adopts known names only (present keys overwrite, unknown names and bad values are ignored)", () => {
    const hub = new PartKeyStore(file);
    hub.set("mouser", { MOUSER_API_KEY: KEYS.MOUSER_API_KEY });
    hub.set("digikey", { DIGIKEY_CLIENT_ID: KEYS.DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET: KEYS.DIGIKEY_CLIENT_SECRET });
    expect(hub.fleetPayload()).toEqual({ DIGIKEY_CLIENT_ID: KEYS.DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET: KEYS.DIGIKEY_CLIENT_SECRET, MOUSER_API_KEY: KEYS.MOUSER_API_KEY });
    const member = new PartKeyStore(join(dir, "member-env"));
    member.set("mouser", { MOUSER_API_KEY: "old-member-key-0000" });
    member.set("traceparts", { TRACEPARTS_EMAIL: "keep@example.test" });
    expect(member.adopt({ ...hub.fleetPayload(), PATH: "/evil", TRACEPARTS_EMAIL: "bad" }).sort()).toEqual(["DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET", "MOUSER_API_KEY"]);
    expect(member.get("MOUSER_API_KEY")).toBe(KEYS.MOUSER_API_KEY);
    expect(member.get("TRACEPARTS_EMAIL")).toBe("keep@example.test");
    expect(readFileSync(join(dir, "member-env"), "utf8")).not.toContain("PATH=");
    expect(member.adopt(null)).toEqual([]);
  });
});
