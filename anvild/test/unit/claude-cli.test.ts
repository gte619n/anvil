import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledVersion,
  cliStatus,
  CLI_PKG,
  install,
  managedCliPath,
  parseCliVersion,
  recordLatest,
  resolveLatest,
  type ExecLike,
  type FetchLike,
} from "../../src/daemon/claude-cli";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "anvil-cli-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const fetchTag = (latest: string, ok = true): FetchLike =>
  (async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ latest }) })) as unknown as FetchLike;

describe("parseCliVersion", () => {
  test("pulls the leading semver out of `claude --version`", () => {
    expect(parseCliVersion("2.1.322 (Claude Code)")).toBe("2.1.322");
    expect(parseCliVersion("  2.1.290\n")).toBe("2.1.290");
  });
});

describe("resolveLatest", () => {
  test("returns the registry 'latest' dist-tag", async () => {
    expect(await resolveLatest(fetchTag("2.1.322"))).toBe("2.1.322");
  });
  test("throws on a non-ok registry response", async () => {
    await expect(resolveLatest(fetchTag("x", false))).rejects.toThrow(/responded 503/);
  });
});

describe("bundledVersion", () => {
  test("reads the agent-sdk manifest version (real install is 2.1.x)", () => {
    expect(bundledVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("install", () => {
  // A fake `bun add` that fabricates the resolved binary + a `--version` responder, so we exercise
  // the full install/validate/persist path without the network or a 324MB download.
  const fakeExec = (version: string, onAdd?: () => void): ExecLike => async (cmd, cwd) => {
    if (cmd[1] === "add") {
      onAdd?.();
      // Materialize the binary bun would have linked.
      const bin = join(cwd, "node_modules", ".bin", "claude");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
      writeFileSync(bin, "#!/bin/sh\n");
      return { code: 0, stdout: `installed ${CLI_PKG}@${version}`, stderr: "" };
    }
    if (cmd[1] === "--version") return { code: 0, stdout: `${version} (Claude Code)`, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };

  test("installs the resolved latest, validates, and persists state", async () => {
    const res = await install(stateDir, { fetchFn: fetchTag("2.1.322"), execFn: fakeExec("2.1.322") });
    expect(res.version).toBe("2.1.322");
    expect(existsSync(res.binPath)).toBe(true);
    expect(managedCliPath(stateDir)).toBe(res.binPath);
    const persisted = JSON.parse(readFileSync(join(stateDir, "claude-cli", "installed.json"), "utf8"));
    expect(persisted.version).toBe("2.1.322");
  });

  test("installs an explicit version without hitting the registry", async () => {
    let fetched = false;
    const noFetch: FetchLike = (async () => {
      fetched = true;
      throw new Error("should not fetch");
    }) as unknown as FetchLike;
    const res = await install(stateDir, { version: "2.1.290", fetchFn: noFetch, execFn: fakeExec("2.1.290") });
    expect(res.version).toBe("2.1.290");
    expect(fetched).toBe(false);
  });

  test("throws (and persists nothing) when `bun add` fails", async () => {
    const failing: ExecLike = async (cmd) =>
      cmd[1] === "add" ? { code: 1, stdout: "", stderr: "network down" } : { code: 0, stdout: "", stderr: "" };
    await expect(install(stateDir, { version: "2.1.322", execFn: failing })).rejects.toThrow(/bun add .* failed/);
    expect(managedCliPath(stateDir)).toBeNull();
  });
});

describe("cliStatus", () => {
  test("falls back to bundled when nothing is managed", () => {
    const s = cliStatus(stateDir);
    expect(s.managed).toBe(false);
    expect(s.active).toBe(s.bundled);
    expect(s.latest).toBeUndefined();
  });

  test("reflects a managed install + recorded latest", async () => {
    const fake: ExecLike = async (cmd, cwd) => {
      if (cmd[1] === "add") {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
        writeFileSync(join(cwd, "node_modules", ".bin", "claude"), "#!/bin/sh\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "2.1.300 (Claude Code)", stderr: "" };
    };
    await install(stateDir, { version: "2.1.300", execFn: fake });
    const changed = recordLatest(stateDir, "2.1.322");
    expect(changed).toBe(true);
    const s = cliStatus(stateDir);
    expect(s.managed).toBe(true);
    expect(s.active).toBe("2.1.300");
    expect(s.latest).toBe("2.1.322");
    expect(s.checkedAt).toBeTruthy();
    // Re-recording the same latest is a no-op change.
    expect(recordLatest(stateDir, "2.1.322")).toBe(false);
  });
});
