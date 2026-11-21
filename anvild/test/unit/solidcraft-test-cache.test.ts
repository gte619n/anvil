/**
 * The persistent cache of real SolidCraft release zips the real-tool suites use
 * (test/helpers/solidcraft-cache.ts, decision 168): a zip is never used or cached unless its sha256
 * is the one recorded in the repo, and a failed fetch is an error that says what was tried.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseAssetName } from "../../src/solidcraft/install";
import { SOLIDCRAFT_TEST_RELEASES, solidcraftReleaseBuild, solidcraftReleaseZip, solidcraftTestCache } from "../helpers/solidcraft-cache";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "anvil-sc-cache-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const quiet = () => undefined;

test("the cache lives in ~/Library/Caches/anvil-test/solidcraft, or under ANVIL_TEST_CACHE; the three pinned releases have recorded hashes", () => {
  expect(solidcraftTestCache({})).toEndWith("/Library/Caches/anvil-test/solidcraft");
  expect(solidcraftTestCache({ ANVIL_TEST_CACHE: "/x/cache" })).toBe("/x/cache/solidcraft");
  expect(Object.keys(SOLIDCRAFT_TEST_RELEASES).sort()).toEqual(["0.30.1", "0.43.0", "0.44.1"]);
  for (const sha of Object.values(SOLIDCRAFT_TEST_RELEASES)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
});

test("a downloaded zip whose sha256 is not the recorded one is deleted and refused; a bad cached or legacy copy is never used", async () => {
  const cache = tmp();
  const legacy = tmp();
  const name = releaseAssetName("0.44.1");
  mkdirSync(join(cache, "dl"), { recursive: true });
  writeFileSync(join(cache, "dl", name), "stale"); // a corrupt cached copy
  mkdirSync(join(legacy, "dl"), { recursive: true });
  writeFileSync(join(legacy, "dl", name), "also wrong"); // a wrong legacy copy
  let fetched = 0;
  const download = async (_ref: unknown, dest: string) => {
    fetched++;
    writeFileSync(dest, "not the release");
  };
  await expect(solidcraftReleaseZip("0.44.1", { cache, legacyDir: legacy, download, log: quiet })).rejects.toThrow("not the recorded");
  expect(fetched).toBe(1);
  expect(readdirSync(join(cache, "dl"))).toEqual([]); // nothing unverified is left behind
  // No zip anywhere and no way to fetch one: a clear error, and no build is invented.
  const offline = async () => {
    throw new Error("network is unreachable");
  };
  await expect(solidcraftReleaseZip("0.43.0", { cache, legacyDir: legacy, download: offline, log: quiet })).rejects.toThrow("could not be obtained");
  await expect(solidcraftReleaseBuild("0.43.0", { cache, legacyDir: legacy, download: offline, log: quiet })).rejects.toThrow("network is unreachable");
  expect(existsSync(join(cache, "x", "0.43.0"))).toBe(false);
  await expect(solidcraftReleaseZip("9.9.9", { cache, log: quiet })).rejects.toThrow("no recorded sha256");
});
