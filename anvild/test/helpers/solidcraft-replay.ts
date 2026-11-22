/**
 * Test doubles for the replay gate (Phase B2): two or more fake SolidCraft "builds" that genuinely
 * behave differently, and fixture git repositories with a real `origin`.
 *
 * A fake build is a small executable that runs test/fixtures/fake-solidcraft.ts with its version
 * and the path of a per-version behaviour table (`FAKE_SC_TABLE`, see fake-solidcraft-eval.ts)
 * baked in. The table is a JSON file a test may rewrite between runs.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GithubRelease } from "../../src/solidcraft/release";
import { releaseAssetName } from "../../src/solidcraft/install";
import type { FakeEvalTable } from "../fixtures/fake-solidcraft-eval";
import { REFERENCE_PLATE } from "./fake-solidcraft";
import { fakeCliScript, fakeReleaseZip } from "./solidcraft-release";

export type { FakeEvalTable };
export type Command = { command: string; params: Record<string, unknown> };

export function writeTable(file: string, table: FakeEvalTable): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(table, null, 2));
  return file;
}

/**
 * Write an executable fake `solidcraft-cli` of `version` into `dir/<version>/` and return its path.
 * A table path is always baked in (a file that is not there means "no special behaviour"), because
 * that is also what switches the fake to its design-script replay server.
 */
export function fakeBuild(dir: string, version: string, tableFile?: string): { path: string; version: string } {
  const path = join(dir, version, "solidcraft-cli");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fakeCliScript(version, { FAKE_SC_TABLE: tableFile ?? join(dir, "no-table.json") }));
  chmodSync(path, 0o755);
  return { path, version };
}

/** A release zip whose binary reads `tableFile`. */
export function fakeReleaseWithTable(version: string, tableFile: string): { zip: Buffer; sha256: string } {
  return fakeReleaseZip(version, { env: { FAKE_SC_TABLE: tableFile } });
}

/** A GitHub release entry as the API returns it. `publishedAt` is epoch ms. */
export function githubRelease(version: string, publishedAt: number, sha256: string, over: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tag_name: `v${version}`,
    prerelease: false,
    draft: false,
    published_at: new Date(publishedAt).toISOString(),
    assets: [
      { name: releaseAssetName(version), browser_download_url: `https://example.invalid/${releaseAssetName(version)}`, digest: `sha256:${sha256}` },
      { name: "SHA256SUMS.txt", browser_download_url: `https://example.invalid/v${version}/SHA256SUMS.txt`, digest: null },
    ],
    ...over,
  };
}

/** The reference plate with a different length — a design that is genuinely another design. */
export function plate(length = 80): Command[] {
  return REFERENCE_PLATE.map((c) => (c.command === "parameters.add" && c.params.name === "L" ? { ...c, params: { ...c.params, expression: `${length} mm` } } : c));
}
/** A plain box: another closed-form part, so a repo can hold two parts with different numbers. */
export function box(l = 30, w = 20, h = 10): Command[] {
  return [{ command: "solid.box", params: { length: l, width: w, height: h, name: "Block" } }];
}
/** The plate with a fillet far too large to compute: `eval` exits 0 with a `timeline[].error`. */
export function plateWithImpossibleFillet(): Command[] {
  return REFERENCE_PLATE.map((c) => (c.command === "solid.fillet" ? { ...c, params: { ...c.params, radius: 500 } } : c));
}

/** A block with one through hole: moving the hole changes nothing but the centre of mass. */
export function blockWithHole(): Command[] {
  return [...box(30, 20, 10), { command: "solid.hole", params: { position: [10, 10, 10], diameter: 4, name: "Bore" } }];
}

/**
 * Fake modelling commands as the steps of an exported design script: `parameters.add` stays, and
 * every other command becomes a `timeline.add` step holding a fake feature (the format the fake's
 * replay understands; the real one holds the kernel's feature objects).
 */
export function asDesignSteps(commands: Command[]): Command[] {
  return commands.map((c) => (c.command === "parameters.add" ? c : { command: "timeline.add", params: { feature: { type: "fake", id: c.command, params: c.params } } }));
}

/** The text of a `design.json`. `about.design` is the part name (the behaviour table keys on it). */
export function designJson(part: string, commands: Command[]): string {
  return rawScript(part, asDesignSteps(commands));
}

/** A script with exactly these steps, unconverted — for scripts that are NOT plain design scripts. */
export function rawScript(part: string, steps: Command[]): string {
  return JSON.stringify({ about: { design: part, format: "solidcraft/58", replay: "solidcraft-cli eval script.json", version: "0.44.1" }, commands: steps }, null, 1);
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Write files (repo-relative path → text) and commit them. */
export function commitFiles(repo: string, files: Record<string, string>, message: string): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

export interface FixtureRepo {
  /** The working checkout — what an environment's `repoRoot` points at. */
  repoRoot: string;
  /** The bare repository that is the checkout's `origin` (absent with `remote: false`). */
  origin?: string;
}

/**
 * A repository on branch `main` holding `files`, with a real bare `origin` it has pushed to (unless
 * `remote: false`).
 */
export function fixtureRepo(root: string, files: Record<string, string>, opts: { remote?: boolean } = {}): FixtureRepo {
  const repoRoot = join(root, "work");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "-q", "-b", "main");
  commitFiles(repoRoot, files, "designs");
  if (opts.remote === false) return { repoRoot };
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(repoRoot, "remote", "add", "origin", origin);
  git(repoRoot, "push", "-q", "origin", "main");
  return { repoRoot, origin };
}

/** Push a commit to `origin/main` from a SECOND clone, so the first checkout has not fetched it. */
export function pushFromElsewhere(root: string, origin: string, files: Record<string, string>): void {
  const other = join(root, `elsewhere-${Math.random().toString(36).slice(2, 8)}`);
  git(root, "clone", "-q", origin, other);
  commitFiles(other, files, "pushed from another machine");
  git(other, "push", "-q", "origin", "main");
}
