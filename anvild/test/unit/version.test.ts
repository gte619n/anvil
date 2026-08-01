/**
 * [CI2-9] The daemon's reported version MAJOR.MINOR must track the repo-root VERSION file (the single
 * source of truth every other artifact derives from). It used to read anvild/package.json, which was
 * frozen at 0.2.0 while the release train was 3.0.x — so health/badge/fleet/watchdog all reported a
 * version 3 majors stale. This pins them together so they can't drift again.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, humanVersion } from "../../src/version";

const versionFile = readFileSync(join(import.meta.dir, "../../../VERSION"), "utf8").trim();

test("[CI2-9] humanVersion is MAJOR.MINOR.0 of the repo VERSION file", () => {
  expect(/^\d+\.\d+$/.test(versionFile)).toBe(true);
  expect(humanVersion()).toBe(`${versionFile}.0`);
});

test("[CI2-9] the reported VERSION's MAJOR.MINOR matches the VERSION file", () => {
  const majorMinor = VERSION.split("+")[0]!.split(".").slice(0, 2).join(".");
  expect(majorMinor).toBe(versionFile);
});
