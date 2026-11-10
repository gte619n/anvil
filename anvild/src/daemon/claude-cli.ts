/**
 * Managed Claude CLI — advance the Claude engine to the latest version WITHOUT an Anvil release.
 *
 * The daemon spawns Claude via `@anthropic-ai/claude-agent-sdk`, whose bundled CLI is frozen into
 * `bun.lock` at install time. When Anthropic ships a model that needs a newer CLI (the "Claude Code
 * X does not support this model" 400), the only fix today is a dependency bump + full release.
 *
 * This module installs the standalone `@anthropic-ai/claude-code` CLI into an **isolated** root
 * under the daemon state dir (`<stateDir>/claude-cli/`, its own package.json + lockfile, so the repo
 * `bun.lock` is never touched) and hands the resolved native binary to the Agent SDK via
 * `pathToClaudeCodeExecutable` (see agent/cli.ts `setManagedCliPath`). The bundled CLI stays as the
 * deterministic floor/fallback.
 *
 * Decisions & full design: docs/plans/2026-11-10-managed-claude-cli-updates.md.
 *
 * Everything here takes injected `fetch`/`exec` so unit tests never hit the network or spawn `bun`.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The npm package that ships the Claude Code CLI (the one `claude update` tracks). */
export const CLI_PKG = "@anthropic-ai/claude-code";
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${encodeURIComponent(CLI_PKG)}/dist-tags`;

/** What the Models tab shows for the Claude engine. */
export interface ClaudeCliInfo {
  /** Version actually spawned: the managed CLI when one is installed & valid, else `bundled`. */
  active: string;
  /** CLI version shipped with the pinned agent-sdk — the floor used when nothing is managed. */
  bundled: string;
  /** Is a managed (independently-installed) CLI currently in effect? */
  managed: boolean;
  /** Newest published version from the npm registry (set by the background check). */
  latest?: string;
  /** ISO timestamp of the last `latest` refresh. */
  checkedAt?: string;
}

interface InstalledState {
  version: string;
  binPath: string;
  installedAt: string;
}
interface CheckState {
  latestVersion: string;
  checkedAt: string;
}

export type FetchLike = typeof fetch;
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecLike = (cmd: string[], cwd: string) => Promise<ExecResult>;

const installRoot = (stateDir: string): string => join(stateDir, "claude-cli");
const installedFile = (stateDir: string): string => join(installRoot(stateDir), "installed.json");
const checkFile = (stateDir: string): string => join(installRoot(stateDir), "check.json");

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

/** Parse the leading semver out of `claude --version` output (`"2.1.322 (Claude Code)"`). */
export function parseCliVersion(raw: string): string {
  return raw.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? raw.trim();
}

/**
 * CLI version bundled with the pinned agent-sdk (the floor). Read from the SDK's `manifest.json`
 * (`.version`), which maps 1:1 to the native binary it ships. `"unknown"` if it can't be resolved.
 */
export function bundledVersion(requireFn: NodeJS.Require = createRequire(import.meta.url)): string {
  try {
    const entry = requireFn.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = readJson<{ version?: string }>(join(dirname(entry), "manifest.json"));
    return manifest?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Default exec: async `Bun.spawn` (matches daemon/selfupdate.ts), collecting stdout/stderr. */
const defaultExec: ExecLike = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, stdout, stderr };
};

/**
 * Resolve the newest published CLI version from the npm registry's dist-tags (`latest`). Throws on a
 * network/parse failure so callers can surface "couldn't check".
 */
export async function resolveLatest(fetchFn: FetchLike = fetch): Promise<string> {
  const res = await fetchFn(DIST_TAGS_URL);
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const tags = (await res.json()) as { latest?: string };
  if (!tags.latest) throw new Error("registry returned no 'latest' dist-tag");
  return tags.latest;
}

/** The managed CLI binary installed under `stateDir`, if one exists and its binary is still present. */
export function managedCliPath(stateDir: string): string | null {
  const state = readJson<InstalledState>(installedFile(stateDir));
  if (state?.binPath && existsSync(state.binPath)) return state.binPath;
  return null;
}

/** Version of the managed CLI currently installed under `stateDir`, or null. */
export function managedVersion(stateDir: string): string | null {
  return managedCliPath(stateDir) ? (readJson<InstalledState>(installedFile(stateDir))?.version ?? null) : null;
}

/**
 * Install `@anthropic-ai/claude-code@<version>` (default: latest) into the isolated managed root and
 * return the resolved native binary path. Validates by running `--version` before persisting state,
 * so a half-installed CLI never becomes the active engine. Never mutates the repo `bun.lock`.
 */
export async function install(
  stateDir: string,
  opts: { version?: string; fetchFn?: FetchLike; execFn?: ExecLike } = {},
): Promise<{ version: string; binPath: string }> {
  const exec = opts.execFn ?? defaultExec;
  const version = opts.version ?? (await resolveLatest(opts.fetchFn ?? fetch));
  const root = installRoot(stateDir);
  mkdirSync(root, { recursive: true });
  // Isolated package root: bun installs here, never near the daemon's own node_modules / tracked lock.
  const pkgJson = join(root, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: "anvil-claude-cli", private: true }, null, 2));
  }

  const add = await exec(["bun", "add", "--exact", `${CLI_PKG}@${version}`], root);
  if (add.code !== 0) {
    throw new Error(`bun add ${CLI_PKG}@${version} failed (exit ${add.code}): ${add.stderr || add.stdout}`.trim());
  }

  const binPath = join(root, "node_modules", ".bin", process.platform === "win32" ? "claude.exe" : "claude");
  if (!existsSync(binPath)) throw new Error(`installed CLI but binary missing at ${binPath}`);

  // Validate the binary actually runs before we make it the active engine.
  const check = await exec([binPath, "--version"], root);
  if (check.code !== 0) throw new Error(`installed CLI failed --version (exit ${check.code}): ${check.stderr}`.trim());
  const resolved = parseCliVersion(check.stdout) || version;

  const state: InstalledState = { version: resolved, binPath, installedAt: new Date().toISOString() };
  writeFileSync(installedFile(stateDir), JSON.stringify(state, null, 2));
  return { version: resolved, binPath };
}

/** Persist the newest-available version (background check). Returns whether it changed. */
export function recordLatest(stateDir: string, latestVersion: string): boolean {
  mkdirSync(installRoot(stateDir), { recursive: true });
  const prev = readJson<CheckState>(checkFile(stateDir))?.latestVersion;
  writeFileSync(checkFile(stateDir), JSON.stringify({ latestVersion, checkedAt: new Date().toISOString() }, null, 2));
  return prev !== latestVersion;
}

/** Compose the full status the UI renders. */
export function cliStatus(stateDir: string): ClaudeCliInfo {
  const bundled = bundledVersion();
  const managed = managedVersion(stateDir);
  const check = readJson<CheckState>(checkFile(stateDir));
  return {
    active: managed ?? bundled,
    bundled,
    managed: managed != null,
    ...(check ? { latest: check.latestVersion, checkedAt: check.checkedAt } : {}),
  };
}
