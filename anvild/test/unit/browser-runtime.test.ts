/**
 * [C2] The agent browser's pinned server runtime (src/browser/runtime.ts; review of Phase C2): the
 * manifest shipped in the repo, the exact install command (`npm ci --ignore-scripts` in a
 * daemon-owned folder, clean environment, no user or global npm config), the marker, and the check
 * that runs before every launch. npm itself is replaced by a recorded stand-in here; the real
 * install runs in test/real/browser-c2.test.ts.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_MARKER, browserRuntimeCli, browserRuntimeDir, browserRuntimeManifest, browserRuntimeProblem, installBrowserRuntime, runtimeInstallCommand } from "../../src/browser/runtime";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "anvil-c2-runtime-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const OPTS = { npmPath: "/opt/homebrew/bin/npm", pathEnv: "/opt/homebrew/bin:/usr/bin:/bin", tmpdir: "/tmp" };
/** What a successful `npm ci` leaves behind. */
const fakeNpm = (version = "0.0.86") => async (_command: string[], cwd: string) => {
  mkdirSync(join(cwd, "node_modules", "@playwright", "mcp"), { recursive: true });
  writeFileSync(join(cwd, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version }));
  writeFileSync(join(cwd, "node_modules", "@playwright", "mcp", "cli.js"), "// server\n");
  return { code: 0, output: "added 3 packages" };
};

describe("the pinned manifest", () => {
  test("[C2] the repo ships a manifest pinning @playwright/mcp@0.0.86 with an integrity hash for every package, and the runtime folder is named after the lock's hash", () => {
    const m = browserRuntimeManifest();
    expect(JSON.parse(m.packageJson)).toMatchObject({ private: true, dependencies: { "@playwright/mcp": "0.0.86" } });
    const lock = JSON.parse(m.packageLock) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string }> };
    expect(lock.lockfileVersion).toBe(3);
    const pkgs = Object.entries(lock.packages).filter(([k]) => k !== "");
    expect(pkgs.map(([k]) => k).sort()).toEqual(["node_modules/@playwright/mcp", "node_modules/playwright", "node_modules/playwright-core"]);
    for (const [name, p] of pkgs) {
      expect([name, /^sha512-[A-Za-z0-9+/=]{80,}$/.test(p.integrity ?? "")]).toEqual([name, true]);
      expect([name, p.resolved?.startsWith("https://registry.npmjs.org/")]).toEqual([name, true]);
      expect([name, /^\d/.test(p.version ?? "")]).toEqual([name, true]); // an exact version, never a range
    }
    expect(browserRuntimeDir("/state")).toBe(`/state/browser/runtime-${m.lockSha256.slice(0, 16)}`);
    expect(browserRuntimeCli("/state")).toBe(`/state/browser/runtime-${m.lockSha256.slice(0, 16)}/node_modules/@playwright/mcp/cli.js`);
  });
});

describe("install", () => {
  test("[C2] the install command is npm ci --ignore-scripts with env -i (PATH, a temporary HOME, TMPDIR) and empty user and global npm config, run inside a daemon-owned staging folder", async () => {
    const seen: { command: string[]; cwd: string; files: string[] }[] = [];
    await installBrowserRuntime(stateDir, {
      ...OPTS,
      run: async (command, cwd) => {
        seen.push({ command, cwd, files: readdirSync(cwd).sort() });
        return fakeNpm()(command, cwd);
      },
    });
    expect(seen).toHaveLength(1);
    const { command, cwd, files } = seen[0]!;
    // Run in a staging folder under <stateDir>/browser — never a worktree — holding only the manifest.
    expect(cwd.startsWith(join(stateDir, "browser", "runtime-staging-"))).toBe(true);
    expect(files).toEqual([".home", ".npmrc-global-empty", "package-lock.json", "package.json"]);
    expect(command).toEqual([
      "/usr/bin/env",
      "-i",
      "PATH=/opt/homebrew/bin:/usr/bin:/bin",
      `HOME=${join(cwd, ".home")}`,
      "TMPDIR=/tmp",
      "/opt/homebrew/bin/npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      "--userconfig",
      "/dev/null",
      "--globalconfig",
      join(cwd, ".npmrc-global-empty"),
      "--cache",
      join(stateDir, "browser", "npm-cache"),
    ]);
    expect(command).toEqual(runtimeInstallCommand(cwd, OPTS, join(stateDir, "browser", "npm-cache")));
    expect(command.some((a) => /^npm_config_|^NODE_OPTIONS=|^NPM_CONFIG_/i.test(a))).toBe(false);
    expect(command).not.toContain("install"); // `ci` only: the lock is the authority
  });

  test("[C2] a successful install leaves the runtime in runtime-<hash> with the marker and the lock copy, and passes the launch check; a second install is a no-op", async () => {
    let runs = 0;
    const run = async (command: string[], cwd: string) => (runs++, fakeNpm()(command, cwd));
    expect(browserRuntimeProblem(stateDir)).toBe("the browser runtime is not installed");
    await installBrowserRuntime(stateDir, { ...OPTS, run });
    const dir = browserRuntimeDir(stateDir);
    const m = browserRuntimeManifest();
    expect(JSON.parse(readFileSync(join(dir, RUNTIME_MARKER), "utf8"))).toMatchObject({ lockSha256: m.lockSha256, package: "@playwright/mcp@0.0.86" });
    expect(readFileSync(join(dir, "package-lock.json"), "utf8")).toBe(m.packageLock);
    expect(existsSync(browserRuntimeCli(stateDir))).toBe(true);
    expect(existsSync(join(dir, ".home"))).toBe(false);
    expect(browserRuntimeProblem(stateDir)).toBeUndefined();
    expect(readdirSync(join(stateDir, "browser")).filter((f) => f.startsWith("runtime-staging-"))).toEqual([]);
    await installBrowserRuntime(stateDir, { ...OPTS, run });
    expect(runs).toBe(1);
  });

  test("[C2] a failed install (offline, an integrity mismatch) throws with npm's words and leaves no runtime behind (fail closed)", async () => {
    await expect(installBrowserRuntime(stateDir, { ...OPTS, run: async () => ({ code: 1, output: "npm error code EINTEGRITY\nnpm error sha512-… integrity checksum failed" }) })).rejects.toThrow(/npm ci failed \(exit 1\).*EINTEGRITY/);
    expect(existsSync(browserRuntimeDir(stateDir))).toBe(false);
    expect(readdirSync(join(stateDir, "browser")).filter((f) => f.startsWith("runtime-"))).toEqual([]);
    expect(browserRuntimeProblem(stateDir)).toBe("the browser runtime is not installed");
    // npm "succeeding" with the wrong package is not accepted either.
    await expect(installBrowserRuntime(stateDir, { ...OPTS, run: fakeNpm("0.0.99") })).rejects.toThrow(/0\.0\.99, not 0\.0\.86/);
  });
});

describe("the check before every launch", () => {
  test("[C2] the runtime may be launched only with a marker for the pinned lock, an unchanged lock copy, the server script in place and the pinned version installed", async () => {
    await installBrowserRuntime(stateDir, { ...OPTS, run: fakeNpm() });
    const dir = browserRuntimeDir(stateDir);
    const lock = readFileSync(join(dir, "package-lock.json"), "utf8");
    const marker = readFileSync(join(dir, RUNTIME_MARKER), "utf8");
    const cli = readFileSync(browserRuntimeCli(stateDir), "utf8");

    writeFileSync(join(dir, RUNTIME_MARKER), JSON.stringify({ lockSha256: "f".repeat(64) }));
    expect(browserRuntimeProblem(stateDir)).toMatch(/marker does not match/);
    rmSync(join(dir, RUNTIME_MARKER));
    expect(browserRuntimeProblem(stateDir)).toMatch(/incomplete/);
    writeFileSync(join(dir, RUNTIME_MARKER), marker);

    writeFileSync(join(dir, "package-lock.json"), `${lock} `);
    expect(browserRuntimeProblem(stateDir)).toMatch(/lock file was changed/);
    writeFileSync(join(dir, "package-lock.json"), lock);

    rmSync(browserRuntimeCli(stateDir));
    expect(browserRuntimeProblem(stateDir)).toMatch(/incomplete|missing/);
    mkdirSync(browserRuntimeCli(stateDir)); // a folder where the script should be
    expect(browserRuntimeProblem(stateDir)).toMatch(/script is missing/);
    rmSync(browserRuntimeCli(stateDir), { recursive: true });
    writeFileSync(browserRuntimeCli(stateDir), cli);
    expect(browserRuntimeProblem(stateDir)).toBeUndefined();
  });
});
