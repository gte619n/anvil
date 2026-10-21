# ADB over Tailscale — Android debugging passthrough

Debug an Android app **on your phone** while the development session runs on a **remote (often
headless) Anvil server**. The app under test runs on the phone; the server runs `adb` and reaches the
phone over the tailnet, so `adb logcat`, `adb install`, `adb shell`, etc. all work from the session as
if the phone were plugged into the server by USB.

Everything interactive (the pairing code, the "Allow debugging?" prompt) happens **on the phone**. The
server side is pure CLI, so this works on a box with nothing but Anvil installed.

## The pieces

| Where | What it does |
|-------|--------------|
| Android app (`app/.../MainActivity.kt`, `AdbWifi.kt`) | Discovers the phone's own wireless-debugging port via mDNS (local — mDNS doesn't cross the tailnet), finds the phone's Tailscale IP, and drives the daemon over HTTP. Silently reconnects on launch once set up. |
| Daemon (`anvild/src/server/adb.ts`) | Resolves/installs `adb`, runs connect/pair/pin, reports device state. Routes live in `http.ts` under `/api/adb/*`. A hub also replicates its adb identity to members (`propagateAdbIdentity` in `fleet.ts`) so any server can debug any paired device. |
| Web UI (`anvild/web/src/settings.ts`) | The **Servers → Debug this phone** card: a status dot + one primary **Connect fleet** button, a "How it works" instructions modal, and first-time tools (pair / re-sync / disconnect / install) folded under *First-time setup*. |

## How a connection is made

1. **Pair (first time on a server).** On the phone: *Settings → Developer options → Wireless
   debugging → Pair device with pairing code*. Enter the 6-digit code in the ADB card. This is the
   one-time Android-11 handshake so `adb connect` is allowed.
2. **Auto-connect.** The app asks the daemon to reach the phone on the **pinned port** (`5555`). If
   that misses, it discovers the phone's current wireless-debugging port and hands it to the daemon,
   which:
   - `adb connect <tailscale-ip>:<discovered-port>`
   - `adb -s … tcpip 5555` — restarts adbd on a **stable** port using legacy RSA trust
   - reconnects on `:5555` and, best-effort, sets `persist.adb.tcp.port` so the pin survives a reboot
   - The phone shows **"Allow debugging?"** once (RSA trust); approve it and the server is trusted
     from then on.
3. **Fleet fan-out.** After a successful auto-connect, a hub pushes its adb identity
   (`~/.android/adbkey` pair) to every fleet member and has each one `adb connect <phone>:5555` too —
   see *One pairing, whole fleet* below. The phone's toast lists which servers are ready.
4. **Self-toggle grant.** Riding the connection it just made, the daemon runs
   `pm grant com.gte619n.anvil android.permission.WRITE_SECURE_SETTINGS`. That permission (not
   grantable at runtime, but a `pm grant` sticks across reboots and app updates) lets the Anvil app
   flip the **Wireless debugging toggle itself** (`AdbToggle.kt` writes `Settings.Global
   adb_wifi_enabled`) — so from now on nobody ever opens Developer options again.
5. **Every later launch** reconnects to `:5555` silently — no discovery, no code, no prompt. (The app
   only does this after you've succeeded once; it records that in `anvil.adb` prefs.) When the fast
   path misses *and* the app holds the self-toggle grant — the reboot case: Android cleared both the
   pin and the Wireless-debugging toggle — the app silently turns the toggle back on, discovers the
   fresh port, and asks the daemon to re-pin. The server is already RSA-trusted, so no prompt.

The pin (`adb tcpip`) uses the old RSA-key trust, which is **independent of the Android-11 wifi
pairing** — that's why you don't re-enter a 6-digit code after a reboot, only re-approve/re-pin if the
port was lost.

## HTTP API (`/api/adb/*`)

| Method & path | Body | Returns |
|---------------|------|---------|
| `GET /api/adb/info` | — | `{ serverIps, adbInstalled, adbPath?, devices }` |
| `POST /api/adb/install` | — | `{ ok, output }` — downloads Google platform-tools |
| `POST /api/adb/auto` | `{ host, port? }` | `{ ok, output, pinned, persistent, authorized }` |
| `POST /api/adb/connect` | `{ host, port }` | `{ ok, output }` |
| `POST /api/adb/pair` | `{ host, port, code }` | `{ ok, output }` |
| `POST /api/adb/disconnect` | `{ host? }` | `{ ok, output }` |
| `POST /api/adb/key` | `{ key, pub, host? }` | member landing point: install the fleet adb identity; with `host`, also connect the device |
| `POST /api/adb/sync` | `{ host? }` | hub: push the identity to every member (defaults `host` to the phone this hub last saw) → `{ ok, output, results }` |
| `POST /api/adb/reconnect` | — | re-dial the phone this server last saw, using the shared key → `{ connected, reconnected, host, output }` |

These sit behind the same Tailscale boundary as the rest of the daemon (no app-layer auth, by design —
see `tailscale-is-accepted-security-boundary`).

## One pairing, whole fleet

adb trust — both the Android-11 wireless pairing and the legacy "Allow debugging?" RSA approval — is
bound to the adb **key**, not the machine. So the fleet shares one identity instead of pairing N×M:

- The phone pairs with the **hub only**, through the app's ADB card. Nothing interactive ever happens
  on a server: the pairing dialog and the 6-digit code live on the phone, the code is typed into the
  Anvil app, and the daemon just runs `adb pair` — closet-friendly.
- On every successful auto-connect, the hub POSTs its `~/.android/adbkey` pair to each member's
  `/api/adb/key` (same transport rules as Todoist token propagation: https-then-http per member,
  tailnet-gated, WireGuard-encrypted hop). Members back up any prior key to `adbkey.bak`, install the
  fleet key (0600), and `adb kill-server` so it takes effect. A member without adb self-installs
  platform-tools in the background.
- The same POST carries the phone's tailnet IP, so each member immediately runs
  `adb connect <phone>:5555` — the shared key is already trusted, so no prompt appears anywhere. The
  device shows up in `adb devices` on **every server** each time the app opens.
- The settings card's **Sync to fleet** button pushes the key on demand (e.g. right after adding a
  new server) without needing the phone connected.

Members never pair, never prompt, and never need the phone's pairing dialog. Adding a fourth server =
pair nothing; the next app launch (or Sync to fleet) makes it debug-ready. More devices (tablet etc.):
each device pairs with the hub once, and the whole fleet inherits it the same way.

### Staying connected (why a session sees the phone)

`adb connect` state lives only in a machine's adb-server process (`127.0.0.1:5037`), and only while the
link holds. A build/debug **session** (an agent) on a machine shares that adb server, so once the
machine is connected the session sees the phone — and both apps on the phone at once, since a device
hosts many packages (`adb install com.appA` / `com.appB` coexist with no `-s` needed while it's the
only device attached).

**Connection is manual, by design.** Nothing re-dials in the background. Each daemon:

- **remembers** the last phone it reached (`<stateDir>/adb-device.json`), written on every connect and
  on a key-push that carries a host — so reconnecting never needs the pairing code again;
- **reconnects on demand** via `POST /api/adb/reconnect` (re-dials the remembered phone with the shared
  key, no prompt) or the card's **Connect fleet** / **Re-sync servers** buttons.

A connection stays up until you disconnect or the phone drops it (reboot, sleep, network blip). To get
it back, tap **Re-sync servers** (reconnects every server to this phone) or, from a session, have the
agent hit its own daemon: `curl -XPOST http://localhost:7701/api/adb/reconnect`. Several servers
holding a live connection at once is expected and fine — the shared key is built for every server to
debug simultaneously.
If you ever need to force it, **Re-sync servers** on the card reconnects the whole fleet to this phone,
or an agent can `curl -XPOST http://localhost:7701/api/adb/reconnect` on its own host.

## Headless servers: self-installing adb

If `adb` isn't found (`PATH`, Homebrew, the Android SDK, or `~/.anvil/platform-tools`), the card shows
an **Install platform-tools on server** button. `installPlatformTools()`:

- downloads Google's official `platform-tools-latest-<os>.zip` from `dl.google.com`,
- extracts it to `~/.anvil/platform-tools/` with whatever's present (`unzip` → `ditto` → `tar`),
- `chmod +x` and verifies with `adb version`.

No Homebrew, apt, sudo, or GUI required. Needs only outbound HTTPS to `dl.google.com` and `HOME` set
for the daemon's user (adb keeps its RSA key in `$HOME/.android/adbkey` — that's what makes the phone's
one-time approval stick).

## Reboot survival

- `adb tcpip 5555` pins the port until the phone reboots.
- The daemon then tries `setprop persist.adb.tcp.port 5555` and reads it back. Where the device honors
  it (varies by OEM / Android version, and may need root), adbd comes back on `:5555` after a reboot
  and the silent launch reconnect just works. `adbAuto` reports this as `persistent` so the UI can tell
  the user which case they're in.
- Where `persist.adb.tcp.port` does **not** stick (most unrooted phones), the self-toggle grant covers
  it: on the next app launch the fast path misses, the app flips Wireless debugging back on via
  `WRITE_SECURE_SETTINGS`, rediscovers the port, and the daemon re-pins — all silent. `adbAuto`
  reports the grant as `selfToggle`. Net effect: after a reboot, *opening the Anvil app once* is the
  only step; no Settings, no prompts.
- Manual fallback (e.g. to pre-grant from a laptop before the daemon ever connects):
  `adb shell pm grant com.gte619n.anvil android.permission.WRITE_SECURE_SETTINGS`. Revoke with
  `pm revoke` — everything degrades back to the manual toggle.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Card says "adb isn't installed" | Tap Install, or `brew install android-platform-tools` on the server. |
| "unauthorized" after connect | Approve the "Allow debugging?" prompt on the phone (tap "always allow"). |
| Re-prompted every connect | Daemon user has no writable `HOME`; set it so `~/.android/adbkey` persists. |
| Works, then dies after reboot | Open the Anvil app — with the self-toggle grant it recovers on its own. Still dead? Tap Auto-connect (re-grants too). |
| "Not reachable on :5555 yet" on launch | Normal before first setup, or after a reboot that dropped the pin — tap Auto-connect. |
| "Wireless debugging is off" message | The app lacks the self-toggle grant (old APK, or first run). Flip the toggle once in Developer options and tap Auto-connect — the server grants the permission over that connection. |
| Install fails at unzip | No `unzip`/`ditto`/`tar` on the box — install `unzip`. |
