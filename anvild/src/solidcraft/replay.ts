/**
 * The replay gate, one machine's side (agent-cad-and-browser spec §4.10, §4.14 items 2 and 17, B0
 * evidence "`solidcraft-cli eval`").
 *
 * Before the fleet pin moves to a candidate build, each machine replays the designs it hosts under
 * BOTH the pinned build and the candidate, and compares the two results. Comparing two builds — not
 * the candidate against the numbers stored in `part.json` — means a stale `part.json` cannot reject
 * every candidate. Nothing here reads `part.json` at all.
 *
 * Where the designs come from:
 *   - For each environment: `cad/<part>/design.json` on `origin/<defaultBase>` after a fetch, or on
 *     the local `<defaultBase>` when the repo has no `origin`. They are read with `git ls-tree` and
 *     `git show` into a temporary folder, never from the working checkout (which may be on any
 *     branch, with any edits). These decide.
 *   - For each open session worktree: `cad/<part>/design.json` as it sits on disk. These are
 *     ADVISORY: listed, never holding the pin.
 *
 * What a replay is: `solidcraft-cli eval <file> --json-out <tmp>`. It has FAILED when the exit code
 * is not 0, OR any `timeline[].error` is set, OR any `params[].error` is set (`eval` exits 0 when a
 * feature fails to compute). Compared across builds: `body_count`, per-body `faces`, `volume_mm3`
 * (1e-6 relative) and the sorted bounding box. Not compared: `edges`, `kernel.*`, `ms`, `area_mm2`.
 *
 * With no baseline build (no pin recorded and no SolidCraft found on the machine) there is nothing
 * to compare against: each design is replayed under the candidate only, and an error there is a
 * `candidate-error`. The report then carries no `baseline` version.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SolidcraftReplayDifference, SolidcraftReplayNumbers, SolidcraftReplayOutcome, SolidcraftReplayPart, SolidcraftReplayReport } from "@protocol";
import { binaryEnv, type Run, type RunResult } from "./install";

export type { SolidcraftReplayDifference, SolidcraftReplayOutcome, SolidcraftReplayPart, SolidcraftReplayReport };

/** Volume (and bounding-box) tolerance, relative. Adjacent real releases differed by 5e-12. */
export const REPLAY_TOLERANCE = 1e-6;
export const REPLAY_TIMEOUT_MS = 120_000;
export const REPLAY_CONCURRENCY = 2;
/** `cad/<part>/design.json`, exactly one folder deep. */
const DESIGN_RE = /^cad\/([^/]+)\/design\.json$/;

// ── Reading one eval result ─────────────────────────────────────────────────────────────────────

export interface EvalBody {
  name: string;
  faces: number;
  volume: number;
  /** Bounding-box extents, sorted ascending, so a design is the same whichever way it faces. */
  extents: [number, number, number];
}
export interface EvalSummary {
  bodyCount: number;
  bodies: EvalBody[];
}
export type EvalOutcome = { ok: true; summary: EvalSummary } | { ok: false; error: string };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const firstLine = (s: string): string => s.trim().split("\n")[0]?.slice(0, 400) ?? "";

/**
 * Turn one `eval` run into a result. `json` is the text of the `--json-out` file (or stdout). The
 * exit code alone is never trusted: a feature that fails to compute leaves it at 0.
 */
export function readEval(code: number, json: string | undefined, stderr = ""): EvalOutcome {
  if (code !== 0) return { ok: false, error: `eval exited ${code}${stderr.trim() ? `: ${firstLine(stderr)}` : ""}` };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json ?? "") as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
  } catch (e) {
    return { ok: false, error: `eval wrote no readable result (${e instanceof Error ? e.message : String(e)})` };
  }
  const items = (key: string): Record<string, unknown>[] => (Array.isArray(doc[key]) ? (doc[key] as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);
  const failedFeature = items("timeline").find((t) => t.error !== null && t.error !== undefined);
  if (failedFeature) return { ok: false, error: `feature ${String(failedFeature.name ?? failedFeature.id ?? "?")} failed: ${String(failedFeature.error).slice(0, 300)}` };
  const failedParam = items("params").find((p) => p.error !== null && p.error !== undefined);
  if (failedParam) return { ok: false, error: `parameter ${String(failedParam.name ?? "?")} failed: ${String(failedParam.error).slice(0, 300)}` };
  if (!Array.isArray(doc.bodies)) return { ok: false, error: "eval result has no `bodies`" };
  const bodies: EvalBody[] = items("bodies").map((b, i) => {
    const bbox = (b.bbox ?? {}) as { min?: unknown[]; max?: unknown[] };
    const ext = [0, 1, 2].map((k) => num(bbox.max?.[k]) - num(bbox.min?.[k])).sort((x, y) => x - y) as [number, number, number];
    return { name: typeof b.name === "string" && b.name ? b.name : `body ${i + 1}`, faces: num(b.faces), volume: num(b.volume_mm3), extents: ext };
  });
  const bodyCount = typeof doc.body_count === "number" ? doc.body_count : bodies.length;
  return { ok: true, summary: { bodyCount, bodies } };
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
  if (baseline && !baseline.ok) {
    // Already broken under the pinned build: the candidate cannot be blamed, whatever it does.
    return { outcome: "baseline-broken", error: baseline.error, ...(candidate.ok ? { new: numbersOf(candidate.summary) } : {}) };
  }
  const old = baseline ? { old: numbersOf(baseline.summary) } : {};
  if (!candidate.ok) return { outcome: "candidate-error", error: candidate.error, ...old };
  const next = { new: numbersOf(candidate.summary) };
  if (!baseline) return { outcome: "same", ...next };
  const differences = compareEval(baseline.summary, candidate.summary);
  return differences.length ? { outcome: "differs", differences, ...old, ...next } : { outcome: "same", ...old, ...next };
}

// ── Running eval ────────────────────────────────────────────────────────────────────────────────

export interface ReplayBuild {
  path: string;
  version: string;
}

/** `eval` one script under one build. A crash, a hang past the timeout and an unreadable result are all failures. */
export async function evalDesign(build: ReplayBuild, script: string, outFile: string, run: Run, timeoutMs: number, env: Record<string, string>): Promise<EvalOutcome> {
  rmSync(outFile, { force: true });
  const started = Date.now();
  let r: RunResult;
  try {
    r = await run([build.path, "eval", script, "--json-out", outFile], { env, timeoutMs });
  } catch (e) {
    return { ok: false, error: `could not run SolidCraft ${build.version}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.code !== 0 && Date.now() - started >= timeoutMs) return { ok: false, error: `eval did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped` };
  let json: string | undefined;
  try {
    json = readFileSync(outFile, "utf8");
  } catch {
    json = r.stdout;
  }
  return readEval(r.code ?? 1, json, r.stderr);
}

/** Like install.ts's runner, but a timed-out process is killed hard (a hung kernel ignores SIGTERM). */
export const replayRun: Run = async (cmd, opts = {}) => {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: opts.env ?? { PATH: "/usr/bin:/bin" }, timeout: opts.timeoutMs ?? REPLAY_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code: p.signalCode ? 137 : code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
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
  /** The copy to replay, in the temporary folder. */
  file: string;
}
export interface EnvironmentDesigns {
  /** The ref the designs were read from (`origin/main`, or `main` with no remote). */
  ref?: string;
  designs: FoundDesign[];
  /** Why the environment was skipped, or what went less than perfectly (a failed fetch). */
  notes: string[];
}

/**
 * Copy `cad/<part>/design.json` — and nothing else — from the environment's default branch into
 * `destDir`. The ref is `origin/<defaultBase>` after a fetch, or the local `<defaultBase>` when the
 * repo has no `origin`. The working checkout is never read.
 */
export async function readEnvironmentDesigns(env: ReplayEnvironment, destDir: string, git: Git = spawnGit): Promise<EnvironmentDesigns> {
  const notes: string[] = [];
  const skip = (why: string): EnvironmentDesigns => ({ designs: [], notes: [`${env.name}: ${why}`] });
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

  const tree = await git(env.repoRoot, ["ls-tree", "-r", "-z", "--name-only", fullRef, "--", "cad/"]);
  if (tree.code !== 0) return { ref, designs: [], notes: [...notes, `${env.name}: could not list ${ref} (${firstLine(tree.stderr)})`] };
  const designs: FoundDesign[] = [];
  for (const path of tree.stdout.split("\0")) {
    const m = DESIGN_RE.exec(path);
    if (!m) continue;
    const part = m[1]!;
    const shown = await git(env.repoRoot, ["show", `${fullRef}:${path}`]);
    if (shown.code !== 0) {
      notes.push(`${env.name}: could not read ${path} from ${ref} (${firstLine(shown.stderr)})`);
      continue;
    }
    const dir = join(destDir, `d${designs.length}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "design.json");
    writeFileSync(file, shown.stdout);
    designs.push({ part, path, file });
  }
  return { ref, designs, notes };
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
      if (!statSync(src).isFile()) continue;
      const dir = join(destDir, `w${out.length}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "design.json");
      writeFileSync(file, readFileSync(src));
      out.push({ part, path: `cad/${part}/design.json`, file });
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
  run?: Run;
  git?: Git;
  /** Designs replayed at once (each runs its two builds one after the other). */
  concurrency?: number;
  /** Per `eval` run. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  tmpRoot?: string;
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
  const run = o.run ?? replayRun;
  const timeoutMs = o.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const env = binaryEnv(o.env ?? process.env);
  const tmp = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "anvil-sc-replay-"));
  const notes: string[] = [];
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

    const results = await pooled(jobs, o.concurrency ?? REPLAY_CONCURRENCY, async (job): Promise<SolidcraftReplayPart> => {
      const out = (tag: string) => join(job.design.file, "..", `${tag}.json`);
      const baseline = o.baseline ? await evalDesign(o.baseline, job.design.file, out("pinned"), run, timeoutMs, env) : undefined;
      const candidate = await evalDesign(o.candidate, job.design.file, out("candidate"), run, timeoutMs, env);
      return { ...job.base, ...classify(baseline, candidate) };
    });
    const parts = results.filter((_, i) => !jobs[i]!.advisory);
    const advisory = results.filter((_, i) => jobs[i]!.advisory);
    if (!o.baseline && jobs.length) notes.push("no pinned SolidCraft build on this machine: designs were replayed under the candidate for errors only");
    return {
      candidate: o.candidate.version,
      ...(o.baseline ? { baseline: o.baseline.version } : {}),
      hostsDesigns: parts.length > 0,
      pass: !parts.some(holdsPin),
      parts,
      advisory,
      notes,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Does this part's outcome hold the pin? */
export const holdsPin = (p: Pick<SolidcraftReplayPart, "outcome">): boolean => p.outcome === "differs" || p.outcome === "candidate-error";

/** One sentence for a failing part: what moved, from what to what. */
export function describeFailure(p: SolidcraftReplayPart): string {
  if (p.outcome === "candidate-error") return `${p.part} replays under the pinned build but fails under the candidate (${p.error ?? "no detail"})`;
  const d = p.differences?.[0];
  if (!d) return `${p.part} differs`;
  const show = (v: number | number[]): string => (Array.isArray(v) ? `[${v.map((x) => +x.toPrecision(8)).join(", ")}]` : String(+v.toPrecision(10)));
  const what = d.field === "volume_mm3" ? "volume (mm³)" : d.field === "bbox" ? "bounding box (mm)" : d.field === "faces" ? "face count" : "body count";
  return `${p.part}: ${what} ${show(d.old)} → ${show(d.new)}`;
}
