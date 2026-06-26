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

  test("the hello capabilities mirror SERVER_CAPABILITIES (the single source of truth)", () => {
    expect(hello.capabilities).toEqual([...SERVER_CAPABILITIES]);
  });

  test("emits a fresh capabilities array, not a shared reference to the constant", () => {
    // Defensive: clients/tests must not be able to mutate the module-level constant through a frame.
    expect(hello.capabilities).not.toBe(SERVER_CAPABILITIES);
  });
});
