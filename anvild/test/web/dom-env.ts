/**
 * [Phase 4] Minimal DOM test harness for the web client. jsdom is already a daemon dependency (the
 * markdown pipeline uses it), so this needs no new package. Web modules touch the DOM only inside
 * functions/constructors (never at import time), so a test can import the module first and install
 * the DOM in beforeAll before exercising it.
 *
 * Bun shares globalThis across test files in a process, so DOM tests MUST uninstall in afterAll to
 * keep the daemon tests (which must not see a `window`) unaffected.
 */
import { JSDOM } from "jsdom";

const DOM_GLOBALS = ["window", "document", "location", "history", "navigator", "localStorage", "HTMLElement", "Event", "CustomEvent", "getComputedStyle"] as const;

let saved: Record<string, unknown> = {};

export function installDom(opts: { url?: string; html?: string } = {}): JSDOM {
  const dom = new JSDOM(opts.html ?? "<!doctype html><html><body></body></html>", {
    url: opts.url ?? "https://appassets.androidplatform.net/",
    pretendToBeVisual: true,
  });
  const g = globalThis as Record<string, unknown>;
  const w = dom.window as unknown as Record<string, unknown>;
  saved = {};
  for (const k of DOM_GLOBALS) {
    saved[k] = g[k];
    // location/history can be read-only accessors on some runtimes — define, don't assign.
    Object.defineProperty(g, k, { value: w[k] ?? (dom.window as any)[k], configurable: true, writable: true });
  }
  return dom;
}

export function uninstallDom(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    Object.defineProperty(g, k, { value: saved[k], configurable: true, writable: true });
  }
  saved = {};
}
