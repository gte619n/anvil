/**
 * The pure parts of the phase gate (agent-cad-and-browser spec §8.4): manifest validation, JUnit
 * parsing and named-test matching. No process spawning and no filesystem access here (file existence
 * is injected), so all of it is unit-tested with fixture XML in test/unit/phase-gate.test.ts. The
 * runner that shells out lives in ./phase-gate.ts.
 */

/** One test file and the tests in it that stand for a phase's Acceptance bullets. */
export interface PhaseTestRef {
  /** Path relative to `anvild/`, e.g. "test/unit/protected.test.ts". */
  file: string;
  /** Full test names — see `fullTestName` for the exact rule. */
  names: string[];
}

export interface PhaseEntry {
  title: string;
  tests: PhaseTestRef[];
  /** Playwright specs (relative to `anvild/`). `bun test` never runs these; the gate does. */
  playwright?: string[];
  /** Playwright config for those specs (default: test/golden/playwright.config.ts). */
  playwrightConfig?: string;
  /** Real-tool tests (under test/real/), run only with `--require-real` and `ANVIL_REAL_TOOLS=1`. */
  real?: PhaseTestRef[];
  /** A spike phase ships no product code: it passes on recorded evidence, not on tests. */
  spike?: boolean;
}

export interface PhaseManifest {
  phases: Record<string, PhaseEntry>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A path the manifest may name: relative, inside `anvild/`, no `..` segments. */
function badPath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p.trim()) return "must be a non-empty string";
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return "must be relative to anvild/";
  if (p.split(/[\\/]/).includes("..")) return "must not contain '..'";
  return undefined;
}

function validateRefs(raw: unknown, where: string, errors: string[], mustBeUnder?: string): PhaseTestRef[] {
  if (!Array.isArray(raw)) {
    errors.push(`${where} must be an array`);
    return [];
  }
  const out: PhaseTestRef[] = [];
  const seenFiles = new Set<string>();
  raw.forEach((r, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(r)) return void errors.push(`${at} must be an object { file, names }`);
    const bad = badPath(r.file);
    if (bad) return void errors.push(`${at}.file ${bad}`);
    const file = normalizeFile(r.file as string);
    if (mustBeUnder && !file.startsWith(mustBeUnder)) errors.push(`${at}.file must be under ${mustBeUnder} (got ${file})`);
    if (seenFiles.has(file)) errors.push(`${at}.file ${file} is listed twice — merge the entries`);
    seenFiles.add(file);
    if (!Array.isArray(r.names) || r.names.length === 0) return void errors.push(`${at}.names must be a non-empty array of test names`);
    const names: string[] = [];
    for (const n of r.names) {
      if (typeof n !== "string" || !n.trim()) errors.push(`${at}.names contains an empty or non-string name`);
      else if (names.includes(n)) errors.push(`${at}.names lists ${JSON.stringify(n)} twice`);
      else names.push(n);
    }
    out.push({ file, names });
  });
  return out;
}

/**
 * Check the manifest's SHAPE. Returns every problem found (not just the first) so one run tells the
 * author everything to fix. An empty `tests` list is a valid shape — whether it is acceptable for a
 * given phase is `phaseProblems`' call, made only for the phase being gated.
 */
export function validateManifest(raw: unknown): { manifest?: PhaseManifest; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw) || !isObj(raw.phases)) return { errors: ['manifest must be an object { "phases": { "<id>": … } }'] };
  const phases: Record<string, PhaseEntry> = {};
  for (const [id, p] of Object.entries(raw.phases)) {
    const at = `phases.${id}`;
    if (!/^[A-Z][0-9]+$/.test(id)) errors.push(`${at}: phase id must look like A1 (a capital letter and a number)`);
    if (!isObj(p)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (typeof p.title !== "string" || !p.title.trim()) errors.push(`${at}.title must be a non-empty string`);
    const entry: PhaseEntry = { title: String(p.title ?? ""), tests: validateRefs(p.tests, `${at}.tests`, errors) };
    if (p.real !== undefined) entry.real = validateRefs(p.real, `${at}.real`, errors, "test/real/");
    if (p.playwright !== undefined) {
      if (!Array.isArray(p.playwright)) errors.push(`${at}.playwright must be an array of spec paths`);
      else {
        entry.playwright = [];
        p.playwright.forEach((s, i) => {
          const bad = badPath(s);
          if (bad) errors.push(`${at}.playwright[${i}] ${bad}`);
          else entry.playwright!.push(normalizeFile(s as string));
        });
      }
    }
    if (p.playwrightConfig !== undefined) {
      const bad = badPath(p.playwrightConfig);
      if (bad) errors.push(`${at}.playwrightConfig ${bad}`);
      else entry.playwrightConfig = normalizeFile(p.playwrightConfig as string);
    }
    if (p.spike !== undefined) {
      if (typeof p.spike !== "boolean") errors.push(`${at}.spike must be a boolean`);
      else if (p.spike) entry.spike = true;
    }
    for (const k of Object.keys(p)) {
      if (!["title", "tests", "real", "playwright", "playwrightConfig", "spike"].includes(k)) errors.push(`${at}: unknown key ${JSON.stringify(k)}`);
    }
    phases[id] = entry;
  }
  return errors.length ? { errors } : { manifest: { phases }, errors };
}

/**
 * Step 2 of the gate, for ONE phase: a non-spike phase must name at least one test (a bullet with no
 * test is not done), and every file it lists — test, real and Playwright — must exist. Whether each
 * NAMED test exists is settled by the JUnit report (`checkNamedTests` → "missing"), which is the only
 * reliable source: a title built by `test.each` or a template cannot be found by reading the source.
 */
export function phaseProblems(manifest: PhaseManifest, phaseId: string, exists: (file: string) => boolean): string[] {
  const phase = manifest.phases[phaseId];
  if (!phase) return [`unknown phase ${JSON.stringify(phaseId)} (known: ${Object.keys(manifest.phases).join(", ")})`];
  if (phase.spike) return [];
  const problems: string[] = [];
  const named = phase.tests.reduce((n, t) => n + t.names.length, 0);
  if (named === 0) problems.push(`phase ${phaseId} names no tests — every Acceptance bullet needs a named test`);
  const files = [
    ...phase.tests.map((t) => t.file),
    ...(phase.real ?? []).map((t) => t.file),
    ...(phase.playwright ?? []),
    ...(phase.playwright?.length && phase.playwrightConfig ? [phase.playwrightConfig] : []),
  ];
  for (const f of files) if (!exists(f)) problems.push(`listed file does not exist: ${f}`);
  return problems;
}

// ── JUnit ───────────────────────────────────────────────────────────────────────────────────────

export interface JUnitCase {
  /** The test file, relative to the directory `bun test` ran in, "/"-separated, no leading "./". */
  file: string;
  /** The full test name — see `fullTestName`. */
  name: string;
  status: "passed" | "failed" | "skipped";
  /** `expect()` calls that ran. 0 for a skipped test, and for a test that asserts nothing. */
  assertions: number;
}

/** Separator between describe-block names and the test title in a full test name. */
export const NAME_SEP = " > ";

/**
 * THE NAME-MATCHING RULE. A manifest name is the test's full path inside its file: the titles of
 * the enclosing `describe` blocks, outermost first, then the test's own title, joined by " > ".
 * A top-level test is just its title. Examples:
 *
 *   test("plate volume", …)                                    →  "plate volume"
 *   describe("gate", () => test("fails on a missing hole", …)) →  "gate > fails on a missing hole"
 *
 * Matching is exact and case-sensitive after trimming; nothing is matched by prefix or substring.
 * `test.each` rows are matched by their EXPANDED title. If several cases in the file share one full
 * name, all of them must pass.
 */
export function fullTestName(describes: readonly string[], title: string): string {
  return [...describes, title].join(NAME_SEP);
}

export function normalizeFile(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]!] = unescapeXml(m[2]!);
  return out;
}

/**
 * Parse the JUnit XML that `bun test --reporter=junit` writes (verified against Bun 1.3.14):
 *
 *   <testsuites>
 *     <testsuite name="test/unit/x.test.ts" file="test/unit/x.test.ts" …>     ← one per FILE
 *       <testsuite name="describe title" file="…" line="…" …>                 ← one per describe, nested
 *         <testcase name="title" classname="…" file="…" assertions="2" />     ← passed
 *         <testcase name="…" assertions="0"><skipped /></testcase>            ← skip / skipIf / todo
 *         <testcase name="…" assertions="1"><failure type="…" /></testcase>   ← failed
 *
 * The describe path is taken from the NESTING of <testsuite> elements, not from `classname` — Bun
 * writes classname innermost-first and double-escaped, so it is not a usable path. The outermost
 * suite is the file and contributes no name segment. Not a general XML parser: it reads exactly the
 * elements above and throws on a report with no <testsuites> root, so a truncated/garbage report
 * can never be mistaken for "no tests ran".
 */
export function parseJUnit(xml: string): JUnitCase[] {
  if (!/<testsuites[\s>]/.test(xml)) throw new Error("not a JUnit report: no <testsuites> element");
  const cases: JUnitCase[] = [];
  const stack: string[] = []; // suite names; [0] is the file-level suite
  let open: JUnitCase | undefined; // a <testcase> with children, until its </testcase>
  const re = /<(\/?)(testsuites|testsuite|testcase|skipped|failure|error)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const closing = m[1] === "/";
    const el = m[2]!;
    const selfClosing = m[4] === "/";
    if (el === "testsuites") continue;
    if (el === "testsuite") {
      if (closing) stack.pop();
      else if (!selfClosing) stack.push(attrs(m[3]!).name ?? "");
      continue;
    }
    if (el === "testcase") {
      if (closing) {
        open = undefined;
        continue;
      }
      const a = attrs(m[3]!);
      const n = Number(a.assertions);
      const c: JUnitCase = {
        file: normalizeFile(a.file ?? stack[0] ?? ""),
        name: fullTestName(stack.slice(1), a.name ?? ""),
        status: "passed",
        assertions: Number.isFinite(n) ? n : 0,
      };
      cases.push(c);
      open = selfClosing ? undefined : c;
      continue;
    }
    if (!open || closing) continue;
    // A failure outranks a skip if a report ever carries both.
    if (el === "skipped") open.status = open.status === "failed" ? "failed" : "skipped";
    else open.status = "failed"; // <failure> or <error>
  }
  return cases;
}

export interface CaseCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  assertions: number;
}

export function countCases(cases: readonly JUnitCase[]): CaseCounts {
  const c: CaseCounts = { total: cases.length, passed: 0, failed: 0, skipped: 0, assertions: 0 };
  for (const k of cases) {
    c[k.status]++;
    c.assertions += k.assertions;
  }
  return c;
}

export interface NamedCheck {
  ok: boolean;
  /** One line per problem, each naming the file and the test. */
  problems: string[];
  /** Named tests looked for / found passing with ≥ 1 assertion. */
  named: number;
  namedOk: number;
}

/**
 * Step 3 of the gate: every named test must be PRESENT in the report for its file, PASSED, NOT
 * skipped, and have run AT LEAST ONE assertion (a test that asserts nothing proves nothing).
 * Additionally any FAILED case in the report fails the check, named or not — a phase's files must
 * be green. With `failOnAnySkip` (the real-tool run) any skipped case fails too, named or not.
 */
export function checkNamedTests(
  cases: readonly JUnitCase[],
  refs: readonly PhaseTestRef[],
  opts: { failOnAnySkip?: boolean } = {},
): NamedCheck {
  const problems: string[] = [];
  let named = 0;
  let namedOk = 0;
  for (const ref of refs) {
    const file = normalizeFile(ref.file);
    const inFile = cases.filter((c) => c.file === file);
    for (const rawName of ref.names) {
      named++;
      const name = rawName.trim();
      const hits = inFile.filter((c) => c.name.trim() === name);
      if (hits.length === 0) {
        problems.push(`missing: ${file} › ${name} (not in the test report — renamed, deleted, or never written)`);
        continue;
      }
      let good = true;
      for (const h of hits) {
        if (h.status === "skipped") problems.push(`skipped: ${file} › ${name}`);
        else if (h.status === "failed") problems.push(`failed: ${file} › ${name}`);
        else if (h.assertions < 1) problems.push(`no assertions: ${file} › ${name} (a named test must run at least one expect())`);
        else continue;
        good = false;
      }
      if (good) namedOk++;
    }
  }
  const mentioned = (c: JUnitCase, word: string) => problems.includes(`${word}: ${c.file} › ${c.name.trim()}`);
  for (const c of cases) {
    if (c.status === "failed" && !mentioned(c, "failed")) problems.push(`failed: ${c.file} › ${c.name.trim()}`);
    if (opts.failOnAnySkip && c.status === "skipped" && !mentioned(c, "skipped")) problems.push(`skipped: ${c.file} › ${c.name.trim()}`);
  }
  return { ok: problems.length === 0, problems, named, namedOk };
}

// ── CLI args ────────────────────────────────────────────────────────────────────────────────────

export interface GateArgs {
  phase: string;
  requireReal: boolean;
  allowDirty: boolean;
  spikeEvidence?: string;
  /** `--timeout-scale <x>`: every step's time limit times x (see `stepTimeoutMs`). */
  timeoutScale?: number;
}

export const USAGE = "usage: bun test/tools/phase-gate.ts <phase> [--require-real] [--allow-dirty] [--spike-evidence <file>] [--timeout-scale <x>]";

export function parseGateArgs(argv: readonly string[]): { args?: GateArgs; error?: string } {
  let phase: string | undefined;
  const args: Omit<GateArgs, "phase"> = { requireReal: false, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--require-real") args.requireReal = true;
    else if (a === "--allow-dirty") args.allowDirty = true;
    else if (a === "--spike-evidence") {
      const v = argv[++i];
      if (!v) return { error: "--spike-evidence needs a file path" };
      args.spikeEvidence = v;
    } else if (a === "--timeout-scale") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--timeout-scale needs a positive number" };
      args.timeoutScale = v;
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else if (phase) return { error: `unexpected argument ${a}` };
    else phase = a;
  }
  if (!phase) return { error: "missing <phase>" };
  return { args: { phase, ...args } };
}

/**
 * Which `git status --porcelain` lines make the tree DIRTY for the gate. The gate's promise is that
 * the printed sha is the code that was tested, so anything that could change what it runs blocks:
 *  - every change under `anvild/`, tracked or untracked (bun picks up an untracked test or source);
 *  - every tracked change elsewhere — notably docs/plans/anvil-protocol.ts, which anvild/protocol.ts
 *    is a symlink to — EXCEPT Markdown under `docs/`.
 * Not blocking, but listed: untracked files outside `anvild/`, and edited `docs/**` Markdown. Those
 * cannot change a test result, and the spec's own workflow edits them around a gate run (the PASS
 * block is pasted into the spec's §11, and its status tables are ticked, before the push).
 */
export function classifyDirty(porcelain: string): { blocking: string[]; ignored: string[] } {
  const blocking: string[] = [];
  const ignored: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3).replace(/^"|"$/g, "");
    const outside = !path.startsWith("anvild/") && !path.includes(" -> ");
    const harmless = outside && (line.startsWith("??") || (path.startsWith("docs/") && path.endsWith(".md")));
    (harmless ? ignored : blocking).push(line);
  }
  return { blocking, ignored };
}

// ── step time limits ─────────────────────────────────────────────────────────────────────────────

/** How long each step may run before its process group is killed and the step fails "timed out".
 *  The full suite takes ~10 min on the M4; the limits leave room without letting a hang block forever. */
export const STEP_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  "named tests": 20 * 60_000,
  "full suite": 45 * 60_000,
  typecheck: 10 * 60_000,
  "typecheck:web": 10 * 60_000,
  "build:web": 10 * 60_000,
  playwright: 30 * 60_000,
  "real tools": 45 * 60_000,
};
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

/** A step's time limit: its default (`STEP_TIMEOUTS_MS`) times `--timeout-scale`, else times
 *  `ANVIL_GATE_TIMEOUT_SCALE`; `ANVIL_GATE_TIMEOUT_MS` sets every step's limit outright. */
export function stepTimeoutMs(step: string, scale: number | undefined, env: Record<string, string | undefined> = process.env): number {
  const fixed = Number(env.ANVIL_GATE_TIMEOUT_MS);
  if (env.ANVIL_GATE_TIMEOUT_MS && Number.isFinite(fixed) && fixed > 0) return fixed;
  const envScale = Number(env.ANVIL_GATE_TIMEOUT_SCALE);
  const k = scale ?? (env.ANVIL_GATE_TIMEOUT_SCALE && Number.isFinite(envScale) && envScale > 0 ? envScale : 1);
  return Math.round((STEP_TIMEOUTS_MS[step] ?? DEFAULT_STEP_TIMEOUT_MS) * k);
}

export interface StepRun {
  code: number;
  out: string;
  ms: number;
  timedOut: boolean;
  /** Where the step's whole output was teed. */
  log: string;
}

/**
 * Run one step's command in its OWN process group (detached), its stdout and stderr teed to `log`
 * as they arrive and kept for the caller. After `timeoutMs` the whole group (the command and
 * everything it started — bun's test workers, SolidCraft, Chrome) gets SIGTERM, then SIGKILL 5 s
 * later, and the run ends `timedOut` with exit code 124. Never throws on the command's behalf: a
 * command that cannot be started is exit code 127 with the reason in `out`.
 */
export async function runStep(cmd: string[], opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number; log: string; graceMs?: number }): Promise<StepRun> {
  const { spawn } = await import("node:child_process");
  const { createWriteStream } = await import("node:fs");
  const t0 = performance.now();
  const sink = createWriteStream(opts.log, { flags: "a" });
  sink.write(`$ ${cmd.join(" ")}\n`);
  const chunks: Buffer[] = [];
  const done = await new Promise<{ code: number; timedOut: boolean }>((resolveRun) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const msg = Buffer.from(`could not start ${cmd[0]}: ${e instanceof Error ? e.message : String(e)}\n`);
      chunks.push(msg);
      sink.write(msg);
      resolveRun({ code: 127, timedOut: false });
      return;
    }
    const take = (b: Buffer) => {
      chunks.push(b);
      sink.write(b);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const group = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const msg = Buffer.from(`\n[phase-gate] timed out after ${(opts.timeoutMs / 1000).toFixed(0)}s: killing process group ${child.pid}\n`);
      chunks.push(msg);
      sink.write(msg);
      group("SIGTERM");
      killer = setTimeout(() => group("SIGKILL"), opts.graceMs ?? 5_000);
    }, opts.timeoutMs);
    let exitCode: number | null = null;
    let straggler: ReturnType<typeof setTimeout> | undefined;
    child.on("error", (e) => take(Buffer.from(`could not start ${cmd[0]}: ${e.message}\n`)));
    // The leader exited, but something it started may still hold the pipes open: give it a moment,
    // then kill what is left of the group so the step ends with the leader's code.
    child.on("exit", (code) => {
      exitCode = code;
      straggler = setTimeout(() => group("SIGKILL"), opts.graceMs ?? 5_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      if (straggler) clearTimeout(straggler);
      if (timedOut) group("SIGKILL"); // whatever of the group outlived its leader
      resolveRun({ code: timedOut ? 124 : (exitCode ?? code ?? 1), timedOut });
    });
  });
  await new Promise<void>((r) => sink.end(r));
  return { code: done.code, out: Buffer.concat(chunks).toString(), ms: performance.now() - t0, timedOut: done.timedOut, log: opts.log };
}
