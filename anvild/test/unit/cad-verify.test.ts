/**
 * [A5] Unit tests for the merge guard (agent-cad-and-browser spec §4.11, §8.1 `verify`): the
 * measured-vs-replay comparison, the `--changed-since` selection, the CLI's arguments, state dir and
 * binary resolution, the read-only lock store, the system-prompt rule, and the protected Bash rule
 * letting the guard through.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionSuggestion } from "@protocol";
import { refusedBash, registerCadProtectedRules, resetCadProtectedForTest } from "../../src/agent/cad-protected";
import { CAD_SYSTEM_PROMPT, VERIFY_CLI_COMMAND, VERIFY_CLI_PATH } from "../../src/agent/cad-tool-ids";
import { PermissionBroker, makePreToolUseHook } from "../../src/agent/permissions";
import { resetProtectedRulesForTest } from "../../src/agent/protected";
import type { Measurement } from "../../src/cadwork/gate";
import { LockStore, READ_ONLY_LOCKS } from "../../src/cadwork/locks";
import type { Measured } from "../../src/cadwork/partfile";
import { EXIT_CANNOT_RUN, EXIT_FAIL, EXIT_OK, parseArgs, resolveBinary, stateDirFrom } from "../../src/cadwork/verify-cli";
import { VerifyCannotRun, changedParts, measuredChecks, verifyParts } from "../../src/cadwork/verify";
import { PIN_FILE } from "../../src/solidcraft/pin";
import type { Session } from "../../src/session/session";
import { cleanupTemp, tempDir, tempRepo } from "../helpers/cad-work";
import { git } from "../helpers/cad-verify";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";

afterEach(() => cleanupTemp());

const replay: Measurement = { bbox: [6, 50, 80], volume: 23335.167, faces: 22, bodies: 1, holes: [{ diameter: 3.4, count: 4, kind: "through" }], scriptSha: "a".repeat(64), solidcraft: "0.44.1" };
const stored = (over: Partial<Measured> = {}): Measured => ({ at: "2026-11-20T00:00:00Z", solidcraft: "0.44.1", scriptSha: "a".repeat(64), bbox: [80, 6, 50], volume: 23335.167, faces: 22, bodies: 1, holes: [{ diameter: 3.4, count: 4, kind: "through" }], warnings: [], ...over });
const failing = (checks: { id: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.id);

describe("measuredChecks: part.json.measured against the replay", () => {
  test("[A5] a measurement of the same script with the same numbers (in any bbox order) passes every check", () => {
    const c = measuredChecks(stored(), replay, { length: 0.01, volumeRel: 0.001 });
    expect(c.map((x) => x.id)).toEqual(["measured.scriptSha", "measured.bbox.min", "measured.bbox.mid", "measured.bbox.max", "measured.volume", "measured.bodies", "measured.holes"]);
    expect(failing(c)).toEqual([]);
    expect(c.every((x) => x.hard)).toBe(true);
  });

  test("[A5] another script, numbers beyond the part's tolerance, other bodies or holes, or no measurement at all each fail", () => {
    const tol = { length: 0.01, volumeRel: 0.001 };
    expect(failing(measuredChecks(stored({ scriptSha: "b".repeat(64) }), replay, tol))).toEqual(["measured.scriptSha"]);
    expect(failing(measuredChecks(stored({ volume: 23335.167 * 1.002 }), replay, tol))).toEqual(["measured.volume"]);
    expect(failing(measuredChecks(stored({ volume: 23335.167 * 1.0005 }), replay, tol))).toEqual([]); // within 0.1 %
    expect(failing(measuredChecks(stored({ bbox: [6, 50, 80.02] }), replay, tol))).toEqual(["measured.bbox.max"]);
    expect(failing(measuredChecks(stored({ bodies: 2 }), replay, tol))).toEqual(["measured.bodies"]);
    expect(failing(measuredChecks(stored({ holes: [{ diameter: 3.4, count: 3, kind: "through" }] }), replay, tol))).toEqual(["measured.holes"]);
    expect(failing(measuredChecks(stored({ holes: [{ diameter: 3.4, count: 4, kind: "blind" }] }), replay, tol))).toEqual(["measured.holes"]);
    const none = measuredChecks(undefined, replay, tol);
    expect(failing(none)).toEqual(["measured.part.json"]);
    expect(String(none[0]!.measured)).toContain("check_part");
  });

  test("[A5] the tolerance is the part's own clamped to the caps, and the defaults for a part with no expectations", () => {
    // A tolerance loosened past the caps (1 mm) is held to 0.1 mm.
    expect(failing(measuredChecks(stored({ bbox: [6, 50, 80.5] }), replay, { length: 1, volumeRel: 0.5 }))).toEqual(["measured.bbox.max"]);
    expect(failing(measuredChecks(stored({ volume: 23335.167 * 1.02 }), replay, { length: 1, volumeRel: 0.5 }))).toEqual(["measured.volume"]);
    expect(failing(measuredChecks(stored({ bbox: [6, 50, 80.05] }), replay, { length: 0.1, volumeRel: 0.01 }))).toEqual([]);
    expect(failing(measuredChecks(stored({ bbox: [6, 50, 80.05] }), replay, undefined))).toEqual(["measured.bbox.max"]); // default 0.01 mm
  });
});

describe("changedParts: what --changed-since selects", () => {
  test("[A5] parts under cad/<part>/ changed since the merge base in the working tree, rules.json, daemon folders and bad refs", () => {
    const repo = tempRepo();
    git(repo, "checkout", "-q", "-b", "main");
    for (const p of ["one", "two"]) {
      mkdirSync(join(repo, "cad", p), { recursive: true });
      writeFileSync(join(repo, "cad", p, "design.json"), "{}\n");
    }
    writeFileSync(join(repo, "cad", "rules.json"), "{}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const base = git(repo, "rev-parse", "HEAD");
    expect(changedParts(repo, base)).toEqual({ parts: [], rulesChanged: false, unexpected: [] });
    writeFileSync(join(repo, "cad", "two", "part.json"), "{}\n"); // untracked
    mkdirSync(join(repo, "cad", "one", "release"), { recursive: true });
    writeFileSync(join(repo, "cad", "one", "release", "x"), "x"); // daemon-written (and normally git-excluded)
    mkdirSync(join(repo, "cad", "Not-A-Part"), { recursive: true });
    writeFileSync(join(repo, "cad", "Not-A-Part", "x"), "x");
    // A folder no part can have is not a part (the merge guard skips it) but is reported as unexpected.
    expect(changedParts(repo, base)).toEqual({ parts: ["two"], rulesChanged: false, unexpected: ["cad/Not-A-Part/x"] });
    writeFileSync(join(repo, "cad", "rules.json"), '{"changed":true}\n');
    expect(changedParts(repo, base).rulesChanged).toBe(true);
    // A diverged ref: only what changed on this side since the fork point (merge base) counts.
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ours");
    git(repo, "checkout", "-q", "-b", "theirs", base);
    writeFileSync(join(repo, "cad", "one", "design.json"), '{"theirs":1}\n');
    git(repo, "commit", "-q", "-am", "theirs");
    git(repo, "checkout", "-q", "main");
    expect(changedParts(repo, "theirs")).toEqual({ parts: ["two"], rulesChanged: true, unexpected: ["cad/Not-A-Part/x"] });
    expect(() => changedParts(repo, "no-such-ref")).toThrow(VerifyCannotRun);
    expect(() => changedParts(repo, "--output=/tmp/x")).toThrow(VerifyCannotRun); // never an option to git
  });
});

describe("verify-cli arguments, state dir and binary", () => {
  test("[A5] parseArgs: --changed-since, --part (repeated or several names), --json; anything else is an error", () => {
    expect(parseArgs([])).toEqual({ parts: [], json: false });
    expect(parseArgs(["--changed-since", "origin/main", "--json"])).toEqual({ changedSince: "origin/main", parts: [], json: true });
    expect(parseArgs(["--changed-since=main"])).toEqual({ changedSince: "main", parts: [], json: false });
    expect(parseArgs(["--part", "a", "b", "--part=c"])).toEqual({ parts: ["a", "b", "c"], json: false });
    for (const bad of [["--changed-since"], ["--part"], ["--binary", "/bin/sh"], ["extra"], ["--changed-since", "--json"]]) expect("error" in parseArgs(bad)).toBe(true);
    expect([EXIT_OK, EXIT_FAIL, EXIT_CANNOT_RUN]).toEqual([0, 1, 2]);
  });

  test("[A5] the state dir is ANVIL_STATE_DIR (with ~ expanded) or ~/.anvil, as the daemon resolves it", () => {
    expect(stateDirFrom({}, "/Users/x")).toBe("/Users/x/.anvil");
    expect(stateDirFrom({ ANVIL_STATE_DIR: "~/s" }, "/Users/x")).toBe("/Users/x/s");
    expect(stateDirFrom({ ANVIL_STATE_DIR: "/abs/state" }, "/Users/x")).toBe("/abs/state");
  });

  test("[A5] the binary: ANVIL_SOLIDCRAFT_CLI first (the documented same-user override), else the pinned managed build; a pin with no verified install, or a missing file, is an error", () => {
    const state = tempDir();
    expect(resolveBinary(state, { ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT })).toEqual({ path: FAKE_SOLIDCRAFT, source: "env" });
    expect(resolveBinary(state, { ANVIL_SOLIDCRAFT_CLI: "/nonexistent/solidcraft-cli" })).toEqual({ error: "solidcraft-cli was not found at /nonexistent/solidcraft-cli" });
    writeFileSync(join(state, PIN_FILE), JSON.stringify({ version: "0.44.1", sha256: "b".repeat(64), pinnedAt: "2026-11-20T00:00:00Z" }));
    expect(resolveBinary(state, {})).toEqual({ error: "the fleet pins SolidCraft 0.44.1, which is not installed on this machine (the daemon installs it)" });
    writeFileSync(join(state, PIN_FILE), "{ broken");
    expect("error" in resolveBinary(state, {})).toBe(true);
    // With the env override the pin is not consulted (exactly resolveSolidcraftCli's order).
    expect(resolveBinary(state, { ANVIL_SOLIDCRAFT_CLI: FAKE_SOLIDCRAFT })).toMatchObject({ source: "env" });
  });
});

describe("the read-only lock store", () => {
  test("[A5] opened read-only it creates no folder, leaves a corrupt file where it is, reads a good one, and refuses every write", () => {
    const bare = tempDir();
    const ro = new LockStore(bare, { readOnly: true });
    expect(existsSync(join(bare, "cadwork"))).toBe(false);
    expect(ro.unreadable).toBeUndefined();
    expect(() => ro.putRules({ repo: "r", sha: "s", text: "t", at: "2026-11-20T00:00:00Z" })).toThrow(READ_ONLY_LOCKS);
    expect(existsSync(join(bare, "cadwork"))).toBe(false);

    const good = tempDir();
    new LockStore(good).putRules({ repo: "r", sha: "s", text: "t", at: "2026-11-20T00:00:00Z" });
    const text = readFileSync(join(good, "cadwork", "locks.json"), "utf8");
    const reader = new LockStore(good, { readOnly: true });
    expect(reader.findRules({ key: "r", path: "/nowhere" })?.sha).toBe("s");
    expect(() => reader.merge({ rules: [{ repo: "r", sha: "z", text: "t", at: "2027-01-01T00:00:00Z" }] })).toThrow(READ_ONLY_LOCKS);
    expect(readFileSync(join(good, "cadwork", "locks.json"), "utf8")).toBe(text);

    const bad = tempDir();
    mkdirSync(join(bad, "cadwork"));
    writeFileSync(join(bad, "cadwork", "locks.json"), "[]");
    const broken = new LockStore(bad, { readOnly: true });
    expect(broken.unreadable).toContain("schema-1");
    expect(broken.quarantined).toBeUndefined();
    expect(readdirSync(join(bad, "cadwork"))).toEqual(["locks.json"]);
  });

  test("[A5] verifyParts reports an unreadable lock store as could-not-run, never as 'nothing approved'", async () => {
    const repo = tempRepo();
    const bad = tempDir();
    mkdirSync(join(bad, "cadwork"));
    writeFileSync(join(bad, "cadwork", "locks.json"), "nope");
    const r = await verifyParts({ worktree: repo, stateDir: bad, binary: { path: FAKE_SOLIDCRAFT } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not be read");
    expect(r.parts).toEqual([]);
  });
});

describe("daemon integration: the prompt and the Bash rule", () => {
  let repo = "";
  let state = "";
  beforeEach(() => {
    repo = tempRepo();
    state = tempDir("anvil-cad-state-");
    registerCadProtectedRules(state);
  });
  afterEach(() => {
    resetCadProtectedForTest();
    resetProtectedRulesForTest();
  });

  test("[A5] the CAD system prompt tells the agent to run verify-cli --changed-since <base> after any merge or rebase touching cad/, and not to commit a merge that fails it", () => {
    expect(VERIFY_CLI_PATH).toEndWith("/anvild/src/cadwork/verify-cli.ts");
    expect(existsSync(VERIFY_CLI_PATH)).toBe(true);
    expect(VERIFY_CLI_COMMAND).toBe(`bun ${VERIFY_CLI_PATH} --changed-since <base>`);
    expect(CAD_SYSTEM_PROMPT).toContain(VERIFY_CLI_COMMAND);
    for (const phrase of ["after any git merge or rebase that touches cad/", "Do not commit a merge", "while it fails", "check_part"]) expect(CAD_SYSTEM_PROMPT).toContain(phrase);
  });

  test("[A5] the protected Bash rule lets the merge guard through (the relative form and the prompt's absolute path, under every policy), and still denies solidcraft-cli", async () => {
    const asked: { requestId: string; suggestions: PermissionSuggestion[] }[] = [];
    const session = (autonomy: string) =>
      ({
        id: "sess_1",
        data: { autonomy, cwd: repo },
        isAlwaysAllowed: () => false,
        rememberAllow: () => undefined,
        requestPermission: (requestId: string, _tool: string, _input: unknown, suggestions: PermissionSuggestion[]) => void asked.push({ requestId, suggestions }),
      }) as unknown as Session;
    const commands = [
      "bun anvild/src/cadwork/verify-cli.ts --changed-since origin/main",
      VERIFY_CLI_COMMAND.replace("<base>", "main"),
      `cd ${repo} && bun ${VERIFY_CLI_PATH} --changed-since HEAD~1 --json`,
    ];
    for (const command of commands) {
      expect(refusedBash(command, [state])).toBeUndefined();
      for (const autonomy of ["bypass", "mostly-autonomous"]) {
        const broker = new PermissionBroker();
        const before = asked.length;
        const pending = makePreToolUseHook(session(autonomy), broker)({ tool_name: "Bash", tool_input: { command } } as any, "t", { signal: new AbortController().signal } as any) as Promise<any>;
        await new Promise((r) => setTimeout(r, 0));
        const prompt = asked[before];
        if (prompt) broker.resolve(prompt.requestId, "allow");
        const out = await pending;
        expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
        expect(String(out.hookSpecificOutput.permissionDecisionReason ?? "")).not.toContain("solidcraft-cli");
      }
    }
    // Naming the binary on the command line is still the tripwire.
    expect(refusedBash(`ANVIL_SOLIDCRAFT_CLI=/x/solidcraft-cli bun ${VERIFY_CLI_PATH}`, [state])).toContain("solidcraft-cli");
    expect(refusedBash(`cat ${state}/cadwork/locks.json`, [state])).toBeString();
  });
});
