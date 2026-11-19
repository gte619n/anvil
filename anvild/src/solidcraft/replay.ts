/**
 * The replay gate, one machine's side (agent-cad-and-browser spec §4.10, §4.14 items 2 and 17).
 *
 * Before the fleet pin moves to a candidate build, each machine replays the designs it hosts under
 * BOTH the pinned build and the candidate, and compares the two results. Comparing two builds — not
 * the candidate against the numbers stored in `part.json` — means a stale `part.json` cannot reject
 * every candidate. Nothing here reads `part.json` at all.
 *
 * Where the designs come from:
 *   - For each environment: `cad/<part>/design.json` on `origin/<defaultBase>` after a fetch, or on
 *     the local `<defaultBase>` when the repo has no `origin`. They are read with `git ls-tree` and
 *     `git show` into a temporary folder, never from the working checkout. These decide.
 *   - For each open session worktree: `cad/<part>/design.json` as it sits on disk. These are
 *     ADVISORY: listed, never holding the pin.
 *
 * A design file is untrusted input (it comes from a repository or an agent's worktree), so:
 *   1. every script is SCREENED first (./script-screen.ts). One that is not a plain design script
 *      is `refused`: it is never handed to SolidCraft, it holds the pin, and it is named;
 *   2. every replay runs in a SANDBOX (./replay-client.ts): a fresh folder, a throwaway HOME, and
 *      SolidCraft's own file sandbox, which refuses a step that reaches outside that folder.
 *
 * What a replay result means:
 *   - a build that replays the script and reports no `timeline[].error` / `params[].error` gives
 *     numbers; the two builds' numbers are compared: `body_count`, per-body `faces`, `volume_mm3`
 *     (1e-6 relative), the sorted bounding box and the centre of mass. NOT compared: `edges`,
 *     `kernel.*`, timings, `area_mm2`;
 *   - a build that RAN the script and reported feature errors (or refused a step) has a
 *     conclusive failure: under the pin that is `baseline-broken` (ignored), under the candidate
 *     `candidate-error` (rejects the candidate);
 *   - a build that could not be started, crashed or timed out gives NO verdict: `inconclusive`,
 *     whichever build it was. That holds the pin and is tried again; it never counts as a pass and
 *     never as a rejection.
 *
 * With no baseline build there is nothing to compare against: each design is replayed under the
 * candidate only. The hub accepts that only when no pin is recorded.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolidcraftReplayDifference, SolidcraftReplayNumbers, SolidcraftReplayOutcome, SolidcraftReplayPart, SolidcraftReplayReport } from "@protocol";
import type { RunResult } from "./install";
import { sandboxedReplay, type ReplayDocument } from "./replay-client";
import { MAX_SCRIPT_BYTES, screenScriptText } from "./script-screen";

export type { SolidcraftReplayDifference, SolidcraftReplayOutcome, SolidcraftReplayPart, SolidcraftReplayReport };

/** Volume, bounding-box and centre-of-mass tolerance, relative. Adjacent real releases differed by 5e-12. */
export const REPLAY_TOLERANCE = 1e-6;
/** The centre of mass is never held tighter than this, in mm (real builds show ~1e-11 of float dust). */
export const COM_FLOOR_MM = 1e-6;
export const REPLAY_TIMEOUT_MS = 120_000;
export const REPLAY_CONCURRENCY = 2;
/** One machine's whole replay. Well under the hub's 60-minute HTTP timeout for the member call. */
export const REPLAY_TOTAL_TIMEOUT_MS = 30 * 60_000;
/** `cad/<part>/design.json`, exactly one folder deep. */
const DESIGN_RE = /^cad\/([^/]+)\/design\.json$/;

// ── Reading one replay result ───────────────────────────────────────────────────────────────────

export interface EvalBody {
  name: string;
  faces: number;
  volume: number;
  /** Bounding-box extents, sorted ascending, so a design is the same whichever way it faces. */
  extents: [number, number, number];
  /** Centre of mass on world axes, when the build reports one. */
  com?: [number, number, number];
}
export interface EvalSummary {
  bodyCount: number;
  bodies: EvalBody[];
}
export type EvalOutcome =
  | { ok: true; summary: EvalSummary }
  /**
   * `conclusive`: the build ran the script and this is its answer (feature errors, a refused
   * step). Not conclusive: the build could not be run, crashed or timed out — no verdict.
   */
  | { ok: false; error: string; conclusive: boolean };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const firstLine = (s: string): string => s.trim().split("\n")[0]?.slice(0, 400) ?? "";

/**
 * Turn what a build reported into a result. A feature or parameter error is a failed replay even
 * though the build itself was content (the real `eval` exits 0, a real `batch` answers ok).
 */
export function readResult(doc: unknown): EvalOutcome {
  const failed = (error: string): EvalOutcome => ({ ok: false, error, conclusive: true });
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "the build returned no readable result", conclusive: false };
  const d = doc as Record<string, unknown>;
  const items = (key: string): Record<string, unknown>[] => (Array.isArray(d[key]) ? (d[key] as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);
  const failedFeature = items("timeline").find((t) => t.error !== null && t.error !== undefined);
  if (failedFeature) return failed(`feature ${String(failedFeature.name ?? failedFeature.id ?? "?")} failed: ${String(failedFeature.error).slice(0, 300)}`);
  const failedParam = items("params").find((p) => p.error !== null && p.error !== undefined);
  if (failedParam) return failed(`parameter ${String(failedParam.name ?? "?")} failed: ${String(failedParam.error).slice(0, 300)}`);
  if (!Array.isArray(d.bodies)) return { ok: false, error: "the result has no `bodies`", conclusive: false };
  const bodies: EvalBody[] = items("bodies").map((b, i) => {
    const bbox = (b.bbox ?? {}) as { min?: unknown[]; max?: unknown[] };
    const ext = [0, 1, 2].map((k) => num(bbox.max?.[k]) - num(bbox.min?.[k])).sort((x, y) => x - y) as [number, number, number];
    const c = Array.isArray(b.center_of_mass) && b.center_of_mass.length === 3 ? (b.center_of_mass.map(num) as [number, number, number]) : undefined;
    return { name: typeof b.name === "string" && b.name ? b.name : `body ${i + 1}`, faces: num(b.faces), volume: num(b.volume_mm3), extents: ext, ...(c && c.every((x) => !Number.isNaN(x)) ? { com: c } : {}) };
  });
  const bodyCount = typeof d.body_count === "number" ? d.body_count : bodies.length;
  return { ok: true, summary: { bodyCount, bodies } };
}

/**
 * The same reading for `solidcraft-cli eval` output (exit code + JSON text). The replay gate no
 * longer runs `eval` (it has no sandbox); this stays for callers that hold an eval result. The
 * exit code alone is never trusted: a feature that fails to compute leaves it at 0.
 */
export function readEval(code: number, json: string | undefined, stderr = ""): EvalOutcome {
  if (code !== 0) return { ok: false, error: `eval exited ${code}${stderr.trim() ? `: ${firstLine(stderr)}` : ""}`, conclusive: code === 1 };
  let doc: unknown;
  try {
    doc = JSON.parse(json ?? "");
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
  } catch (e) {
    return { ok: false, error: `eval wrote no readable result (${e instanceof Error ? e.message : String(e)})`, conclusive: false };
  }
  return readResult(doc);
}

/** Equal within `tol`, relative to the larger magnitude. NaN (a missing number) equals only NaN. */
export function withinTolerance(a: number, b: number, tol: number = REPLAY_TOLERANCE): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (a === b) return true;
  return Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * The differences between the pinned build's result (`old`) and the candidate's (`next`). Empty
 * means "same". Bodies are paired in order; when the counts differ only that is reported, because
 * no pairing is then meaningful.
 */
export function compareEval(old: EvalSummary, next: EvalSummary, tol: number = REPLAY_TOLERANCE): SolidcraftReplayDifference[] {
  if (old.bodyCount !== next.bodyCount || old.bodies.length !== next.bodies.length) {
    return [{ field: "body_count", old: old.bodyCount, new: next.bodyCount }];
  }
  const out: SolidcraftReplayDifference[] = [];
  old.bodies.forEach((a, i) => {
    const b = next.bodies[i]!;
    if (a.faces !== b.faces && !(Number.isNaN(a.faces) && Number.isNaN(b.faces))) out.push({ field: "faces", body: a.name, old: a.faces, new: b.faces });
    if (!withinTolerance(a.volume, b.volume, tol)) out.push({ field: "volume_mm3", body: a.name, old: a.volume, new: b.volume });
    // The box is compared against its own largest side, so a thin plate's thickness is not held to
    // a tighter absolute bound than its length.
    const scale = Math.max(...a.extents.map(Math.abs), ...b.extents.map(Math.abs));
    const boxSame = a.extents.every((x, k) => {
      const y = b.extents[k]!;
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y);
      return Math.abs(x - y) <= tol * scale;
    });
    if (!boxSame) out.push({ field: "bbox", body: a.name, old: [...a.extents], new: [...b.extents] });
    // Centre of mass: a hole or a body that moved without changing volume, faces or extents shows
    // only here. Skipped when either build does not report one (older builds lack the key).
    if (a.com && b.com) {
      const allowed = Math.max(COM_FLOOR_MM, tol * (Number.isFinite(scale) ? scale : 0));
      if (a.com.some((x, k) => Math.abs(x - b.com![k]!) > allowed)) out.push({ field: "center_of_mass", body: a.name, old: [...a.com], new: [...b.com] });
    }
  });
  return out;
}

export function numbersOf(s: EvalSummary): SolidcraftReplayNumbers {
  return {
    body_count: s.bodyCount,
    faces: s.bodies.reduce((n, b) => n + (Number.isNaN(b.faces) ? 0 : b.faces), 0),
    volume_mm3: s.bodies.reduce((n, b) => n + (Number.isNaN(b.volume) ? 0 : b.volume), 0),
  };
}

/** The outcome for one design from its two replays. `baseline` undefined ⇒ errors-only mode. */
export function classify(baseline: EvalOutcome | undefined, candidate: EvalOutcome): Pick<SolidcraftReplayPart, "outcome" | "differences" | "old" | "new" | "error"> {
  // No verdict from the pinned build is NOT "broken under the pin": that would wave through
  // whatever the candidate did to this design. It holds.
  if (baseline && !baseline.ok && !baseline.conclusive) return { outcome: "inconclusive", error: `the pinned build gave no result: ${baseline.error}` };
  if (baseline && !baseline.ok) {
    // It ran and reported errors under the pinned build: the candidate cannot be blamed, whatever it does.
    return { outcome: "baseline-broken", error: baseline.error, ...(candidate.ok ? { new: numbersOf(candidate.summary) } : {}) };
  }
  const old = baseline ? { old: numbersOf(baseline.summary) } : {};
  if (!candidate.ok && !candidate.conclusive) return { outcome: "inconclusive", error: `the candidate gave no result: ${candidate.error}`, ...old };
  if (!candidate.ok) return { outcome: "candidate-error", error: candidate.error, ...old };
  const next = { new: numbersOf(candidate.summary) };
  if (!baseline) return { outcome: "same", ...next };
  const differences = compareEval(baseline.summary, candidate.summary);
  return differences.length ? { outcome: "differs", differences, ...old, ...next } : { outcome: "same", ...old, ...next };
}

/** Does this part's outcome hold the pin? */
export const holdsPin = (p: Pick<SolidcraftReplayPart, "outcome">): boolean => p.outcome === "differs" || p.outcome === "candidate-error" || p.outcome === "refused" || p.outcome === "inconclusive";
/** Does it REJECT the candidate for good? Only a replay that ran and differed, or ran and failed. */
export const rejectsCandidate = (p: Pick<SolidcraftReplayPart, "outcome">): boolean => p.outcome === "differs" || p.outcome === "candidate-error";

// ── Running one replay ──────────────────────────────────────────────────────────────────────────

export interface ReplayBuild {
  path: string;
  version: string;
}

/** Replay one screened script under one build. The default is the sandboxed runner. */
export type ReplayOne = (build: ReplayBuild, scriptText: string, commands: unknown[], opts: { timeoutMs: number; tmpRoot: string; pathEnv?: string }) => Promise<EvalOutcome>;

/**
 * The sandboxed runner (./replay-client.ts) with its answer read as a replay result. Exported so
 * Track A's `verify` can replay a design the same way.
 */
export const replayInSandbox: ReplayOne = async (build, scriptText, commands, opts) => {
  const r = await sandboxedReplay(build, scriptText, commands, opts);
  if (r.status === "replayed") return readResult(r.doc satisfies ReplayDocument);
  if (r.status === "refused-by-build") return { ok: false, error: `SolidCraft ${build.version} refused the script: ${r.error}`, conclusive: true };
  return { ok: false, error: r.error, conclusive: false };
};

// ── Finding designs ─────────────────────────────────────────────────────────────────────────────

export interface ReplayEnvironment {
  name: string;
  repoRoot: string;
  defaultBase?: string;
}
/** An open session worktree whose designs are replayed as advisory. */
export interface ReplayWorktree {
  path: string;
  /** Shown on the card: the session's title or branch. */
  label: string;
  environment?: string;
}
export type WorktreeProvider = () => Promise<ReplayWorktree[]> | ReplayWorktree[];

export type Git = (repoRoot: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

/** The real git. No prompts, no pager; `-c core.hooksPath=/dev/null` so a repo's hooks never run. */
export const spawnGit: Git = async (repoRoot, args, timeoutMs = 60_000) => {
  try {
    const p = Bun.spawn(["git", "-C", repoRoot, "-c", "core.hooksPath=/dev/null", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" } as Record<string, string>,
      timeout: timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: (await p.exited) ?? 1, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

export interface FoundDesign {
  part: string;
  /** Repo-relative, `cad/<part>/design.json`. */
  path: string;
  /** The copy to replay, in the temporary folder. Absent when the design is refused unread. */
  file?: string;
  /** Why it is refused without being read (larger than the size cap). */
  refused?: string;
}
export interface EnvironmentDesigns {
  /** The ref the designs were read from (`origin/main`, or `main` with no remote). */
  ref?: string;
  designs: FoundDesign[];
  /** Why the environment was skipped (no such repo or branch), or what went less than perfectly. */
  notes: string[];
  /** The ref exists but could not be read. The machine cannot vouch for these designs: holds the pin. */
  errors: string[];
}

/**
 * Copy `cad/<part>/design.json` — and nothing else — from the environment's default branch into
 * `destDir`. The ref is `origin/<defaultBase>` after a fetch, or the local `<defaultBase>` when the
 * repo has no `origin`. The working checkout is never read.
 *
 * A repository or branch that is genuinely not there is a note (the environment hosts nothing).
 * A ref that exists and cannot be listed or read is an ERROR: silence there would count as a pass.
 */
export async function readEnvironmentDesigns(env: ReplayEnvironment, destDir: string, git: Git = spawnGit): Promise<EnvironmentDesigns> {
  const notes: string[] = [];
  const errors: string[] = [];
  const skip = (why: string): EnvironmentDesigns => ({ designs: [], notes: [`${env.name}: ${why}`], errors: [] });
  if (!existsSync(env.repoRoot)) return skip("the repository folder is missing; skipped");
  if ((await git(env.repoRoot, ["rev-parse", "--git-dir"])).code !== 0) return skip("not a git repository; skipped");

  const hasOrigin = (await git(env.repoRoot, ["remote", "get-url", "origin"])).code === 0;
  const resolves = async (ref: string): Promise<boolean> => (await git(env.repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
  let ref: string | undefined;
  if (hasOrigin) {
    let base = env.defaultBase?.trim();
    if (!base) {
      const head = await git(env.repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
      base = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : undefined;
    }
    for (const b of base ? [base] : ["main", "master"]) {
      const fetched = await git(env.repoRoot, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], 120_000);
      if (await resolves(`refs/remotes/origin/${b}`)) {
        ref = `origin/${b}`;
        if (fetched.code !== 0) notes.push(`${env.name}: could not fetch origin/${b} (${firstLine(fetched.stderr) || `git exited ${fetched.code}`}); used the last fetched copy`);
        break;
      }
    }
    if (!ref) return skip(`origin has no branch ${base ?? "main or master"}; skipped`);
  } else {
    for (const b of env.defaultBase?.trim() ? [env.defaultBase.trim()] : ["main", "master"]) {
      if (await resolves(`refs/heads/${b}`)) {
        ref = b;
        break;
      }
    }
    if (!ref) return skip(`there is no local branch ${env.defaultBase?.trim() || "main or master"}; skipped`);
  }
  const fullRef = hasOrigin ? `refs/remotes/${ref}` : `refs/heads/${ref}`;

  // `-l` adds the blob size, so an oversized file is never read into memory.
  const tree = await git(env.repoRoot, ["ls-tree", "-r", "-l", "-z", fullRef, "--", "cad/"]);
  if (tree.code !== 0) return { ref, designs: [], notes, errors: [`${env.name}: could not list ${ref} (${firstLine(tree.stderr) || `git exited ${tree.code}`})`] };
  const designs: FoundDesign[] = [];
  for (const entry of tree.stdout.split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(\S+)\t(.*)$/s.exec(entry);
    if (!m) continue;
    const [, mode, type, sha, size, path] = m as unknown as [string, string, string, string, string, string];
    const d = DESIGN_RE.exec(path);
    if (!d) continue;
    const part = d[1]!;
    if (mode === "120000") {
      notes.push(`${env.name}: ${path} on ${ref} is a symbolic link, not a design file; skipped`);
      continue;
    }
    if (type !== "blob") {
      notes.push(`${env.name}: ${path} on ${ref} is a ${type === "commit" ? "submodule" : type}, not a design file; skipped`);
      continue;
    }
    if (Number(size) > MAX_SCRIPT_BYTES) {
      designs.push({ part, path, refused: `the design script is ${Math.round(Number(size) / (1024 * 1024))} MB, larger than the ${MAX_SCRIPT_BYTES / (1024 * 1024)} MB limit` });
      continue;
    }
    const shown = await git(env.repoRoot, ["cat-file", "blob", sha]);
    if (shown.code !== 0) {
      errors.push(`${env.name}: could not read ${path} from ${ref} (${firstLine(shown.stderr) || `git exited ${shown.code}`})`);
      continue;
    }
    const dir = join(destDir, `d${designs.length}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "design.json");
    writeFileSync(file, shown.stdout);
    designs.push({ part, path, file });
  }
  return { ref, designs, notes, errors };
}

/** Copy the designs sitting in a session worktree (its files as they are now) into `destDir`. */
export function readWorktreeDesigns(worktreePath: string, destDir: string): FoundDesign[] {
  const out: FoundDesign[] = [];
  let parts: string[];
  try {
    parts = readdirSync(join(worktreePath, "cad")).sort();
  } catch {
    return out;
  }
  for (const part of parts) {
    const src = join(worktreePath, "cad", part, "design.json");
    try {
      const st = statSync(src);
      if (!st.isFile()) continue;
      const path = `cad/${part}/design.json`;
      if (st.size > MAX_SCRIPT_BYTES) {
        out.push({ part, path, refused: `the design script is larger than the ${MAX_SCRIPT_BYTES / (1024 * 1024)} MB limit` });
        continue;
      }
      const dir = join(destDir, `w${out.length}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "design.json");
      writeFileSync(file, readFileSync(src));
      out.push({ part, path, file });
    } catch {
      /* not a part folder */
    }
  }
  return out;
}

// ── One machine ─────────────────────────────────────────────────────────────────────────────────

export interface ReplayMachineOptions {
  candidate: ReplayBuild;
  /** The pinned build. Undefined ⇒ replay under the candidate for errors only. */
  baseline?: ReplayBuild;
  environments: ReplayEnvironment[];
  worktrees?: WorktreeProvider;
  /** How one script is replayed under one build. Default: the sandboxed runner. */
  replayOne?: ReplayOne;
  git?: Git;
  /** Designs replayed at once (each runs its two builds one after the other). */
  concurrency?: number;
  /** Per replay of one script under one build. */
  timeoutMs?: number;
  /** For the whole machine. Designs not reached by then are `inconclusive` and the report says so. */
  totalTimeoutMs?: number;
  /** Only `PATH` is read from it. */
  env?: Record<string, string | undefined>;
  tmpRoot?: string;
  now?: () => number;
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
export async function pooled<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Replay everything this machine hosts under both builds and report. Never throws for a bad design. */
export async function replayMachine(o: ReplayMachineOptions): Promise<SolidcraftReplayReport> {
  const replayOne = o.replayOne ?? replayInSandbox;
  const timeoutMs = o.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const now = o.now ?? (() => Date.now());
  const deadline = now() + (o.totalTimeoutMs ?? REPLAY_TOTAL_TIMEOUT_MS);
  const pathEnv = (o.env ?? process.env).PATH;
  const tmp = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "anvil-sc-replay-"));
  const notes: string[] = [];
  const errors: string[] = [];
  try {
    interface Job {
      design: FoundDesign;
      base: Pick<SolidcraftReplayPart, "part" | "environment" | "path" | "ref" | "worktree">;
      advisory: boolean;
    }
    const jobs: Job[] = [];
    for (const [i, e] of o.environments.entries()) {
      const found = await readEnvironmentDesigns(e, join(tmp, `env${i}`), o.git);
      notes.push(...found.notes);
      errors.push(...found.errors);
      for (const design of found.designs) jobs.push({ design, advisory: false, base: { part: design.part, environment: e.name, path: design.path, ref: found.ref } });
    }
    let worktrees: ReplayWorktree[] = [];
    try {
      worktrees = (await o.worktrees?.()) ?? [];
    } catch (e) {
      notes.push(`open session worktrees could not be listed (${e instanceof Error ? e.message : String(e)})`);
    }
    for (const [i, w] of worktrees.entries()) {
      for (const design of readWorktreeDesigns(w.path, join(tmp, `wt${i}`))) {
        jobs.push({ design, advisory: true, base: { part: design.part, environment: w.environment ?? "", path: design.path, worktree: w.label } });
      }
    }

    let unreached = 0;
    const results = await pooled(jobs, o.concurrency ?? REPLAY_CONCURRENCY, async (job): Promise<SolidcraftReplayPart> => {
      if (job.design.refused || !job.design.file) return { ...job.base, outcome: "refused", error: job.design.refused ?? "the design script could not be read" };
      if (now() >= deadline) {
        if (!job.advisory) unreached++;
        return { ...job.base, outcome: "inconclusive", error: "not replayed: this machine's replay ran out of time" };
      }
      // Layer 1: the screen. A refused script is never handed to SolidCraft, under either build.
      const screened = screenScriptText(readFileSync(job.design.file, "utf8"));
      if (!screened.ok) return { ...job.base, outcome: "refused", error: screened.reason };
      const text = JSON.stringify(screened.script);
      // Layer 2: the sandbox, once per build.
      const opts = { timeoutMs: Math.max(1_000, Math.min(timeoutMs, deadline - now())), tmpRoot: tmp, ...(pathEnv ? { pathEnv } : {}) };
      const baseline = o.baseline ? await replayOne(o.baseline, text, screened.script.commands, opts) : undefined;
      const candidate = await replayOne(o.candidate, text, screened.script.commands, opts);
      return { ...job.base, ...classify(baseline, candidate) };
    });
    if (unreached) errors.push(`this machine's replay ran out of time with ${unreached} of ${jobs.filter((j) => !j.advisory).length} designs not replayed`);
    const parts = results.filter((_, i) => !jobs[i]!.advisory);
    const advisory = results.filter((_, i) => jobs[i]!.advisory);
    if (!o.baseline && jobs.length) notes.push("no pinned SolidCraft build on this machine: designs were replayed under the candidate for errors only");
    return {
      candidate: o.candidate.version,
      ...(o.baseline ? { baseline: o.baseline.version } : {}),
      hostsDesigns: parts.length > 0,
      pass: !parts.some(holdsPin) && errors.length === 0,
      parts,
      advisory,
      notes,
      errors,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** One sentence for a part that holds the pin: what happened, from what to what. */
export function describeFailure(p: SolidcraftReplayPart): string {
  if (p.outcome === "candidate-error") return `${p.part} replays under the pinned build but fails under the candidate (${p.error ?? "no detail"})`;
  if (p.outcome === "refused") return `${p.part} was refused and not replayed (${p.error ?? "no detail"})`;
  if (p.outcome === "inconclusive") return `${p.part} could not be replayed (${p.error ?? "no detail"})`;
  const d = p.differences?.[0];
  if (!d) return `${p.part} differs`;
  const show = (v: number | number[]): string => (Array.isArray(v) ? `[${v.map((x) => +x.toPrecision(8)).join(", ")}]` : String(+v.toPrecision(10)));
  const what = d.field === "volume_mm3" ? "volume (mm³)" : d.field === "bbox" ? "bounding box (mm)" : d.field === "faces" ? "face count" : d.field === "center_of_mass" ? "centre of mass (mm)" : "body count";
  return `${p.part}: ${what} ${show(d.old)} → ${show(d.new)}`;
}
