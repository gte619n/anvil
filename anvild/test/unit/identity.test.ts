import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { loadServerIdentity, serverHelloEvent } from "../../src/server/identity";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-id-"));
}

test("serverId is generated once and stays stable across reloads (daemon restart)", () => {
  const dir = tmp();
  try {
    const a = loadServerIdentity(dir, {});
    expect(a.serverId).toMatch(/^srv_/);
    const b = loadServerIdentity(dir, {}); // simulates a restart against the same state dir
    expect(b.serverId).toBe(a.serverId); // load-bearing: clients key the server by this
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serverName is ANVIL_SERVER_NAME when set, else the hostname", () => {
  const dir = tmp();
  try {
    expect(loadServerIdentity(dir, { ANVIL_SERVER_NAME: "build-box" }).serverName).toBe("build-box");
    expect(loadServerIdentity(dir, { ANVIL_SERVER_NAME: "  " }).serverName).toBe(hostname()); // blank → hostname
    expect(loadServerIdentity(dir, {}).serverName).toBe(hostname());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blank/corrupt server-id file is regenerated, not trusted", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "server-id"), "   \n");
    const id = loadServerIdentity(dir, {});
    expect(id.serverId).toMatch(/^srv_/);
    expect(readFileSync(join(dir, "server-id"), "utf8").trim()).toBe(id.serverId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serverHelloEvent carries the identity + protocol version", () => {
  const ev = serverHelloEvent({ serverId: "srv_x", serverName: "mac-mini" });
  expect(ev.type).toBe("server.hello");
  expect(ev.serverId).toBe("srv_x");
  expect(ev.serverName).toBe("mac-mini");
  expect(typeof ev.version).toBe("string");
  expect(ev.protocolVersion).toBe(ev.v);
});
