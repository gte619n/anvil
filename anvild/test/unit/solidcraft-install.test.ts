/**
 * Phase B1 unit tests for the managed SolidCraft install (spec §4.10, §4.14 items 14, 15, 19; the
 * six-step sequence in the B0 spike evidence). The downloader and the codesign/spctl runner are
 * fakes; hashing, extraction, the step order and the on-disk result are the real code, and step 6
 * really executes the extracted binary.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSolidcraftCli, setManagedSolidcraftCli } from "../../src/solidcraft/binary";
import {
  SOLIDCRAFT_REQUIREMENT,
  SOLIDCRAFT_TEAM_ID,
  installSolidcraft,
  installedSolidcraft,
  installedVersions,
  pruneSolidcraft,
  solidcraftCliPath,
  solidcraftRoot,
  solidcraftVersionDir,
  type InstallDeps,
  type InstallResult,
} from "../../src/solidcraft/install";
import { SolidcraftPinService } from "../../src/solidcraft/pin";
import { ZipError, extractZip, readZipEntries } from "../../src/solidcraft/zip";
import { fakeReleaseZip, fakeVerifier, makeZip, memoryDownloader, sha256Of, type FakeReleaseOptions, type FakeVerifierOptions } from "../helpers/solidcraft-release";

const V = "0.44.1";
const dirs: string[] = [];
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "anvil-sc-install-"));
  dirs.push(d);
  return d;
}
afterEach(() => setManagedSolidcraftCli(undefined));
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Everything left under <stateDir>/solidcraft — an empty list means "nothing on disk". */
const leftovers = (dir: string): string[] => (existsSync(solidcraftRoot(dir)) ? readdirSync(solidcraftRoot(dir)) : []);

interface Setup {
  dir: string;
  sha256: string;
  deps: Partial<InstallDeps>;
  run: ReturnType<typeof fakeVerifier>;
  download: ReturnType<typeof memoryDownloader>;
  slept: number[];
}
function setup(release: FakeReleaseOptions = {}, verifier: FakeVerifierOptions = {}, zipOverride?: Buffer): Setup {
  const dir = stateDir();
  const made = fakeReleaseZip(V, release);
  const zip = zipOverride ?? made.zip;
  const run = fakeVerifier(verifier);
  const download = memoryDownloader({ [V]: zip });
  const slept: number[] = [];
  const deps: Partial<InstallDeps> = { download, run, notarizeAttempts: 3, notarizeRetryMs: 7, sleep: async (ms) => void slept.push(ms), log: () => {} };
  return { dir, sha256: sha256Of(zip), deps, run, download, slept };
}
function refused(r: InstallResult): Extract<InstallResult, { ok: false }> {
  if (r.ok) throw new Error("expected the install to be refused");
  return r;
}

describe("verification", () => {
  test("[B1] a zip whose sha256 differs is deleted and reported", async () => {
    const s = setup();
    const wrong = "0".repeat(64);
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: wrong }, s.deps));
    expect(r.reason).toBe("sha-mismatch");
    expect(r.detail).toContain(s.sha256); // what it actually was
    expect(r.detail).toContain(wrong); // what the pin records
    expect(existsSync(solidcraftVersionDir(s.dir, V))).toBe(false);
    expect(leftovers(s.dir)).toEqual([]);
    // Nothing was extracted or run: the check comes before any of that.
    expect(s.run.calls).toEqual([]);
  });

  test("[B1] a zip signed by the wrong Team ID is deleted and reported", async () => {
    const s = setup({}, { teamOk: false });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("wrong-team");
    expect(r.detail).toContain(SOLIDCRAFT_TEAM_ID);
    expect(existsSync(solidcraftVersionDir(s.dir, V))).toBe(false);
    expect(leftovers(s.dir)).toEqual([]);
    // The binary was never executed: no --version call was made.
    expect(s.run.calls.some((c) => c.includes("--version"))).toBe(false);
  });

  test("[B1] the Team ID is the constant G5QA5U5X2S, enforced by a codesign requirement string", async () => {
    expect(SOLIDCRAFT_TEAM_ID).toBe("G5QA5U5X2S");
    expect(SOLIDCRAFT_REQUIREMENT).toBe(
      'anchor apple generic and certificate leaf[subject.OU] = "G5QA5U5X2S" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    );
    // …and it is a literal in the source, not read from config or the environment.
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "solidcraft", "install.ts"), "utf8");
    expect(src).toContain('export const SOLIDCRAFT_TEAM_ID = "G5QA5U5X2S";');
    const s = setup();
    await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    const teamCall = s.run.calls.find((c) => c.some((a) => a.startsWith("-R=")));
    expect(teamCall).toEqual(["/usr/bin/codesign", "--verify", "--strict", `-R=${SOLIDCRAFT_REQUIREMENT}`, expect.stringContaining("solidcraft-cli")]);
  });

  test("[B1] an invalid signature is deleted and reported", async () => {
    const s = setup({}, { signatureOk: false });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("signature-invalid");
    expect(leftovers(s.dir)).toEqual([]);
    expect(s.run.calls.length).toBe(1); // stopped at step 3
  });

  test("[B1] a build that is not notarized is retried a bounded number of times, then deleted and reported", async () => {
    const s = setup({}, { notarized: [false] });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("not-notarized");
    expect(r.detail).toContain("Unnotarized Developer ID");
    const assess = s.run.calls.filter((c) => c[0] === "/usr/sbin/spctl" && c.includes("-a"));
    expect(assess.length).toBe(3); // notarizeAttempts, no more
    expect(s.slept).toEqual([7, 7]); // a pause between attempts, none after the last
    expect(leftovers(s.dir)).toEqual([]);
    expect(s.run.calls.some((c) => c.includes("--version"))).toBe(false);
  });

  test("[B1] a notarization check that passes on a retry installs", async () => {
    const s = setup({}, { notarized: [false, true] });
    const r = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    expect(r.ok).toBe(true);
    expect(s.run.calls.filter((c) => c[0] === "/usr/sbin/spctl" && c.includes("-a")).length).toBe(2);
    expect(s.slept).toEqual([7]);
  });

  test("[B1] Gatekeeper assessments disabled is 'cannot verify', a failure, with no retry", async () => {
    const s = setup({}, { assessments: false });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("cannot-verify");
    expect(r.detail).toContain("cannot verify");
    // spctl -a accepts anything with assessments off, so it must not even be asked.
    expect(s.run.calls.some((c) => c[0] === "/usr/sbin/spctl" && c.includes("-a"))).toBe(false);
    expect(s.slept).toEqual([]);
    expect(leftovers(s.dir)).toEqual([]);
  });

  test("[B1] a binary that reports another version is deleted and reported", async () => {
    const s = setup({ reports: "0.43.0" });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("version-mismatch");
    expect(r.detail).toContain("solidcraft-cli 0.43.0");
    expect(r.detail).toContain("solidcraft-cli 0.44.1");
    expect(leftovers(s.dir)).toEqual([]);
  });

  test("[B1] --version must match exactly: extra output is a mismatch", async () => {
    const s = setup({}, { version: () => ({ code: 0, stdout: "solidcraft-cli 0.44.1 (nightly)\n", stderr: "" }) });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("version-mismatch");
  });

  test("[B1] the six steps run in order, with spctl -t install and never -t execute", async () => {
    const s = setup();
    const r = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    expect(r.ok).toBe(true);
    const shape = s.run.calls.map((c) => {
      if (c[0] === "/usr/bin/codesign") return c.some((a) => a.startsWith("-R=")) ? "team" : "codesign";
      if (c[0] === "/usr/sbin/spctl") return c.includes("--status") ? "spctl-status" : `spctl ${c.slice(1, -1).join(" ")}`;
      return c.slice(1).join(" ");
    });
    expect(shape).toEqual(["codesign", "team", "spctl-status", "spctl -a -vv -t install", "--version"]);
    expect(s.run.calls.flat()).not.toContain("execute");
    // Every check ran on the SAME file, and it was verified before being moved into place.
    const checked = new Set(s.run.calls.filter((c) => !c.includes("--status")).map((c) => (c[1] === "--version" ? c[0] : c.at(-1))));
    expect(checked.size).toBe(1);
    expect([...checked][0]).toContain(`${join("solidcraft", ".tmp-")}`);
  });

  test("[B1] a failed download is reported and leaves nothing behind", async () => {
    const s = setup();
    const r = refused(await installSolidcraft(s.dir, { version: "0.45.0", sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("download-failed");
    expect(leftovers(s.dir)).toEqual([]);
  });

  test("[B1] a malformed version or sha256 is refused before anything is downloaded", async () => {
    const s = setup();
    for (const ref of [
      { version: "../../etc", sha256: s.sha256 },
      { version: "0.44", sha256: s.sha256 },
      { version: V, sha256: "abc" },
      { version: V, sha256: s.sha256.toUpperCase() },
    ]) {
      expect(refused(await installSolidcraft(s.dir, ref, s.deps)).reason).toBe("bad-request");
    }
    expect(s.download.calls).toEqual([]);
    expect(existsSync(solidcraftRoot(s.dir))).toBe(false);
  });
});

describe("zip handling", () => {
  const top = `solidcraft-cli-${V}-macos-universal`;
  const good = { name: `${top}/solidcraft-cli`, data: "#!/bin/sh\necho hi\n", mode: 0o100755 };

  async function installZip(zip: Buffer) {
    const s = setup({}, {}, zip);
    const r = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    return { s, r };
  }

  test("[B1] a zip entry with '..' is refused and nothing is written outside the staging folder", async () => {
    const { s, r } = await installZip(makeZip([{ name: `${top}/` }, good, { name: `${top}/../../escaped.txt`, data: "x" }]));
    expect(refused(r).reason).toBe("unsafe-zip");
    expect(refused(r).detail).toContain("..");
    expect(existsSync(join(s.dir, "escaped.txt"))).toBe(false);
    expect(existsSync(join(solidcraftRoot(s.dir), "escaped.txt"))).toBe(false);
    expect(leftovers(s.dir)).toEqual([]);
    expect(s.run.calls).toEqual([]); // refused before any verification, let alone execution
  });

  test("[B1] a zip entry with an absolute path is refused", async () => {
    const target = join(tmpdir(), `anvil-sc-abs-${process.pid}.txt`);
    const { s, r } = await installZip(makeZip([{ name: `${top}/` }, good, { name: target, data: "x" }]));
    expect(refused(r).reason).toBe("unsafe-zip");
    expect(refused(r).detail).toContain("absolute path");
    expect(existsSync(target)).toBe(false);
    expect(leftovers(s.dir)).toEqual([]);
  });

  test("[B1] a zip entry that is a symlink is refused", async () => {
    const { s, r } = await installZip(makeZip([{ name: `${top}/` }, { name: `${top}/solidcraft-cli`, data: "/bin/sh", mode: 0o120777 }]));
    expect(refused(r).reason).toBe("unsafe-zip");
    expect(refused(r).detail).toContain("symlink");
    expect(leftovers(s.dir)).toEqual([]);
  });

  test("[B1] a zip with no solidcraft-cli is refused as a missing binary", async () => {
    const s = setup({ noBinary: true });
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps));
    expect(r.reason).toBe("missing-binary");
    expect(leftovers(s.dir)).toEqual([]);
    expect(s.run.calls).toEqual([]);
  });

  test("[B1] solidcraft-cli as a folder is not a binary", async () => {
    const { r } = await installZip(makeZip([{ name: `${top}/` }, { name: `${top}/solidcraft-cli/` }, { name: `${top}/solidcraft-cli/x`, data: "x" }]));
    expect(refused(r).reason).toBe("missing-binary");
  });

  test("[B1] solvecraft-cli is never extracted, so it can never be run", async () => {
    const s = setup({ withSolvecraft: true });
    const r = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    expect(r.ok).toBe(true);
    const files = readdirSync(solidcraftVersionDir(s.dir, V)).sort();
    expect(files).toEqual([".anvil-verified.json", "LICENSE-MIT", "solidcraft-cli"]);
    expect(s.run.calls.flat().some((a) => a.includes("solvecraft"))).toBe(false);
  });

  test("[B1] the single top-level folder is stripped; two top folders or a loose file are refused", async () => {
    const two = await installZip(makeZip([{ name: `${top}/` }, good, { name: "other/solidcraft-cli", data: "x" }]));
    expect(refused(two.r).reason).toBe("bad-zip");
    const loose = await installZip(makeZip([{ name: "solidcraft-cli", data: "x", mode: 0o100755 }]));
    expect(refused(loose.r).reason).toBe("bad-zip");
    const notZip = await installZip(Buffer.from("this is not a zip at all, just some bytes"));
    expect(refused(notZip.r).reason).toBe("bad-zip");
  });

  test("[B1] the reader refuses backslashes, duplicates, file-as-folder and a wrong checksum", async () => {
    const dir = stateDir();
    const write = (name: string, zip: Buffer): string => {
      const f = join(dir, name);
      writeFileSync(f, zip);
      return f;
    };
    const problem = (f: string): string => {
      try {
        readZipEntries(f);
        return "accepted";
      } catch (e) {
        return e instanceof ZipError ? e.problem : "other";
      }
    };
    expect(problem(write("bs.zip", makeZip([{ name: "t/" }, { name: "t\\..\\x", data: "x" }])))).toBe("unsafe-zip");
    expect(problem(write("dup.zip", makeZip([{ name: "t/a", data: "1" }, { name: "t/a", data: "2" }])))).toBe("unsafe-zip");
    expect(problem(write("faf.zip", makeZip([{ name: "t/a", data: "1" }, { name: "t/a/b", data: "2" }])))).toBe("unsafe-zip");
    expect(problem(write("dot.zip", makeZip([{ name: "t/./a", data: "1" }])))).toBe("unsafe-zip");
    expect(problem(write("ok.zip", makeZip([{ name: "t/" }, { name: "t/a", data: "1" }])))).toBe("accepted");

    // Flip one byte of stored data: the size still matches, the CRC does not.
    const zip = makeZip([{ name: "t/" }, { name: "t/a", data: "hello world", method: 0 }]);
    zip[zip.indexOf("hello world")] = 0x48;
    const out = join(dir, "out");
    mkdirSync(out);
    await expect(extractZip(write("crc.zip", zip), out)).rejects.toThrow(/checksum mismatch/);
  });

  test("[B1] extraction keeps the executable bit and file contents", async () => {
    const dir = stateDir();
    const f = join(dir, "a.zip");
    const big = Buffer.alloc(300_000, "abcdefghij");
    writeFileSync(f, makeZip([{ name: "t/" }, { name: "t/bin", data: big, mode: 0o100755 }, { name: "t/sub/" }, { name: "t/sub/note.txt", data: "n", method: 0 }, { name: "t/empty", data: "" }]));
    const out = join(dir, "out");
    mkdirSync(out);
    expect((await extractZip(f, out)).sort()).toEqual(["bin", "empty", "sub/note.txt"]);
    expect(readFileSync(join(out, "bin")).equals(big)).toBe(true);
    expect(lstatSync(join(out, "bin")).mode & 0o111).toBe(0o111);
    expect(lstatSync(join(out, "sub", "note.txt")).mode & 0o111).toBe(0);
    expect(readFileSync(join(out, "empty")).length).toBe(0);
  });
});

describe("install", () => {
  test("[B1] a good zip becomes the binary resolveSolidcraftCli() returns", async () => {
    const s = setup();
    const service = new SolidcraftPinService({ stateDir: s.dir, install: s.deps, env: {}, exists: () => false, log: () => {} });
    expect(resolveSolidcraftCli({}, () => false)).toBeUndefined(); // nothing before the pin

    const set = await service.setPin({ version: V, sha256: s.sha256 });
    expect(set.ok).toBe(true);

    const resolved = resolveSolidcraftCli({}, () => false);
    expect(resolved).toEqual({ path: solidcraftCliPath(s.dir, V), source: "managed", version: V });
    expect(lstatSync(resolved!.path).isFile()).toBe(true);
    // It is the build that was verified, and it runs.
    const out = Bun.spawnSync([resolved!.path, "--version"]);
    expect(out.stdout.toString().trim()).toBe(`solidcraft-cli ${V}`);
    expect(installedSolidcraft(s.dir, V, s.sha256)?.path).toBe(resolved!.path);
    expect(leftovers(s.dir)).toEqual([V]); // no temp folder, no zip left
  });

  test("[B1] an already verified install is reused without downloading again", async () => {
    const s = setup();
    const first = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    const second = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    expect(first.ok && !first.alreadyInstalled).toBe(true);
    expect(second.ok && second.alreadyInstalled).toBe(true);
    expect(s.download.calls).toEqual([V]);
  });

  test("[B1] a folder verified against a different zip is not trusted: it is replaced, or removed on failure", async () => {
    const s = setup();
    await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps);
    // The pin now records another sha256 for the same version, and the download does not match it.
    const other = "f".repeat(64);
    expect(installedSolidcraft(s.dir, V, other)).toBeUndefined();
    const r = refused(await installSolidcraft(s.dir, { version: V, sha256: other }, s.deps));
    expect(r.reason).toBe("sha-mismatch");
    expect(existsSync(solidcraftVersionDir(s.dir, V))).toBe(false); // the untrusted folder is gone
  });

  test("[B1] a version folder without the verification marker is not an install", async () => {
    const dir = stateDir();
    mkdirSync(solidcraftVersionDir(dir, V), { recursive: true });
    writeFileSync(solidcraftCliPath(dir, V), "#!/bin/sh\n", { mode: 0o755 });
    expect(installedSolidcraft(dir, V)).toBeUndefined();
    expect(installedVersions(dir)).toEqual([V]);
  });

  test("[B1] concurrent installs of one version download once and leave one folder", async () => {
    const s = setup();
    const results = await Promise.all([1, 2, 3, 4].map(() => installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, s.deps)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(s.download.calls).toEqual([V]);
    expect(leftovers(s.dir)).toEqual([V]);
  });

  test("[B1] an install that loses the race to another process accepts the winner's verified folder", async () => {
    // Another daemon process finishes the same install while ours is at step 6: our rename then
    // finds the folder already there. Simulated by running a second, independent install to
    // completion from inside our verifier.
    const s = setup();
    const made = fakeReleaseZip(V);
    let raced = false;
    const racing = fakeVerifier({
      before: async (cmd) => {
        if (cmd[1] !== "--version" || raced) return;
        raced = true;
        // Installs in ONE process are de-duplicated, so the competitor is built in another state
        // dir and its finished, verified folder is copied into ours — what a second process leaves.
        const other = stateDir();
        const r = await installSolidcraft(other, { version: V, sha256: s.sha256 }, { ...s.deps, run: fakeVerifier(), download: memoryDownloader({ [V]: made.zip }) });
        expect(r.ok).toBe(true);
        mkdirSync(solidcraftRoot(s.dir), { recursive: true });
        cpSync(solidcraftVersionDir(other, V), solidcraftVersionDir(s.dir, V), { recursive: true });
      },
    });
    const r = await installSolidcraft(s.dir, { version: V, sha256: s.sha256 }, { ...s.deps, run: racing });
    expect(raced).toBe(true);
    expect(r.ok).toBe(true);
    expect(installedSolidcraft(s.dir, V, s.sha256)).toBeDefined();
    expect(leftovers(s.dir)).toEqual([V]); // our temp sibling was cleaned up
  });

  test("[B1] prune keeps only the pinned, previous and candidate versions", async () => {
    const dir = stateDir();
    for (const v of ["0.40.1", "0.43.0", "0.44.1", "0.45.0", "0.30.1"]) {
      mkdirSync(solidcraftVersionDir(dir, v), { recursive: true });
      writeFileSync(solidcraftCliPath(dir, v), "x");
    }
    const fresh = join(solidcraftRoot(dir), ".tmp-0.46.0-live");
    const stale = join(solidcraftRoot(dir), ".tmp-0.41.0-dead");
    mkdirSync(fresh);
    mkdirSync(stale);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(stale, old, old);

    const removed = pruneSolidcraft(dir, ["0.44.1", "0.43.0", "0.45.0", undefined]);
    expect(removed).toEqual(["0.30.1", "0.40.1"]);
    expect(installedVersions(dir).sort()).toEqual(["0.43.0", "0.44.1", "0.45.0"]);
    expect(existsSync(fresh)).toBe(true); // an install in progress is left alone
    expect(existsSync(stale)).toBe(false); // a crashed one is swept
    expect(pruneSolidcraft(join(dir, "nope"), [])).toEqual([]);
  });
});
