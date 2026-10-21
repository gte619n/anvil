import { describe, expect, test } from "bun:test";
import { ADB_PIN_PORT, ANDROID_APP_ID, adbCandidatePaths, adbTarget, connectedOk, grantOk, parseDeviceState, platformToolsUrl, summarizeAuto } from "./adb";

// These guard the string/URL/parsing logic the ADB passthrough depends on — the parts that are easy
// to get subtly wrong (adb connect exits 0 even when it failed; get-state phrasing varies) and that
// can't be exercised without a phone + adb on the box.

describe("adbTarget", () => {
  test("joins host:port", () => expect(adbTarget("100.64.0.1", 5555)).toBe("100.64.0.1:5555"));
  test("brackets IPv6 literals", () => expect(adbTarget("fd7a::1", 5555)).toBe("[fd7a::1]:5555"));
});

describe("connectedOk", () => {
  // adb exits 0 on all of these — success has to be read from the message, not the exit code.
  test("accepts a fresh connect", () => expect(connectedOk("connected to 100.64.0.1:5555")).toBe(true));
  test("accepts an already-connected", () => expect(connectedOk("already connected to 100.64.0.1:5555")).toBe(true));
  test("rejects cannot connect", () => expect(connectedOk("cannot connect to 100.64.0.1:5555: Connection refused")).toBe(false));
  test("rejects failed to connect", () => expect(connectedOk("failed to connect to 100.64.0.1:5555")).toBe(false));
  test("rejects empty", () => expect(connectedOk("(no output)")).toBe(false));
});

describe("parseDeviceState", () => {
  test("device = ready", () => expect(parseDeviceState("device")).toBe("device"));
  test("unauthorized = needs the Allow tap", () => expect(parseDeviceState("unauthorized\n")).toBe("unauthorized"));
  test("offline mid-handshake", () => expect(parseDeviceState("offline")).toBe("offline"));
  test("error text → unknown", () => expect(parseDeviceState("error: no devices/emulators found")).toBe("unknown"));
});

describe("platformToolsUrl", () => {
  test("darwin", () => expect(platformToolsUrl("darwin")).toContain("platform-tools-latest-darwin.zip"));
  test("linux", () => expect(platformToolsUrl("linux")).toContain("platform-tools-latest-linux.zip"));
  test("win32 → windows", () => expect(platformToolsUrl("win32")).toContain("platform-tools-latest-windows.zip"));
  test("unsupported → null", () => expect(platformToolsUrl("aix")).toBeNull());
  test("downloads from Google's official host", () => expect(platformToolsUrl("linux")).toStartWith("https://dl.google.com/"));
});

describe("adbCandidatePaths", () => {
  const paths = adbCandidatePaths("/home/anvil");
  test("includes Homebrew", () => expect(paths).toContain("/opt/homebrew/bin/adb"));
  test("includes the self-install dir", () => expect(paths).toContain("/home/anvil/.anvil/platform-tools/adb"));
  test("includes the Android SDK default", () => expect(paths.some((p) => p.includes("Android/Sdk/platform-tools/adb"))).toBe(true));
});

describe("summarizeAuto", () => {
  test("ready + persistent says reboot-proof", () => {
    const s = summarizeAuto("100.64.0.1:5555", "device", true);
    expect(s).toContain("debugging ready");
    expect(s).toContain("across reboots");
  });
  test("ready + non-persistent says until reboot", () => {
    expect(summarizeAuto("100.64.0.1:5555", "device", false)).toContain("until the phone reboots");
  });
  test("ready + self-toggle says reopening the app recovers", () => {
    const s = summarizeAuto("100.64.0.1:5555", "device", false, true);
    expect(s).toContain("debugging ready");
    expect(s).toContain("re-enables Wireless debugging");
  });
  test("unauthorized points the user at the Allow prompt", () => {
    expect(summarizeAuto("100.64.0.1:5555", "unauthorized", false)).toContain("Allow debugging");
  });
});

describe("grantOk", () => {
  // `pm grant` exits 0 and prints nothing on success; failures print a one-line exception.
  test("silent success", () => expect(grantOk({ ok: true, output: "(no output)", code: 0 })).toBe(true));
  test("unknown permission (old APK without the manifest entry)", () => {
    expect(grantOk({ ok: false, output: "java.lang.IllegalArgumentException: Unknown permission: android.permission.WRITE_SECURE_SETTINGS", code: 255 })).toBe(false);
  });
  test("exit 0 but exception text still fails", () => {
    expect(grantOk({ ok: true, output: "java.lang.SecurityException: Permission android.permission.WRITE_SECURE_SETTINGS is not a changeable permission type", code: 0 })).toBe(false);
  });
});

describe("ANDROID_APP_ID", () => {
  test("matches the app's applicationId", () => expect(ANDROID_APP_ID).toBe("com.gte619n.anvil"));
});

describe("ADB_PIN_PORT", () => {
  test("is the legacy tcpip port", () => expect(ADB_PIN_PORT).toBe(5555));
});
