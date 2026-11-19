/**
 * Phase B1 unit tests for the SolidCraft pin (spec §4.10): the persisted record, the availability
 * rule, one machine's apply / set / pin back / boot, the format guard (§4.14 item 18) and the
 * release lookup (§4.14 item 16).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentManagedSolidcraft, resolveSolidcraftCli, setManagedSolidcraftCli } from "../../src/solidcraft/binary";
import { OLDER_BUILD_MESSAGE, checkScriptFormat, localFormatNumber, resetFormatCache, scriptFormatNumber } from "../../src/solidcraft/format";
import { installedVersions, solidcraftCliPath, type InstallDeps } from "../../src/solidcraft/install";
import { PIN_FILE, PinStore, SolidcraftPinService, parsePin, pinAvailability, pinBackWarning, readLocalPin } from "../../src/solidcraft/pin";
import { parseSha256Sums, resolveReleaseRef } from "../../src/solidcraft/release";
import { fakeReleaseZip, fakeVerifier, memoryDownloader, type FakeVerifierOptions } from "../helpers/solidcraft-release";

const dirs: string[] = [];
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "anvil-sc-pin-"));
  dirs.push(d);
  return d;
}
afterEach(() => setManagedSolidcraftCli(undefined));
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const A = fakeReleaseZip("0.43.0");
const B = fakeReleaseZip("0.44.1");
const C = fakeReleaseZip("0.45.0");
const refA = { version: "0.43.0", sha256: A.sha256 };
const refB = { version: "0.44.1", sha256: B.sha256 };
const refC = { version: "0.45.0", sha256: C.sha256 };
const ZIPS = { "0.43.0": A.zip, "0.44.1": B.zip, "0.45.0": C.zip };

function installDeps(verifier: FakeVerifierOptions = {}, zips: Record<string, Buffer> = ZIPS): Partial<InstallDeps> & { download: ReturnType<typeof memoryDownloader> } {
  return { download: memoryDownloader(zips), run: fakeVerifier(verifier), notarizeAttempts: 1, sleep: async () => {}, log: () => {} };
}
function service(dir: string, opts: { verifier?: FakeVerifierOptions; zips?: Record<string, Buffer>; candidate?: string; env?: Record<string, string>; changes?: number[] } = {}) {
  const install = installDeps(opts.verifier, opts.zips);
  const svc = new SolidcraftPinService({
    stateDir: dir,
    install,
    env: opts.env ?? {},
    exists: () => false,
    candidateVersion: () => opts.candidate,
    onChange: () => void opts.changes?.push(1),
    log: () => {},
  });
  return { svc, install };
}

describe("pinAvailability", () => {
  test("[B1] no pin recorded → available with no reason, so CAD works before a pin exists", () => {
    expect(pinAvailability("0.44.1", undefined)).toEqual({ available: true });
    expect(pinAvailability(undefined, undefined)).toEqual({ available: true });
  });

  test("[B1] on the pinned version → available", () => {
    expect(pinAvailability("0.44.1", { version: "0.44.1" })).toEqual({ available: true, pinned: "0.44.1" });
  });

  test("[B1] a machine on a different version is unavailable, with a reason naming both versions", () => {
    const a = pinAvailability("0.43.0", { version: "0.44.1" });
    expect(a.available).toBe(false);
    expect(a.pinned).toBe("0.44.1");
    expect(a.reason).toContain("0.43.0");
    expect(a.reason).toContain("0.44.1");
    // A NEWER local build is just as wrong as an older one: it writes what the fleet cannot read.
    expect(pinAvailability("0.45.0", { version: "0.44.1" }).available).toBe(false);
  });

  test("[B1] a failed install (no local build on the pin) is unavailable, and the failure is in the reason", () => {
    const a = pinAvailability(undefined, { version: "0.44.1" }, "zip sha256 is aa…, the pin records bb…");
    expect(a.available).toBe(false);
    expect(a.reason).toContain("not installed");
    expect(a.reason).toContain("zip sha256 is aa…");
    expect(a.pinned).toBe("0.44.1");
  });
});

describe("pin store", () => {
  test("[B1] the pin survives a reload, with pinnedAt and previous", () => {
    const dir = stateDir();
    const store = new PinStore(dir);
    expect(store.get()).toBeUndefined();
    const first = store.set(refA, new Date("2026-11-19T10:00:00Z"));
    expect(first).toEqual({ ...refA, pinnedAt: "2026-11-19T10:00:00.000Z" });
    const second = store.set(refB, new Date("2026-11-20T10:00:00Z"));
    expect(second).toEqual({ ...refB, pinnedAt: "2026-11-20T10:00:00.000Z", previous: { ...refA, pinnedAt: "2026-11-19T10:00:00.000Z" } });

    const reloaded = new PinStore(dir);
    expect(reloaded.get()).toEqual(second);
    expect(reloaded.corrupt()).toBeUndefined();
    expect(readLocalPin(dir)).toEqual(second);
    expect(JSON.parse(readFileSync(join(dir, PIN_FILE), "utf8"))).toEqual(second);
  });

  test("[B1] setting the build that is already pinned keeps previous and pinnedAt", () => {
    const store = new PinStore(stateDir());
    store.set(refA, new Date("2026-11-19T10:00:00Z"));
    const pinned = store.set(refB, new Date("2026-11-20T10:00:00Z"));
    expect(store.set(refB, new Date("2026-11-21T10:00:00Z"))).toEqual(pinned);
  });

  test("[B1] a corrupt pin file is reported, left in place, and is not treated as 'no pin'", () => {
    const dir = stateDir();
    writeFileSync(join(dir, PIN_FILE), "{ not json");
    const store = new PinStore(dir);
    expect(store.get()).toBeUndefined();
    expect(store.corrupt()).toContain(PIN_FILE);
    expect(readFileSync(join(dir, PIN_FILE), "utf8")).toBe("{ not json"); // not overwritten on load
    // A second start still sees it: the guard does not lapse by itself.
    expect(new PinStore(dir).corrupt()).toBeDefined();
    // Writing a pin repairs it.
    store.set(refA);
    expect(store.corrupt()).toBeUndefined();
    expect(new PinStore(dir).get()?.version).toBe("0.43.0");
  });

  test("[B1] a pin file of the wrong shape is corrupt too", () => {
    for (const bad of [{ version: "0.44.1" }, { ...refA, pinnedAt: "x", previous: { version: "nope", sha256: "z" } }, { version: "../x", sha256: A.sha256, pinnedAt: "x" }, [], "pin"]) {
      const dir = stateDir();
      writeFileSync(join(dir, PIN_FILE), JSON.stringify(bad));
      const store = new PinStore(dir);
      expect(store.get()).toBeUndefined();
      expect(store.corrupt()).toBeDefined();
    }
    expect(parsePin({ ...refA, pinnedAt: "2026-11-19T10:00:00Z", extra: 1 })).toEqual({ ...refA, pinnedAt: "2026-11-19T10:00:00Z" });
  });

  test("[B1] a machine with a corrupt pin file reports CAD unavailable until the pin is set again", async () => {
    const dir = stateDir();
    writeFileSync(join(dir, PIN_FILE), "garbage");
    const { svc } = service(dir);
    const st = await svc.status();
    expect(st.state).toBe("error");
    expect(st.available).toBe(false);
    expect(st.reason).toContain("cannot be read");
    expect((await svc.setPin(refA)).ok).toBe(true);
    expect((await svc.status()).state).toBe("ready");
  });
});

describe("member apply", () => {
  test("[B1] applying the hub's pin installs that exact version and reports ready", async () => {
    const dir = stateDir();
    const changes: number[] = [];
    const { svc, install } = service(dir, { changes });
    expect(await svc.status()).toEqual({ state: "unpinned", available: true });

    const pin = { ...refB, pinnedAt: "2026-11-20T10:00:00.000Z", previous: { ...refA, pinnedAt: "2026-11-19T10:00:00.000Z" } };
    const st = await svc.apply(pin);
    expect(st).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
    expect(install.download.calls).toEqual(["0.44.1"]); // exactly the pinned version, nothing else
    expect(svc.pin()).toEqual(pin); // stored as the hub sent it, previous included
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(dir, "0.44.1"), source: "managed", version: "0.44.1" });
    expect(changes.length).toBeGreaterThanOrEqual(2); // "installing", then the result
  });

  test("[B1] a member handed the pinned version with a sha256 that is refused keeps the pin it had, and stays ready", async () => {
    const dir = stateDir();
    const { svc } = service(dir);
    const good = { ...refB, pinnedAt: "2026-11-19T10:00:00.000Z" };
    expect((await svc.apply(good)).state).toBe("ready");
    // The same version again, with a sha256 no zip matches.
    const st = await svc.apply({ version: "0.44.1", sha256: "0".repeat(64), pinnedAt: "2026-11-19T11:00:00.000Z" });
    expect(svc.pin()).toEqual(good); // the stored pin still names the zip that was verified
    expect(readLocalPin(dir)).toEqual(good);
    expect(st).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true }); // and no stale error
    expect(svc.applyRefusal()).toContain("was refused");
    expect(svc.applyRefusal()).toContain("0".repeat(64));
    expect(installedVersions(dir)).toEqual(["0.44.1"]);
    expect(Bun.spawnSync([solidcraftCliPath(dir, "0.44.1"), "--version"]).stdout.toString().trim()).toBe("solidcraft-cli 0.44.1");
    // A later good apply clears the refusal; a different VERSION is still recorded before its install.
    await svc.apply(good);
    expect(svc.applyRefusal()).toBeUndefined();
    const other = await svc.apply({ version: "0.45.0", sha256: "0".repeat(64), pinnedAt: "2026-11-19T12:00:00.000Z" });
    expect(other.state).toBe("error");
    expect(svc.pin()?.version).toBe("0.45.0"); // off the pin, and saying so
  });

  test("[B1] a member whose install fails stays on its old version and reports CAD unavailable with the reason", async () => {
    const dir = stateDir();
    // This machine can fetch 0.43.0 but its download of 0.44.1 is a different file.
    const { svc } = service(dir, { zips: { "0.43.0": A.zip, "0.44.1": C.zip } });
    expect((await svc.apply({ ...refA, pinnedAt: "2026-11-19T10:00:00.000Z" })).state).toBe("ready");

    const st = await svc.apply({ ...refB, pinnedAt: "2026-11-20T10:00:00.000Z", previous: refA });
    expect(st.state).toBe("error");
    expect(st.available).toBe(false);
    expect(st.version).toBe("0.43.0"); // still the old build…
    expect(st.pinned).toBe("0.44.1"); // …but the pin it holds is the new one
    expect(st.failure).toBe("sha-mismatch");
    expect(st.reason).toContain("runs SolidCraft 0.43.0 but the fleet is pinned to 0.44.1");
    // The same verdict from the pure rule Track A calls.
    expect(pinAvailability(st.version, svc.pin())).toMatchObject({ available: false, pinned: "0.44.1" });
    expect((await svc.availability()).available).toBe(false);
    expect(existsSync(solidcraftCliPath(dir, "0.44.1"))).toBe(false);
  });

  test("[B1] after an apply only the pinned, previous and candidate versions stay on disk", async () => {
    const dir = stateDir();
    const { svc } = service(dir, { candidate: "0.45.0" });
    await svc.apply({ ...refA, pinnedAt: "t1" });
    await svc.installBeside(refC); // the candidate, beside the pin
    await svc.apply({ ...refB, pinnedAt: "t2", previous: refA });
    expect(installedVersions(dir).sort()).toEqual(["0.43.0", "0.44.1", "0.45.0"]);
    // The pin moves on: 0.43.0 is no longer pinned, previous or candidate.
    const { svc: later } = service(dir, { candidate: undefined });
    await later.apply({ ...refC, pinnedAt: "t3", previous: refB });
    expect(installedVersions(dir).sort()).toEqual(["0.44.1", "0.45.0"]);
  });

  test("[B1] an env override on the pinned version is ready; on another version it is not", async () => {
    const dir = stateDir();
    const probe = (v: string) => ({ version: () => ({ code: 0, stdout: `solidcraft-cli ${v}\n`, stderr: "" }) });
    const on = service(dir, { env: { ANVIL_SOLIDCRAFT_CLI: "/opt/sc/solidcraft-cli" }, verifier: probe("0.44.1") });
    await on.svc.apply({ ...refB, pinnedAt: "t" });
    expect(await on.svc.status()).toMatchObject({ state: "ready", source: "env", version: "0.44.1", available: true });

    const off = service(stateDir(), { env: { ANVIL_SOLIDCRAFT_CLI: "/opt/sc/solidcraft-cli" }, verifier: probe("0.40.1") });
    await off.svc.apply({ ...refB, pinnedAt: "t" });
    expect(await off.svc.status()).toMatchObject({ state: "error", source: "env", version: "0.40.1", available: false });
  });
});

describe("hub pin", () => {
  test("[B1] the hub verifies a build before recording it: a failing install leaves the pin unchanged", async () => {
    const dir = stateDir();
    const { svc } = service(dir);
    expect((await svc.setPin(refA)).ok).toBe(true);
    const bad = await svc.setPin({ version: "0.44.1", sha256: "0".repeat(64) });
    expect(bad).toMatchObject({ ok: false, failure: "sha-mismatch" });
    expect(svc.pin()?.version).toBe("0.43.0");
    expect((await svc.status()).state).toBe("ready"); // still on the pin it had
    expect(currentManagedSolidcraft()?.version).toBe("0.43.0");
  });

  test("[B1] a refused re-pin of the pinned version with a wrong sha256 leaves the install intact and the machine ready", async () => {
    const dir = stateDir();
    const { svc } = service(dir);
    expect((await svc.setPin(refB)).ok).toBe(true);
    const bad = await svc.setPin({ version: "0.44.1", sha256: "0".repeat(64) });
    expect(bad).toMatchObject({ ok: false, failure: "sha-mismatch" });
    // The pin, the folder and the running build are all exactly as before.
    expect(svc.pin()).toMatchObject({ version: "0.44.1", sha256: B.sha256 });
    expect(installedVersions(dir)).toEqual(["0.44.1"]);
    expect(Bun.spawnSync([solidcraftCliPath(dir, "0.44.1"), "--version"]).stdout.toString().trim()).toBe("solidcraft-cli 0.44.1");
    expect(await svc.status()).toEqual({ state: "ready", version: "0.44.1", source: "managed", pinned: "0.44.1", available: true });
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(dir, "0.44.1"), source: "managed", version: "0.44.1" });
  });

  test("[B1] status never says ready for a managed build that is no longer on disk", async () => {
    const dir = stateDir();
    const { svc } = service(dir);
    await svc.setPin(refB);
    expect((await svc.status()).state).toBe("ready");
    rmSync(join(dir, "solidcraft"), { recursive: true, force: true }); // the folder vanishes under the daemon
    const st = await svc.status();
    expect(st.state).toBe("error");
    expect(st.available).toBe(false);
    expect(st.version).toBeUndefined();
    expect(st.reason).toContain("not installed");
    expect((await svc.availability()).available).toBe(false);
    expect(resolveSolidcraftCli({}, () => false)).toBeUndefined(); // the daemon stops pointing at it
  });

  test("[B1] pin back returns to previous; the build left behind becomes the new previous", async () => {
    const dir = stateDir();
    const { svc, install } = service(dir);
    await svc.setPin(refA);
    await svc.setPin(refB);
    expect(svc.pin()).toMatchObject({ version: "0.44.1", previous: { version: "0.43.0", sha256: A.sha256 } });

    const back = await svc.pinBack();
    expect(back.ok).toBe(true);
    expect(svc.pin()).toMatchObject({ version: "0.43.0", sha256: A.sha256, previous: { version: "0.44.1", sha256: B.sha256 } });
    expect(await svc.status()).toMatchObject({ state: "ready", version: "0.43.0", pinned: "0.43.0" });
    expect(resolveSolidcraftCli({}, () => false)?.version).toBe("0.43.0");
    // The previous build was kept on disk, so pinning back needs no download.
    expect(install.download.calls).toEqual(["0.43.0", "0.44.1"]);
  });

  test("[B1] pin back with no previous is refused", async () => {
    const { svc } = service(stateDir());
    expect((await svc.pinBack()).ok).toBe(false);
    await svc.setPin(refA);
    expect(await svc.pinBack()).toMatchObject({ ok: false, error: expect.stringContaining("no previous pin") });
    expect(svc.pin()?.version).toBe("0.43.0");
  });

  test("[B1] pin back after scripts were rewritten: warned, affected parts listed, no automatic rewrite", async () => {
    const dir = stateDir();
    const { svc } = service(dir);
    await svc.setPin(refA);
    await svc.setPin(refB);
    const designs = [
      { part: "bracket", version: "0.44.1", environment: "fixtures", path: "cad/bracket/design.json" },
      { part: "plate", version: "0.43.0", environment: "fixtures", path: "cad/plate/design.json" },
      { part: "lid", version: "0.44.1", environment: "enclosure" },
    ];
    const asked: string[] = [];
    const warning = await pinBackWarning(svc.pin(), (newer) => {
      asked.push(newer);
      return designs;
    });
    expect(asked).toEqual(["0.44.1"]); // asked about the build being left
    expect(warning.current?.version).toBe("0.44.1");
    expect(warning.previous?.version).toBe("0.43.0");
    // Only the designs the newer build wrote are at risk.
    expect(warning.rewritten.map((d) => d.part)).toEqual(["bracket", "lid"]);
    // Asking changed nothing, and the provider is only ever read.
    expect(svc.pin()?.version).toBe("0.44.1");
    expect(designs.length).toBe(3);

    // With no provider (the design store is another track's), the list is empty, not an error.
    expect((await pinBackWarning(svc.pin(), () => [])).rewritten).toEqual([]);
    // With NO provider the list is unknown, which is reported as such and never as "none".
    expect(await pinBackWarning(svc.pin())).toMatchObject({ rewritten: [], listUnavailable: true });
    expect((await pinBackWarning(svc.pin(), () => [])).listUnavailable).toBeUndefined();
    // A provider that fails must not be read as "nothing is at risk".
    const failed = await pinBackWarning(svc.pin(), () => {
      throw new Error("design store offline");
    });
    expect(failed).toMatchObject({ rewritten: [], listError: "design store offline" });
    expect(await pinBackWarning(undefined)).toEqual({ rewritten: [] });
  });
});

describe("boot", () => {
  test("[B1] at start, a recorded pin whose folder is a verified install becomes the daemon's SolidCraft", async () => {
    const dir = stateDir();
    await service(dir).svc.setPin(refB);
    setManagedSolidcraftCli(undefined); // a new process starts with nothing primed

    const { svc, install } = service(dir);
    expect(resolveSolidcraftCli({}, () => false)).toBeUndefined();
    svc.boot();
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(dir, "0.44.1"), source: "managed", version: "0.44.1" });
    expect(await svc.status()).toMatchObject({ state: "ready", version: "0.44.1" });
    expect(install.download.calls).toEqual([]); // no network at boot when the folder verifies
  });

  test("[B1] at start, no pin means nothing is primed", () => {
    const { svc } = service(stateDir());
    svc.boot();
    expect(currentManagedSolidcraft()).toBeUndefined();
  });

  test("[B1] at start, a pin whose folder is missing or unverified is not used, and the install is retried", async () => {
    const dir = stateDir();
    await service(dir).svc.setPin(refB);
    setManagedSolidcraftCli(undefined);
    rmSync(join(dir, "solidcraft", "0.44.1", ".anvil-verified.json")); // tampered / half-written

    const quiet = service(dir);
    quiet.svc.boot({ retryInstall: false });
    expect(currentManagedSolidcraft()).toBeUndefined();
    expect(await quiet.svc.status()).toMatchObject({ state: "error", available: false, pinned: "0.44.1" });

    const changes: number[] = [];
    const retry = service(dir, { changes });
    retry.svc.boot();
    for (let i = 0; i < 200 && currentManagedSolidcraft()?.version !== "0.44.1"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(currentManagedSolidcraft()?.version).toBe("0.44.1");
    expect(retry.install.download.calls).toEqual(["0.44.1"]);
  });
});

describe("design format guard", () => {
  test("[B1] a script written by a newer format is refused with \"this machine's SolidCraft is older than the design\"", () => {
    const script = { about: { design: "plate", format: "solidcraft/58", version: "0.44.1" }, commands: [] };
    expect(scriptFormatNumber(script)).toBe(58);
    const r = checkScriptFormat(script, 57, "0.43.0");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(OLDER_BUILD_MESSAGE);
      expect(r.error).toContain("this machine's SolidCraft is older than the design");
      expect(r.error).toContain("58");
      expect(r.error).toContain("0.43.0");
    }
    // The same or an older format replays. A script with no readable format is REFUSED: merge
    // decision (one format check for the manager and the replay gate), following decision 51 from
    // the A1 review — a missing number must not let an older build rewrite a newer design.
    expect(checkScriptFormat(script, 58)).toEqual({ ok: true });
    expect(checkScriptFormat({ about: { format: "solidcraft/48" } }, 58)).toEqual({ ok: true });
    const none = checkScriptFormat({ commands: [] }, 48);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("no-format");
    expect(scriptFormatNumber({ about: { format: "fusion/3" } })).toBeUndefined();
  });

  test("[B1] the local build's format number is read once per version", async () => {
    resetFormatCache();
    let reads = 0;
    const read = async () => {
      reads++;
      return 58;
    };
    expect(await Promise.all([localFormatNumber("0.44.1", read), localFormatNumber("0.44.1", read)])).toEqual([58, 58]);
    expect(await localFormatNumber("0.44.1", read)).toBe(58);
    expect(reads).toBe(1);
    expect(await localFormatNumber("0.43.0", async () => 57)).toBe(57);
    // A failed read is not remembered.
    await expect(localFormatNumber("0.40.1", async () => Promise.reject(new Error("crashed")))).rejects.toThrow("crashed");
    expect(await localFormatNumber("0.40.1", async () => 54)).toBe(54);
  });
});

describe("release lookup", () => {
  const SHA = "f324ec49fd50b30d6dc18928d84749b8a72a132e4233daf844e422b3c38bc251";
  const name = "solidcraft-cli-0.44.1-macos-universal.zip";
  function github(opts: { digest?: string; sums?: string; draft?: boolean; status?: number } = {}): typeof fetch & { urls: string[] } {
    const urls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/releases/tags/v0.44.1")) {
        if (opts.status) return new Response("nope", { status: opts.status });
        return Response.json({
          tag_name: "v0.44.1",
          prerelease: false,
          draft: opts.draft ?? false,
          published_at: "2026-11-17T18:00:00Z",
          assets: [
            { name, browser_download_url: `https://example.invalid/${name}`, digest: opts.digest ?? `sha256:${SHA}` },
            { name: "SHA256SUMS.txt", browser_download_url: "https://example.invalid/SHA256SUMS.txt" },
          ],
        });
      }
      if (url.endsWith("/SHA256SUMS.txt")) return new Response(opts.sums ?? `e8916fc40135a38b4b7c15bbf4698e2b01c2f11402e9dbc32e84021cee400d43  solidcraft-0.44.1-macos-universal.dmg\n${SHA}  ${name}\n`);
      return new Response("not found", { status: 404 });
    }) as typeof fetch & { urls: string[] };
    f.urls = urls;
    return f;
  }

  test("[B1] the hub resolves one { version, sha256 } when the asset digest and SHA256SUMS.txt agree", async () => {
    const f = github();
    expect(await resolveReleaseRef("0.44.1", f)).toEqual({ version: "0.44.1", sha256: SHA });
    expect(f.urls[0]).toBe("https://api.github.com/repos/tangency-labs/solidcraft/releases/tags/v0.44.1");
    expect(parseSha256Sums(`${SHA}  ${name}\nnot a line\n`).get(name)).toBe(SHA);
  });

  test("[B1] a digest that disagrees with SHA256SUMS.txt, a missing line, a draft or a missing release records nothing", async () => {
    await expect(resolveReleaseRef("0.44.1", github({ digest: `sha256:${"a".repeat(64)}` }))).rejects.toThrow(/disagree/);
    await expect(resolveReleaseRef("0.44.1", github({ sums: "nothing here\n" }))).rejects.toThrow(/no line/);
    await expect(resolveReleaseRef("0.44.1", github({ digest: "" }))).rejects.toThrow(/no sha256 digest/);
    await expect(resolveReleaseRef("0.44.1", github({ draft: true }))).rejects.toThrow(/draft/);
    await expect(resolveReleaseRef("0.44.1", github({ status: 404 }))).rejects.toThrow(/no release v0.44.1/);
    await expect(resolveReleaseRef("latest", github())).rejects.toThrow(/not a SolidCraft version/);
  });
});
