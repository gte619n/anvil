import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../../src/fleet/store";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-fleet-"));
}
const member = (id: string, host: string) => ({ serverId: id, serverName: id, host, url: `https://${host}:7701/` });

test("upsert adds, dedups by serverId AND host, and persists across reloads", () => {
  const dir = tmp();
  try {
    const f = new FleetStore(dir);
    f.upsert(member("srv_a", "a.ts.net"));
    f.upsert(member("srv_b", "b.ts.net"));
    expect(f.list().length).toBe(2);
    // same serverId → replace (rename host)
    f.upsert(member("srv_a", "a2.ts.net"));
    expect(f.list().filter((m) => m.serverId === "srv_a")).toHaveLength(1);
    expect(f.list().find((m) => m.serverId === "srv_a")?.host).toBe("a2.ts.net");
    // same host, different id → also dedups (re-paired box that got a new serverId)
    f.upsert(member("srv_c", "b.ts.net"));
    expect(f.list().filter((m) => m.host === "b.ts.net")).toHaveLength(1);

    // reload from disk
    const f2 = new FleetStore(dir);
    expect(f2.list().map((m) => m.serverId).sort()).toEqual(["srv_a", "srv_c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove drops by serverId", () => {
  const dir = tmp();
  try {
    const f = new FleetStore(dir);
    f.upsert(member("srv_a", "a.ts.net"));
    f.upsert(member("srv_b", "b.ts.net"));
    f.remove("srv_a");
    expect(f.list().map((m) => m.serverId)).toEqual(["srv_b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
