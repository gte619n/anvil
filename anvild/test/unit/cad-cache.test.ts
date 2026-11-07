import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CadCache, CONVERTER_VERSION } from "../../src/cad/cache";

const tmp = () => mkdtempSync(join(tmpdir(), "cad-cache-"));
const bytes = (s: string) => new TextEncoder().encode(s);

describe("CadCache.key", () => {
  test("stable for identical input", () => {
    const c = new CadCache(tmp(), 1024);
    expect(c.key(bytes("abc"), 0)).toBe(c.key(bytes("abc"), 0));
  });

  test("changes with content, lod, and version", () => {
    const c = new CadCache(tmp(), 1024);
    const k = c.key(bytes("abc"), 0);
    expect(c.key(bytes("abd"), 0)).not.toBe(k);
    expect(c.key(bytes("abc"), 1)).not.toBe(k);
    expect(k).toContain(`_v${CONVERTER_VERSION}`);
    expect(k).toContain("_lod0");
  });
});

describe("CadCache put/get", () => {
  test("round-trip", async () => {
    const c = new CadCache(tmp(), 1024 * 1024);
    const glb = new Uint8Array([1, 2, 3, 4]);
    const k = c.key(bytes("file"), 0);
    expect(await c.get(k)).toBeNull();
    await c.put(k, glb);
    const got = await c.get(k);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3, 4]);
  });

  test("miss never throws", async () => {
    const c = new CadCache(tmp(), 1024);
    expect(await c.get("does-not-exist")).toBeNull();
  });
});

describe("CadCache LRU eviction", () => {
  test("evicts oldest past the byte cap", async () => {
    // cap holds ~2 of our 100-byte entries
    const c = new CadCache(tmp(), 250);
    const blob = (n: number) => new Uint8Array(100).fill(n);

    await c.put(c.key(bytes("a"), 0), blob(1));
    await new Promise((r) => setTimeout(r, 15));
    await c.put(c.key(bytes("b"), 0), blob(2));
    await new Promise((r) => setTimeout(r, 15));
    await c.put(c.key(bytes("c"), 0), blob(3));

    // Oldest ("a") should be evicted to stay under 250 bytes; b and c remain.
    expect(await c.get(c.key(bytes("a"), 0))).toBeNull();
    expect(await c.get(c.key(bytes("b"), 0))).not.toBeNull();
    expect(await c.get(c.key(bytes("c"), 0))).not.toBeNull();
  });
});
