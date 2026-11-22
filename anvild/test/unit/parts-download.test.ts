/**
 * [C5] Unit: parts_fetch's download — https only, every hop vetted by resolved address and dialled
 * at the checked address, the size cap enforced while streaming, the type decided before writing.
 * The "public" host is a local HTTPS fixture reached through the dial seam (test/helpers/parts.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPart, type PartDownloadDeps } from "../../src/integrations/parts/download";
import { STEP_BYTES, fixtureResolver, startFileFixture, type FileFixture } from "../helpers/parts";

let files: FileFixture;
let dir: string;
const dialled: string[] = [];
const deps = (): PartDownloadDeps => ({
  resolver: fixtureResolver,
  selfHosts: () => [],
  fleetHosts: () => [],
  ca: files.ca,
  dial: (address, port) => (dialled.push(`${address}:${port}`), { address: "127.0.0.1", port: files.port }),
});
const dest = (name: string) => join(dir, name);
const get = (path: string, max = 1_000_000, host = "files.parts.test") => downloadPart(`https://${host}${path}`, max, dest, deps());

beforeAll(() => (files = startFileFixture()));
afterAll(() => files.stop());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anvil-c5-dl-"));
  dialled.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("downloadPart", () => {
  test("[C5] a STEP file over https is written whole, from the address that was checked (the name's resolved address, never a second lookup)", async () => {
    const got = await get("/models/lm317.step");
    expect(got).toMatchObject({ name: "lm317.step", size: STEP_BYTES.length, finalUrl: "https://files.parts.test/models/lm317.step" });
    expect(readFileSync(got.path, "utf8")).toBe(STEP_BYTES);
    expect(dialled).toEqual(["93.184.216.34:443"]);
  });

  test("[C5] a redirect to a loopback address is refused, and so is one to a name that resolves to a private address, and one to http — nothing is written", async () => {
    for (const [path, why] of [["/to-loopback", /redirected to an address that is not allowed: 127\.0\.0\.1 is a loopback address/], ["/to-private-name", /redirected to an address that is not allowed: intranet\.parts\.test resolves to 10\.1\.2\.3, a private address/], ["/to-http", /redirected to http:\/\/files\.parts\.test, and only https is followed/]] as const) {
      const e = await get(path).catch((x) => x);
      expect([path, e.kind, e.message]).toEqual([path, "refused", expect.stringMatching(why)]);
    }
    expect(readdirSync(dir)).toEqual([]);
    // A redirect to another public https host is followed (and vetted again).
    const ok = await get("/to-good");
    expect(ok.finalUrl).toBe("https://other.parts.test/models/ok.step");
    expect(dialled.slice(-2)).toEqual(["93.184.216.34:443", "93.184.216.34:443"]);
  });

  test("[C5] an http URL, a loopback URL and a private name are refused before any connection", async () => {
    expect((await downloadPart("http://files.parts.test/x.step", 100, dest, deps()).catch((x) => x)).message).toBe("only https URLs are fetched");
    expect((await downloadPart("https://127.0.0.1/x.step", 100, dest, deps()).catch((x) => x)).message).toMatch(/not allowed: 127\.0\.0\.1 is a loopback address/);
    expect((await downloadPart("https://[::1]/x.step", 100, dest, deps()).catch((x) => x)).message).toMatch(/loopback/);
    expect((await downloadPart("https://intranet.parts.test/x.step", 100, dest, deps()).catch((x) => x)).message).toMatch(/private address/);
    expect(dialled).toEqual([]);
  });

  test("[C5] an oversize response is aborted and deleted — by its Content-Length before writing, and while streaming when it has none", async () => {
    const e1 = await get("/big.step", 50).catch((x) => x);
    expect(e1.message).toMatch(/it is 100 bytes, over the 50-byte limit; nothing was saved/);
    const e2 = await get("/huge-stream.step", 50_000).catch((x) => x);
    expect(e2.message).toMatch(/over the 50000-byte limit; the download was stopped and the partial file deleted/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("[C5] the type is decided from the server's suggested name before a byte is written: destFor refusing stops the download", async () => {
    const seen: string[] = [];
    const e = await downloadPart("https://files.parts.test/named", 1000, (name) => {
      seen.push(name);
      throw new Error(`.dmg refused`);
    }, deps()).catch((x) => x);
    expect(seen).toEqual(["installer.dmg"]);
    expect(e.message).toBe(".dmg refused");
    expect(existsSync(join(dir, "installer.dmg"))).toBe(false);
  });
});
