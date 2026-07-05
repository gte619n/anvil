/**
 * [Phase 3 / BE-8] TokenStore<T> + fanOut consolidate the byte-identical push registries (apns/fcm
 * device tokens, webpush subscriptions) and their send→collect-dead→prune skeleton, which were
 * copy-pasted across three files with zero tests. Pinning them here covers dedup, removal, atomic
 * 0600 persistence, and the dead-target collection every provider depends on.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore, fanOut } from "../../src/push/token-store";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "anvil-tokstore-")), "sub", "tokens.json");
const identity = (t: string) => t;

test("add de-duplicates by key and persists", () => {
  const f = tmpFile();
  const s = new TokenStore<string>(f, identity);
  s.add("a");
  s.add("a"); // dup — ignored
  s.add("b");
  expect([...s.list()]).toEqual(["a", "b"]);
  expect(s.size).toBe(2);
  // persisted (and the parent dir was created)
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(["a", "b"]);
});

test("registry file is written 0600 (secrets)", () => {
  const f = tmpFile();
  const s = new TokenStore<string>(f, identity);
  s.add("a");
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("remove drops by key and rewrites; no-op when absent", () => {
  const f = tmpFile();
  const s = new TokenStore<string>(f, identity);
  s.add("a");
  s.add("b");
  s.remove("a");
  s.remove("nope"); // no-op
  expect([...s.list()]).toEqual(["b"]);
});

test("a fresh store loads existing items from disk", () => {
  const f = tmpFile();
  new TokenStore<string>(f, identity).add("a");
  const reopened = new TokenStore<string>(f, identity);
  expect([...reopened.list()]).toEqual(["a"]);
});

test("keyOf lets objects (subscriptions) dedupe by a field", () => {
  interface Sub { endpoint: string; k: string }
  const s = new TokenStore<Sub>(tmpFile(), (x) => x.endpoint);
  s.add({ endpoint: "e1", k: "v1" });
  s.add({ endpoint: "e1", k: "v2" }); // same endpoint → dup
  s.add({ endpoint: "e2", k: "v3" });
  expect(s.list().map((x) => x.endpoint)).toEqual(["e1", "e2"]);
});

test("prune removes the reported-dead items in one write", () => {
  const f = tmpFile();
  const s = new TokenStore<string>(f, identity);
  ["a", "b", "c"].forEach((t) => s.add(t));
  s.prune(["a", "c"]);
  expect([...s.list()]).toEqual(["b"]);
  s.prune([]); // no-op
  expect([...s.list()]).toEqual(["b"]);
});

test("fanOut sends to every item and collects the ones reported dead", async () => {
  const sent: string[] = [];
  const dead = await fanOut(["a", "b", "c"], async (t) => {
    sent.push(t);
    return t === "b"; // b is dead
  });
  expect(sent.sort()).toEqual(["a", "b", "c"]);
  expect(dead).toEqual(["b"]);
});
