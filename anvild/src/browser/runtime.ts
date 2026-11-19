/**
 * The agent browser's server runtime: a pinned copy of Playwright MCP that the DAEMON installs into
 * its own state folder and starts by absolute path.
 *
 * Why not `npx`: the server is started with the session's worktree as its working directory, and the
 * agent can write there. `npx` (and npm) read `node_modules/` and `.npmrc` from the working
 * directory, so a planted package or a planted `script-shell`, `node-options`, `registry` or `cache`
 * setting would run in place of the pinned server. Nothing here reads anything from a worktree:
 *
 *  - `runtime/package.json` and `runtime/package-lock.json` (in this repo) pin `@playwright/mcp` and
 *    every transitive dependency with an integrity hash;
 *  - `installBrowserRuntime` copies them into a new folder under `<stateDir>/browser/` and runs
 *    `npm ci --ignore-scripts` THERE, with a clean environment (`env -i`: PATH, a temporary HOME,
 *    TMPDIR) and its user and global config pointed at empty files, so npm verifies every package
 *    against the lock and no project, user or global `.npmrc` applies. The finished folder gets a
 *    marker with the lock's sha256 and is moved to `<stateDir>/browser/runtime-<lock hash>/`;
 *  - the launch line is `<absolute node> <that folder>/node_modules/@playwright/mcp/cli.js …`. Node
 *    resolves a script's dependencies from the script's own folder, never from the working directory.
 *
 * Before every launch `browserRuntimeProblem` re-checks the marker, the lock copy and the script. A
 * runtime that is missing and cannot be installed (no network) leaves the browser unavailable.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_STATE_DIRNAME, PLAYWRIGHT_MCP_VERSION } from "./preset";
import runtimeLock from "./runtime/package-lock.json";
import runtimePackage from "./runtime/package.json";

export const RUNTIME_MARKER = ".anvil-runtime.json";
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface RuntimeManifest {
  packageJson: string;
  packageLock: string;
  lockSha256: string;
}

let manifest: RuntimeManifest | undefined;
/** The pinned manifest shipped in the repo (imported, so it is part of a compiled daemon too). The
 *  hash is over the lock exactly as it is written into the runtime folder. */
export function browserRuntimeManifest(): RuntimeManifest {
  if (!manifest) {
    const packageJson = `${JSON.stringify(runtimePackage, null, 2)}\n`;
    const packageLock = `${JSON.stringify(runtimeLock, null, 2)}\n`;
    manifest = { packageJson, packageLock, lockSha256: createHash("sha256").update(packageLock).digest("hex") };
  }
  return manifest;
}

/** `<stateDir>/browser/runtime-<first 16 hex of the lock's sha256>`: a new lock is a new folder. */
export function browserRuntimeDir(stateDir: string): string {
  return join(stateDir, BROWSER_STATE_DIRNAME, `runtime-${browserRuntimeManifest().lockSha256.slice(0, 16)}`);
}
export function browserRuntimeCli(stateDir: string): string {
  return join(browserRuntimeDir(stateDir), "node_modules", "@playwright", "mcp", "cli.js");
}

/** Why the installed runtime may not be launched, or undefined when it may. Cheap; run before every launch. */
export function browserRuntimeProblem(stateDir: string): string | undefined {
  const dir = browserRuntimeDir(stateDir);
  const m = browserRuntimeManifest();
  try {
    if (!existsSync(dir)) return "the browser runtime is not installed";
    const marker = JSON.parse(readFileSync(join(dir, RUNTIME_MARKER), "utf8")) as { lockSha256?: unknown };
    if (marker.lockSha256 !== m.lockSha256) return "the browser runtime's marker does not match the pinned lock file";
    if (readFileSync(join(dir, "package-lock.json"), "utf8") !== m.packageLock) return "the browser runtime's lock file was changed";
    if (!statSync(browserRuntimeCli(stateDir)).isFile()) return "the browser runtime's server script is missing";
    const installed = JSON.parse(readFileSync(join(dir, "node_modules", "@playwright", "mcp", "package.json"), "utf8")) as { version?: unknown };
    if (installed.version !== PLAYWRIGHT_MCP_VERSION) return `the browser runtime holds @playwright/mcp ${String(installed.version)}, not ${PLAYWRIGHT_MCP_VERSION}`;
    return undefined;
  } catch (e) {
    return `the browser runtime is incomplete (${e instanceof Error ? e.message : String(e)})`;
  }
}

export interface RuntimeInstallOptions {
  /** Absolute path of `npm`, resolved from the daemon's PATH. */
  npmPath: string;
  /** The PATH npm runs with (it needs `node`). */
  pathEnv: string;
  tmpdir: string;
  /** Test seam: run the command (default: spawn it and wait). Resolves with the exit code and output. */
  run?: (command: string[], cwd: string) => Promise<{ code: number; output: string }>;
}

async function defaultRun(command: string[], cwd: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {} });
  const timer = setTimeout(() => proc.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: `${out}\n${err}`.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** The exact command `installBrowserRuntime` runs in `staging`. Pure. */
export function runtimeInstallCommand(staging: string, opts: Pick<RuntimeInstallOptions, "npmPath" | "pathEnv" | "tmpdir">, cacheDir: string): string[] {
  return [
    "/usr/bin/env",
    "-i",
    `PATH=${opts.pathEnv}`,
    `HOME=${join(staging, ".home")}`,
    `TMPDIR=${opts.tmpdir}`,
    opts.npmPath,
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    // No user or global npm configuration applies. (npm refuses to load the same file as both, so the
    // global one is an empty file the daemon wrote next to the manifest.)
    "--userconfig",
    "/dev/null",
    "--globalconfig",
    join(staging, ".npmrc-global-empty"),
    "--cache",
    cacheDir,
  ];
}

/**
 * Install the pinned runtime into `<stateDir>/browser/runtime-<hash>/`. A no-op when it is already
 * there and passes `browserRuntimeProblem`. @throws with npm's last lines when the install fails
 * (offline, an integrity mismatch); nothing is left in the final folder then.
 */
export async function installBrowserRuntime(stateDir: string, opts: RuntimeInstallOptions): Promise<void> {
  if (!browserRuntimeProblem(stateDir)) return;
  const m = browserRuntimeManifest();
  const base = join(stateDir, BROWSER_STATE_DIRNAME);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(base, "runtime-staging-"));
  try {
    writeFileSync(join(staging, "package.json"), m.packageJson);
    writeFileSync(join(staging, "package-lock.json"), m.packageLock);
    writeFileSync(join(staging, ".npmrc-global-empty"), "");
    mkdirSync(join(staging, ".home"), { recursive: true });
    const command = runtimeInstallCommand(staging, opts, join(base, "npm-cache"));
    const { code, output } = await (opts.run ?? defaultRun)(command, staging);
    if (code !== 0) throw new Error(`npm ci failed (exit ${code}): ${output.split("\n").slice(-4).join(" ").slice(0, 400)}`);
    rmSync(join(staging, ".home"), { recursive: true, force: true });
    writeFileSync(join(staging, RUNTIME_MARKER), `${JSON.stringify({ lockSha256: m.lockSha256, package: `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, installedAt: new Date().toISOString() }, null, 2)}\n`);
    const dir = browserRuntimeDir(stateDir);
    rmSync(dir, { recursive: true, force: true }); // a broken earlier copy
    renameSync(staging, dir);
    const problem = browserRuntimeProblem(stateDir);
    if (problem) throw new Error(problem);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
