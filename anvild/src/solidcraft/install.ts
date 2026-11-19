/**
 * Managed SolidCraft install (agent-cad-and-browser spec §4.10, §4.14 items 14, 15 and 19).
 *
 * A build lives at `<stateDir>/solidcraft/<version>/solidcraft-cli`. It gets there only after the
 * release zip has passed the six-step sequence recorded in the B0 spike evidence:
 *
 *   1. the zip's sha256 equals the value the hub recorded for that version;
 *   2. safe extraction into a new empty folder (see ./zip.ts), single top-level folder stripped, a
 *      regular file `solidcraft-cli` present; `solvecraft-cli` is never written, so never run;
 *   3. `codesign --verify --strict`;
 *   4. the Team ID, enforced by a `codesign -R` requirement string (never by parsing text);
 *   5. `spctl --status` says assessments are enabled (otherwise "cannot verify", a failure), and
 *      `spctl -a -vv -t install` exits 0 with `source=Notarized Developer ID` — retried a bounded
 *      number of times, because the first check of a new binary needs an online lookup;
 *   6. `solidcraft-cli --version` prints exactly `solidcraft-cli <version>`.
 *
 * The work happens in a temp sibling folder that is renamed into place only after step 6, so a
 * version folder never exists half-installed and two installs of one version cannot corrupt each
 * other. Any failure deletes the folder and returns a typed reason.
 *
 * The downloader and the command runner are injected, so unit tests need no network and no codesign.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipError, extractZip } from "./zip";

/** The Developer ID team that signs SolidCraft. A constant in source on purpose (spec §6). */
export const SOLIDCRAFT_TEAM_ID = "G5QA5U5X2S";

/** The `codesign -R` requirement: Apple-anchored Developer ID Application, issued to that team. */
export const SOLIDCRAFT_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${SOLIDCRAFT_TEAM_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;

export const SOLIDCRAFT_BINARY = "solidcraft-cli";
/** Shipped by older zips next to the CLI. Never extracted, so it can never be run. */
export const NEVER_RUN = ["solvecraft-cli"] as const;
const MARKER = ".anvil-verified.json";
const CODESIGN = "/usr/bin/codesign";
const SPCTL = "/usr/sbin/spctl";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export const isSolidcraftVersion = (v: unknown): v is string => typeof v === "string" && VERSION_RE.test(v);
export const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA_RE.test(v);

/** One exact build: the version and the sha256 of its release zip. */
export interface SolidcraftRef {
  version: string;
  sha256: string;
}

/** Why an install was refused. Each maps to one step of the sequence above. */
export type InstallFailure =
  | "bad-request" // version or sha256 is not well-formed
  | "download-failed"
  | "sha-mismatch" // step 1
  | "bad-zip" // step 2: malformed, or not the expected layout
  | "unsafe-zip" // step 2: absolute path, `..`, symlink, …
  | "missing-binary" // step 2: no regular file `solidcraft-cli`
  | "signature-invalid" // step 3
  | "wrong-team" // step 4
  | "cannot-verify" // step 5: Gatekeeper assessments are disabled
  | "not-notarized" // step 5
  | "version-mismatch" // step 6
  | "install-failed"; // filesystem trouble moving the folder into place

export type InstallResult =
  | { ok: true; version: string; sha256: string; path: string; alreadyInstalled: boolean }
  | { ok: false; version: string; reason: InstallFailure; detail: string };

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Run a command and collect its output. Never throws: a spawn failure is `code: 127`. */
export type Run = (cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<RunResult>;
/** Fetch the release zip for `ref.version` into `destFile`. Throws on failure. */
export type Download = (ref: SolidcraftRef, destFile: string) => Promise<void>;

export interface InstallDeps {
  download: Download;
  run: Run;
  /** Total attempts at the notarization check (step 5) before the folder is deleted. */
  notarizeAttempts: number;
  /** Pause between those attempts. */
  notarizeRetryMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export const releaseAssetName = (version: string): string => `solidcraft-cli-${version}-macos-universal.zip`;
export const releaseAssetUrl = (version: string): string =>
  `https://github.com/tangency-labs/solidcraft/releases/download/v${version}/${releaseAssetName(version)}`;

/** The real downloader: stream the GitHub release asset to disk. */
export function httpDownloader(fetchImpl: typeof fetch = fetch): Download {
  return async (ref, destFile) => {
    const res = await fetchImpl(releaseAssetUrl(ref.version), { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for ${releaseAssetName(ref.version)}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destFile, { flags: "wx" }));
  };
}

/** A downloader that copies a zip already on disk (`resolve` maps a version to its path). */
export function fileDownloader(resolve: (version: string) => string | undefined): Download {
  return async (ref, destFile) => {
    const src = resolve(ref.version);
    if (!src || !existsSync(src)) throw new Error(`no local zip for SolidCraft ${ref.version}`);
    copyFileSync(src, destFile);
  };
}

/** The real runner. `env` REPLACES the environment (credentials never reach a downloaded binary). */
export const spawnRun: Run = async (cmd, opts = {}) => {
  try {
    const p = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: opts.env ?? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: opts.timeoutMs ?? 120_000,
    });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

/** The environment a managed binary is asked `--version` under: nothing but what it needs to start. */
export function binaryEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "/", TMPDIR: env.TMPDIR ?? "/tmp" };
}

const defaultDeps = (): InstallDeps => ({
  download: httpDownloader(),
  run: spawnRun,
  notarizeAttempts: 3,
  notarizeRetryMs: 5_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(m),
});

export const solidcraftRoot = (stateDir: string): string => join(stateDir, "solidcraft");
export const solidcraftVersionDir = (stateDir: string, version: string): string => join(solidcraftRoot(stateDir), version);
export const solidcraftCliPath = (stateDir: string, version: string): string => join(solidcraftVersionDir(stateDir, version), SOLIDCRAFT_BINARY);

function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The managed build of `version` if its folder holds a binary AND the marker written after a full
 * verification. With `sha256`, the marker must also name that zip — a folder verified against a
 * different zip of the same version is not the pinned build.
 */
export function installedSolidcraft(stateDir: string, version: string, sha256?: string): { path: string; version: string; sha256: string } | undefined {
  if (!isSolidcraftVersion(version)) return undefined;
  const path = solidcraftCliPath(stateDir, version);
  if (!isRegularFile(path)) return undefined;
  try {
    const m = JSON.parse(readFileSync(join(solidcraftVersionDir(stateDir, version), MARKER), "utf8")) as { version?: unknown; sha256?: unknown };
    if (m.version !== version || !isSha256(m.sha256)) return undefined;
    if (sha256 !== undefined && m.sha256 !== sha256) return undefined;
    return { path, version, sha256: m.sha256 };
  } catch {
    return undefined;
  }
}

/** Every managed version folder currently on disk (verified or not). */
export function installedVersions(stateDir: string): string[] {
  try {
    return readdirSync(solidcraftRoot(stateDir)).filter((n) => VERSION_RE.test(n));
  } catch {
    return [];
  }
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

const tail = (r: RunResult): string => `${r.stderr}${r.stdout}`.trim().split("\n").slice(-4).join(" | ").slice(0, 600);

/**
 * Steps 3 to 6 on an extracted binary. Exported so the real-tool suite and a future "re-verify"
 * action can run exactly the sequence the installer runs.
 */
export async function verifySolidcraftBinary(
  bin: string,
  version: string,
  deps: Pick<InstallDeps, "run" | "notarizeAttempts" | "notarizeRetryMs" | "sleep">,
): Promise<{ ok: true } | { ok: false; reason: InstallFailure; detail: string }> {
  // 3. The signature is intact.
  const sig = await deps.run([CODESIGN, "--verify", "--strict", "--verbose=2", bin]);
  if (sig.code !== 0) return { ok: false, reason: "signature-invalid", detail: `codesign --verify --strict failed (exit ${sig.code}): ${tail(sig)}` };

  // 4. …and it was made by the pinned team.
  const team = await deps.run([CODESIGN, "--verify", "--strict", `-R=${SOLIDCRAFT_REQUIREMENT}`, bin]);
  if (team.code !== 0) return { ok: false, reason: "wrong-team", detail: `not signed by Developer ID team ${SOLIDCRAFT_TEAM_ID} (exit ${team.code}): ${tail(team)}` };

  // 5. Notarized. With assessments off, spctl accepts anything, so that is "cannot verify".
  const status = await deps.run([SPCTL, "--status"]);
  if (status.code !== 0 || !/assessments enabled/.test(`${status.stdout}${status.stderr}`)) {
    return { ok: false, reason: "cannot-verify", detail: `cannot verify notarization: Gatekeeper assessments are not enabled on this machine (${tail(status) || `exit ${status.code}`})` };
  }
  const attempts = Math.max(1, deps.notarizeAttempts);
  let last: RunResult = { code: -1, stdout: "", stderr: "" };
  for (let i = 1; i <= attempts; i++) {
    last = await deps.run([SPCTL, "-a", "-vv", "-t", "install", bin]);
    if (last.code === 0 && /source=Notarized Developer ID/.test(`${last.stdout}${last.stderr}`)) break;
    if (i === attempts) return { ok: false, reason: "not-notarized", detail: `spctl did not accept it as a notarized Developer ID build after ${attempts} attempt(s) (exit ${last.code}): ${tail(last)}` };
    await deps.sleep(deps.notarizeRetryMs);
  }

  // 6. First execution: it is the version we asked for.
  const ver = await deps.run([bin, "--version"], { env: binaryEnv(), timeoutMs: 60_000 });
  const want = `${SOLIDCRAFT_BINARY} ${version}`;
  if (ver.code !== 0 || ver.stdout.trim() !== want) {
    return { ok: false, reason: "version-mismatch", detail: `--version printed ${JSON.stringify(ver.stdout.trim() || ver.stderr.trim())} (exit ${ver.code}), expected ${JSON.stringify(want)}` };
  }
  return { ok: true };
}

/** In-flight installs by folder, so two callers in this process share one download and one verify. */
const inflight = new Map<string, Promise<InstallResult>>();

/**
 * Install exactly `ref` (version + zip sha256) under `stateDir`, or return the already-verified
 * install. Never throws; a refusal is `{ ok: false, reason, detail }` with nothing left on disk.
 */
export function installSolidcraft(stateDir: string, ref: SolidcraftRef, deps: Partial<InstallDeps> = {}): Promise<InstallResult> {
  if (!isSolidcraftVersion(ref.version) || !isSha256(ref.sha256)) {
    return Promise.resolve({ ok: false, version: String(ref.version), reason: "bad-request", detail: "a version like 0.44.1 and a 64-character lowercase sha256 are required" });
  }
  const key = `${solidcraftVersionDir(stateDir, ref.version)}\0${ref.sha256}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = doInstall(stateDir, ref, { ...defaultDeps(), ...deps }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doInstall(stateDir: string, ref: SolidcraftRef, deps: InstallDeps): Promise<InstallResult> {
  const { version, sha256 } = ref;
  const root = solidcraftRoot(stateDir);
  const finalDir = solidcraftVersionDir(stateDir, version);
  const finalBin = solidcraftCliPath(stateDir, version);
  const have = installedSolidcraft(stateDir, version, sha256);
  if (have) return { ok: true, version, sha256, path: have.path, alreadyInstalled: true };
  // A folder that is there but was not verified against THIS zip is not trusted: remove it.
  rmSync(finalDir, { recursive: true, force: true });

  const fail = (reason: InstallFailure, detail: string): InstallResult => {
    deps.log(`[solidcraft] install ${version} refused (${reason}): ${detail}`);
    return { ok: false, version, reason, detail };
  };

  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(root, `.tmp-${version}-`));
  try {
    const zip = join(tmp, "download.zip");
    try {
      await deps.download(ref, zip);
    } catch (e) {
      return fail("download-failed", e instanceof Error ? e.message : String(e));
    }
    if (!isRegularFile(zip)) return fail("download-failed", "the downloader wrote no file");

    // 1. The zip is the one the hub recorded.
    const got = await sha256File(zip);
    if (got !== sha256) return fail("sha-mismatch", `zip sha256 is ${got}, the pin records ${sha256}`);

    // 2. Safe extraction into a new empty folder.
    const staged = join(tmp, "v");
    mkdirSync(staged);
    try {
      await extractZip(zip, staged, { skip: NEVER_RUN });
    } catch (e) {
      if (e instanceof ZipError) return fail(e.problem, e.message);
      return fail("bad-zip", e instanceof Error ? e.message : String(e));
    }
    rmSync(zip, { force: true });
    const bin = join(staged, SOLIDCRAFT_BINARY);
    if (!isRegularFile(bin)) return fail("missing-binary", `the zip has no regular file ${SOLIDCRAFT_BINARY} in its top folder`);

    // 3 – 6. Signature, team, notarization, version.
    const verdict = await verifySolidcraftBinary(bin, version, deps);
    if (!verdict.ok) return fail(verdict.reason, verdict.detail);

    writeFileSync(join(staged, MARKER), JSON.stringify({ version, sha256, verifiedAt: new Date().toISOString() }, null, 2));
    try {
      renameSync(staged, finalDir);
    } catch (e) {
      // Another process finished the same install first. Its folder is fine if it carries our marker.
      if (!installedSolidcraft(stateDir, version, sha256)) return fail("install-failed", `could not move the build into place: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.log(`[solidcraft] installed ${version} at ${finalBin}`);
    return { ok: true, version, sha256, path: finalBin, alreadyInstalled: false };
  } catch (e) {
    return fail("install-failed", e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Temp folders older than this are leftovers from a crashed install, not a running one. */
const STALE_TMP_MS = 60 * 60_000;

/**
 * Keep only the listed versions (pinned, previous, candidate — each is about 0.5 GB) and sweep
 * leftover temp folders. Returns the version folders removed.
 */
export function pruneSolidcraft(stateDir: string, keep: readonly (string | undefined)[], now: number = Date.now()): string[] {
  const root = solidcraftRoot(stateDir);
  const keepSet = new Set(keep.filter((v): v is string => !!v));
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const full = join(root, name);
    if (VERSION_RE.test(name)) {
      if (keepSet.has(name)) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } else if (name.startsWith(".tmp-")) {
      try {
        if (now - statSync(full).mtimeMs > STALE_TMP_MS) rmSync(full, { recursive: true, force: true });
      } catch {
        /* raced with the install that owns it */
      }
    }
  }
  return removed.sort();
}
