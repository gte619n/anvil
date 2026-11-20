/**
 * [A5] Follow-ups from the Phase A5 review: the merge-guard command survives a checkout path with a
 * space; every SolidCraft child gets its own TMPDIR that is gone once the process is (live manager and
 * the merge guard's throwaway replay); the test cache of real builds trusts a cached binary only when
 * it still hashes to what was unpacked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CAD_SYSTEM_PROMPT, VERIFY_CLI_COMMAND, VERIFY_CLI_PATH, shellQuote } from "../../src/agent/cad-tool-ids";
import { CadError } from "../../src/cadwork/manager";
import { LockStore } from "../../src/cadwork/locks";
import { partRef } from "../../src/cadwork/partfolder";
import { verifyParts } from "../../src/cadwork/verify";
import { BOX, cleanupTemp, fakeManager, recordingSpawn, stopManagers, tempDir, tempRepo, writeDesign } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";
import { SOLIDCRAFT_TEST_RELEASES, solidcraftReleaseBuild, solidcraftTestCache } from "../helpers/solidcraft-cache";

afterEach(async () => {
  await stopManagers();
  cleanupTemp();
});

const until = async (cond: () => boolean, what: string): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("the merge guard command in the system prompt", () => {
  test("[A5] a path with a space or a quote is single-quoted so the agent's shell runs exactly that file; a plain path is left as it is", () => {
    expect(shellQuote("/Users/x/anvil/anvild/src/cadwork/verify-cli.ts")).toBe("/Users/x/anvil/anvild/src/cadwork/verify-cli.ts");
    const odd = "/Users/x/My Projects/it's anvil/verify-cli.ts";
    const quoted = shellQuote(odd);
    expect(quoted).not.toBe(odd);
    // What the shell makes of it is exactly the one path.
    const r = Bun.spawnSync(["sh", "-c", `printf %s ${quoted}`], { stdout: "pipe" });
    expect(r.stdout.toString()).toBe(odd);
    expect(VERIFY_CLI_COMMAND).toBe(`bun ${shellQuote(VERIFY_CLI_PATH)} --changed-since <base>`);
    expect(CAD_SYSTEM_PROMPT).toContain(VERIFY_CLI_COMMAND);
  });
});

describe("each SolidCraft child gets its own TMPDIR, removed with the process", () => {
  test("[A5] the live manager: a fresh TMPDIR per process inside the manager's temp folder; gone when the process stops, and the folder itself at shutdown", async () => {
    const repo = tempRepo();
    const root = join(tempDir(), "sc-tmp");
    const log = recordingSpawn();
    const m = fakeManager({ spawn: log.spawn, tmpRoot: root });
    await m.open(partRef(repo, "plate"));
    await m.open(partRef(repo, "bracket"));
    const [a, b] = [log.envs[0]!.TMPDIR!, log.envs[1]!.TMPDIR!];
    expect(a).not.toBe(b);
    for (const d of [a, b]) {
      expect(dirname(d)).toBe(root);
      expect(existsSync(d)).toBe(true);
    }
    await m.shutdown();
    await until(() => !existsSync(a) && !existsSync(b), "the children's TMPDIRs to go");
    expect(readdirSync(root)).toEqual([]);

    // Default: a daemon-owned anvil-sc-* folder under the system temp folder, removed at shutdown.
    const log2 = recordingSpawn();
    const m2 = fakeManager({ spawn: log2.spawn });
    await m2.open(partRef(repo, "plate"));
    const own = dirname(log2.envs[0]!.TMPDIR!);
    expect(own.split("/").at(-1)).toStartWith("anvil-sc-");
    await m2.shutdown();
    await until(() => !existsSync(own), "the manager's temp folder to go");
  });

  test("[A5] a format refusal kills the child it started, and its TMPDIR goes with it", async () => {
    const repo = tempRepo();
    const root = join(tempDir(), "sc-tmp");
    writeDesign(repo, "plate", [BOX()], { design: "plate", format: "solidcraft/9999", version: "99.0.0" });
    const log = recordingSpawn();
    const m = fakeManager({ spawn: log.spawn, tmpRoot: root });
    const err = await m.open(partRef(repo, "plate")).catch((e) => e);
    expect(err).toBeInstanceOf(CadError);
    expect(String(err.message)).toContain("older than the design");
    expect(log.envs.length).toBe(1);
    await until(() => !existsSync(log.envs[0]!.TMPDIR!), "the refused child's TMPDIR to go");
    expect(readdirSync(root)).toEqual([]);
  });

  test("[A5] the merge guard's replay child runs with a TMPDIR inside its throwaway folder, which is gone when verify returns", async () => {
    const repo = tempRepo();
    writeDesign(repo, "plate", [BOX()]);
    const log = recordingSpawn();
    const state = tempDir("anvil-cad-state-");
    const r = await verifyParts({ worktree: repo, parts: ["plate"], binary: { path: FAKE_SOLIDCRAFT }, lockStore: new LockStore(state), manager: { spawn: log.spawn } });
    expect(r.parts.map((p) => p.part)).toEqual(["plate"]);
    expect(log.envs.length).toBe(1);
    const t = log.envs[0]!.TMPDIR!;
    const box = log.cmds[0]![log.cmds[0]!.indexOf("--allow-path") + 1]!; // <throwaway>/cad/plate
    const throwaway = dirname(dirname(box));
    expect(dirname(dirname(t))).toBe(throwaway); // <throwaway>/tmp/p-XXXX
    expect(existsSync(t)).toBe(false);
    expect(existsSync(throwaway)).toBe(false);
  });
});

describe("the test cache of real SolidCraft builds", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete (SOLIDCRAFT_TEST_RELEASES as Record<string, string>)["9.0.0"];
  });
  /** A release-shaped zip holding one `solidcraft-cli` script, registered under version 9.0.0. */
  function fakeRelease(cache: string): string {
    const work = mkdtempSync(join(tmpdir(), "anvil-sc-zip-"));
    dirs.push(work);
    const folder = join(work, "solidcraft-cli-9.0.0-macos-universal");
    mkdirSync(folder);
    writeFileSync(join(folder, "solidcraft-cli"), "#!/bin/sh\necho 9.0.0\n");
    chmodSync(join(folder, "solidcraft-cli"), 0o755);
    const zip = join(cache, "dl", "solidcraft-cli-9.0.0-macos-universal.zip");
    mkdirSync(dirname(zip), { recursive: true });
    const z = Bun.spawnSync(["zip", "-qr", zip, "solidcraft-cli-9.0.0-macos-universal"], { cwd: work });
    if (z.exitCode !== 0) throw new Error("zip failed");
    (SOLIDCRAFT_TEST_RELEASES as Record<string, string>)["9.0.0"] = createHash("sha256").update(readFileSync(zip)).digest("hex");
    return zip;
  }

  test("[A5] the marker holds the zip's AND the unpacked binary's sha256; a cached binary that no longer matches is unpacked again; stale staging folders are removed", async () => {
    const cache = mkdtempSync(join(tmpdir(), "anvil-sc-cache-"));
    dirs.push(cache);
    fakeRelease(cache);
    const leftover = join(cache, "x", ".9.0.0-abc123");
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, "junk"), "x");
    const quiet = () => undefined;
    const cli = await solidcraftReleaseBuild("9.0.0", { cache, log: quiet, legacyDir: "/nonexistent" });
    const original = readFileSync(cli, "utf8");
    const [zipSha, cliSha] = readFileSync(join(cache, "x", "9.0.0", ".zip-sha256"), "utf8").trim().split(/\s+/);
    expect(zipSha).toBe(SOLIDCRAFT_TEST_RELEASES["9.0.0"]);
    expect(cliSha).toBe(createHash("sha256").update(readFileSync(cli)).digest("hex"));
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(join(cache, "x")).filter((n) => n.startsWith("."))).toEqual([]);
    // Someone swaps the cached binary: the marker alone no longer vouches for it.
    writeFileSync(cli, "#!/bin/sh\necho evil\n");
    const logs: string[] = [];
    const again = await solidcraftReleaseBuild("9.0.0", { cache, log: (m) => void logs.push(m), legacyDir: "/nonexistent" });
    expect(again).toBe(cli);
    expect(readFileSync(again, "utf8")).toBe(original);
    expect(logs.join("\n")).toContain("does not match its marker");
  });

  test("[A5] a relative ANVIL_TEST_CACHE is resolved to an absolute path", () => {
    const got = solidcraftTestCache({ ANVIL_TEST_CACHE: "rel/cache" });
    expect(got.startsWith("/")).toBe(true);
    expect(got).toBe(join(process.cwd(), "rel", "cache", "solidcraft"));
  });
});
