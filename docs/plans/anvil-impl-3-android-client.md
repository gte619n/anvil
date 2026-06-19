# Anvil Implementation Plan — Android Client
**Phase:** 2 | **Depends on:** daemon core, rendering pipeline, protocol.ts | **Status:** draft

## 1. Scope & goal

Retarget the Android app from a **Zellij web-client wrapper** into a **native Compose shell that hosts the shared daemon-rendered markdown WebView surface**, speaking the Anvil WebSocket protocol to `anvild` over Tailscale. First daily-driver client (arch §10.2).

> **CRITICAL FINDING (changes the estimate):** the existing app is **NOT Kotlin/Compose**. It is **100% Java + Android Views/XML + a multi-WebView pool** (`app/src/main/java/com/zellijconnect/app/*.java`, 26 `.java`, 0 `.kt`; `app/build.gradle` has no Kotlin/Compose plugins). So Phase 2 is a **greenfield Compose rewrite in the same Gradle module**, not an incremental refactor. ~3 Java utility classes survive; the rest is deleted/rebuilt.

In scope: native Compose shell (session list + previews + budget gauge, navigation, multi-pane workspace, Fold inner/outer + phone with live re-layout); WS client (`seq` tracking, resume, `cid`, FGS keep-alive); WebView render surface host (conversation bubbles + reader) with `addWebMessageListener` bridge + select-to-cite; native multiline input (Shift+Enter newline), paste & drag-drop → REST attachment upload; native permission dialogs; FCM push; terminal mode integration points (Phase 3); model/autonomy controls, kill, worktree panel.

## 2. Decisions inherited
- Client stack native → **Compose** (§11 #3).
- Markdown rendered once in the daemon; WebView for ALL surfaces (§8.3 #13). `RenderedMarkdown{source,html}` pre-sanitized with `data-line`.
- WebView hardening (§8.3): no `addJavascriptInterface`; `WebViewCompat.addWebMessageListener` + origin check; `setAllowFileAccess(false)`; `WebViewAssetLoader` over `appassets.androidplatform.net`; CSP; mermaid `securityLevel:'strict'`; `onRenderProcessGone` → reload + restore scroll.
- Streaming: `assistant.delta` morphed client-side; `assistant.message` authoritative.
- Resume: per-session `seq`; persist highest rendered seq; reconnect `session.attach{lastSeq}` → replay or `conversation.snapshot` (§6.4).
- No shared viewport → device switch & foldable resize are non-events.
- Push FCM + live-WS fallback (§6.7 #5/#8); suppress while WS holds the event; fires on `permission.request` and `result`.
- Permissions mostly-autonomous (§6.6); render dialogs only on escalation; `PermissionSuggestion[]` drives buttons.
- Model default Opus; budget load-bearing (§3 #9) — `budget` event prominent in the list with `warn`.
- Attachments via REST (§6.5) → `prompt.send{attachmentIds}`.
- Select-to-cite client affordance (§8.2) → `Cite` in `prompt.send.cites`.
- Terminal persistent server-side; active client owns size (§7 #10).

## 3. What we reuse vs delete

**Reuse / adapt (~3 files):**
- `KeepAliveService.java` — FGS (`FOREGROUND_SERVICE_SPECIAL_USE`, `START_STICKY`). Rebind to the WS lifecycle. **Note:** a partial wake lock was deliberately removed in commit `b022324`; do **not** reintroduce a CPU wake lock — rely on FGS + FCM.
- `IMESwitchManager.java` — `WRITE_SECURE_SETTINGS` IME swap (Unexpected Keyboard ↔ Gboard). Reuse, but **invert the trigger** (see §5 Input).
- `SetupGuideActivity.java` (+ layout) — ADB setup guide for the IME permission; reuse, keep the `isSetupComplete` gate.
- `AndroidManifest.xml` permission set, `<queries>`, FGS decl, `FileProvider`, `res/drawable/ic_claude_*`, `file_paths.xml` — reuse. Add FCM service decl. Remove `usesCleartextTraffic` if Tailscale serve gives HTTPS.
- `AppConfig.java` SharedPreferences pattern — repurpose keys (drop Zellij URL/token; add `anvild` MagicDNS host; keep IME ids).

**Delete (Zellij/web-wrapper architecture):** `MainActivity.java` (921 lines), `WebViewPool.java` (476, uses forbidden `addJavascriptInterface`), `TabManager`/`TabAdapter` + tab XML, `ClipboardBridge`/`TouchBridge`/`SafeClickMovementMethod`, `ConnectionMonitor`; **all SFTP** (`SftpManager`, `SftpHostKeyStore`, `FileBrowserView/Adapter`, `FileViewerView`, jsch) — replaced by daemon `fs.*`; **all client-side markdown** (`MermaidRenderer`/`MermaidPlugin`/`MermaidBitmapCache`, `PrismLanguages`, Markwon + prism4j deps) — daemon renders now; `SessionPickerDialog`/`SettingsDialog`/dialog XML/`SessionInfo`; `assets/mermaid/*`.

Net: Gradle module stays; dependency block rewritten.

## 4. Module/package layout
Single `:app` module (KMP out of scope — Apple shares Swift, not Kotlin). New root `com.anvil.android`:
```
App.kt, MainActivity.kt (single Compose activity, edgeToEdge, nav host)
di/  net/{protocol/(ServerEvent,ClientCommand,Domain), AnvilWsClient, ReconnectController, RestClient, ConnectionState}
data/{SessionRepository, ConversationStore, SeqStore(DataStore), BudgetRepository}
service/{KeepAliveService.kt, AnvilFcmService.kt}
ui/{theme, nav, sessionlist, workspace, conversation, reader, files, worktree, terminal, permission, controls}
webview/{RenderedMarkdownWebView, WebViewAssets, Bridge}
ime/IMESwitchManager.kt
```
assets: `assets/webview/{index.html, app.js, vendor.js, styles.css, katex/*}` — the §8.3 bundle.

## 5. Components
- **Shell/nav:** single Compose `MainActivity` (`singleTask`, edgeToEdge). `material3-adaptive` `NavigableListDetailPaneScaffold` driven by `currentWindowAdaptiveInfo().windowSizeClass`. Global connection-state + budget chrome.
- **WS client (`AnvilWsClient`):** OkHttp `WebSocket` (mature single-conn, `pingInterval` liveness; Ktor's KMP/Flow edge is moot — Android-only). `Flow<ServerEvent>` (kotlinx.serialization polymorphic on `type`) + `suspend send(cmd)`; `cid → CompletableDeferred` correlation. Lives in a singleton scope tied to the FGS, surviving navigation.
- **`ReconnectController`:** exponential backoff; on reconnect, `session.attach{lastSeq}` per known session from `SeqStore`.
- **Per-session seq:** apply event → bump persisted watermark; drop seq ≤ watermark (idempotent resume).
- **WebView host (`RenderedMarkdownWebView`):** one reusable `AndroidView<WebView>` for bubbles + reader. `WebViewAssetLoader` (`appassets.androidplatform.net`); `addWebMessageListener("anvilBridge", setOf(origin), …)`; receives daemon HTML, idiomorph-morphs; sends `ready`/`select`/`scroll`/`link`; `onRenderProcessGone` → recreate + restore scroll; CSP `<meta>`; mermaid `strict`.
- **Input (`InputBar`):** Compose `BasicTextField` multiline; **Shift+Enter = newline, Enter = send** via `onKeyEvent` (the §1 fix); paste + `Modifier.dragAndDropTarget` → REST upload → `attachmentIds` + pending `cites`. **IME (decision):** prose input uses Gboard, NOT Unexpected Keyboard, so `IMESwitchManager` is **inverted** — switch to the terminal IME only when the terminal pane is focused (Phase 3), default otherwise; dormant in Phase 2.
- **Push (`AnvilFcmService`):** on connect/token refresh → `push.register{platform:"fcm", token}`; `onMessageReceived` handles background `permission.request`/`result`, deep-links to the session; ignore a push whose `requestId`/`seq` is already rendered.
- **Panes:** Conversation (`LazyColumn`, bubble WebViews, native tool cards, status chip, interrupt); Reader (`fs.watch`/`fs.changed`, scroll-preserving, select-to-cite); Files (native tree over `fs.list`/`fs.read`); Worktree (native `GitStatus`); Terminal (Phase 3); Controls (`set_model`/`set_autonomy`/`kill`).

## 6. Multi-pane & foldable
`material3-adaptive` + `currentWindowAdaptiveInfo()` + `FoldingFeature` posture. No `configChanges` hacks fighting a grid — reflow.
- **Fold inner / tablet / landscape:** two/three-pane (conversation primary; reader when markdown open; files/worktree third/rail). Session list = list-detail leading pane.
- **Fold outer / phone:** single visible pane; reader/files/worktree/terminal as swipeable tabs/drawer.
- **Fold/unfold:** `WindowSizeClass` recomposes the scaffold; pane state in `rememberSaveable`/ViewModel so re-layout never loses place. Consume `FoldingFeature.bounds` to avoid splitting a pane across the hinge. Keep `configChanges` + `adjustResize`.

## 7. Implementation steps
Build against a stub daemon / fixtures until §10.1 is ready.
1. **M0** Gradle/Compose conversion (add Kotlin+Compose+material3-adaptive; delete Markwon/prism4j/jsch; add OkHttp, kotlinx.serialization, Coil 3, DataStore, Firebase BoM; salvage 3 Java files; blank Compose `MainActivity`). *Largest hidden cost.*
2. **M1** Protocol mirror + WS client + REST + `/api/health` display.
3. **M2** Connection lifecycle (FGS-bound WS, backoff, `SeqStore`, attach/snapshot resume).
4. **M3** Session list (`SessionCard` previews + `BudgetGauge` with `warn`) + create-session (existing-dir vs fresh-worktree).
5. **M4** WebView render surface (AssetLoader + addWebMessageListener + CSP + `onRenderProcessGone`), static then streaming morph.
6. **M5** Conversation pane E2E (bubbles, tool cards, status, `InputBar` Shift+Enter, interrupt, `prompt.send`).
7. **M6** Attachments (paste + drag-drop → REST → `attachmentIds`).
8. **M7** Permission dialogs from `suggestions[]`.
9. **M8** Reader pane + select-to-cite + `fs.watch` (hard requirement this phase).
10. **M9** Worktree panel + controls.
11. **M10** Adaptive multi-pane (incremental from M5).
12. **M11** FCM push.
13. **M12** Files pane (overlaps Phase 3).
14. **M13** Terminal pane (Phase 3): `TerminalPane` wrapping **Termux `terminal-view`** via `AndroidView`; `terminal.open/data/input/resize/close/exit`; mode switch via `IMESwitchManager` + monospace.

## 8. Dependencies (pin in `libs.versions.toml`)
| Lib | Version (2026) | License |
|---|---|---|
| Kotlin | 2.x | Apache-2.0 |
| Compose BOM + material3 | 1.4.0 | Apache-2.0 |
| material3-window-size-class + -adaptive / -navigation-suite | 1.4.0 / 1.0+ (nav-suite 1.5.x) | Apache-2.0 |
| androidx.webkit | 1.12.1→latest | Apache-2.0 |
| OkHttp | 4.12+/5.x | Apache-2.0 |
| kotlinx.serialization-json | 1.7+ | Apache-2.0 |
| androidx.datastore-preferences | 1.1+ | Apache-2.0 |
| Coil 3 (`coil-compose`,`coil-network-okhttp`) | 3.x | Apache-2.0 |
| Firebase BoM + firebase-messaging | current | Apache-2.0 (+Google services) |
| Termux `terminal-view`+`terminal-emulator` | JitPack/master | **GPL-3.0 ⚠️ (decision)** |

Deleted: Markwon 4.6.2 + ext, prism4j 2.0.0, jsch 0.2.21.
**License flag:** Termux terminal components are **GPL-3.0** → bundling makes the app GPL-3.0. Decide before Phase 3 (alt: wrap `terminal-emulator` only, or from-scratch Compose emulator — no maintained Compose-native option exists).

## 9. Key flows
- **Connect/resume:** start → FGS → dial `wss://<magicdns>` → `session.list`+`budget` → per session `session.attach{lastSeq}` → replay/snapshot; drop → backoff → re-attach.
- **Send w/ attachment:** paste image → REST upload → `AttachmentRef`; type (Shift+Enter), Enter → `prompt.send{text,attachmentIds,cites,cid}`; server echoes `message.user`, streams `delta`→cards→`message`→`result`.
- **Permission:** escalation → `permission.request{suggestions}` → (FCM if backgrounded) → native dialog → `permission.respond`.
- **Select-to-cite:** WebView selection → `data-line` → `{select,…}` via bridge → pending `Cite` → next `prompt.send.cites`.
- **Push wake:** background, WS dropped → FCM → notification → tap → reconnect → `session.attach` → reconcile; stale push for rendered `requestId` dropped.

## 10. Risks & open questions
- **Java/Views, not Compose** — biggest schedule risk; M0 is a real module rewrite.
- **Daemon dependency** — needs WS + render pipeline + `/api/health` first; mitigate with fixtures.
- **Terminal widget GPL-3.0** + no Compose-native emulator — decide in Phase 3.
- **WebView render-process termination** mid-stream — verify reload+scroll-restore under Fold memory pressure.
- **Streaming morph perf** with many bubble WebViews — lean toward a **single conversation WebView** rendering the whole transcript (better morph perf; native chrome around it) vs per-bubble.
- **IME switching** post-Android-15 with `WRITE_SECURE_SETTINGS` — confirm; inverted trigger reduces blast radius.
- **`applicationId` change** `com.zellijconnect.app`→`com.anvil.android` = clean reinstall (loses prefs/setup flag).
- **FCM = non-Tailscale cloud dep** (accepted) — needs Firebase project + `google-services.json`.
- **Push token timing** — `push.register` needs a live WS; queue on cold refresh.

## 11. Cross-references
Architecture §3/§4/§6/§6.4/§6.5/§6.6/§6.7/§7/§8.x/§9/§10/§11. Protocol: `ServerEvent`/`ClientCommand`, `Session`, `Budget`, `RenderedMarkdown`, `Cite`, `GitStatus`, `rest.*`. Original spec: `SPEC.md`. Surviving code: `KeepAliveService`, `IMESwitchManager`, `SetupGuideActivity`.
Sources (2026): WebViewAssetLoader/load-local-content; OWASP MASTG-BEST-0011; Compose material3 releases; foldable trifolds; OkHttp/Ktor WS; Termux terminal-view; Coil 3; FCM Android get-started.
