import { test, expect, afterEach } from "bun:test";
import { isManaged, serviceManager } from "../../src/daemon/selfupdate";

// serviceManager()/isManaged() read ANVIL_MANAGED, which the launcher (scripts/service.sh) sets to
// "launchd" on macOS and "systemd" on Linux. Restore the ambient value after each case so tests
// don't leak env state into the rest of the suite.
const original = process.env.ANVIL_MANAGED;
afterEach(() => {
  if (original === undefined) delete process.env.ANVIL_MANAGED;
  else process.env.ANVIL_MANAGED = original;
});

test("serviceManager recognises launchd (macOS)", () => {
  process.env.ANVIL_MANAGED = "launchd";
  expect(serviceManager()).toBe("launchd");
  expect(isManaged()).toBe(true);
});

test("serviceManager recognises systemd (Linux)", () => {
  process.env.ANVIL_MANAGED = "systemd";
  expect(serviceManager()).toBe("systemd");
  expect(isManaged()).toBe(true);
});

test("unmanaged (bun dev) is not restartable", () => {
  delete process.env.ANVIL_MANAGED;
  expect(serviceManager()).toBeNull();
  expect(isManaged()).toBe(false);
});

test("an unknown ANVIL_MANAGED value is treated as unmanaged", () => {
  process.env.ANVIL_MANAGED = "supervisord";
  expect(serviceManager()).toBeNull();
  expect(isManaged()).toBe(false);
});
