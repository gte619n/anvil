import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@protocol";
import { SERVER_CAPABILITIES, serverHelloEvent } from "./identity";

// server.hello advertises this build's capabilities so a newer client can skip commands an older
// member can't handle (instead of getting `unknown command type` back — the bug that surfaced as a
// random "unknown command type: 'autopilot.schedule.get'" toast from a stale fleet member). These
// assertions exist so a future refactor can't silently drop the field and resurrect that skew.
describe("serverHelloEvent", () => {
  const hello = serverHelloEvent({ serverId: "srv_test", serverName: "test-host" });

  test("carries the server identity and protocol/version envelope", () => {
    expect(hello.type).toBe("server.hello");
    expect(hello.serverId).toBe("srv_test");
    expect(hello.serverName).toBe("test-host");
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof hello.version).toBe("string");
  });

  test("advertises capabilities, including autopilot", () => {
    expect(Array.isArray(hello.capabilities)).toBe(true);
    expect(hello.capabilities).toContain("autopilot");
  });

  test("advertises the accounts capability", () => {
    expect(SERVER_CAPABILITIES).toContain("accounts");
  });

  test("the hello capabilities mirror SERVER_CAPABILITIES (the single source of truth)", () => {
    expect(hello.capabilities).toEqual([...SERVER_CAPABILITIES]);
  });

  test("emits a fresh capabilities array, not a shared reference to the constant", () => {
    // Defensive: clients/tests must not be able to mutate the module-level constant through a frame.
    expect(hello.capabilities).not.toBe(SERVER_CAPABILITIES);
  });
});

describe("serverHelloEvent role derivation", () => {
  const id = { serverId: "srv_test", serverName: "test-host" };

  test("role is standalone with no hub and no members", () => {
    const hello = serverHelloEvent(id, { pairedHubId: null, memberCount: 0 });
    expect(hello.role).toBe("standalone");
    expect(hello.hubServerId).toBeUndefined();
  });

  test("role is hub when it has members and no paired hub", () => {
    expect(serverHelloEvent(id, { pairedHubId: null, memberCount: 2 }).role).toBe("hub");
  });

  test("role is member when paired — even if it also holds members", () => {
    const hello = serverHelloEvent(id, { pairedHubId: "srv_hub", memberCount: 3 });
    expect(hello.role).toBe("member");
    expect(hello.hubServerId).toBe("srv_hub");
  });
});
