# Anvil Implementation Plans — Index

**Created:** 2026-06-19 | **Updated:** 2026-07 | **Status:** plans 1 & 4 shipped; the web client (not planned here) is the daily driver and is bundled into all native shells; the native clients shipped as **thin Kotlin/Swift WebView shells** (not the originally-planned Compose/native rewrites); push (Web Push + APNs + FCM) is implemented

These are the component implementation plans for the Anvil re-architecture (dropping
Zellij). They build on the locked design in `anvil-native-architecture.md` and the wire
contract in `anvil-protocol.ts` (now **v0.5** — git lifecycle + env defaults + session
icons added since these plans were written; see the file header).

> **Reality check (2026-06-20):** Plan 1 (daemon core) and Plan 4 (terminal + file browser)
> are implemented. Instead of starting with Plan 3 (native Android), a **web client** served
> by the daemon was built and is the current daily driver — so Plans 3/5 (native clients) and
> Plan 6's push *send* path remain open. See `anvil-native-architecture.md` §0 for full status.

## The plans

| # | Plan | Phase | Covers |
|---|------|-------|--------|
| 1 | [Daemon Core](anvil-impl-1-daemon-core.md) | 1 | Bun/TS skeleton, WS server + dispatch, session supervisor (process-group kill), Agent SDK driver, auth guard, event-log + resume, budget tracker, autonomy/danger-list |
| 2 | [Rendering Pipeline & WebView Bundle](anvil-impl-2-rendering-pipeline.md) | 1+2 | Daemon markdown→HTML (markdown-it + Shiki + KaTeX + DOMPurify), the shared WebView bundle, streaming morph, mermaid, select-to-cite bridge, hardening |
| 3 | [Android Client](anvil-impl-3-android-client.md) | 2 | Native Compose shell, WS client, WebView host, input/attachments, FCM, panes, foldable layout |
| 4 | [Terminal & File Browser](anvil-impl-4-terminal-file-browser.md) | 3 | Persistent server-side PTY (`Bun.Terminal`), terminal channel + widgets, `fs.*` API, live watch, path safety |
| 5 | [Apple Clients (macOS + iOS)](anvil-impl-5-apple-clients.md) | 4+5 | Shared `AnvilCore` Swift package, WKWebView host, SwiftTerm, APNs, iOS adaptation |
| 6 | [Push, Tailscale & Ops](anvil-impl-6-push-tailscale-ops.md) | cross-cutting | FCM/APNs senders, `tailscale serve`, LaunchAgent/systemd, env/auth injection, migration off the Python server |

## Build order
Daemon core (1) + rendering pipeline daemon-side (2) + transport/ops (6, partial) → Android client (3) + WebView bundle (2) + FCM (6) → Terminal & file browser (4) → Mac (5) → iPhone (5) + APNs (6).

## Cross-cutting findings from planning (read before starting)

1. **~~The Android app is Java/Views, NOT Kotlin/Compose.~~ (SUPERSEDED — 2026-07)** The shipped
   Android client is now **Kotlin** — a thin WebView shell that hosts the bundled web UI (6 `.kt`
   files, 0 `.java`; see `app/src/main/java/com/gte619n/anvil/`), matching `docs/ARCHITECTURE.md`
   ("Android (Kotlin WebView)"). The originally-planned greenfield Compose rewrite did not happen;
   the WebView-shell approach (shared web UI across web/iOS/Android) won instead. This finding is kept
   for history — do not plan against the old "26 `.java` files" baseline.

2. **`node-pty`-on-Bun risk is retired.** Bun shipped a native `Bun.Terminal` PTY API in v1.3.5 (Dec 2025); use it, not node-pty. **Pin Bun ≥ 1.3.14** (macOS use-after-free + `fs.watch` rewrite). Keep a thin `PtyBackend` seam to fall back to `bun-pty` (FFI) if needed. (Plan 4 §3.)

3. **Protocol v0.2 amendments applied** (gaps the plans found): `fs.list.result`/`fs.read.result` (the union had no typed response for `fs.list`/`fs.read`), `push.unregister`, `FileContent.truncated` + `FsReadCmd.range` (large-file paging), and a clarification that `terminal.*` events carry `seq` for ordering but are **excluded from the durable conversation log** (terminal resume = scrollback replay).

4. **Streaming-input SDK mode is mandatory** for the daemon — it's what unlocks `canUseTool`, `interrupt`, mid-session `setModel`, and durable multi-turn. (Plan 1 §4.4.)

5. **Single conversation WebView, not per-bubble.** For morph performance, render the whole transcript in one WebView with native chrome around it, rather than one WebView per message bubble. (Plan 3 §10.)

## Decisions still needed from the user

- **Android terminal widget licensing (DECISION):** the only mature Android VT emulator is Termux's `terminal-view`/`terminal-emulator`, which is **GPL-3.0**. Bundling it makes the Android app GPL-3.0. Options: (a) accept GPL-3.0, (b) wrap only the Apache-licensed `terminal-emulator` core, (c) build/commission a clean-room Compose emulator. Needed before Phase 3. (Plans 3 §8, 4 §9 Q5.)

## Library pins worth noting
Bun ≥ 1.3.14 · `@anthropic-ai/claude-agent-sdk` (pin + lockfile, surface moving) · katex ≥ 0.16.21 (CVE-2025-23207) · mermaid ≥ 11.10.0 (`securityLevel:'strict'` only; CVE-2025-54881/CVE-2026-54011) · dompurify ≥ 3.4.x · idiomorph · chokidar · SwiftTerm (MIT).
