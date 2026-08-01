/**
 * [stable-update-service Phase 4 / D15] The self-bootstrapping migration guard. Pins: the watchdog unit
 * path per service manager, "arm only when managed AND the unit is missing" (the one-time hop), and that
 * an unmanaged/dev daemon never tries to arm.
 */
import { test, expect } from "bun:test";
import { watchdogUnitPath, needsArming, armWatchdog } from "../../src/daemon/updater/arm";

test("resolves the watchdog unit path per service manager", () => {
  expect(watchdogUnitPath("launchd", "/home/u")).toBe("/home/u/Library/LaunchAgents/com.anvil.anvil-updater.plist");
  expect(watchdogUnitPath("systemd", "/home/u")).toBe("/home/u/.config/systemd/user/com.anvil.anvil-updater.service");
  expect(watchdogUnitPath(null, "/home/u")).toBeNull();
});

test("needsArming is true only when managed and the unit is absent", () => {
  const absent = () => false;
  const present = () => true;
  expect(needsArming("launchd", "/home/u", absent)).toBe(true); // migration hop
  expect(needsArming("launchd", "/home/u", present)).toBe(false); // already armed
  expect(needsArming(null, "/home/u", absent)).toBe(false); // unmanaged (dev) — never arms
});

test("armWatchdog spawns service.sh install-updater exactly on the migration hop", () => {
  const spawns: string[][] = [];
  const spawn = (cmd: string[]) => spawns.push(cmd);

  // Managed + unit missing + script present → arms once.
  const armed = armWatchdog({ mgr: "launchd", home: "/home/u", exists: () => true /* unit? no; script? yes */ });
  // exists:()=>true makes needsArming false (unit "present"), so use a smarter stub:
  expect(armed).toBe(false);

  const existsUnitMissing = (p: string) => p.endsWith("service.sh"); // script exists, unit does not
  const didArm = armWatchdog({ mgr: "systemd", home: "/home/u", exists: existsUnitMissing, spawn, log: () => {} });
  expect(didArm).toBe(true);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.join(" ")).toMatch(/service\.sh install-updater$/);
});

test("armWatchdog is a no-op when unmanaged", () => {
  const spawns: string[][] = [];
  const didArm = armWatchdog({ mgr: null, home: "/home/u", exists: () => false, spawn: (c) => spawns.push(c) });
  expect(didArm).toBe(false);
  expect(spawns).toHaveLength(0);
});
