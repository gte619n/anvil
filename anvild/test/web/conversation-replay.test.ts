/**
 * [WEB2-9] Guard: snapshot replay is batched. Replaying a full-history snapshot used to call
 * scrollDown() for EVERY appended message — each one a forced layout (scrollHeight read +
 * scrollTop write) over an ever-growing pane, so a large transcript was O(n²) and froze the tab.
 * Replay now suppresses the per-message scroll (gated on `ui.replayingSnapshot`) and main's
 * conversation.snapshot handler issues ONE scroll at the end.
 *
 * The test replays a 1000-event snapshot through the same renderers main.ts uses and asserts, via
 * instrumented scrollTop/scrollHeight accessors on the #conversation element, that the whole replay
 * costs ≤2 layout read/write cycles — while the rendered messages stay complete and in order.
 *
 * conversation.ts touches the DOM at import time ($("#conversation") etc.), so the DOM is installed
 * first and the module loaded via dynamic import (same pattern as dialogs.test.ts).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import type { ContentBlock } from "../../protocol";

let convo: typeof import("../../web/src/conversation");
let state: typeof import("../../web/src/state");

const HTML = `<!doctype html><html><body>
  <div id="conversation"></div>
  <button id="scroll-bottom" hidden></button>
  <button id="stop" hidden></button>
  <div id="toast"></div>
  <div id="modal-root"></div>
  <div id="menu-root"></div>
</body></html>`;

// Layout-access counters on the live #conversation element (installed per test via instrument()).
let layoutReads = 0;
let layoutWrites = 0;
function instrument(el: HTMLElement): void {
  layoutReads = 0;
  layoutWrites = 0;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get() {
      layoutReads++;
      return 10_000;
    },
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get() {
      layoutReads++;
      return 0;
    },
    set() {
      layoutWrites++;
    },
  });
}

beforeAll(async () => {
  installDom({ html: HTML });
  convo = await import("../../web/src/conversation");
  state = await import("../../web/src/state");
  // Minimal injected deps — only what the exercised render paths reach.
  convo.initConversation({
    activeId: () => "s1",
    activeServer: () => ({ url: "https://hub.test" }) as never,
    sessions: new Map(),
    environments: new Map(),
    snapshotLoaded: new Set(),
    saveConvoCache: () => {},
    setStatus: () => {},
    panelView: () => null,
    renderLinks: () => {},
  });
});
afterAll(() => uninstallDom());

const md = (html: string): ContentBlock => ({ kind: "markdown", rendered: { source: html, html } });

/** Replay `n` events through the same renderers main's renderSnapshotEvents uses, mirroring the
 *  conversation.snapshot handler's batching envelope (flag → replay → flag off → one scroll). */
function replay(n: number): void {
  convo.clearConversation();
  state.ui.replayingSnapshot = true;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) convo.appendUser(`<p>user ${i}</p>`, [], "2026-08-01T00:00:00Z");
    else if (i % 10 === 5) convo.appendToolResult(`tool output ${i}`, false); // folds into the activity block
    else convo.commitAssistant([md(`<p>assistant ${i}</p>`)], "2026-08-01T00:00:01Z");
  }
  state.ui.replayingSnapshot = false;
  convo.scrollDown();
  convo.finalizeActivity();
}

test("[WEB2-9] a 1000-event snapshot replays with ≤2 layout read/write cycles", () => {
  const el = convo.conversation;
  instrument(el);
  state.ui.stickToBottom = true;
  replay(1000);
  // One scrollHeight read + one scrollTop write for the entire replay (the single batched scroll).
  expect(layoutReads + layoutWrites).toBeLessThanOrEqual(2);
  expect(layoutWrites).toBe(1); // the final scroll DID land at the bottom
});

test("[WEB2-9] batching preserves message count, order, and activity folding", () => {
  const el = convo.conversation;
  instrument(el);
  replay(1000);
  const users = el.querySelectorAll(".bubble.user");
  const assistants = el.querySelectorAll(".bubble.assistant");
  expect(users.length).toBe(500);
  expect(assistants.length).toBe(400); // 100 odd slots (i%10===5) fold into activity blocks instead
  expect(users[0]!.textContent).toContain("user 0");
  expect(users[499]!.textContent).toContain("user 998");
  expect(assistants[399]!.textContent).toContain("assistant 999");
  // Interleaving preserved: each assistant bubble immediately follows its user turn.
  const kids = [...el.children];
  const iUser0 = kids.findIndex((c) => c.textContent?.includes("user 0"));
  const iAsst1 = kids.findIndex((c) => c.textContent?.includes("assistant 1"));
  expect(iAsst1).toBe(iUser0 + 1);
  // Tool results were reconstructed into consolidated activity blocks, finalized to "Worked".
  const activities = el.querySelectorAll("details.activity");
  expect(activities.length).toBe(100);
  expect(el.querySelectorAll("details.activity.live").length).toBe(0);
});

test("[WEB2-9] live (non-replay) appends still follow the bottom per message", () => {
  const el = convo.conversation;
  convo.clearConversation();
  instrument(el);
  state.ui.stickToBottom = true;
  convo.appendUser("<p>hi</p>", [], "2026-08-01T00:00:00Z");
  expect(layoutWrites).toBeGreaterThanOrEqual(1); // the ungated path scrolls as before
});
