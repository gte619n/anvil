/**
 * [WEB2-6] Guard: the per-turn convo-cache save touches a bounded amount of DOM. saveConvoCache
 * used to clone + serialize the ENTIRE transcript on every (debounced) turn — 30–150ms on long
 * sessions. It now serializes through serializeTranscript(maxNodes), which clones only the last
 * `maxNodes` top-level blocks. Asserted here:
 *   - a long transcript serializes a bounded slice (clone count == cap, top-level nodes == cap,
 *     oldest content absent, newest present, order intact);
 *   - restore (innerHTML = saved html) paints exactly what was saved;
 *   - the common case (transcript under the cap) is byte-identical to the old whole-pane clone;
 *   - the cache-shaping transforms survive the cap: transient UI (thinking / empty-state) is
 *     stripped and a live activity block is frozen to "Worked" — without mutating the live pane.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

let convo: typeof import("../../web/src/conversation");
let state: typeof import("../../web/src/state");

const HTML = `<!doctype html><html><body>
  <div id="conversation"></div>
  <button id="scroll-bottom" hidden></button>
  <button id="stop" hidden></button>
  <div id="toast"></div>
</body></html>`;

beforeAll(async () => {
  installDom({ html: HTML });
  convo = await import("../../web/src/conversation");
  state = await import("../../web/src/state");
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

/** Fill the pane with `n` user bubbles (msg 0 … msg n-1). */
function fill(n: number): void {
  convo.clearConversation();
  state.ui.replayingSnapshot = true; // skip per-append scrolling; irrelevant here
  for (let i = 0; i < n; i++) convo.appendUser(`<p>msg ${i}</p>`, [], "2026-08-01T00:00:00Z");
  state.ui.replayingSnapshot = false;
}

/** Count top-level clone operations (each cloned block is one cloneNode call from serialize). */
function countingClones<T>(fn: () => T): { result: T; clones: number } {
  const NodeProto = (window as unknown as { Node: { prototype: { cloneNode(deep?: boolean): Node } } }).Node.prototype;
  const orig = NodeProto.cloneNode;
  let clones = 0;
  NodeProto.cloneNode = function (deep?: boolean): Node {
    clones++;
    return orig.call(this, deep);
  };
  try {
    return { result: fn(), clones };
  } finally {
    NodeProto.cloneNode = orig;
  }
}

test("[WEB2-6] a 1000-bubble transcript saves a bounded slice (cap = 200)", () => {
  fill(1000);
  const counted = countingClones(() => convo.serializeTranscript(200));
  const html = counted.result;
  expect(counted.clones).toBeLessThanOrEqual(200); // bounded DOM work, regardless of transcript length
  const restore = document.createElement("div");
  restore.innerHTML = html;
  expect(restore.children.length).toBe(200); // top-level blocks capped
  expect(html).toContain("msg 999"); // newest kept…
  expect(html).toContain("msg 800");
  expect(html).not.toContain("msg 799"); // …oldest dropped
  // Restore paints what was saved, in order.
  const bubbles = restore.querySelectorAll(".bubble.user");
  expect(bubbles.length).toBe(200);
  expect(bubbles[0]!.textContent).toContain("msg 800");
  expect(bubbles[199]!.textContent).toContain("msg 999");
}, 30_000); // fill(1000) is ~1.2s locally (appendUser × 1000); a loaded CI runner can exceed the 5s
// default even though the asserted work (serialize ≤200 clones) is trivial — match the sibling
// conversation-replay 1000-event tests' 30s guard so the heavy fixture setup can't flake the suite.

test("[WEB2-6] the common case (under the cap) is byte-identical to the old full clone", () => {
  fill(50);
  // The pre-WEB2-6 behavior: clone the whole pane, strip transients (none here), serialize.
  const full = (convo.conversation.cloneNode(true) as HTMLElement).innerHTML;
  expect(convo.serializeTranscript(200)).toBe(full);
});

test("[WEB2-6] the thinking indicator is stripped from the cache but stays in the live pane", () => {
  fill(300);
  convo.showThinking("thinking"); // transient indicator pinned to the bottom
  const html = convo.serializeTranscript(200);
  expect(html).not.toContain("thinking"); // transient UI never cached
  expect(html).toContain("msg 299"); // the real content around it survives
  // The LIVE pane was not mutated by serialization.
  expect(convo.conversation.querySelector(".thinking")).not.toBeNull();
  convo.hideThinking();
});

test("[WEB2-6] a live activity block is frozen to 'Worked' in the cache, live DOM untouched", () => {
  fill(300);
  convo.appendToolResult("running a tool", false); // opens a LIVE activity block (no finalize)
  const restore = document.createElement("div");
  restore.innerHTML = convo.serializeTranscript(200);
  const activity = restore.querySelector("details.activity");
  expect(activity).not.toBeNull(); // the block itself IS cached (it's within the last 200 nodes)
  expect(activity!.classList.contains("live")).toBe(false); // frozen…
  expect(activity!.querySelector(".activity-title")!.textContent).toBe("Worked"); // …as "Worked"
  // The LIVE pane was not mutated by serialization: the running turn is still live.
  expect(convo.conversation.querySelector("details.activity.live")).not.toBeNull();
});
