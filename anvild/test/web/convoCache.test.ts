import { test, expect, beforeAll, afterAll } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";
import { convoCache, migrateLegacyConvoCache } from "../../web/src/convoCache";

// jsdom provides localStorage but NOT indexedDB, so these exercise the in-memory + index fallback —
// which is exactly the same call surface main.ts uses, so the behavioural contract is covered.
beforeAll(() => installDom());
afterAll(() => uninstallDom());

test("set/get round-trips the stamped entry and has() is a synchronous hint", async () => {
  await convoCache.set("s1", "<p>hello</p>", 7, "ep1");
  expect(convoCache.has("s1")).toBe(true); // sync — drives the attach decision before get() resolves
  expect(await convoCache.get("s1")).toEqual({ html: "<p>hello</p>", seq: 7, epoch: "ep1" });
  expect(convoCache.has("s2")).toBe(false);
  expect(await convoCache.get("s2")).toBeNull();
});

test("a large transcript (>1.5MB) survives — no cliff (spec D8)", async () => {
  const big = "x".repeat(2_000_000); // would have blown the old 1.5MB localStorage cap
  await convoCache.set("big", big, 1, "ep");
  expect((await convoCache.get("big"))!.html.length).toBe(2_000_000);
  await convoCache.delete("big");
});

test("delete removes content and the index hint", async () => {
  await convoCache.set("s3", "bye", 1, "ep");
  await convoCache.delete("s3");
  expect(convoCache.has("s3")).toBe(false);
  expect(await convoCache.get("s3")).toBeNull();
});

test("[WEB2-11] keys() lists cached ids so a boot sweep can drop orphans", async () => {
  await convoCache.set("live_1", "a", 1, "ep");
  await convoCache.set("orphan_1", "b", 1, "ep");
  expect(convoCache.keys().sort()).toEqual(expect.arrayContaining(["live_1", "orphan_1"]));
  // simulate the boot sweep: forget an id no longer in the session list
  for (const id of convoCache.keys()) if (id === "orphan_1") await convoCache.delete(id);
  expect(convoCache.keys()).not.toContain("orphan_1");
  expect(convoCache.keys()).toContain("live_1");
});

test("move migrates an optimistic session's cache — stamp included — to its real id", async () => {
  await convoCache.set("temp_1", "optimistic", 4, "epX");
  await convoCache.move("temp_1", "sess_real");
  expect(await convoCache.get("sess_real")).toEqual({ html: "optimistic", seq: 4, epoch: "epX" });
  expect(await convoCache.get("temp_1")).toBeNull();
  expect(convoCache.has("temp_1")).toBe(false);
});

test("migrateLegacyConvoCache drops pre-Phase-3 localStorage blobs but keeps the index", async () => {
  localStorage.setItem("anvil.convo.old1", "<p>legacy</p>");
  localStorage.setItem("anvil.convo.old2", "<p>legacy2</p>");
  await convoCache.set("keep", "kept", 1, "ep"); // writes the index key anvil.convo.index
  migrateLegacyConvoCache();
  expect(localStorage.getItem("anvil.convo.old1")).toBeNull();
  expect(localStorage.getItem("anvil.convo.old2")).toBeNull();
  expect(convoCache.has("keep")).toBe(true); // the index survives the cleanup
});
