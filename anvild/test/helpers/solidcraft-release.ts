/**
 * Test doubles for the managed SolidCraft install (Phase B1): a zip writer that can produce hostile
 * archives, a fake release zip whose `solidcraft-cli` is a real executable (a shell wrapper around
 * test/fixtures/fake-solidcraft.ts), and a scripted stand-in for codesign / spctl.
 *
 * With these, the installer runs its real code — hashing, extraction, the six-step order, the
 * rename into place — and really executes the extracted binary for `--version`. Only the two Apple
 * tools are faked, because a test fixture cannot carry a Developer ID signature.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { SOLIDCRAFT_REQUIREMENT, releaseAssetName, spawnRun, type Download, type Run, type RunResult } from "../../src/solidcraft/install";

export interface ZipInput {
  name: string;
  data?: string | Buffer;
  /** Full Unix mode including the file type, e.g. 0o100755, 0o040755, 0o120777 (symlink). */
  mode?: number;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
}

/** Build a zip byte-for-byte, with no name checks: tests need archives a real tool would refuse to write. */
export function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const isDir = e.name.endsWith("/");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const method = isDir || raw.length === 0 ? 0 : (e.method ?? 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const mode = e.mode ?? (isDir ? 0o040755 : 0o100644);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const sha256Of = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

const FAKE_SOLIDCRAFT = join(import.meta.dir, "..", "fixtures", "fake-solidcraft.ts");

/**
 * An executable that behaves like `solidcraft-cli` of `version` (it runs the fake server). `env`
 * adds FAKE_SC_* settings baked into the script — the daemon runs a managed binary with a bare
 * environment, so this is the only way a setting reaches it (e.g. `FAKE_SC_TABLE`, Phase B2).
 */
export function fakeCliScript(version: string, env: Record<string, string> = {}): string {
  const extra = Object.entries(env).map(([k, v]) => `${k}='${v}' `).join("");
  return `#!/bin/sh\n${extra}FAKE_SC_VERSION='${version}' exec '${process.execPath}' '${FAKE_SOLIDCRAFT}' "$@"\n`;
}

export interface FakeReleaseOptions {
  /** The version the binary REPORTS (default: the zip's own version). */
  reports?: string;
  /** Leave `solidcraft-cli` out. */
  noBinary?: boolean;
  /** Also ship `solvecraft-cli`, as older releases do. */
  withSolvecraft?: boolean;
  /** Extra entries appended inside (or outside) the top folder — for hostile archives. */
  extra?: ZipInput[];
  /** FAKE_SC_* settings baked into the binary (see `fakeCliScript`). */
  env?: Record<string, string>;
}

/** A zip laid out like the real release asset: one top folder holding the CLI and a licence. */
export function fakeReleaseZip(version: string, opts: FakeReleaseOptions = {}): { zip: Buffer; sha256: string; top: string } {
  const top = `solidcraft-cli-${version}-macos-universal`;
  const entries: ZipInput[] = [
    { name: `${top}/` },
    { name: `${top}/LICENSE-MIT`, data: "MIT\n" },
    ...(opts.noBinary ? [] : [{ name: `${top}/solidcraft-cli`, data: fakeCliScript(opts.reports ?? version, opts.env), mode: 0o100755 } satisfies ZipInput]),
    ...(opts.withSolvecraft ? [{ name: `${top}/solvecraft-cli`, data: "#!/bin/sh\nexit 0\n", mode: 0o100755 } satisfies ZipInput] : []),
    ...(opts.extra ?? []),
  ];
  const zip = makeZip(entries);
  return { zip, sha256: sha256Of(zip), top };
}

/** A downloader serving zips from memory, counting calls. An unknown version throws like a 404. */
export function memoryDownloader(zips: Record<string, Buffer>): Download & { calls: string[] } {
  const calls: string[] = [];
  const dl = (async (ref, destFile) => {
    calls.push(ref.version);
    const zip = zips[ref.version];
    if (!zip) throw new Error(`GitHub answered 404 for ${releaseAssetName(ref.version)}`);
    writeFileSync(destFile, zip);
  }) as Download & { calls: string[] };
  dl.calls = calls;
  return dl;
}

export interface FakeVerifierOptions {
  /** `codesign --verify --strict` (step 3). */
  signatureOk?: boolean;
  /** The Team-ID requirement (step 4). */
  teamOk?: boolean;
  /** `spctl --status` says assessments are enabled. */
  assessments?: boolean;
  /** Step 5 outcomes, one per attempt; the last value repeats. Default: accepted first time. */
  notarized?: boolean[];
  /** Replace the real execution of `<bin> --version` (step 6). */
  version?: (bin: string) => RunResult | Promise<RunResult>;
  /** Called before each command (tests use it to interleave a competing install). */
  before?: (cmd: string[]) => void | Promise<void>;
}

/**
 * A `Run` that answers codesign and spctl from a script and really executes everything else. Every
 * command is recorded in `.calls`.
 */
export function fakeVerifier(opts: FakeVerifierOptions = {}): Run & { calls: string[][] } {
  const calls: string[][] = [];
  let spctlAttempt = 0;
  const ok = (stdout = "", stderr = ""): RunResult => ({ code: 0, stdout, stderr });
  const run = (async (cmd, runOpts) => {
    calls.push(cmd);
    await opts.before?.(cmd);
    const bin = cmd.at(-1)!;
    if (cmd[0] === "/usr/bin/codesign") {
      if (cmd.some((a) => a.startsWith("-R="))) {
        // The real tool is handed the requirement string; a fake that ignored it would let a
        // changed constant through, so it must be exactly the pinned one.
        if (!cmd.includes(`-R=${SOLIDCRAFT_REQUIREMENT}`)) return { code: 2, stdout: "", stderr: "unexpected requirement" };
        return opts.teamOk === false ? { code: 3, stdout: "", stderr: `${bin}: valid on disk\ntest-requirement: code failed to satisfy specified code requirement(s)` } : ok();
      }
      return opts.signatureOk === false ? { code: 1, stdout: "", stderr: `${bin}: code object is not signed at all` } : ok("", `${bin}: valid on disk`);
    }
    if (cmd[0] === "/usr/sbin/spctl") {
      if (cmd.includes("--status")) return ok(opts.assessments === false ? "assessments disabled\n" : "assessments enabled\n");
      const seq = opts.notarized ?? [true];
      const pass = seq[Math.min(spctlAttempt++, seq.length - 1)];
      return pass
        ? ok("", `${bin}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Test (G5QA5U5X2S)`)
        : { code: 3, stdout: "", stderr: `${bin}: rejected\nsource=Unnotarized Developer ID` };
    }
    if (opts.version && cmd[1] === "--version") return opts.version(cmd[0]!);
    return spawnRun(cmd, runOpts);
  }) as Run & { calls: string[][] };
  run.calls = calls;
  return run;
}
