# Anvil Implementation Plan — Markdown Rendering Pipeline & WebView Bundle
**Phase:** 1 (daemon side) + 2 (bundle) | **Depends on:** daemon core, protocol.ts | **Status:** draft

## 1. Scope & goal

Two halves of Anvil's markdown rendering subsystem:

1. **Daemon-side render pipeline** (TS/Bun, in `anvild`): raw markdown → `RenderedMarkdown { source, html }` via `markdown-it` → Shiki → KaTeX → DOMPurify, with `data-line` source attributes preserved for select-to-cite. An MVP deliverable per §10.1.
2. **Shared client-side WebView bundle**: one self-contained `index.html` + CSS + JS shipped inside every native shell (SwiftUI/Compose), loaded from a **local, opaque origin** (no network), that receives `RenderedMarkdown` (and raw `assistant.delta` text), renders it, streams it without flicker via DOM morphing + block caching, runs mermaid in-process under strict CSP, and exposes a select-to-cite bridge back to native.

Goal: **one rendering pipeline across Mac/iOS/Android** (Decision #13) for *both* conversation message bodies and the on-demand markdown reader pane (§8.2), with mermaid fidelity (#14) and source-accurate citing.

Out of scope: native shell navigation/layout/input, session list, terminal widget, file-tree UI, the daemon's Agent SDK integration, the WS transport. This plan consumes those.

## 2. Decisions inherited (cite §8.3, protocol types)

- **§8.3 / #13**: render once in the daemon, display in a scoped read-only WebView, for *all* markdown surfaces (chat bubbles + reader pane).
- **§8.3 pipeline**: `markdown-it` (emit `data-line`) → **Shiki** (server-side code) → **KaTeX `renderToString`** (server-side math) → **DOMPurify/rehype-sanitize**. Output `RenderedMarkdown`.
- **§8.3 / #14**: **mermaid.js in the WebView** with `securityLevel:'strict'` + CSP nonce. **Never `'loose'`**.
- **§8.3 hardening**: CSP via `<meta>`; Apple `allowsContentJavaScript` + `WKScriptMessageHandler`; Android **no `addJavascriptInterface`** → `addWebMessageListener` + origin check, `setAllowFileAccess(false)`, opaque/null base; `onRenderProcessGone`/`webViewWebContentProcessDidTerminate` → reload + restore scroll.
- **§8.3 streaming**: never re-`innerHTML`; morphdom/idiomorph + Streamdown block caching; auto-scroll gated on pin-to-bottom.
- **Protocol**: `RenderedMarkdown{source,html}`; `ContentBlock`; `assistant.delta` = **raw text** (client renders incrementally); `assistant.message` = **authoritative server HTML** (replaces draft); `message.user` & `FsChangedEvent.content.markdown` also `RenderedMarkdown`; `Cite{path,startLine,endLine,excerpt}` 1-based inclusive → `PromptSendCmd.cites`.

**Contract decision (validated, kept):** the daemon streams **raw text deltas** rendered client-side; the finalized turn arrives as **authoritative server HTML** and is swapped in. Rationale in §5.

## 3. Daemon-side pipeline

`render/markdown.ts` exporting `renderMarkdown(source): RenderedMarkdown`. Pure, no DOM, no network.

- **Stage 0 — warmup (boot once).** Shiki **fine-grained bundle** (`createHighlighterCore` + `shiki/engine/javascript` + curated langs: ts/tsx/js/python/rust/bash/json/yaml/markdown/diff/html/css/sql/go/swift/kotlin + `github-light`/`github-dark`). Never `shiki/bundle/full` (6.4 MB). Runs in the daemon → bundle size is a memory/startup concern only, never shipped to the device. KaTeX has no warmup.
- **Stage 1 — markdown-it → HTML + `data-line`.** `markdown-it({html:false, linkify:true, typographer:true})` (`html:false` is the first sanitize layer). A core rule sets `token.attrSet('data-line', "<start>,<end>")` from `token.map` on opening block tokens — the VS Code preview scroll-sync mechanism. **Emit both start and end** (two-value) so cite end-ranges are exact without sibling inference.
- **Stage 2 — Shiki fences.** Override `fence` → `codeToHtml(code, {lang, themes:{light,dark}})`. **Dual-theme** output (CSS vars) so the bundle flips theme with zero re-render. Unknown langs fall back to `text`. Carry `data-line` onto `<pre class="shiki">`.
- **Stage 3 — KaTeX `renderToString`.** Inline/block rule → `katex.renderToString(tex, {displayMode, throwOnError:false, strict:'warn', trust:false, output:'htmlAndMathml'})`. **`trust:false` mandatory** (CVE-2025-23207, fixed ≥ 0.16.21). Pin **katex ≥ 0.16.21**. KaTeX CSS + fonts bundled into the WebView, not fetched.
- **Stage 4 — sanitize.** **DOMPurify** (daemon via jsdom/Bun DOM); chosen over `rehype-sanitize` (maintenance). Pin **dompurify ≥ 3.4.x**. `ALLOWED_TAGS`/`ADD_ATTR` keep KaTeX/MathML, Shiki `pre/code/span`+inline `style`, task-list checkboxes, and `data-line`/`data-*`. **Mermaid emitted only as inert `<pre class="mermaid" data-line>` text** — SVG generated in the WebView (§6). `source` = verbatim raw markdown.
- **Caching.** LRU keyed on content hash of `source`. Critical for snapshot replay and `fs.changed` re-renders. Store the rendered `RenderedMarkdown` alongside finalized assistant turns in the event log so snapshot replay is a cache read. Daemon renders authoritative HTML for **whole/finalized** content only (`assistant.message`, `message.user`, `fs.changed`, snapshot) — **never per-delta**.

## 4. WebView bundle

```
webview-bundle/
  index.html   # shell loaded at opaque/null origin; CSP <meta>; nonce'd scripts; <main id="root">
  app.js       # bridge, render loop, morph, block cache, scroll, cite
  vendor.js    # idiomorph + mermaid (pinned), one nonce'd <script>
  styles.css   # prose + code + KaTeX theme (light/dark via :root[data-theme])
  katex.css ; fonts/
```

Load locally only — Apple `WKURLSchemeHandler`/`loadHTMLString`; Android `WebViewAssetLoader` (`https://appassets.androidplatform.net`, a checkable origin satisfying CSP `'self'`).

**Render loop.** A state machine driven by native messages. Maintains *surfaces* (one for the conversation transcript, one per open reader pane) addressed by `surfaceId`; each holds rendered blocks (the cache) + scroll/pin state. On `render` (authoritative): parse into a detached `<template>`, **idiomorph** the live surface (`morphStyle:'innerHTML'`) — preserves scroll/selection — then run the mermaid pass on new `pre.mermaid`. Idiomorph over morphdom (HTMX/Turbo-proven id-set matching).

**Theming.** `:root[data-theme]`; proportional prose font stack, monospace code stack; Shiki dual-theme vars recolor with no re-render; `setFontScale` maps to `:root` font-size. Fully reflowable (the §1 point).

**JS↔native bridge — exact shapes.**
```ts
type ToBundle =
  | { t:"render";    surfaceId; mode:"authoritative"; html }   // assistant.message / message.user / fs.changed / snapshot
  | { t:"delta";     surfaceId; text }                          // append raw markdown (assistant.delta)
  | { t:"deltaEnd";  surfaceId }
  | { t:"reset";     surfaceId }
  | { t:"theme";     theme:"light"|"dark" }
  | { t:"fontScale"; scale }
  | { t:"scrollTo";  surfaceId; line?; y? }                     // restore after process-death / scroll-sync
  | { t:"config";    mermaidEnabled }
type FromBundle =
  | { t:"ready"; protocol:1 }
  | { t:"cite"; surfaceId; startLine; endLine; excerpt }
  | { t:"scrollState"; surfaceId; pinnedToBottom; y; topLine }
  | { t:"link"; href }
  | { t:"size"; surfaceId; contentHeight }
  | { t:"error"; message }
```
`surfaceId` opaque, assigned by native (`"transcript"`, `"reader:<path>"`). The bundle never originates network or storage.

## 5. Streaming render

**Contract kept:** deltas = raw markdown text rendered client-side; finalized = authoritative server HTML swapped in. Rationale: streaming pre-rendered HTML fragments would re-run sanitize/Shiki/KaTeX per chunk (O(n²)) and ship far more bytes; the web stack already solved incremental markdown (Streamdown). Bundle gives instant feedback; the daemon's authoritative HTML (Shiki+KaTeX+full sanitize) replaces it on `deltaEnd`/`render`. Daemon stays single source of truth.

**Block caching (Streamdown).** Accumulate raw text, split at block boundaries; completed blocks parsed once and cached; only the **trailing growing block** re-parsed per delta — O(n).

**Incomplete-syntax repair.** Run a **remend**-style termination pass before parsing the trailing block (auto-close fences/bold/links/tables) so a half-streamed ` ```ts ` doesn't render literally.

**Client markdown engine.** A **minimal markdown-it** build for the trailing block only (no Shiki, no KaTeX mid-stream). All delta-produced HTML passes through **DOMPurify in the bundle** (model output is untrusted). idiomorph merges new blocks so completed blocks never re-mount.

**Swap to authoritative.** On `deltaEnd` + `render`, idiomorph the whole surface to the daemon HTML (no flash; correct Shiki/KaTeX/mermaid appears).

**Scroll / pin-to-bottom.** Track `pinnedToBottom` per surface (within ~32px); auto-scroll only when pinned; if scrolled up, deltas accumulate with an optional "jump to latest". `scrollState` posted on settle for process-death restore.

## 6. Mermaid & math

**Math** fully server-side (§3.3); bundle ships only `katex.css` + fonts, does nothing at runtime (mid-stream shows raw `$…$` until the authoritative swap).

**Mermaid** is the one content-derived JS execution, in the WebView only (the daemon can't render mermaid without a headless browser). Pin **mermaid ≥ 11.10.0** (target 11.15.x; floor fixes CVE-2025-54881). `mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme})` once. **`'strict'` non-negotiable** (`'loose'` → CVE-2026-54011 stored XSS). Render explicitly per `pre.mermaid` via `await mermaid.render(id, el.textContent)`; never `mermaid.run()` with HTML labels. Source arrives inert (DOMPurify-passed); strict + CSP means even a crafted diagram can't execute script. Theme flip re-runs the mermaid pass (SVGs aren't CSS-var themable).

## 7. Select-to-cite bridge

Bundle resolution (shared): on `selectionchange`/`mouseup`/`touchend`, `getSelection()`; for anchor and focus nodes, `closest('[data-line]')`; with the two-value `data-line="start,end"` the bundle has exact ranges; convert markdown-it 0-based to protocol **1-based inclusive**; `excerpt = selection.toString()`; post `{t:"cite", surfaceId, startLine, endLine, excerpt}`.

**Apple:** `userContentController.add(handler, name:"anvil")`; bundle calls `webkit.messageHandlers.anvil.postMessage`. `allowsContentJavaScript` on. Native→bundle via `evaluateJavaScript("window.anvil.receive(...)")`.

**Android:** **no `addJavascriptInterface`**; `WebViewCompat.addWebMessageListener(view, "anvilNative", setOf(allowedOrigin), listener)` where `allowedOrigin = appassets.androidplatform.net` (so the origin check is meaningful — prefer this over `null`). Bundle calls `anvilNative.postMessage(JSON.stringify(...))`; `onPostMessage` verifies `sourceOrigin`. Native→bundle via `replyProxy.postMessage` or `evaluateJavascript`.

Terminates in `PromptSendCmd.cites?` — no protocol change.

## 8. Security & hardening

**CSP (`<meta>`):**
```
default-src 'none'; script-src 'self' 'nonce-<RANDOM>'; style-src 'self' 'unsafe-inline';
img-src 'self' data: <daemon-asset-origin>; font-src 'self'; connect-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none';
```
`script-src` allows only same-origin bundle scripts + a per-load nonce; no inline script from content can match. `style-src 'unsafe-inline'` required by Shiki inline vars + mermaid SVG (scripts remain nonce-locked; tighten to hashes later). `connect-src 'none'` enforces no-network structurally.

**Sanitization (defense in depth):** markdown-it `html:false`; DOMPurify in the daemon (authoritative); DOMPurify in the bundle (deltas). Mermaid `strict`; KaTeX `trust:false` ≥0.16.21.

**WebView config:** Apple `allowsContentJavaScript=true`, non-persistent data store, link clicks intercepted (`decidePolicyFor` → `{t:"link"}`, cancel). Android JS on, `setAllowFileAccess(false)`, `setAllowContentAccess(false)`, file-URL access off, no `addJavascriptInterface`, `shouldOverrideUrlLoading` → `{t:"link"}`+true.

**Process-death recovery.** Bundle posts `scrollState`; native persists last `render` html + scroll. Android `onRenderProcessGone` → return true, recreate/reload, replay `render`, `scrollTo`. Apple `webViewWebContentProcessDidTerminate` → reload, on `ready` replay + `scrollTo`. Bounds the only residual WebView risk.

## 9. Implementation steps
- **M1 (Phase 1, daemon)** markdown-it+`data-line` rule → Shiki dual-theme fence → KaTeX `trust:false` → mermaid passthrough → DOMPurify; LRU cache; store rendered form in the log. Golden-HTML + sanitizer + `data-line` tests.
- **M2 (Phase 2)** bundle skeleton (esbuild/Bun), CSP+nonce, bridge envelope, authoritative `render` via idiomorph, theming, link interception, mermaid strict init.
- **M3** streaming: block splitter + cache, remend repair, minimal client markdown-it + bundle DOMPurify, delta/deltaEnd, authoritative swap, pin-to-bottom.
- **M4** per-platform bridges + hardening: Apple `WKScriptMessageHandler`/`loadHTMLString`; Android `WebViewAssetLoader`+`addWebMessageListener`; select-to-cite → `cites`; process-death recovery. E2E: stream code+math+mermaid, cite, kill render process, confirm restore.

## 10. Dependencies
| Lib | Floor | Where | License |
|---|---|---|---|
| markdown-it | 14.x | daemon + bundle (minimal) | MIT |
| @shikijs/core+langs+themes | 1.x/3.x | daemon only | MIT |
| katex | **≥ 0.16.21** | daemon (render) + bundle (CSS/fonts) | MIT |
| dompurify | ≥ 3.4.x | daemon (jsdom) + bundle | Apache-2.0/MPL dual |
| jsdom (or Bun DOM) | current | daemon | MIT |
| mermaid | **≥ 11.10.0** (target 11.15) | bundle only | MIT |
| idiomorph | 0.3.x+ | bundle | BSD-2 |
| remend (or inlined) | latest | bundle | Apache-2.0 |
| esbuild/Bun | current | build | MIT |

## 11. Risks & open questions
- **`data-line` end-range** — solved by the two-value `start,end` form (recommended, tiny render-rule change).
- **Inline-token line mapping** — `token.map` is block-level; sub-paragraph selections resolve to the block line. Acceptable for cite; document.
- **Mid-stream fidelity gap** — deltas show plain code / raw `$…$` until the authoritative swap (by design). Verify it reads acceptably. Alternative (stream HTML fragments) rejected: O(n²), heavier.
- **`style-src 'unsafe-inline'`** required by Shiki/mermaid; hashed styles a future hardening item.
- **Mermaid theme re-render** on light/dark flip — fine for a few diagrams; measure in diagram-dense docs.
- **Android opaque origin vs origin check** — use `WebViewAssetLoader` (real origin) not `loadDataWithBaseURL(null)` so the check stays meaningful.
- **DOMPurify in two places** — factor the allow-list into a shared constant compiled into both.
- **No metering creep** — rendering is pure-local; never let a "summarize with a model" call into the render path without its own metered key (arch §3).

## 12. Cross-references
- Architecture §8.2, **§8.3**, §9, §10.1–10.2, §11 #13/#14, §13.
- Protocol: `RenderedMarkdown`, `ContentBlock`, `ConversationEvent`, `Cite`, `FileContent.markdown`, `AssistantDeltaEvent`, `AssistantMessageEvent`, `MessageUserEvent`, `FsChangedEvent`, `PromptSendCmd.cites`.
- Sources (2026): markdown-it `token.map`/`data-line` (markdown-it 14 API, vscode#133376); Shiki fine-grained bundle/sizes; KaTeX `renderToString`/`trust`/CVE-2025-23207→0.16.21; mermaid 11.15/`strict`/CVE-2025-54881→11.10.0/CVE-2026-54011; idiomorph (HTMX/Turbo); Streamdown/remend; DOMPurify 3.4.x; Android `addWebMessageListener`.
