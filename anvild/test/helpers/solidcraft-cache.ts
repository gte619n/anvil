/**
 * Real SolidCraft release zips and unpacked builds for the real-tool suites (B1, B2), kept in a
 * PERSISTENT cache (decision 168: the B0 spike's `/tmp/sc-b0` is cleared by macOS).
 *
 *   <cache>/dl/solidcraft-cli-<v>-macos-universal.zip
 *   <cache>/x/<v>/solidcraft-cli-<v>-macos-universal/solidcraft-cli
 *
 * `<cache>` is `$ANVIL_TEST_CACHE/solidcraft` when `ANVIL_TEST_CACHE` is set, else
 * `~/Library/Caches/anvil-test/solidcraft`.
 *
 * A zip missing from the cache is taken, in order, from the spike's `/tmp/sc-b0/dl` (if still there)
 * or downloaded from the pinned GitHub release. EVERY zip is checked against the sha256 recorded in
 * the repo (`SOLIDCRAFT_TEST_RELEASES`, from the B0 evidence) before it is used or cached; one that
 * does not match is deleted and is an error. A build is unpacked from its verified zip with the
 * product's own safe extractor (src/solidcraft/zip.ts) into a new, empty folder, then renamed into
 * place. Only when no zip can be had at all is the spike's unpacked `/tmp/sc-b0/x/<v>` used.
 *
 * When nothing works the call throws with what it tried, so a real run FAILS with a clear message
 * (never skips).
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { httpDownloader, releaseAssetName, releaseAssetUrl, type Download } from "../../src/solidcraft/install";
import { extractZip } from "../../src/solidcraft/zip";

/** The pinned release zips the real suites use, with their sha256 (B0 evidence, `B0-spike.md`). */
export const SOLIDCRAFT_TEST_RELEASES: Readonly<Record<string, string>> = {
  "0.30.1": "1effd9b38bc7f8a67ef7a7c8bec49df6453b307e9f1476b638e2c4f70208dc2f", // signed, NOT notarized
  "0.43.0": "0633d662f3b410da90616d6c7e412f6d799693164541abea82c8d53802ad1d0a",
  "0.44.1": "f324ec49fd50b30d6dc18928d84749b8a72a132e4233daf844e422b3c38bc251",
};

/** Where the B0 spike left its files; read when present, never written. */
export const LEGACY_SPIKE_DIR = "/tmp/sc-b0";
const MARKER = ".zip-sha256";

export function solidcraftTestCache(env: Record<string, string | undefined> = process.env): string {
  return env.ANVIL_TEST_CACHE ? join(env.ANVIL_TEST_CACHE, "solidcraft") : join(homedir(), "Library", "Caches", "anvil-test", "solidcraft");
}

const buildFolder = (v: string) => `solidcraft-cli-${v}-macos-universal`;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

function expectedSha(version: string): string {
  const sha = SOLIDCRAFT_TEST_RELEASES[version];
  if (!sha) throw new Error(`[solidcraft cache] no recorded sha256 for SolidCraft ${version}; add it to SOLIDCRAFT_TEST_RELEASES first`);
  return sha;
}

export interface CacheOptions {
  cache?: string;
  /** Test seam: how a missing zip is fetched (default: the GitHub release). */
  download?: Download;
  legacyDir?: string;
  log?: (m: string) => void;
}

/**
 * The path of the verified release zip for `version` in the cache, fetching it if needed. Throws
 * (with everything it tried) when it cannot be had or does not match its recorded sha256.
 */
export async function solidcraftReleaseZip(version: string, opts: CacheOptions = {}): Promise<string> {
  const sha = expectedSha(version);
  const dl = join(opts.cache ?? solidcraftTestCache(), "dl");
  const dest = join(dl, releaseAssetName(version));
  const log = opts.log ?? ((m: string) => console.log(m));
  if (existsSync(dest)) {
    if ((await sha256File(dest)) === sha) return dest;
    log(`[solidcraft cache] ${dest} does not match its sha256; deleting it and fetching again`);
    rmSync(dest, { force: true });
  }
  mkdirSync(dl, { recursive: true });
  const part = `${dest}.part-${process.pid}-${Date.now()}`;
  const tried: string[] = [];
  const legacy = join(opts.legacyDir ?? LEGACY_SPIKE_DIR, "dl", releaseAssetName(version));
  try {
    if (existsSync(legacy)) {
      copyFileSync(legacy, part);
      if ((await sha256File(part)) === sha) {
        renameSync(part, dest);
        log(`[solidcraft cache] ${releaseAssetName(version)} copied from ${legacy}`);
        return dest;
      }
      rmSync(part, { force: true });
      tried.push(`${legacy} (sha256 does not match; ignored)`);
    }
    try {
      log(`[solidcraft cache] downloading ${releaseAssetUrl(version)}`);
      await (opts.download ?? httpDownloader())({ version, sha256: sha }, part);
    } catch (e) {
      tried.push(`${releaseAssetUrl(version)} (${e instanceof Error ? e.message : String(e)})`);
      throw new Error(
        `[solidcraft cache] SolidCraft ${version} could not be obtained, so this real-tool test cannot run. Tried: ${tried.join("; ")}. ` +
          `Put ${releaseAssetName(version)} (sha256 ${sha}) into ${dl} by hand and run again.`,
      );
    }
    const got = await sha256File(part);
    if (got !== sha) {
      rmSync(part, { force: true });
      throw new Error(`[solidcraft cache] the downloaded ${releaseAssetName(version)} has sha256 ${got}, not the recorded ${sha}; it was deleted and is not used`);
    }
    renameSync(part, dest);
    return dest;
  } finally {
    rmSync(part, { force: true });
  }
}

/**
 * The path of the unpacked `solidcraft-cli` of `version`, unpacking it from the verified zip into the
 * cache if needed. Falls back to the spike's unpacked build only when no zip can be had.
 */
export async function solidcraftReleaseBuild(version: string, opts: CacheOptions = {}): Promise<string> {
  const sha = expectedSha(version);
  const x = join(opts.cache ?? solidcraftTestCache(), "x");
  const dir = join(x, version);
  const cli = join(dir, buildFolder(version), "solidcraft-cli");
  try {
    if (existsSync(cli) && readFileSync(join(dir, MARKER), "utf8").trim() === sha) return cli;
  } catch {
    /* no marker: unpack again */
  }
  let zip: string;
  try {
    zip = await solidcraftReleaseZip(version, opts);
  } catch (e) {
    const legacy = join(opts.legacyDir ?? LEGACY_SPIKE_DIR, "x", version, buildFolder(version), "solidcraft-cli");
    if (existsSync(legacy)) {
      (opts.log ?? console.log)(`[solidcraft cache] using the spike's unpacked ${legacy} (no zip could be had: ${e instanceof Error ? e.message : String(e)})`);
      return legacy;
    }
    throw e;
  }
  mkdirSync(x, { recursive: true });
  const staged = mkdtempSync(join(x, `.${version}-`)); // a new, empty folder for the untrusted archive
  try {
    await extractZip(zip, join(staged, buildFolder(version)));
    writeFileSync(join(staged, MARKER), `${sha}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staged, dir);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  if (!existsSync(cli)) throw new Error(`[solidcraft cache] ${zip} unpacked without a solidcraft-cli`);
  return cli;
}
