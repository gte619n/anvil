/**
 * Phase B1 real-tool suite (agent-cad-and-browser spec §8.3 "B"). Installs a REAL SolidCraft release
 * zip into a temp state dir through the real installer, the real codesign and the real spctl, and
 * checks the refusals with real binaries too. Nothing is faked here.
 *
 * Skipped unless ANVIL_REAL_TOOLS is set (`phase-gate B1 --require-real` sets it and fails on a skip).
 *
 * The zips come from the persistent test cache (../helpers/solidcraft-cache.ts:
 * `~/Library/Caches/anvil-test/solidcraft/dl`, or `$ANVIL_TEST_CACHE/solidcraft/dl`). A zip missing
 * there is taken from the B0 spike's /tmp/sc-b0/dl if that still exists, else downloaded from the
 * pinned GitHub release; every one is checked against its recorded sha256 before use.
 */
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, openSync, closeSync, readdirSync, rmSync, statSync, writeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL } from "../helpers/real-tools";
import { resolveSolidcraftCli, setManagedSolidcraftCli } from "../../src/solidcraft/binary";
import {
  SOLIDCRAFT_TEAM_ID,
  fileDownloader,
  installSolidcraft,
  installedSolidcraft,
  solidcraftCliPath,
  solidcraftRoot,
  solidcraftVersionDir,
  spawnRun,
  verifySolidcraftBinary,
  type Download,
  type Run,
} from "../../src/solidcraft/install";
import { SolidcraftPinService, pinAvailability } from "../../src/solidcraft/pin";
import { SOLIDCRAFT_TEST_RELEASES, solidcraftReleaseZip } from "../helpers/solidcraft-cache";

const GOOD = { version: "0.44.1", sha256: "f324ec49fd50b30d6dc18928d84749b8a72a132e4233daf844e422b3c38bc251" };
const UNNOTARIZED = { version: "0.30.1", sha256: "1effd9b38bc7f8a67ef7a7c8bec49df6453b307e9f1476b638e2c4f70208dc2f" };
// The cache helper verifies each zip against the same recorded sha256 the installer is given here.
if (SOLIDCRAFT_TEST_RELEASES[GOOD.version] !== GOOD.sha256 || SOLIDCRAFT_TEST_RELEASES[UNNOTARIZED.version] !== UNNOTARIZED.sha256) throw new Error("[B1 real] the release sha256 values here and in test/helpers/solidcraft-cache.ts differ");

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  setManagedSolidcraftCli(undefined);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The release zip from the persistent cache (fetched into it, and its sha256 checked, when missing). */
async function downloader(version: string): Promise<{ download: Download; from: string }> {
  const zip = await solidcraftReleaseZip(version); // throws with a clear message when it cannot be had
  return { download: fileDownloader((v) => (v === version ? zip : undefined)), from: zip };
}

/** The real runner, recording each command and its exit code. */
function recordingRun(): Run & { log: { cmd: string[]; code: number; out: string }[] } {
  const log: { cmd: string[]; code: number; out: string }[] = [];
  const run = (async (cmd, opts) => {
    const r = await spawnRun(cmd, opts);
    log.push({ cmd, code: r.code, out: `${r.stdout}${r.stderr}` });
    return r;
  }) as Run & { log: typeof log };
  run.log = log;
  return run;
}

const leftovers = (dir: string): string[] => (existsSync(solidcraftRoot(dir)) ? readdirSync(solidcraftRoot(dir)) : []);

// One install of the real 0.44.1 build, shared by the tests below (it is 0.5 GB on disk).
let shared: { dir: string; run: ReturnType<typeof recordingRun>; from: string; result: Awaited<ReturnType<typeof installSolidcraft>> } | undefined;
async function installGood() {
  if (shared) return shared;
  const dir = tmp("anvil-sc-real-");
  const run = recordingRun();
  const { download, from } = await downloader(GOOD.version);
  const result = await installSolidcraft(dir, GOOD, { download, run, log: (m) => console.log(m) });
  shared = { dir, run, from, result };
  return shared;
}

test.skipIf(!REAL)(
  "[B1 real] a real release zip installs into a temp state dir and passes all six verification steps",
  async () => {
    const { dir, run, from, result } = await installGood();
    console.log(`[B1 real] zip source: ${from}`);
    if (!result.ok) throw new Error(`install refused (${result.reason}): ${result.detail}`);
    expect(result.ok).toBe(true);
    expect(result.alreadyInstalled).toBe(false);
    expect(result.path).toBe(solidcraftCliPath(dir, GOOD.version));
    expect(statSync(result.path).size).toBeGreaterThan(100 * 1024 * 1024); // the real binary, not a stub

    // Steps 3 to 6 each ran with the real tool and exited 0, in order.
    const steps = run.log.map((l) => {
      if (l.cmd[0] === "/usr/bin/codesign") return l.cmd.some((a) => a.startsWith("-R=")) ? "team" : "codesign";
      if (l.cmd[0] === "/usr/sbin/spctl") return l.cmd.includes("--status") ? "spctl-status" : "spctl-install";
      return l.cmd.slice(1).join(" ");
    });
    expect(steps.filter((s, i) => s !== "spctl-install" || steps[i - 1] !== "spctl-install")).toEqual(["codesign", "team", "spctl-status", "spctl-install", "--version"]);
    expect(run.log.at(-1)!.code).toBe(0);
    for (const l of run.log.filter((x) => x.cmd[0] === "/usr/bin/codesign")) expect(l.code).toBe(0);
    expect(run.log.find((l) => l.cmd.includes("--status"))!.out).toContain("assessments enabled");
    const accepted = run.log.filter((l) => l.cmd[0] === "/usr/sbin/spctl" && l.cmd.includes("install")).at(-1)!;
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("source=Notarized Developer ID");
    expect(accepted.out).toContain(`(${SOLIDCRAFT_TEAM_ID})`);
    expect(run.log.at(-1)!.out.trim()).toBe(`solidcraft-cli ${GOOD.version}`);

    // The folder is a verified install, with nothing else left behind.
    expect(installedSolidcraft(dir, GOOD.version, GOOD.sha256)?.path).toBe(result.path);
    expect(leftovers(dir)).toEqual([GOOD.version]);
    // Asked again from the final location, the installed binary reports the pinned version.
    const again = await spawnRun([result.path, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: tmp("anvil-sc-home-"), TMPDIR: tmpdir() } });
    expect(again.code).toBe(0);
    expect(again.stdout.trim()).toBe(`solidcraft-cli ${GOOD.version}`);
  },
  20 * 60_000,
);

test.skipIf(!REAL)(
  "[B1 real] the installed build becomes the daemon's SolidCraft through the pin, and survives a restart",
  async () => {
    const { dir, result } = await installGood();
    expect(result.ok).toBe(true);
    setManagedSolidcraftCli(undefined);
    const none = { download: (async () => Promise.reject(new Error("no download expected"))) as Download };
    const service = new SolidcraftPinService({ stateDir: dir, install: none, env: {}, exists: () => false });
    const set = await service.setPin(GOOD); // the folder is already verified: no second download
    expect(set.ok).toBe(true);
    expect(resolveSolidcraftCli({}, () => false)).toEqual({ path: solidcraftCliPath(dir, GOOD.version), source: "managed", version: GOOD.version });
    expect(await service.status()).toEqual({ state: "ready", version: GOOD.version, source: "managed", pinned: GOOD.version, available: true });

    setManagedSolidcraftCli(undefined);
    const restarted = new SolidcraftPinService({ stateDir: dir, install: none, env: {}, exists: () => false });
    restarted.boot({ retryInstall: false });
    expect(resolveSolidcraftCli({}, () => false)?.version).toBe(GOOD.version);
    expect(pinAvailability(resolveSolidcraftCli({}, () => false)?.version, restarted.pin())).toEqual({ available: true, pinned: GOOD.version });
    // A fleet pinned elsewhere makes this same machine unavailable.
    expect(pinAvailability(GOOD.version, { version: "0.45.0" }).available).toBe(false);
  },
  20 * 60_000,
);

test.skipIf(!REAL)(
  "[B1 real] real refusals: a wrong sha256, a tampered binary, another team's binary, and the un-notarized 0.30.1 build",
  async () => {
    const { dir: goodDir, result } = await installGood();
    if (!result.ok) throw new Error(`install refused (${result.reason}): ${result.detail}`);
    const quick = { run: spawnRun, notarizeAttempts: 2, notarizeRetryMs: 1_000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

    // 1. The real zip against a sha256 that is not its own: refused at step 1, nothing left on disk.
    const { download } = await downloader(GOOD.version);
    const wrongDir = tmp("anvil-sc-real-wrong-");
    const wrong = await installSolidcraft(wrongDir, { version: GOOD.version, sha256: UNNOTARIZED.sha256 }, { download, run: spawnRun, log: () => {} });
    expect(wrong).toMatchObject({ ok: false, reason: "sha-mismatch" });
    if (!wrong.ok) expect(wrong.detail).toContain(GOOD.sha256);
    expect(leftovers(wrongDir)).toEqual([]);

    // 2. The real binary with one byte changed: real codesign refuses it (step 3).
    const scratch = tmp("anvil-sc-real-tamper-");
    const tampered = join(scratch, "solidcraft-cli");
    copyFileSync(result.path, tampered, constants.COPYFILE_FICLONE);
    const fd = openSync(tampered, "r+");
    writeSync(fd, Buffer.from([0x00, 0xff, 0x00, 0xff]), 0, 4, Math.floor(statSync(tampered).size / 2));
    closeSync(fd);
    const t = await verifySolidcraftBinary(tampered, GOOD.version, quick);
    expect(t).toMatchObject({ ok: false, reason: "signature-invalid" });

    // 3. A validly signed binary from a different signer (Apple's own /bin/ls): the signature is
    //    fine, the Team ID requirement is not (step 4).
    const ls = await verifySolidcraftBinary("/bin/ls", GOOD.version, quick);
    expect(ls).toMatchObject({ ok: false, reason: "wrong-team" });
    if (!ls.ok) expect(ls.detail).toContain(SOLIDCRAFT_TEAM_ID);

    // 4. SolidCraft 0.30.1 is signed by the right team but was never notarized: refused at step 5.
    // The zip is REQUIRED: a real-tool run that cannot exercise this refusal must fail, not pass quietly
    // (the cache helper throws, naming what it tried, when the zip cannot be had).
    const { download: oldZip } = await downloader(UNNOTARIZED.version);
    const oldDir = tmp("anvil-sc-real-old-");
    const run = recordingRun();
    const old = await installSolidcraft(oldDir, UNNOTARIZED, { ...quick, download: oldZip, run, log: () => {} });
    expect(old).toMatchObject({ ok: false, reason: "not-notarized" });
    if (!old.ok) expect(old.detail).toContain("Unnotarized Developer ID");
    // It got as far as step 5 (signature and team passed) and was never executed.
    expect(run.log.filter((l) => l.cmd[0] === "/usr/bin/codesign").map((l) => l.code)).toEqual([0, 0]);
    expect(run.log.filter((l) => l.cmd[0] === "/usr/sbin/spctl" && l.cmd.includes("install")).length).toBe(2);
    expect(run.log.some((l) => l.cmd.includes("--version"))).toBe(false);
    expect(existsSync(solidcraftVersionDir(oldDir, UNNOTARIZED.version))).toBe(false);
    expect(leftovers(oldDir)).toEqual([]);

    // None of the refusals disturbed the good install.
    expect(installedSolidcraft(goodDir, GOOD.version, GOOD.sha256)).toBeDefined();
  },
  20 * 60_000,
);
