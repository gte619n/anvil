/**
 * The merge guard (agent-cad-and-browser spec §4.11, §4.14 #2 #3 #8, decisions 62, 88, 97).
 *
 * `verifyParts` answers "is every part this change touches still what the owner approved?" from the
 * repo as it is on disk, with NOTHING trusted from what was measured before. For each selected part:
 *
 *   1. SCREEN   `design.json` with Track B's script screen. A refused design is never loaded.
 *   2. REPLAY   it in a FRESH SolidCraft process of its own: a new `CadManager` with no refresh job,
 *               started in a throwaway folder that holds only a copy of `design.json` (`--allow-path`
 *               is that folder, never the repo), loaded by `batch` — never `--in` (decision 88).
 *   3. MEASURE  and GATE with `measureAndEvaluate`, the very function the live refresh runs: design
 *               bodies only, the hole table, feature errors (`timeline[].error`), the lock store's
 *               accepted numbers, tolerance caps, the rules hash, references (integrity,
 *               interference, and geometry: each measures what its import did), the gap.
 *   4. COMPARE  `part.json.measured` with the replay: the script it was measured from and the numbers,
 *               within the part's tolerance. A text merge of two branches gives a script neither
 *               branch measured, so this fails until the refresh has run on the merged script and
 *               its measurement is committed.
 *
 * A part is OK when its state is `pass`, or `concept` (reported, never failing). `fail`, `gap`,
 * `unverified` (an adoption pending — the locked block is unknown to the lock store — a measurement
 * of another script, a design that did not load) all fail.
 *
 * READ ONLY. Nothing here writes `part.json`, `design.json`, `cad/rules.json` or the lock store; the
 * only files written are the throwaway folder (deleted afterwards) and whatever SolidCraft writes in
 * its own temp and recovery folders.
 *
 * SELECTION. `parts` names parts outright. `changedSince: REF` selects every part with a path under
 * `cad/<part>/` that differs between `git merge-base REF HEAD` and the WORKING TREE (committed,
 * staged, unstaged, and untracked files), and every part when `cad/rules.json` differs. The working
 * tree, not `HEAD`, because the guard is run on a merge before it is committed. Both together: the
 * union. Neither: every part in `cad/`.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingLines, pendingAdoptions, type GateCheck, type GateResult, type GateState, type Measurement } from "./gate";
import { LockStore, type LockReader } from "./locks";
import { CadError, CadManager, type CadManagerOptions } from "./manager";
import { CAD_DIR, isValidPartName, listParts, partRef, type PartRef } from "./partfolder";
import { DEFAULT_TOLERANCE, TOLERANCE_CAPS, readPartFile, type Measured } from "./partfile";
import { DESIGN_FILE } from "./poststep";
import { measureAndEvaluate } from "./refresh";
import { makeReferenceReplay, type ReferenceReplay } from "./refreplay";
import { screenScriptText } from "../solidcraft/script-screen";

export interface VerifyOptions {
  /** The worktree root (the git toplevel). */
  worktree: string;
  /** Parts named outright. */
  parts?: string[];
  /** Also select the parts changed since this git ref (see the header). */
  changedSince?: string;
  /** The SolidCraft binary. Production: `resolveSolidcraftCli()` (verify-cli.ts, the service). */
  binary: { path: string };
  /** What the owner approved. Default: the store in `stateDir`, opened READ-ONLY. */
  lockStore?: LockReader;
  /** Where the daemon keeps its lock store (`<stateDir>/cadwork/locks.json`); used when `lockStore` is absent. */
  stateDir?: string;
  /** This machine's serverId: an approval found by the repo's PATH counts only when it was made here. */
  machine?: string;
  /** Spawn / environment / timeout seams for the replay processes (tests). `resolveCli` and `refresh` are always verify's own. */
  manager?: Omit<CadManagerOptions, "resolveCli" | "refresh">;
  /** Where the throwaway folders are made. Default: the system temp folder. */
  tmpRoot?: string;
}

/** A part whose state is one of these does not fail the guard. */
export const VERIFY_OK_STATES: readonly GateState[] = ["pass", "concept"];

export interface PartVerdict {
  part: string;
  state: GateState;
  /** `state` is pass or concept. */
  ok: boolean;
  /** One line saying why it fails (or what it is, for a concept). */
  reason?: string;
  /** Every check of the gate, then the `measured.*` checks of step 4. */
  checks: GateCheck[];
  /** The failing hard checks as plain lines. */
  failing: string[];
  warnings: string[];
  needsAdoption?: GateResult["needsAdoption"];
  /** What the replay measured (design bodies only). */
  measurement?: Measurement;
  scriptSha?: string;
  ms: number;
}

export interface VerifyResult {
  /** Every selected part is OK (and the run itself worked). */
  ok: boolean;
  /** The run could not be carried out (a bad ref, an unreadable lock store): exit code 2. */
  error?: string;
  parts: PartVerdict[];
  /** How the parts were chosen. */
  selection: { all: boolean; named: string[]; changedSince?: string; changed: string[]; rulesChanged: boolean };
}

/** Thrown for a run that cannot be carried out at all (verify-cli exits 2). */
export class VerifyCannotRun extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyCannotRun";
  }
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
}

/**
 * The parts `changedSince` selects: every `cad/<part>/…` path that differs between the merge base
 * of `ref` and HEAD and the working tree, plus untracked files there; `rulesChanged` when
 * `cad/rules.json` is among them. Throws `VerifyCannotRun` for a ref git does not know.
 */
export function changedParts(worktree: string, ref: string): { parts: string[]; rulesChanged: boolean; unexpected: string[] } {
  if (!ref || ref.startsWith("-")) throw new VerifyCannotRun(`--changed-since needs a git ref, not ${JSON.stringify(ref)}`);
  const commit = git(worktree, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (!commit.ok) throw new VerifyCannotRun(`--changed-since: ${JSON.stringify(ref)} is not a commit in this repository`);
  const base = git(worktree, ["merge-base", commit.out.trim(), "HEAD"]);
  if (!base.ok) throw new VerifyCannotRun(`--changed-since: ${JSON.stringify(ref)} has no common history with HEAD${base.err ? ` (${base.err})` : ""}`);
  const diff = git(worktree, ["diff", "--name-only", "--no-renames", "-z", base.out.trim(), "--", CAD_DIR]);
  if (!diff.ok) throw new VerifyCannotRun(`git diff failed: ${diff.err}`);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", CAD_DIR]);
  if (!untracked.ok) throw new VerifyCannotRun(`git ls-files failed: ${untracked.err}`);
  const paths = [...diff.out.split("\0"), ...untracked.out.split("\0")].filter(Boolean);
  const parts = new Set<string>();
  const unexpected = new Set<string>();
  let rulesChanged = false;
  for (const p of paths) {
    if (p === `${CAD_DIR}/rules.json`) {
      rulesChanged = true;
      continue;
    }
    const m = /^cad\/([^/]+)\/(.+)$/.exec(p);
    // Anything else under cad/ that is not inside a validly named part folder: a file directly under
    // cad/ (`cad/bracket.step`) or a folder no part can have (`cad/Widget_X/…`). The merge guard skips
    // these; an autopilot builder and the dev pipeline are failed on them (B3 review, item 4).
    if (!m || !isValidPartName(m[1])) {
      unexpected.add(p);
      continue;
    }
    if (/^(\.cache|release)(\/|$)/.test(m[2]!)) continue; // daemon-written, git-excluded
    parts.add(m[1]!);
  }
  return { parts: [...parts].sort(), rulesChanged, unexpected: [...unexpected].sort() };
}

const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/**
 * Step 4: `part.json.measured` against what the replay produced. Every check is hard. The tolerance
 * is the part's own (clamped to the caps), or the defaults for a part with no expectations.
 */
export function measuredChecks(measured: Measured | undefined, replay: Measurement, tolerance: { length: number; volumeRel: number } | undefined): GateCheck[] {
  const tol = tolerance ? { length: Math.min(tolerance.length, TOLERANCE_CAPS.length), volumeRel: Math.min(tolerance.volumeRel, TOLERANCE_CAPS.volumeRel) } : DEFAULT_TOLERANCE;
  if (!measured) {
    return [{ id: "measured.part.json", expected: "part.json records the daemon's measurement of this design", measured: "part.json has no measurement — open the part in Anvil (check_part) so the daemon measures it, then commit part.json", ok: false, hard: true }];
  }
  const out: GateCheck[] = [];
  out.push({
    id: "measured.scriptSha",
    expected: `part.json was measured from this design.json (${replay.scriptSha.slice(0, 12)})`,
    measured: measured.scriptSha === replay.scriptSha ? "same script" : `part.json was measured from another script (${String(measured.scriptSha).slice(0, 12)}) — run check_part on this design and commit part.json`,
    ok: measured.scriptSha === replay.scriptSha,
    hard: true,
  });
  const box = Array.isArray(measured.bbox) && measured.bbox.length === 3 ? [...measured.bbox].map(Number).sort((a, b) => a - b) : undefined;
  const names = ["measured.bbox.min", "measured.bbox.mid", "measured.bbox.max"];
  for (let i = 0; i < 3; i++) out.push({ id: names[i]!, expected: replay.bbox[i]!, measured: box ? box[i]! : "missing", ok: !!box && close(box[i]!, replay.bbox[i]!, tol.length), hard: true });
  out.push({ id: "measured.volume", expected: replay.volume, measured: typeof measured.volume === "number" ? measured.volume : "missing", ok: typeof measured.volume === "number" && close(measured.volume, replay.volume, tol.volumeRel * Math.abs(replay.volume)), hard: true });
  out.push({ id: "measured.bodies", expected: replay.bodies, measured: typeof measured.bodies === "number" ? measured.bodies : "missing", ok: measured.bodies === replay.bodies, hard: true });
  const holes = (h: { diameter: number; count: number; kind?: string }[]) => h.map((x) => `⌀${Math.round(x.diameter * 1e4) / 1e4}×${x.count}${x.kind ? ` ${x.kind}` : ""}`).join(", ") || "none";
  const mh = Array.isArray(measured.holes) ? [...measured.holes].sort((a, b) => a.diameter - b.diameter || String(a.kind).localeCompare(String(b.kind))) : undefined;
  const rh = [...replay.holes].sort((a, b) => a.diameter - b.diameter || String(a.kind).localeCompare(String(b.kind)));
  const sameHoles = !!mh && mh.length === rh.length && mh.every((h, i) => close(h.diameter, rh[i]!.diameter, tol.length) && h.count === rh[i]!.count && h.kind === rh[i]!.kind);
  out.push({ id: "measured.holes", expected: holes(rh), measured: mh ? holes(mh) : "missing", ok: sameHoles, hard: true });
  return out;
}

function verdictOf(part: string, gate: GateResult, extra: GateCheck[], t0: number, more: Partial<PartVerdict> = {}): PartVerdict {
  const checks = [...gate.checks, ...extra];
  const extraFails = extra.some((c) => c.hard && !c.ok);
  // The measured-vs-replay checks can only make a part fail; they never lift a concept or an unverified part.
  const state: GateState = gate.state === "pass" && extraFails ? "fail" : gate.state;
  const result = { ...gate, checks, state };
  const failing = failingLines(result);
  const adoptions = pendingAdoptions(result);
  const reason =
    state === "pass"
      ? undefined
      : state === "concept"
        ? "concept part: dimensions not confirmed yet (reported, not failing)"
        : state === "gap"
          ? `blocked on a feature SolidCraft cannot make: ${gate.gap?.feature ?? "?"}${gate.gap?.detail ? ` — ${gate.gap.detail}` : ""}`
          : adoptions.length
            ? `adoption pending (${adoptions.join(", ")}): what is in the repo is not what the owner approved — the owner must adopt it in Anvil`
            : failing.length
              ? `the gate fails — ${failing.join("; ")}`
              : `the gate says ${state}`;
  return {
    part,
    state,
    ok: VERIFY_OK_STATES.includes(state),
    ...(reason ? { reason } : {}),
    checks,
    failing,
    warnings: gate.warnings,
    ...(gate.needsAdoption ? { needsAdoption: gate.needsAdoption } : {}),
    ms: performance.now() - t0,
    ...more,
  };
}

const failed = (part: string, reason: string, t0: number, state: GateState = "fail"): PartVerdict => ({
  part,
  state,
  ok: false,
  reason,
  checks: [{ id: "design", expected: "design.json loads in a fresh SolidCraft process", measured: reason, ok: false, hard: true }],
  failing: [`design: ${reason}`],
  warnings: [],
  ms: performance.now() - t0,
});

/** One part: screen, replay in a fresh sandboxed process, measure, gate, compare with part.json. */
async function verifyOne(ref: PartRef, locks: LockReader, opts: VerifyOptions, replayReference: ReferenceReplay): Promise<PartVerdict> {
  const t0 = performance.now();
  let bytes: Buffer;
  try {
    const st = lstatSync(join(ref.dir, DESIGN_FILE));
    if (!st.isFile()) return failed(ref.part, `cad/${ref.part}/design.json is not a regular file`, t0);
    bytes = readFileSync(join(ref.dir, DESIGN_FILE));
  } catch {
    // No design: the gate decides (a part with only expectations is unverified, never pass).
    bytes = Buffer.alloc(0);
  }
  if (bytes.length) {
    const screened = screenScriptText(bytes.toString("utf8"));
    if (!screened.ok) return failed(ref.part, `design.json was refused by Anvil's script screen and was not loaded: ${screened.reason}`, t0);
  }

  // The replay never sees the repo: a throwaway folder shaped like a worktree, holding only a copy
  // of the exact bytes screened above. SolidCraft's --allow-path is that copy's part folder.
  const root = realpathSync(mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "anvil-verify-")));
  // A fresh manager per part, with NO refresh job: nothing it runs can write part.json, and its one
  // process is gone before the folder is.
  // Its child's TMPDIR is inside the same throwaway folder, so nothing it leaves outlives the run.
  const manager = new CadManager({ ...opts.manager, maxProcs: 1, resolveCli: () => opts.binary, refresh: undefined, tmpRoot: join(root, "tmp") });
  try {
    const dir = join(root, CAD_DIR, ref.part);
    mkdirSync(dir, { recursive: true });
    if (bytes.length) writeFileSync(join(dir, DESIGN_FILE), bytes);
    const box: PartRef = { key: dir, worktree: root, part: ref.part, dir };
    const evaluated = await manager.run(box, async (slot) =>
      measureAndEvaluate((tool, args) => slot.call(tool, args), ref, { scriptSha: slot.scriptSha(), state: slot.state() }, { locks, machine: opts.machine, replayReference }),
    );
    const part = readPartFile(ref.dir);
    const extra = evaluated.measurement && part.kind === "ok" ? measuredChecks(part.file.measured, evaluated.measurement, part.file.expectations?.tolerance) : [];
    return verdictOf(ref.part, evaluated.gate, extra, t0, { ...(evaluated.measurement ? { measurement: evaluated.measurement } : {}), ...(evaluated.scriptSha ? { scriptSha: evaluated.scriptSha } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failed(ref.part, e instanceof CadError ? msg : `the replay failed: ${msg}`, t0, "unverified");
  } finally {
    await manager.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Verify the selected parts of a worktree. Never writes to the repo or the lock store. */
export async function verifyParts(opts: VerifyOptions): Promise<VerifyResult> {
  const named = [...new Set(opts.parts ?? [])];
  const selection: VerifyResult["selection"] = { all: false, named, changed: [], rulesChanged: false, ...(opts.changedSince !== undefined ? { changedSince: opts.changedSince } : {}) };
  let locks: LockReader;
  let worktree: string;
  const selected = new Set<string>();
  let existing: string[] = [];
  try {
    try {
      worktree = realpathSync(opts.worktree);
    } catch {
      throw new VerifyCannotRun(`${opts.worktree} does not exist`);
    }
    if (opts.lockStore) locks = opts.lockStore;
    else {
      if (!opts.stateDir) throw new VerifyCannotRun("no lock store: pass lockStore or stateDir");
      const store = new LockStore(opts.stateDir, { readOnly: true });
      if (store.unreadable) throw new VerifyCannotRun(`the lock store ${store.file} could not be read (${store.unreadable})`);
      locks = store;
    }
    for (const p of named) {
      if (!isValidPartName(p)) throw new VerifyCannotRun(`${JSON.stringify(p)} is not a part name`);
      selected.add(p);
    }
    existing = listParts(worktree);
    if (opts.changedSince !== undefined) {
      const c = changedParts(worktree, opts.changedSince);
      selection.changed = c.parts;
      selection.rulesChanged = c.rulesChanged;
      // A part folder the change deleted has nothing left to verify.
      for (const p of c.parts) if (existing.includes(p)) selected.add(p);
      if (c.rulesChanged) for (const p of existing) selected.add(p);
    }
    if (!named.length && opts.changedSince === undefined) {
      selection.all = true;
      for (const p of existing) selected.add(p);
    }
  } catch (e) {
    if (e instanceof VerifyCannotRun) return { ok: false, error: e.message, parts: [], selection };
    throw e;
  }

  const parts: PartVerdict[] = [];
  // A reference the lock store holds no measurement of is checked against its import replayed alone,
  // in a throwaway process of the same binary (./refreplay.ts).
  const m = opts.manager ?? {};
  const replayReference = makeReferenceReplay({ resolveCli: () => opts.binary, manager: { ...(m.spawn ? { spawn: m.spawn } : {}), ...(m.extraEnv ? { extraEnv: m.extraEnv } : {}), ...(m.requestTimeoutMs ? { requestTimeoutMs: m.requestTimeoutMs } : {}) }, ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}) });
  for (const name of [...selected].sort()) {
    const t0 = performance.now();
    let ref: PartRef;
    try {
      ref = partRef(worktree, name);
    } catch (e) {
      parts.push(failed(name, e instanceof Error ? e.message : String(e), t0));
      continue;
    }
    if (!existing.includes(name)) {
      parts.push(failed(name, `cad/${name} does not exist`, t0));
      continue;
    }
    parts.push(await verifyOne(ref, locks, opts, replayReference));
  }
  return { ok: parts.every((p) => p.ok), parts, selection };
}
