// ── Native shell bridge + Web Push (arch §6.7) ────────────────────────────────
// The native Android/Apple shells inject `window.AnvilNative` for ADB-wifi connect and platform
// push (FCM/APNs); the plain web build falls back to a service worker + Web Push. This module owns
// both the bridge handle and the web-push subscription lifecycle (the bell button).
//
// It imports `toast`/`selectSession`/`sessions` back from main.ts. That's an import cycle, but a
// safe one: those symbols are only touched inside event/click handlers that fire at runtime, never
// while this module is evaluating, so the live bindings are always resolved by the time they run
// (the headless smoke test guards the load-order assumption).
import { apiFetch } from "./api";
import { $, icon } from "./dom";
import { selectSession, sessions, toast } from "./main";

// Native Android/Apple shell bridge (present only inside the app): ADB-wifi connect, native push.
export const nativeBridge: { postMessage(s: string): void; onmessage?: (e: MessageEvent) => void } | undefined = (window as unknown as { AnvilNative?: typeof nativeBridge }).AnvilNative;
// The Android WebView shell can't host a second window (no onCreateWindow / multi-window support), so
// window.open() there is a dead end (a chrome-less, Back-less, unscrollable takeover). The reader's
// "pop out" therefore opens an in-app full-screen overlay on Android instead of a standalone window
// (macOS gets a real NSWindow, the web a real tab). The Apple shell doesn't expose AnvilNative, so
// this matches the Android app specifically, not Mac.
export const isAndroidApp = !!nativeBridge && /Android/i.test(navigator.userAgent);
if (nativeBridge) {
  nativeBridge.onmessage = (e) => {
    try {
      const r = JSON.parse(e.data) as { ok?: boolean; message?: string };
      const out = document.getElementById("adb-output");
      if (out) out.textContent = `${r.ok ? "✓ " : "⚠ "}${r.message ?? ""}`;
      else toast(r.message ?? "done");
    } catch {
      /* ignore */
    }
  };
}

// ── Web Push (arch §6.7) ──────────────────────────────────────────────────────────
let swReg: ServiceWorkerRegistration | null = null;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function urlB64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
export async function initPush(): Promise<void> {
  if (nativeBridge) return; // native shells use platform push (FCM/APNs), not web push / service worker
  if (!pushSupported) return; // unsupported (e.g. iOS Safari until installed as a PWA)
  const bell = $("#btn-notify");
  bell.hidden = false;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
  } catch {
    bell.hidden = true;
    return;
  }
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-session" && e.data.sessionId && sessions.has(e.data.sessionId)) selectSession(e.data.sessionId);
  });
  bell.addEventListener("click", () => void toggleNotify());
  void refreshBell();
}
async function refreshBell(): Promise<void> {
  const sub = await swReg?.pushManager.getSubscription();
  const on = Notification.permission === "granted" && !!sub;
  const bell = $("#btn-notify");
  bell.innerHTML = icon(on ? "notifications_active" : "notifications_off");
  bell.classList.toggle("active", on);
}
async function toggleNotify(): Promise<void> {
  if (!swReg) return;
  const existing = await swReg.pushManager.getSubscription();
  if (existing) {
    await apiFetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: existing.endpoint }) });
    await existing.unsubscribe();
    toast("Notifications off");
  } else {
    if ((await Notification.requestPermission()) !== "granted") {
      toast("Notifications blocked in browser settings");
      return;
    }
    const { publicKey } = (await (await apiFetch("/api/push/key")).json()) as { publicKey: string };
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
    await apiFetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
    toast("Notifications on");
  }
  void refreshBell();
}
