import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentValidation } from "@protocol";

/**
 * The validation gate (phase 2B). After a build session finishes, anvil runs an environment's
 * checks in the worktree; all must exit 0 before a WorkUnit can advance to `anvil:review` (PR).
 * If an environment defines no gate, we AUTO-DETECT sensible checks from the repo's manifests so
 * "anything linked" still gets a quality bar; if nothing is detectable, the gate is empty and the
 * caller PRs-anyway-but-flags-it (the agreed last resort).
 */

export interface CheckResult {
  command: string;
  code: number;
  output: string; // combined stdout+stderr, trimmed/capped
}
export interface ValidationResult {
  passed: boolean;
  autodetected: boolean; // true when commands came from detection, not an explicit env gate
  results: CheckResult[];
  /** Set when no gate was defined and nothing could be detected — caller decides how to flag. */
  noChecks?: boolean;
}

/** Which package manager a JS/TS repo uses, by lockfile (defaults to npm). */
function detectPackageManager(repoRoot: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(repoRoot, "bun.lockb")) || existsSync(join(repoRoot, "bun.lock"))) return "bun";
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

/** A `package.json`'s `scripts` map, or {} if absent/unreadable. */
function packageScripts(repoRoot: string): Record<string, string> {
  const p = join(repoRoot, "package.json");
  if (!existsSync(p)) return {};
  try {
    return (JSON.parse(readFileSync(p, "utf8")).scripts ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Build JS/TS checks for a dir with a package.json, optionally prefixed with `cd <rel> &&`. */
function jsChecks(dir: string, relPrefix?: string): string[] {
  const scripts = packageScripts(dir);
  if (Object.keys(scripts).length === 0) return [];
  const pm = detectPackageManager(dir);
  const cd = relPrefix ? `cd ${relPrefix} && ` : "";
  const run = (script: string) => `${cd}${pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`}`;
  const out: string[] = [];
  if (scripts.typecheck) out.push(run("typecheck"));
  else if (scripts["type-check"]) out.push(run("type-check"));
  if (scripts.lint) out.push(run("lint"));
  if (scripts.test) out.push(`${cd}${pm === "npm" ? "npm test" : `${pm} test`}`);
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "gradle", "target", "vendor", ".venv", "venv"]);

/**
 * Infer sensible validation commands from the repo's manifests. Favors fast correctness checks
 * (typecheck, test, lint) over slow ones (full builds). Looks at the root first, then one level of
 * subdirectories (monorepo / Gradle-root-with-a-JS-subproject layouts). Returns [] if nothing fits.
 */
export function detectChecks(repoRoot: string): string[] {
  // JS/TS at the repo root
  let out = jsChecks(repoRoot);
  if (out.length > 0) return out;

  // JS/TS one level down (e.g. a Gradle/Android repo whose daemon lives in `anvild/`)
  try {
    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (!existsSync(join(repoRoot, entry.name, "package.json"))) continue;
      out.push(...jsChecks(join(repoRoot, entry.name), entry.name));
    }
  } catch {
    /* unreadable dir — fall through to other ecosystems */
  }
  if (out.length > 0) return out;

  // Deno
  if (existsSync(join(repoRoot, "deno.json")) || existsSync(join(repoRoot, "deno.jsonc"))) {
    out.push("deno check .", "deno test -A");
  }
  // Rust
  if (out.length === 0 && existsSync(join(repoRoot, "Cargo.toml"))) {
    out.push("cargo check", "cargo test");
  }
  // Go
  if (out.length === 0 && existsSync(join(repoRoot, "go.mod"))) {
    out.push("go build ./...", "go test ./...");
  }
  // Python
  if (out.length === 0 && (existsSync(join(repoRoot, "pyproject.toml")) || existsSync(join(repoRoot, "pytest.ini")))) {
    out.push("python -m pytest -q");
  }
  return out;
}

/** The gate that will actually run for an environment: its explicit commands, else auto-detected. */
export function resolveGate(
  repoRoot: string,
  validation: EnvironmentValidation | undefined,
): { commands: string[]; autodetected: boolean } {
  if (validation?.commands?.length) return { commands: validation.commands, autodetected: false };
  return { commands: detectChecks(repoRoot), autodetected: true };
}

const MAX_OUTPUT = 8000; // cap per-check output so a noisy failure log stays manageable

/** Run one shell command in `cwd`, capturing combined output. */
async function runCheck(command: string, cwd: string, env: Record<string, string>): Promise<CheckResult> {
  const proc = Bun.spawn(["/bin/sh", "-lc", command], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const combined = `${stdout}${stderr}`.trim();
  return { command, code, output: combined.length > MAX_OUTPUT ? `…${combined.slice(-MAX_OUTPUT)}` : combined };
}

/**
 * Run the gate in `cwd` (the worktree). Stops at the first failing check (fail-fast) since a unit
 * only advances when ALL pass. `commands` empty → `passed: true, noChecks: true` (nothing to run).
 */
export async function runValidation(
  cwd: string,
  commands: string[],
  opts: { autodetected?: boolean; env?: Record<string, string> } = {},
): Promise<ValidationResult> {
  if (commands.length === 0) {
    return { passed: true, autodetected: opts.autodetected ?? true, results: [], noChecks: true };
  }
  const env = opts.env ?? (process.env as Record<string, string>);
  const results: CheckResult[] = [];
  for (const command of commands) {
    const r = await runCheck(command, cwd, env);
    results.push(r);
    if (r.code !== 0) return { passed: false, autodetected: opts.autodetected ?? false, results };
  }
  return { passed: true, autodetected: opts.autodetected ?? false, results };
}
