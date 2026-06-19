# Anvil Implementation Plan — Apple Clients (macOS + iOS)
**Phase:** 4 (macOS) + 5 (iOS) | **Depends on:** daemon core, rendering pipeline, protocol.ts | **Status:** draft

## 1. Scope & goal
Two Apple clients as **thin native SwiftUI shells over one shared Swift core**. macOS first (Phase 4), then iPhone/iPad (Phase 5) reusing the same core and most views, adapting layout to compact size classes.
In scope: a shared `AnvilCore` package (Codable models mirroring `protocol.ts`, `URLSessionWebSocketTask` client, `seq`/resume/`cid`, observable state store — **no UI**); macOS app (⌘-switchable session sidebar + previews + budget gauge; multi-pane workspace; native input Shift+Enter; paste/drag-drop → REST); the shared WebView surface via `WKWebView` (`NS/UIViewRepresentable`, local bundle, `WKScriptMessageHandlerWithReply` select-to-cite bridge, `allowsContentJavaScript` for mermaid under strict CSP, process-termination recovery); SwiftTerm terminal integration points; APNs push; iOS adaptation. Shells render no markdown — all arrives as daemon HTML (§8.3).

## 2. Decisions inherited
Native per platform; Mac+iOS share a Swift core (#3). Hybrid render (#13/#14) → `RenderedMarkdown{source,html}` + `data-line` cite. One WS, versioned + per-session sequenced; REST side-channel. Resume via `seq` + `session.attach{lastSeq}` + snapshot. `cid` correlation. Budget gauge load-bearing (§3). Mostly-autonomous permissions, answerable from any device. Push APNs + live-WS fallback + suppression (§6.7 #5/#8). Reader first-class, live-watched, side-by-side, select-to-cite. Terminal persistent, last-attach-wins, SwiftTerm. Auth/billing is a daemon concern — clients only surface `subscriptionAuthOk` + budget; never hold an Anthropic key.

## 3. Shared Swift core (`AnvilCore`)
```
AnvilCore/ Protocol/ Net/ State/ Push/   (one SPM target, zero UI deps)
```
**3.1 Protocol → Swift enums.** The two unions → enums with associated values + **custom Codable** keyed on `type`; `Envelope`(v,type,ts) + `SessionScoped`(sessionId,seq) decoded into an outer struct then the payload.
```swift
public enum ServerEvent {
  case sessionList([Session]); case sessionCreated(cid:String?, session:Session)
  case sessionUpdated(Session); case sessionDeleted(sessionId:String)
  case budget(Budget); case ack(cid:String); case commandError(cid:String?, message:String)
  case conversationSnapshot(meta:SessionScopedMeta, events:[ConversationEvent], lastSeq:Int)
  case messageUser(meta:SessionScopedMeta, rendered:RenderedMarkdown, attachments:[AttachmentRef])
  case assistantDelta(meta:SessionScopedMeta, text:String)
  case assistantMessage(meta:SessionScopedMeta, blocks:[ContentBlock])
  case toolUse(meta:..., toolUseId:String, name:String, input:JSONValue)
  case toolResult(meta:..., toolUseId:String, content:String, isError:Bool)
  case permissionRequest(meta:..., requestId:String, tool:String, input:JSONValue, suggestions:[PermissionSuggestion])
  case status(meta:..., status:SessionStatus); case usage(meta:..., inputTokens:Int, outputTokens:Int)
  case result(meta:..., stopReason:String, usage:Usage); case sessionError(meta:..., message:String, fatal:Bool)
  case fsChanged(meta:..., content:FileContent)
  case terminalData(meta:..., data:String); case terminalExit(meta:..., code:Int)
}
```
`init(from:)` switches on the `type` string; **unknown `type`/enum values degrade gracefully** (don't crash — forward compat). `ClientCommand` encodes the inverse (writes `type` + `cid`). String-backed enums (`Model`/`AutonomyPolicy`/`SessionSource`/`SessionStatus`/`PermissionDecision`) use an `.unknown(String)` fallback. `input/updatedInput` → a recursive `JSONValue` enum for lossless round-trip.

**3.2 WebSocketClient** wraps `URLSessionWebSocketTask`: **re-arm `receive` after every message** (recursive read loop); `sendPing` (completion-handler only — wrap it) every ~20 s; **tear down & recreate the task on any error/failed ping** (do NOT rely on self-heal — iOS 18 has a sticky `notConnectedToInternet` after Wi-Fi↔cellular). `send(cmd)` registers a `cid → CheckedContinuation` for `await ack`; `command.error` throws into it. Decode failures logged, not fatal. `ReconnectController`: backoff+jitter, cap ~30 s; on reconnect replays `session.attach{lastSeq}` per open session.

**3.3 State store** — one `@Observable AppStore`: `SessionStore`, `BudgetStore` (derives `warn` + Opus%), `ConversationStore` (ordered `[ConversationEvent]`, persisted `lastSeq`, streaming-delta buffer, pending permission). `seq` discipline: advance only on `seq == lastSeq+1`; gap → re-attach. Platform-agnostic; the entire UI contract — what makes Mac/iOS share ~all non-view code.

## 4. macOS app
`NavigationSplitView` (sidebar = sessions, detail = workspace). ⌘1…9 / ⌘[ ⌘] switch sessions via a `CommandMenu`. Sidebar rows (title, branch ahead/behind, status pill, dirty count, tokens) + **persistent budget gauge** (amber/red on `Budget.warn`); new-session sheet (existing-dir vs fresh-worktree + base/model/autonomy) → `session.create`. Workspace: resizable split — conversation primary; contextual right region (reader/files/worktree/terminal as tabs); reader appears only when there's markdown (§8.2 primacy); worktree from `Session.git`.
**WebView host** (`NSViewRepresentable`): `allowsContentJavaScript=true` (mermaid) under strict CSP; **local content via `WKURLSchemeHandler`** (`anvil-bundle://`) — favored over `loadFileURL` (cross-origin/`fetch` restrictions; an iOS 18.2 beta `loadFileURL` regression). Inject/morph `RenderedMarkdown.html` via a `window.anvil.applyEvent(...)` API (never full `innerHTML`); deltas morph the trailing block (idiomorph+Streamdown); `assistant.message` swaps in authoritative HTML. **Select-to-cite:** JS → `WKScriptMessageHandlerWithReply` (`citeSelection`) → `Cite` → next `PromptSendCmd.cites`. **Process-termination:** `webViewWebContentProcessDidTerminate` → reload + replay HTML from `ConversationStore` + restore scroll. **Input:** `TextEditor`/`NSTextView`-backed; Enter sends, Shift+Enter newline. **Paste/drag-drop:** `onPasteCommand`/`.dropDestination` → REST `POST …/attachments` → `AttachmentRef` → `attachmentIds`; reader images from `binaryUrl`.

## 5. iOS/iPadOS adaptation
**Fully shared:** all of `AnvilCore` + the WebView render contract + the select-to-cite JS bundle. **Mostly shared:** WebView host becomes `UIViewRepresentable` (same config/bridge/termination recovery); composer/rows/panes reuse SwiftUI bodies. **iOS-specific:** layout by size class (iPad regular + Fold inner = side-by-side `NavigationSplitView`; iPhone/compact = single column, reader/files/worktree/terminal as bottom tabs/drawer — everything reflows); keyboard (no Shift+Enter on phone → explicit newline + send button; hardware-keyboard iPad keeps it); drag-drop/paste (iPad system DnD, iPhone paste/pickers; same REST path); push entitlement + `UIApplication` foreground/background lifecycle (suppress/restore WS, re-attach on foreground); terminal IME accessory bar (SwiftTerm iOS front-end).

## 6. Terminal (SwiftTerm)
SwiftTerm (MIT, actively maintained): UI-agnostic engine + AppKit/UIKit front-ends; wrap each in `NS/UIViewRepresentable`. Integration: pane open → `terminal.open{cols,rows}`; `terminal.data` → base64-decode → `feed(...)`; `terminal.exit` → show state + reopen; SwiftTerm delegate data → base64 → `terminal.input`; resize → `terminal.resize` (last-attach-wins); mode swap monospace+key accessory while focused; PTY is server-side/persistent, client just replays scrollback.

## 7. Push (APNs)
Client: `UNUserNotificationCenter` auth → `registerForRemoteNotifications` → token in `didRegister…DeviceToken` → `push.register{platform:"apns", token}`; suppress redundant push while WS live (daemon does it; client keeps token current + uses in-app events foregrounded); tap → deep-link → reconnect → `session.attach`. Fires on `permission.request` + `result`.
Server (daemon, documented for the counterpart): **token-based `.p8`** (no expiry) → ES256 JWT `{alg:ES256,kid}` / `{iss:TeamID, iat}`, reuse ≤1 h; **HTTP/2** `POST https://api.push.apple.com/3/device/<token>` (sandbox host in dev), headers `authorization: bearer <jwt>`, `apns-topic: <bundle id>`, `apns-push-type: alert`, `apns-priority: 10`. Bun HTTP/2 or `@parse/node-apn`/`apns2`. Additive — system works over Tailscale without it.

## 8. Implementation steps (Mac first)
- **M0 spikes:** `WKURLSchemeHandler` serving the bundle (confirm CSS/JS/mermaid + CSP on current Xcode — watch the iOS-17/Xcode-15.3 CSS-under-custom-scheme regression); `URLSessionWebSocketTask` read-loop + heartbeat + recreate-on-failure across a Wi-Fi→cellular switch; `WKScriptMessageHandlerWithReply` round-trip.
- **M1** `AnvilCore` protocol layer + golden-file decode tests from `protocol.ts` + unknown-enum fallbacks.
- **M2** `AnvilCore` net + state (WS, `cid await ack`, REST, reconnect/resume, stores, `seq` persistence). Headless integration vs daemon.
- **M3** macOS shell (`NavigationSplitView`, sidebar, gauge, ⌘-switch, create sheet) — plain-text conversation to validate wiring.
- **M4** macOS WebView surface (scheme handler, CSP, delta morph, authoritative swap, termination recovery + scroll).
- **M5** input + attachments + reader (`fs.watch`/`fs.changed`) + select-to-cite + worktree/files.
- **M6** terminal (SwiftTerm AppKit) + APNs + deep-link. **macOS daily-driver complete.**
- **M7** iOS target: reuse core; `UIViewRepresentable` host; adaptive layout; iOS keyboard/paste/DnD; SwiftTerm UIKit + key bar; APNs lifecycle. Ship iPhone, then validate iPad side-by-side.

## 9. Dependencies (SPM)
| Package | Version | License | Use |
|---|---|---|---|
| **SwiftTerm** (`migueldeicaza/SwiftTerm`) | latest tag | MIT | terminal engine + AppKit/UIKit front-ends |
| (none) | — | — | WS = Foundation `URLSessionWebSocketTask`; WebView = WebKit; push = UserNotifications |
| Bundled JS (ships in WebView bundle, from daemon pipeline) | — | mermaid MIT / idiomorph BSD-2 / KaTeX MIT | rendering |
Deliberately tiny client dependency surface; SwiftTerm is the only external Swift package.

## 10. Key flows
Connect/resume (`session.list`+`budget` → `session.attach{lastSeq}` per open session → replay/snapshot; recreate task on drop). Send prompt (REST attachments first → `prompt.send{text,attachmentIds,cites,cid}` → `message.user`→`delta`→cards→`message`(swap)→`result`; `cid` resolves continuation). Permission (`permission.request{suggestions}` → APNs if no live device → native dialog → `permission.respond`; `allow_always` persists server-side). Select-to-cite (selection → `data-line` → `citeSelection` reply handler → `Cite` → `cites`). Push (ES256 JWT → `api.push.apple.com` → tap → foreground → reconnect → attach; suppressed while WS live).

## 11. Risks & open questions
- **Local-content loading regressions** (custom-scheme CSS/JS; `loadFileURL` iOS-18.2 beta) — M0 confirms on the shipping toolchain; keep a `loadFileURL` fallback spike. (med)
- **WS recovery after network transitions** — recreate, don't reuse; verify real Wi-Fi↔cellular. (med-high)
- **`sendPing` no async** — wrap; minor. (low)
- **Streaming morph fidelity** (idiomorph+Streamdown) — highest-effort WebView piece; flicker/scroll/selection bugs are the residual cost. (med)
- **Protocol drift** — Swift mirror is hand-written; golden-file decode tests mandatory; unknown values degrade. (med)
- **Open:** does the daemon serve the WebView bundle (download/cache) or do clients ship a pinned copy (version-skew contract)? Exact APNs payload (alert text, `mutable-content`, deep-link `sessionId`). Attachment size limits + REST auth over Tailscale serve (inherits WS auth?).

## 12. Cross-references
Architecture §3, §4, §5, §6, §7, §8.x, §9, §10 phases 4–5, §11 #3/#5/#8/#10/#13/#14, §13. Protocol: `Envelope`/`SessionScoped`, the unions, `RenderedMarkdown`/`Cite`, `Budget`, `PermissionRequestEvent`/`PermissionRespondCmd`, `PushRegisterCmd`, `terminal.*`, `rest`.
Sources (2026): URLSessionWebSocketTask patterns/reconnect; WKWebView local content (scheme-handler vs loadFileURL); `allowsContentJavaScript`; `WKScriptMessageHandlerWithReply`; process-termination recovery; SwiftTerm; APNs token auth + sending requests.
