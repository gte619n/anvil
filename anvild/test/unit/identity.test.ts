import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { loadServerIdentity, sanitizeHostname, serverHelloEvent } from "../../src/server/identity";

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

test("sanitizeHostname passes clean hostnames through and rescues mojibake", () => {
  expect(sanitizeHostname("Mac-Mini-M1.oxos.lan")).toBe("Mac-Mini-M1.oxos.lan"); // real hostname untouched
  expect(sanitizeHostname("mac-mini-m4")).toBe("mac-mini-m4");
  expect(sanitizeHostname("  build_box.local  ")).toBe("build_box.local"); // trimmed, valid charset kept
  expect(sanitizeHostname("mac mini")).toBe("mac-mini"); // non-ascii separator → salvaged, still readable
  expect(sanitizeHostname("M1é")).toBe("M1"); // trailing non-ascii dropped
  expect(sanitizeHostname("à®ÌU")).toBe("anvil-server"); // the reported garbage has no salvageable run → generic label
  expect(sanitizeHostname("®®")).toBe("anvil-server"); // nothing salvageable → stable generic label
  expect(sanitizeHostname("")).toBe(""); // empty stays empty (caller falls back)
});

test("a corrupt hostname never reaches serverName, but ANVIL_SERVER_NAME overrides unsanitized", () => {
  const dir = tmp();
  try {
    // Explicit override is trusted as-is (may be intentionally non-ascii).
    expect(loadServerIdentity(dir, { ANVIL_SERVER_NAME: "Évan's Mac" }).serverName).toBe("Évan's Mac");
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
