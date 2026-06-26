# Anvil — iOS / iPadOS client

Implementation plan for shipping Anvil on iPhone, iPad, and iPad Mini.

## TL;DR

The app is a thin native shell around the shared web bundle (`anvild/web`). A SwiftUI +
`WKWebView` macOS shell already exists in `apple/`. iOS/iPadOS is **the same shell retargeted**,
plus the one native capability the Apple side has never had: push (APNs). One **universal** binary
covers iPhone, iPad, and iPad Mini — they differ only by screen size, which is responsive CSS, not
a separate target. iPad Mini is free.

- **Parity with Android: ~95%.** Identical web UI on both. Gaps are the Android-only ADB-over-WiFi
  bridge (irrelevant on iOS) and the effort of standing up APNs.
- **Lift:** shell + universal layout ≈ a few days; full APNs (client + daemon sender) ≈ 1–2 weeks.
- **Hard prerequisite for push:** Apple Developer Program ($99/yr). The WebView shell alone runs on
  simulator / 7-day free-provisioned device without it.

## Current state (what we reuse)

| Layer | Where | Reuse on iOS |
|---|---|---|
| Web UI (sessions, autopilot, terminals, plan review) | `anvild/web` → bundled by `web/bundle-native.ts` | 100%, unchanged |
| WKWebView host + `anvil-app://` bundle scheme handler | `apple/Sources/Anvil/WebView.swift` | ~90% (swap `NSViewRepresentable`→`UIViewRepresentable`) |
| Daemon-URL injection (`window.ANVIL_DAEMON_URL`) | `WebView.swift` / `ContentView.swift` | verbatim |
| Daemon push payload + token registry (`platform: "fcm" \| "apns"`) | `anvild/src/push/registry.ts`, `webpush.ts` | registry already models APNs |
| FCM sender (pattern to mirror for APNs) | `anvild/src/push/fcm.ts` | template for `apns.ts` |
| Permission-response endpoint | `anvild/src/server/http.ts:311` `/api/permission/respond` | verbatim (notification Allow/Deny posts here) |
| Push-register endpoints | `http.ts:339` `/api/push/fcm/register` | parallel `/api/push/apns/register` |

The Android native pieces that **do not** port: `AdbWifi.kt` (mDNS ADB discovery — Android-device
control, no iOS analog) and the FCM specifics. Everything else (`Notifications`,
`PermissionActionReceiver`, deep-link-to-session) has a direct UNUserNotificationCenter equivalent.

## Build-system reality

SwiftPM's executable target (`apple/Package.swift`) is macOS-only — it cannot produce an iOS app.
iOS therefore goes through the **xcodegen** path that already exists (`apple/project.yml`) and
requires **full Xcode.app** (the Command-Line-Tools-only `make-app.sh` flow stays macOS-only). So:

- macOS shell: keep `swift build` / `make-app.sh` (no Xcode needed).
- iOS shell: add an iOS app target to `project.yml`, `xcodegen generate`, build/archive in Xcode.

Both targets share the same `Sources/Anvil` Swift files via `#if os(...)`.

## Phases

### Phase 0 — Prerequisites (gating, ~half a day of account wrangling)

1. Enroll in the Apple Developer Program ($99/yr).
2. Register App ID `com.gte619n.anvil` (matches existing bundle id) with the **Push Notifications**
   capability.
3. Create a **token-based APNs key** (`.p8` `AuthKey_XXXX.p8`, note Key ID + Team ID). Token auth
   (one key for all environments) is simpler than per-environment certs and mirrors how `fcm.ts`
   uses a service-account key. Store at `~/.config/anvil/apns-key.json`
   (`{ keyId, teamId, bundleId, key }`) alongside the existing `fcm-service-account.json`.
4. Provisioning profile with the push entitlement for device installs / TestFlight.

> Phase 1 can proceed in parallel — the shell builds and runs on the **simulator** and on a device
> via free 7-day provisioning without any of the above. Only push (Phase 2/3) is gated on Phase 0.

### Phase 1 — Universal WebView shell, no push (~2–3 days)

Goal: a real iPhone/iPad/Mini app rendering the full web UI, visually identical to Android.

1. **Cross-platform `WebView.swift`.** Replace the macOS-only `NSViewRepresentable` with a
   platform shim so one file serves both:
   ```swift
   #if os(macOS)
   import AppKit
   typealias PlatformViewRepresentable = NSViewRepresentable
   #else
   import UIKit
   typealias PlatformViewRepresentable = UIViewRepresentable
   #endif
   ```
   `makeNSView`/`makeUIView` both build the same `WKWebViewConfiguration` (scheme handler +
   `window.ANVIL_DAEMON_URL` injection are platform-agnostic). The **pop-out reader window** logic
   (`createWebViewWith` → `NSWindow`, `popoutWindows`) is macOS-only — wrap it in `#if os(macOS)`.
   On iOS, `window.open(...)` for the markdown reader should present a modal `WKWebView` sheet (or,
   simplest first cut, open in-place); track as a web-side affordance, not a blocker.
2. **iOS target in `project.yml`.** Add an `application` target, `platform: iOS`,
   `deploymentTarget: "16.4"` (16.4 unlocks web push fallback and is a reasonable floor),
   `TARGETED_DEVICE_FAMILY: "1,2"` (iPhone **and** iPad → covers iPad Mini automatically). Reuse the
   same `Sources/Anvil` + a new `Resources` entitlements/Info plist. `xcodegen generate`.
3. **App entry / config.** `AnvilApp.swift` and `ContentView.swift` already compile cross-platform
   except macOS `.commands{}` (⌘R reload / Update menu) — guard those with `#if os(macOS)`. iOS gets
   pull-to-reload or a small in-web control instead. `AppConfig.baseURL` (UserDefaults override)
   works as-is.
4. **Safe areas & responsive layout (web-side).** Ensure `index.html` viewport carries
   `viewport-fit=cover`; add `env(safe-area-inset-*)` padding in the web CSS so the notch/home
   indicator don't clip the UI. This also improves the Android edge-to-edge case. Verify the
   session grid, composer, and xterm panes at iPhone width and iPad split widths.
5. **Keyboard / terminal.** Confirm xterm input works with the iOS soft keyboard and a hardware
   keyboard on iPad. WKWebView handles text input; no `keyboardDisplayRequiresUserAction` hack
   needed for our flows.
6. **Bundle the web client** the same way macOS does:
   `bun run build:web && bun run web/bundle-native.ts apple/Sources/Anvil/web`. The iOS target copies
   `Sources/Anvil/web` as a resource; `BundleSchemeHandler` resolves it via `Bundle.main`.

**Exit criteria:** app launches on iPhone, iPad, and iPad Mini simulators + one physical device,
connects to the daemon over Tailscale, drives a session end-to-end. No push yet.

### Phase 2 — APNs client (~3–4 days, needs Phase 0)

Mirror the Android FCM receiver (`AnvilMessagingService` + `Notifications` +
`PermissionActionReceiver`) with `UserNotifications`:

1. **AppDelegate adaptor.** Add `@UIApplicationDelegateAdaptor` to `AnvilApp`. In
   `didFinishLaunching`: set `UNUserNotificationCenter.current().delegate`, request authorization
   (`.alert`, `.badge`, `.sound`), and call `registerForRemoteNotifications()`.
2. **Token registration.** `didRegisterForRemoteNotificationsWithDeviceToken` → hex-encode the
   token → `POST {daemonURL}/api/push/apns/register {token}` (new endpoint, Phase 3). Re-post on
   every launch (APNs tokens can rotate). Reuse the existing fire-and-forget POST pattern from
   Android's `Net.kt`.
3. **Notification categories / actions.** Register a `permission` `UNNotificationCategory` with
   **Allow** / **Deny** `UNNotificationAction`s — the iOS analog of Android's notification buttons.
   `question` and `result` kinds are plain alerts (tap-to-open), matching Android's limitation that
   multiple-choice can't be buttons.
4. **Action handling** (`didReceive response`): for Allow/Deny, read `requestId` + decision from the
   payload's custom keys → `POST /api/permission/respond {requestId, decision}` (the **same**
   endpoint Android uses, `http.ts:311`). For a tap, read `sessionId` → tell the WebView to open
   `#s/<sessionId>` (via `evaluateJavaScript("location.hash='s/<id>'")` or a load with the hash),
   matching Android's deep-link.
5. **Foreground presentation** (`willPresent`): show banners while the app is foregrounded so
   in-session prompts aren't silently swallowed.
6. **`clear` kind:** dismiss the matching delivered notification (session viewed elsewhere), keyed
   by `sessionId` — same supersede/clear behavior as Android's session-keyed notification IDs.
7. **iOS entitlements:** `aps-environment` (development/production), always-sandboxed. Separate
   entitlements file from the macOS target.

### Phase 3 — APNs daemon sender (~2–3 days)

Add the server side parallel to `fcm.ts`, wired into the same fan-out the supervisor already does
(`supervisor.ts:498-499, 1060-1061, 1298-1299` call `webpush.notify` + `fcm.notify` — add
`apns.notify`).

1. **`anvild/src/push/apns.ts` — `Apns` class** mirroring `Fcm`:
   - Load `~/.config/anvil/apns-key.json` (or `ANVIL_APNS_KEY` env); disabled no-op if absent
     (same graceful-degradation contract as `Fcm.enabled`).
   - Token-based auth: sign an ES256 JWT (`alg:ES256`, `kid:keyId`, `iss:teamId`) with the `.p8`,
     cache it ~50 min (APNs requires refresh < 60 min), send as `authorization: bearer <jwt>`.
   - `POST https://api.push.apple.com/3/device/<token>` per device, headers `apns-topic: <bundleId>`,
     `apns-push-type: alert`, `apns-priority: 10`. HTTP/2 — use `fetch` (Bun supports h2) or `node:http2`.
   - **Payload shape (differs from FCM's data-only):** APNs needs a visible `aps.alert` for
     actionable notifications, so send
     `{ aps: { alert: { title, body }, category: kind, "thread-id": sessionId, "mutable-content": 1 },
        sessionId, kind, requestId, tool, dir, ask }`.
     Custom keys ride alongside `aps`. `category` drives the Allow/Deny buttons; `thread-id` groups
     by session (the supersede analog).
   - Token persistence to `state/push/apns-tokens.json` + prune on `410 Unregistered` /
     `BadDeviceToken` (the FCM `dead`-token pattern at `fcm.ts:117-129`).
2. **Endpoints** in `http.ts`: `/api/push/apns/register` + `/api/push/apns/unregister`
   (copy the `/api/push/fcm/register` block at `http.ts:339`, call `supervisor.apns.register`).
3. **Supervisor wiring:** `this.apns = new Apns(cfg.stateDir)` next to `this.fcm`
   (`supervisor.ts:128`); add `void this.apns.notify(payload)` beside each `fcm.notify`.
4. The `PushRegistry` already carries `platform: "apns"` (`registry.ts:9`) — no model change.

### Phase 4 — Distribution (~1–2 days, optional/iterative)

- First cut: manual **Xcode Archive → TestFlight** (internal testers, no review).
- Later: CI on a macOS runner (`xcodebuild` + `xcrun altool`/fastlane → TestFlight), parallel to the
  existing Android→Firebase CI. Note the Apple build needs a signing identity in the runner keychain,
  which the current Linux/Mac CI for the APK does not.
- App Store proper requires review; TestFlight is enough for personal/tailnet use.

## Risks & decisions

- **Push is the only non-trivial new work.** Everything else is retargeting code we have. If push
  slips, Phase 1 still ships a fully usable app (the PWA/home-screen path even gives web-push as a
  stopgop on iOS 16.4+, no native code).
- **Apple Developer Program is a hard gate** for device push + TestFlight. Decide whether to enroll
  before starting Phase 2/3.
- **APNs HTTP/2:** confirm Bun's `fetch` negotiates h2 to `api.push.apple.com`; fall back to
  `node:http2` if not. Low risk, worth a spike before Phase 3.
- **Pop-out markdown reader on iOS:** macOS opens a real `NSWindow`; iOS needs a sheet or in-place.
  Cosmetic, not blocking — flag for the web/UX pass.
- **One universal target vs. separate iPhone/iPad:** go universal. iPad Mini needs nothing extra;
  only responsive CSS matters, and that work also helps Android tablets.

## Effort summary

| Phase | Effort | Gated on |
|---|---|---|
| 0 — Prereqs (account, App ID, APNs key) | ~0.5 day | Apple Developer Program $99/yr |
| 1 — Universal WebView shell (no push) | 2–3 days | Xcode (simulator/free device) |
| 2 — APNs client | 3–4 days | Phase 0 |
| 3 — APNs daemon sender | 2–3 days | Phase 0 |
| 4 — TestFlight / CI | 1–2 days | Phase 0 |

**~1–2 weeks total** for full parity-minus-ADB; **~2–3 days** to a working shell you can hold in
your hand. Resulting app is ~95% the Android experience because both render the same web bundle.
