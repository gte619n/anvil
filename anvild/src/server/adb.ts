// ── ADB over Tailscale (Android debugging passthrough) ────────────────────────────────────────────
// The Android client runs the app being debugged; this (possibly headless) server runs `adb` and
// reaches the phone over the tailnet. The flow:
//   • pair  — one-time Android-11 wireless-debugging handshake (6-digit code), so `adb connect` works
//   • auto  — connect, then `tcpip 5555` to PIN adbd to a stable port (legacy RSA trust, so the phone
//             trusts this server after a single "Allow debugging?" tap), and best-effort set
//             `persist.adb.tcp.port` so the pin survives a reboot
//   • install — fetch Google's official platform-tools so a box with nothing but Anvil can still run adb
// All interactive steps (pairing code, Allow prompt) happen ON THE PHONE; the server side is pure CLI,
// so this works on a headless server.

import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// [BE-14] adb calls reach out over the network and can hang for seconds. Every spawn carries a
// timeout so a wedged adb can't freeze the single-threaded daemon (and every other client).
const ADB_TIMEOUT_MS = 15_000;

/** The fixed port we pin adbd to via legacy `adb tcpip`, so reconnects don't have to chase the
 *  phone's random wireless-debugging port. The pin lasts until the phone reboots (unless
 *  `persist.adb.tcp.port` sticks); once the phone has shown its one-time "Allow debugging?" prompt the
 *  server is RSA-trusted, independent of wifi pairing. */
export const ADB_PIN_PORT = 5555;

/** `adb connect`/`pair` want `host:port`; bracket an IPv6 literal. */
export const adbTarget = (host: string, port: number): string => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

/** Where `adb install` drops Google's platform-tools (no admin rights, works headless). */
export const adbSelfInstallDir = (): string => join(process.env.HOME ?? "", ".anvil", "platform-tools");

/** Candidate adb locations in priority order, after PATH. Pure (home injected) so it's unit-testable. */
export function adbCandidatePaths(home: string): string[] {
  return [
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    join(home, "Library/Android/sdk/platform-tools/adb"),
    join(home, "Android/Sdk/platform-tools/adb"),
    join(home, ".anvil/platform-tools/adb"),
  ];
}

/** Resolve the `adb` binary: PATH first, then the common SDK locations and our self-installed copy.
 *  Returns null when adb isn't present anywhere — the caller surfaces an install hint. */
export function findAdb(): string | null {
  const onPath = Bun.which("adb");
  if (onPath) return onPath;
  return adbCandidatePaths(process.env.HOME ?? "").find((c) => existsSync(c)) ?? null;
}

/** The platform-tools zip URL for a Node platform, or null if Google ships no prebuilt for it. Pure. */
export function platformToolsUrl(platform: NodeJS.Platform): string | null {
  const key = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  return key ? `https://dl.google.com/android/repository/platform-tools-latest-${key}.zip` : null;
}

export interface AdbRun {
  ok: boolean; // process exited 0 — NOTE: `adb connect` exits 0 even on failure, so use connectedOk()
  output: string;
  code: number | null;
}

/** Run `adb` (resolved via findAdb) with a hard timeout; returns combined stdout+stderr and exit code. */
export async function runAdb(args: string[]): Promise<AdbRun> {
  const adb = findAdb();
  if (!adb) return { ok: false, output: "adb not found on the server (install Android platform-tools)", code: null };
  try {
    const p = Bun.spawn([adb, ...args], { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(ADB_TIMEOUT_MS) });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    const output = `${out}${err}`.trim();
    return { ok: p.exitCode === 0, output: output || "(no output)", code: p.exitCode };
  } catch (e) {
    return { ok: false, output: `adb failed to run: ${(e as Error).message}`, code: null };
  }
}

/** `adb connect` exits 0 even when it couldn't connect ("cannot connect to ..."), so success has to be
 *  read from the message, not the exit code. Pure, so it's unit-tested against real adb phrasings. */
export function connectedOk(output: string): boolean {
  return /connected to/i.test(output) && !/failed|cannot|unable|refused|timed out|no route/i.test(output);
}

/** Normalize `adb get-state` into one of the transport states (device = ready to debug;
 *  unauthorized = the phone still needs the "Allow debugging?" tap; offline = mid-handshake). Pure. */
export function parseDeviceState(output: string): string {
  // Whole-word match so an error like "no devices/emulators found" isn't misread as state "device".
  const m = output.toLowerCase().match(/\b(device|unauthorized|offline|bootloader|recovery|sideload)\b/);
  return m?.[1] ?? "unknown";
}

// ── Remembered device + self-healing reconnect ──────────────────────────────────────────────────
// `adb connect` state lives only in the host's adb-server process, and only while the connection
// holds. A session (agent) on this machine shares that adb server (127.0.0.1:5037), so once THIS
// daemon is connected the session sees the phone — the trick is keeping this machine connected
// without the phone's app, which only ever talks to the hub. So every daemon remembers the last
// phone it reached and re-dials it (using the fleet-shared key — no prompt, no phone interaction)
// whenever nothing's connected: on status load, on an explicit reconnect, and on a quiet timer.

/** `<stateDir>/adb-device.json` — the last phone tailnet address this daemon connected to. */
const adbStatePath = (stateDir: string): string => join(stateDir, "adb-device.json");

/** Remember the phone's host so this machine can reconnect on its own later. Best-effort. */
export function rememberAdbDevice(stateDir: string, host: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(adbStatePath(stateDir), JSON.stringify({ host }), "utf8");
  } catch {
    /* non-fatal: losing the hint just means this machine waits for the next fleet sync */
  }
}

/** The last phone host this daemon connected to, or null if it never has. */
export function rememberedAdbHost(stateDir: string): string | null {
  try {
    const h = (JSON.parse(readFileSync(adbStatePath(stateDir), "utf8")) as { host?: string }).host;
    return h && h.trim() ? h.trim() : null;
  } catch {
    return null;
  }
}

/** Count the devices in `adb devices -l` output that are in the ready "device" state. The STATE is
 *  the second whitespace-field on each device line ("<serial> device product:… device:<board> …") —
 *  judge by that column, not a substring, since a ready line also contains a literal "device:<board>"
 *  field. Pure, so it's unit-tested against real adb phrasings. */
export function readyDeviceCount(devicesOutput: string): number {
  return devicesOutput
    .split("\n")
    .slice(1) // drop the "List of devices attached" header
    .filter((l) => l.trim().split(/\s+/)[1] === "device").length;
}

export interface AdbEnsureResult {
  connected: boolean; // a ready device is present (already, or after a reconnect)
  reconnected: boolean; // we actually re-dialed this call
  host: string | null; // the remembered host, if any
  output: string;
}

/**
 * Make sure this machine can see the phone, reconnecting with the shared key if it can't. No-op (fast)
 * when a device is already ready. When nothing's connected and we remember a phone, `adb connect
 * host:5555` — the fleet-shared RSA key is already trusted, so this never prompts. This is what lets a
 * session on the project's machine keep seeing the phone after the hub's one-time fan-out.
 */
export async function adbEnsureConnected(stateDir: string): Promise<AdbEnsureResult> {
  if (!findAdb()) return { connected: false, reconnected: false, host: rememberedAdbHost(stateDir), output: "adb isn't installed on this server" };
  if (readyDeviceCount((await runAdb(["devices", "-l"])).output) > 0) {
    return { connected: true, reconnected: false, host: rememberedAdbHost(stateDir), output: "already connected" };
  }
  const host = rememberedAdbHost(stateDir);
  if (!host) return { connected: false, reconnected: false, host: null, output: "no phone has connected to this server yet — tap Connect fleet on the phone" };
  const r = await runAdb(["connect", adbTarget(host, ADB_PIN_PORT)]);
  const connected = connectedOk(r.output) && readyDeviceCount((await runAdb(["devices", "-l"])).output) > 0;
  return { connected, reconnected: true, host, output: r.output };
}

export interface AdbAutoResult {
  ok: boolean;
  output: string; // human-readable summary + the raw adb logs
  pinned: boolean; // reachable on ADB_PIN_PORT
  persistent: boolean; // pin survives a reboot (persist.adb.tcp.port honored by the device)
  authorized: boolean; // false when the phone still needs the "Allow debugging?" tap
  selfToggle: boolean; // the Anvil app holds WRITE_SECURE_SETTINGS, so it can re-enable Wireless debugging itself
}

/** The Android client's application id — granted WRITE_SECURE_SETTINGS after a successful connect so
 *  the app can flip the Wireless-debugging toggle itself from then on (AdbToggle.kt). */
export const ANDROID_APP_ID = "com.gte619n.anvil";

/** `pm grant` prints nothing on success and a one-line exception on failure (unknown permission on
 *  APKs older than the manifest entry, "not allowed", etc.). Pure, so the phrasing is unit-tested. */
export function grantOk(run: AdbRun): boolean {
  return run.ok && !/exception|error|failed|not allowed|unknown/i.test(run.output.replace("(no output)", ""));
}

/** Best-effort: let the Anvil app flip the Wireless-debugging toggle itself. The grant survives
 *  reboots and app updates, which closes the automation loop — after a reboot the app re-enables
 *  Wireless debugging on launch and the daemon re-pins without any Settings round-trip. Failure is
 *  fine: an APK without the manifest entry just rejects the grant and the manual toggle keeps working. */
async function grantSelfToggle(target: string): Promise<boolean> {
  const r = await runAdb(["-s", target, "shell", "pm", "grant", ANDROID_APP_ID, "android.permission.WRITE_SECURE_SETTINGS"]);
  return grantOk(r);
}

async function deviceState(target: string): Promise<string> {
  return parseDeviceState((await runAdb(["-s", target, "get-state"])).output);
}

/** Read whether adbd is already set to come up on the pinned port after a reboot. */
async function isPersistent(target: string): Promise<boolean> {
  const got = await runAdb(["-s", target, "shell", "getprop", "persist.adb.tcp.port"]);
  return got.output.trim() === String(ADB_PIN_PORT);
}

/** Best-effort reboot survival: ask adbd to keep the tcp port across reboots, then read it back —
 *  non-rooted devices may refuse (SELinux), so we report what actually stuck rather than assume. */
async function makePersistent(target: string): Promise<boolean> {
  await runAdb(["-s", target, "shell", "setprop", "persist.adb.tcp.port", String(ADB_PIN_PORT)]);
  return isPersistent(target);
}

/** Compose the user-facing summary for an auto-connect outcome. Pure, so the phrasing is unit-tested. */
export function summarizeAuto(target: string, state: string, persistent: boolean, selfToggle = false): string {
  if (state === "unauthorized") return `Connected ${target}, but the phone shows "unauthorized" — approve the "Allow debugging?" prompt on the phone.`;
  if (state !== "device") return `Connected ${target}, but it's "${state}" — give it a moment, then retry.`;
  const survival = persistent
    ? ", pinned across reboots."
    : selfToggle
      ? ". After a reboot, just open Anvil on the phone — it re-enables Wireless debugging and reconnects by itself."
      : ", pinned until the phone reboots.";
  return `Connected ${target} — debugging ready${survival}`;
}

/**
 * One-tap connect for the Android client. Fast path: the phone is already pinned, so a plain
 * `adb connect host:5555` is all it takes — no discovery, no pairing code. When that misses and the
 * app supplies a freshly-discovered wireless-debugging `port`, bootstrap the pin: connect on that
 * port, `tcpip 5555` to restart adbd on the stable port, reconnect there, then try to persist it.
 * After one bootstrap every later launch takes the fast path (see maybeAutoAdb in the Android shell).
 */
export async function adbAuto(host: string, port?: number): Promise<AdbAutoResult> {
  const pin = adbTarget(host, ADB_PIN_PORT);

  const fast = await runAdb(["connect", pin]);
  if (connectedOk(fast.output)) {
    const state = await deviceState(pin);
    const persistent = await isPersistent(pin); // report only; the pin already exists on the fast path
    const selfToggle = state === "device" && (await grantSelfToggle(pin));
    return { ok: true, output: [summarizeAuto(pin, state, persistent, selfToggle), fast.output].join("\n"), pinned: true, persistent, authorized: state === "device", selfToggle };
  }
  if (!port) {
    return { ok: false, output: `Not reachable on :${ADB_PIN_PORT} yet — open Anvil on the phone and tap Auto-connect.\n${fast.output}`, pinned: false, persistent: false, authorized: false, selfToggle: false };
  }

  // Bootstrap: connect on the live wireless-debugging port the phone just discovered, pin adbd to the
  // stable port, reconnect, and make the pin survive reboots where the device allows it.
  const target = adbTarget(host, port);
  const conn = await runAdb(["connect", target]);
  if (!connectedOk(conn.output)) {
    return { ok: false, output: conn.output, pinned: false, persistent: false, authorized: false, selfToggle: false };
  }
  const tcp = await runAdb(["-s", target, "tcpip", String(ADB_PIN_PORT)]);
  await Bun.sleep(1500); // adbd restarts on the pinned port; give it a beat before reconnecting
  const re = await runAdb(["connect", pin]);
  const ok = connectedOk(re.output);
  const state = ok ? await deviceState(pin) : "offline";
  const persistent = ok ? await makePersistent(pin) : false;
  const selfToggle = state === "device" && (await grantSelfToggle(pin));
  return { ok, output: [summarizeAuto(pin, state, persistent, selfToggle), conn.output, tcp.output, re.output].join("\n"), pinned: ok, persistent, authorized: state === "device", selfToggle };
}

// ── Fleet-shared adb identity ─────────────────────────────────────────────────────────────────────
// A phone's debugging trust (the "Allow debugging?" approval AND the wireless pairing) is bound to
// the adb KEY, not the machine. So instead of pairing every server with every device, the hub pushes
// its ~/.android/adbkey pair to the members — they present the identity the phone already trusts,
// and `adb connect phone:5555` is authorized everywhere with zero per-member setup.

/** Where adb keeps its client identity for a given HOME. Pure, so it's unit-testable. */
export const adbKeyPaths = (home: string): { key: string; pub: string } => ({
  key: join(home, ".android", "adbkey"),
  pub: join(home, ".android", "adbkey.pub"),
});

export interface AdbIdentity {
  key: string; // PEM private key (~/.android/adbkey)
  pub: string; // one-line public key (~/.android/adbkey.pub)
}

/** Sanity-check a pushed identity before it lands on disk: the private key must be PEM and the public
 *  key adb's single-line base64 form — not swapped, truncated, or arbitrary junk. Pure. */
export function looksLikeAdbIdentity(key?: string, pub?: string): boolean {
  if (!key || !pub) return false;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(key)) return false;
  return /^[A-Za-z0-9+/=]{64,}/.test(pub.trim()); // base64 blob, optionally followed by " user@host"
}

/** Read this server's adb identity, generating one first (`adb keygen`) when the box has never run
 *  adb — a freshly-installed headless hub has no ~/.android until something creates it. */
export async function readAdbIdentity(): Promise<AdbIdentity | null> {
  const home = process.env.HOME;
  if (!home) return null;
  const p = adbKeyPaths(home);
  if (!existsSync(p.key) || !existsSync(p.pub)) {
    mkdirSync(join(home, ".android"), { recursive: true });
    await runAdb(["keygen", p.key]); // writes both FILE and FILE.pub; no device needed
  }
  try {
    return { key: readFileSync(p.key, "utf8"), pub: readFileSync(p.pub, "utf8") };
  } catch {
    return null;
  }
}

/** Adopt a fleet-shared adb identity pushed by the hub. The previous key (if any, and different) is
 *  kept at adbkey.bak for a one-step undo. `adb kill-server` afterwards so a running adb server stops
 *  using its cached copy of the old key (best-effort — adb may not even be installed yet, which is
 *  fine: the key is plain files, usable whenever adb arrives). */
export async function installAdbIdentity(key: string, pub: string): Promise<{ ok: boolean; output: string; changed: boolean }> {
  if (!looksLikeAdbIdentity(key, pub)) return { ok: false, output: "that doesn't look like an adb key pair — refusing to install it", changed: false };
  const home = process.env.HOME;
  if (!home) return { ok: false, output: "the daemon's user has no HOME set, so there's nowhere to install the adb key", changed: false };
  const p = adbKeyPaths(home);
  try {
    mkdirSync(join(home, ".android"), { recursive: true });
    const current = existsSync(p.key) ? readFileSync(p.key, "utf8") : null;
    if (current === key) return { ok: true, output: "already on the fleet adb identity", changed: false };
    if (current !== null) copyFileSync(p.key, `${p.key}.bak`);
    writeFileSync(p.key, key, { mode: 0o600 }); // adb refuses group/world-readable private keys
    writeFileSync(p.pub, pub, { mode: 0o644 });
    await runAdb(["kill-server"]);
    return { ok: true, output: "fleet adb identity installed", changed: true };
  } catch (e) {
    return { ok: false, output: `couldn't install the adb key: ${(e as Error).message}`, changed: false };
  }
}

/** Drop the adb connection to the phone's pinned port (or all connections when no host is given). */
export async function adbDisconnect(host?: string): Promise<{ ok: boolean; output: string }> {
  const r = await runAdb(host ? ["disconnect", adbTarget(host, ADB_PIN_PORT)] : ["disconnect"]);
  return { ok: r.ok, output: r.output };
}

/** Extract a zip with whatever's on the box — `unzip` (ubiquitous), else `ditto` (macOS), else bsdtar
 *  (`tar` on macOS and many Linux reads zips). Tries each present tool, reporting every failure. */
async function extractZip(zipPath: string, destDir: string): Promise<{ ok: boolean; output: string }> {
  const tools: { bin: string; args: string[] }[] = [
    { bin: "unzip", args: ["-o", "-q", zipPath, "-d", destDir] },
    { bin: "ditto", args: ["-x", "-k", zipPath, destDir] },
    { bin: "tar", args: ["-xf", zipPath, "-C", destDir] },
  ];
  const errs: string[] = [];
  for (const { bin, args } of tools) {
    if (!Bun.which(bin)) continue;
    try {
      const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(120_000) });
      const err = await new Response(p.stderr).text();
      await p.exited;
      if (p.exitCode === 0) return { ok: true, output: `extracted with ${bin}` };
      errs.push(`${bin}: ${err.trim() || `exit ${p.exitCode}`}`);
    } catch (e) {
      errs.push(`${bin}: ${(e as Error).message}`);
    }
  }
  return { ok: false, output: errs.length ? errs.join("; ") : "no zip extractor found (install 'unzip')" };
}

/**
 * Install Google's official Android platform-tools into ~/.anvil/platform-tools so a headless server
 * (nothing but Anvil) can drive `adb` without a package manager or admin rights. Idempotent — a no-op
 * returning the resolved path when adb is already present anywhere findAdb looks.
 */
export async function installPlatformTools(): Promise<{ ok: boolean; output: string }> {
  const existing = findAdb();
  if (existing) return { ok: true, output: `adb is already installed at ${existing}` };
  const home = process.env.HOME;
  if (!home) return { ok: false, output: "The daemon's user has no HOME set, so there's nowhere to install adb. Set HOME in the service environment and retry." };
  const url = platformToolsUrl(process.platform);
  if (!url) return { ok: false, output: `No prebuilt platform-tools for ${process.platform} — install adb manually and put it on PATH.` };
  const anvilDir = join(home, ".anvil");
  const zipPath = join(anvilDir, "platform-tools.zip");
  try {
    mkdirSync(anvilDir, { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { ok: false, output: `Couldn't download platform-tools (${res.status} ${res.statusText}) from ${url}` };
    await Bun.write(zipPath, res);
    const unz = await extractZip(zipPath, anvilDir);
    rmSync(zipPath, { force: true });
    if (!unz.ok) return { ok: false, output: `Downloaded, but couldn't unzip: ${unz.output}` };
    const adb = findAdb();
    if (!adb) return { ok: false, output: "Downloaded and unzipped, but adb still isn't where expected — the archive layout may have changed." };
    try {
      await Bun.spawn(["chmod", "+x", adb], { signal: AbortSignal.timeout(5_000) }).exited; // ensure exec bit on posix
    } catch {
      /* non-fatal: extraction usually preserves the exec bit already */
    }
    const ver = await runAdb(["version"]);
    return { ok: true, output: `Installed Android platform-tools to ${adbSelfInstallDir()}\n${ver.output}` };
  } catch (e) {
    return { ok: false, output: `Install failed: ${(e as Error).message}` };
  }
}
