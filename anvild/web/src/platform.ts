// ── Native-shell platform detection (leaf) ────────────────────────────────────
// `nativeBridge`/`isAndroidApp` used to live in push.ts — which imports main.ts back (notification
// taps route through selectSession), so every module that only wanted the PLATFORM FLAGS
// (conversation.ts, panel.ts, settings.ts) transitively pulled the whole app through that cycle,
// making them impossible to import in isolation (jsdom guard tests). The flags are dependency-free,
// so they live here; push.ts keeps the bridge *behavior* (message handler, web-push lifecycle).

// Native Android/Apple shell bridge (present only inside the app): ADB-wifi connect, native push.
export const nativeBridge: { postMessage(s: string): void; onmessage?: (e: MessageEvent) => void } | undefined = (
  window as unknown as { AnvilNative?: typeof nativeBridge }
).AnvilNative;

// The Android WebView shell can't host a second window (no onCreateWindow / multi-window support), so
// window.open() there is a dead end (a chrome-less, Back-less, unscrollable takeover). The reader's
// "pop out" therefore opens an in-app full-screen overlay on Android instead of a standalone window
// (macOS gets a real NSWindow, the web a real tab). The Apple shell doesn't expose AnvilNative, so
// this matches the Android app specifically, not Mac.
export const isAndroidApp = !!nativeBridge && /Android/i.test(navigator.userAgent);
