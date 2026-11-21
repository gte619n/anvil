import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@protocol";
import { SERVER_CAPABILITIES, serverCapabilities, serverHelloEvent } from "./identity";
import { FEATURE_CAPABILITIES } from "../config";

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

  test("[P0] advertises the autopilot-verify capability (completion-verification send-gate)", () => {
    expect(SERVER_CAPABILITIES).toContain("autopilot-verify");
    expect(hello.capabilities).toContain("autopilot-verify");
  });

  test("the hello capabilities mirror SERVER_CAPABILITIES (the single source of truth)", () => {
    expect(hello.capabilities).toEqual([...SERVER_CAPABILITIES]);
  });

  test("emits a fresh capabilities array, not a shared reference to the constant", () => {
    // Defensive: clients/tests must not be able to mutate the module-level constant through a frame.
    expect(hello.capabilities).not.toBe(SERVER_CAPABILITIES);
  });
});

// agent-cad-and-browser spec §4.8: the capability list is the pinned BASE list plus each opt-in
// feature ANVIL_FEATURES enabled. The base list is pinned verbatim so adding/removing a capability is
// always a deliberate, reviewed edit here — and so a feature flag can never leak in by default.
describe("serverCapabilities", () => {
  test("[F0] the base capability list is pinned", () => {
    expect([...SERVER_CAPABILITIES]).toEqual([
      "autopilot",
      "autopilot-maintenance",
      "auth",
      "prompts",
      "fleet-skills",
      "lapo",
      "pairing",
      "model-labels",
      "model-catalog",
      "claude-cli-update",
      "accounts",
      "gemini-sessions",
      "stable-update",
      "loops",
      "history",
      "shadow",
      "fleet-repo",
      "autopilot-verify",
    ]);
  });

  test("[F0] with no features it is exactly the base list, as a fresh array", () => {
    expect(serverCapabilities()).toEqual([...SERVER_CAPABILITIES]);
    expect(serverCapabilities([])).toEqual([...SERVER_CAPABILITIES]);
    expect(serverCapabilities()).not.toBe(SERVER_CAPABILITIES);
    for (const f of FEATURE_CAPABILITIES) expect(serverCapabilities()).not.toContain(f);
  });

  test("[F0] each enabled feature is appended after the base list, in canonical order", () => {
    for (const f of FEATURE_CAPABILITIES) {
      expect(serverCapabilities([f])).toEqual([...SERVER_CAPABILITIES, f]);
    }
    expect(serverCapabilities(["browser", "cad-work"])).toEqual([...SERVER_CAPABILITIES, "cad-work", "browser"]);
    expect(serverCapabilities([...FEATURE_CAPABILITIES])).toEqual([...SERVER_CAPABILITIES, ...FEATURE_CAPABILITIES]);
  });

  test("[F0] an unknown feature name is never advertised", () => {
    expect(serverCapabilities(["teleport", "cad-work"])).toEqual([...SERVER_CAPABILITIES, "cad-work"]);
  });

  test("[F0] server.hello advertises the enabled features through serverCapabilities", () => {
    const id = { serverId: "srv_test", serverName: "test-host" };
    const hello = serverHelloEvent(id, { pairedHubId: null, memberCount: 0 }, ["cad-work", "browser"]);
    expect(hello.capabilities).toEqual(serverCapabilities(["cad-work", "browser"]));
    expect(serverHelloEvent(id).capabilities).toEqual([...SERVER_CAPABILITIES]);
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
