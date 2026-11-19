/**
 * [A2] The CAD rules of the protected check (agent-cad-and-browser spec §4.4): what is always denied,
 * what always prompts with no "always allow", and that none of it can be skipped by an autonomy
 * policy or an earlier "always allow". Driven through the REAL permission hook.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionSuggestion } from "@protocol";
import { cadProtectedRule, refusedBash, registerCadProtectedRules, resetCadProtectedForTest } from "../../src/agent/cad-protected";
import { PermissionBroker, makePreToolUseHook } from "../../src/agent/permissions";
import { protectedVerdict, resetProtectedRulesForTest } from "../../src/agent/protected";
import { CadworkService } from "../../src/session/cadwork-service";
import type { Session } from "../../src/session/session";
import { cleanupTemp, tempDir, tempRepo } from "../helpers/cad-work";

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
  cleanupTemp();
});

function fakeSession(data: Record<string, unknown> = {}) {
  const asked: { requestId: string; tool: string; suggestions: PermissionSuggestion[] }[] = [];
  const remembered = new Set<string>();
  const session = {
    id: "sess_1",
    data: { autonomy: "bypass", cwd: repo, ...data },
    isAlwaysAllowed: (tool: string) => remembered.has(tool),
    rememberAllow: (tool: string) => void remembered.add(tool),
    requestPermission: (requestId: string, tool: string, _input: unknown, suggestions: PermissionSuggestion[]) => void asked.push({ requestId, tool, suggestions }),
  } as unknown as Session;
  return { session, asked, remembered };
}
const ctx = { signal: new AbortController().signal } as any;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Run the real hook; answer a prompt (if one is parked) with `answer`. */
async function gate(s: ReturnType<typeof fakeSession>, tool: string, input: Record<string, unknown>, answer: "allow" | "deny" | "allow_always" = "allow") {
  const broker = new PermissionBroker();
  const before = s.asked.length;
  const pending = makePreToolUseHook(s.session, broker)({ tool_name: tool, tool_input: input } as any, "t", ctx) as Promise<any>;
  await tick();
  const prompt = s.asked[before];
  if (prompt) broker.resolve(prompt.requestId, answer);
  const out = await pending;
  return { decision: out.hookSpecificOutput.permissionDecision as string, reason: String(out.hookSpecificOutput.permissionDecisionReason ?? ""), prompt };
}

describe("cad protected rules", () => {
  test("[A2] Edit, Write, MultiEdit and NotebookEdit to cad/<part>/part.json are denied under every policy, bypass included", async () => {
    for (const autonomy of ["bypass", "mostly-autonomous", "allowlist", "prompt-all"]) {
      const s = fakeSession({ autonomy });
      s.remembered.add("Edit").add("Write"); // an earlier "always allow" changes nothing
      for (const [tool, input] of [
        ["Edit", { file_path: join(repo, "cad", "plate", "part.json"), old_string: "a", new_string: "b" }],
        ["Write", { file_path: "cad/plate/part.json", content: "{}" }], // relative to the session's cwd
        ["MultiEdit", { file_path: join(repo, "cad", "motor-mount", "part.json"), edits: [] }],
        ["NotebookEdit", { notebook_path: join(repo, "cad", "plate", "part.json") }],
        ["Write", { file_path: join(repo, "cad", "plate", "..", "plate", "part.json"), content: "{}" }],
        ["Write", { file_path: join(repo, "cad", "plate", "PART.JSON"), content: "{}" }], // the same file on a case-insensitive disk
      ] as const) {
        const r = await gate(s, tool, input as any);
        expect(r.decision).toBe("deny");
        expect(r.reason).toContain("written by the anvil_cad tools only");
        expect(r.prompt).toBeUndefined(); // refused outright: no card
      }
    }
    // Through a symlink, and from a subfolder of the worktree, it is still the same file.
    mkdirSync(join(repo, "cad", "plate"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "cad", "plate", "part.json"), "{}");
    symlinkSync(join(repo, "cad", "plate", "part.json"), join(repo, "src", "alias.json"));
    symlinkSync(join(repo, "cad"), join(repo, "shortcut"));
    const s = fakeSession();
    expect((await gate(s, "Edit", { file_path: join(repo, "src", "alias.json") })).decision).toBe("deny");
    expect((await gate(s, "Write", { file_path: join(repo, "shortcut", "plate", "part.json") })).decision).toBe("deny");
    const sub = fakeSession({ cwd: join(repo, "src") });
    expect((await gate(sub, "Write", { file_path: "../cad/plate/part.json" })).decision).toBe("deny");
    // Other files are untouched by the rule — including design.json's neighbours and other repos' files.
    for (const file_path of [join(repo, "cad", "plate", "notes.md"), join(repo, "part.json"), join(repo, "cad", "part.json"), join(repo, "docs", "cad", "plate", "part.json", "x"), "/tmp/elsewhere/cad/plate/part.json"]) {
      expect(cadProtectedRule({ session: s.session, tool: "Write", input: { file_path }, cwd: repo })).toBeUndefined();
    }
    expect((await gate(s, "Write", { file_path: join(repo, "README.md") })).decision).toBe("allow");
    expect(cadProtectedRule({ session: s.session, tool: "Read", input: { file_path: join(repo, "cad", "plate", "part.json") }, cwd: repo })).toBeUndefined();
  });

  test("[A2] Edit and Write to cad/rules.json always prompt — under bypass, after an earlier always-allow, with no always-allow offered — and are denied when unattended", async () => {
    const target = { file_path: join(repo, "cad", "rules.json"), content: "{}" };
    for (const autonomy of ["bypass", "mostly-autonomous", "allowlist", "prompt-all"]) {
      const s = fakeSession({ autonomy });
      s.remembered.add("Write").add("Edit");
      const r = await gate(s, "Write", target);
      expect(r.prompt).toBeDefined(); // asked, whatever the policy and whatever was remembered
      expect(r.prompt!.suggestions.map((x) => x.decision)).toEqual(["allow", "deny"]);
      expect(r.prompt!.suggestions.some((x) => x.decision === "allow_always")).toBe(false);
      expect(r.decision).toBe("allow");
      // …and asked AGAIN the next time: the answer was not remembered.
      const again = await gate(s, "Edit", { file_path: "cad/rules.json", old_string: "a", new_string: "b" });
      expect(again.prompt).toBeDefined();
    }
    // A client that answers "always allow" anyway gets an allow-once.
    const s = fakeSession();
    expect((await gate(s, "Write", target, "allow_always")).decision).toBe("allow");
    expect(s.remembered.has("Write")).toBe(false);
    expect((await gate(s, "Write", target, "deny")).decision).toBe("deny");
    expect(s.asked).toHaveLength(2);
    // An autopilot builder session has nobody to answer: denied with no card.
    const builder = fakeSession({ workUnitRole: "builder" });
    const denied = await gate(builder, "Write", target);
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("unattended");
    expect(builder.asked).toEqual([]);
  });

  test("[A2] Bash commands that reach for the daemon's CAD and browser state, solidcraft-cli, or a remote-debugging browser are denied", async () => {
    const s = fakeSession();
    s.remembered.add("Bash");
    const home = homedir();
    const denied = [
      `cat ${state}/cadwork/locks.json`,
      `echo '{}' > "${state}/cadwork/locks.json"`,
      `ls ${state}/solidcraft/versions`,
      `rm -rf ${state}/browser-profile`,
      "/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli run design.json --out x.step",
      "solidcraft-cli eval cad/plate/design.json",
      "cd cad/plate && SOLIDCRAFT-CLI mcp",
      "open -a 'Google Chrome' --args --remote-debugging-port=9222",
      "chrome --user-data-dir=/tmp/p https://example.com",
      "chromium --user-data-dir /tmp/p",
    ];
    for (const command of denied) {
      const r = await gate(s, "Bash", { command });
      expect(r.decision).toBe("deny");
      expect(r.prompt).toBeUndefined();
    }
    // The home-relative spellings of a state dir under $HOME are caught too.
    const under = join(home, ".anvil-test-state");
    for (const command of ["cat ~/.anvil-test-state/cadwork/locks.json", "cat $HOME/.anvil-test-state/cadwork/locks.json", "cat ${HOME}/.anvil-test-state/solidcraft/x", `cat ${under}/browser-profile/Cookies`]) {
      expect(refusedBash(command, [under])).toBeString();
    }
    // Ordinary commands — including ones that merely mention CAD — are not.
    for (const command of ["git status", "ls cad/plate", "cat cad/plate/design.json", "bun test", `ls ${state}`, "echo solidcraft", "grep -r cadwork src/"]) {
      expect(refusedBash(command, [state])).toBeUndefined();
      expect((await gate(s, "Bash", { command })).decision).toBe("allow");
    }
    expect(refusedBash("solidcraft-cli --version", [])).toContain("use the anvil_cad tools");
  });

  test("[A2] propose_expectations is let through with no generic prompt (its own card is the prompt) and denied when unattended", async () => {
    const tool = "mcp__anvil_cad__propose_expectations";
    for (const autonomy of ["bypass", "mostly-autonomous", "allowlist", "prompt-all"]) {
      const s = fakeSession({ autonomy });
      const r = await gate(s, tool, { part: "plate" });
      expect(r.decision).toBe("allow");
      expect(r.prompt).toBeUndefined(); // no second, generic card in front of the typed one
      expect(s.remembered.has(tool)).toBe(false);
      const builder = fakeSession({ autonomy, workUnitRole: "builder" });
      const denied = await gate(builder, tool, { part: "plate" });
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toContain("unattended");
      expect(builder.asked).toEqual([]);
    }
    // The other anvil_cad tools are not affected by the rule.
    expect(cadProtectedRule({ session: fakeSession().session, tool: "mcp__anvil_cad__execute", input: {}, cwd: repo })).toBeUndefined();
    expect(cadProtectedRule({ session: fakeSession().session, tool: "mcp__anvil_cad__record_expectations", input: {}, cwd: repo })).toBeUndefined();
  });

  test("[A2] the rules are registered once per daemon, by the service when cad-work is on, and tests can reset the registry", async () => {
    resetCadProtectedForTest();
    resetProtectedRulesForTest();
    const probe = { session: fakeSession().session, tool: "Bash", input: { command: "solidcraft-cli --version" }, cwd: repo };
    expect(protectedVerdict(probe)).toBeUndefined(); // nothing registered
    // A daemon without the feature registers nothing.
    const off = new CadworkService({ enabled: false, getSession: () => undefined, stateDir: tempDir() });
    expect(protectedVerdict(probe)).toBeUndefined();
    await off.shutdown();
    // A daemon with it registers the rules; a second service (or a repeat call) does not double them.
    const a = new CadworkService({ enabled: true, getSession: () => undefined, stateDir: state });
    const b = new CadworkService({ enabled: true, getSession: () => undefined, stateDir: tempDir() });
    registerCadProtectedRules(state);
    expect(protectedVerdict(probe)).toMatchObject({ kind: "deny" });
    const s = fakeSession();
    const target = { file_path: join(repo, "cad", "rules.json"), content: "{}" };
    await gate(s, "Write", target);
    expect(s.asked).toHaveLength(1); // one card, not one per registration
    // Both daemons' state folders are covered while both are up; shutting one down leaves the other's.
    expect((await gate(s, "Bash", { command: `ls ${state}/cadwork` })).decision).toBe("deny");
    await a.shutdown();
    expect(protectedVerdict(probe)).toMatchObject({ kind: "deny" });
    await b.shutdown();
    resetCadProtectedForTest();
    expect(protectedVerdict(probe)).toBeUndefined();
  });

  test("[A2] review 2: Edit, Write, MultiEdit and NotebookEdit to cad/<part>/design.json always prompt with no always-allow, under every policy, and are denied when unattended", async () => {
    const target = join(repo, "cad", "plate", "design.json");
    for (const autonomy of ["bypass", "mostly-autonomous", "allowlist", "prompt-all"]) {
      for (const [tool, input] of [
        ["Write", { file_path: target, content: "{}" }],
        ["Edit", { file_path: "cad/plate/design.json", old_string: "a", new_string: "b" }],
        ["MultiEdit", { file_path: "cad/plate/../plate/DESIGN.JSON", edits: [] }],
        ["NotebookEdit", { notebook_path: target }],
      ] as const) {
        const s = fakeSession({ autonomy });
        s.remembered.add(tool);
        const r = await gate(s, tool, input as any);
        expect(r.prompt).toBeDefined(); // asked, whatever the policy and whatever was remembered
        expect(r.prompt!.suggestions.map((x) => x.decision)).toEqual(["allow", "deny"]);
        expect(r.decision).toBe("allow");
        expect((await gate(s, tool, input as any, "deny")).decision).toBe("deny"); // and asked again
        expect(s.asked).toHaveLength(2);
      }
    }
    const s = fakeSession();
    expect((await gate(s, "Write", { file_path: target, content: "{}" }, "allow_always")).decision).toBe("allow");
    expect(s.remembered.has("Write")).toBe(false);
    const builder = fakeSession({ workUnitRole: "builder" });
    const denied = await gate(builder, "Write", { file_path: target, content: "{}" });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("unattended");
    expect(builder.asked).toEqual([]);
    // Reading the script, and writing other files of the part, are untouched.
    expect(cadProtectedRule({ session: s.session, tool: "Read", input: { file_path: target }, cwd: repo })).toBeUndefined();
    expect(cadProtectedRule({ session: s.session, tool: "Write", input: { file_path: join(repo, "cad", "plate", "notes.md") }, cwd: repo })).toBeUndefined();
    expect(cadProtectedRule({ session: s.session, tool: "Write", input: { file_path: join(repo, "design.json") }, cwd: repo })).toBeUndefined();
  });

  test("[A2] review 3: the file tools cannot write anywhere under the daemon's state dir — absolute, relative or through a symlink — except in session worktrees and cloned repos", async () => {
    resetCadProtectedForTest();
    // A session whose worktree is where production puts it: under <stateDir>/worktrees.
    const wt = join(state, "worktrees", "sess_1");
    mkdirSync(join(wt, "src"), { recursive: true });
    mkdirSync(join(state, "repos", "widgets"), { recursive: true });
    mkdirSync(join(state, "cadwork"), { recursive: true });
    writeFileSync(join(state, "cadwork", "locks.json"), "{}");
    registerCadProtectedRules(state, [join(state, "worktrees"), join(state, "repos")]);
    const link = join(wt, "innocent");
    symlinkSync(join(state, "cadwork"), link);
    const rel = (p: string) => require("node:path").relative(wt, p);
    const denied: [string, Record<string, unknown>][] = [
      ["Write", { file_path: join(state, "cadwork", "locks.json"), content: "{}" }],
      ["Edit", { file_path: rel(join(state, "cadwork", "locks.json")), old_string: "a", new_string: "b" }], // ../../cadwork/locks.json
      ["Write", { file_path: "innocent/locks.json", content: "{}" }], // through a symlink inside the worktree
      ["MultiEdit", { file_path: join(state, "sessions.json"), edits: [] }],
      ["Write", { file_path: join(state, "env"), content: "X=1" }],
      ["Write", { file_path: join(state, "new-folder", "x.txt"), content: "" }],
      ["NotebookEdit", { notebook_path: join(state, "solidcraft", "x.ipynb") }],
      ["Write", { file_path: join(state, "worktrees"), content: "" }], // the root itself is not a session's file
    ];
    for (const autonomy of ["bypass", "mostly-autonomous", "allowlist"]) {
      for (const [tool, input] of denied) {
        const s = fakeSession({ autonomy, cwd: wt });
        s.remembered.add(tool);
        const r = await gate(s, tool, input);
        expect([tool, input, r.decision]).toEqual([tool, input, "deny"]);
        expect(r.reason).toContain("state folder");
        expect(s.asked).toEqual([]); // refused outright
      }
    }
    // The places a session works in stay writable, and so does everything outside the state dir.
    const s = fakeSession({ cwd: wt });
    for (const fp of [join(wt, "src", "a.ts"), "src/b.ts", join(state, "worktrees", "sess_2", "x.ts"), join(state, "repos", "widgets", "README.md"), join(repo, "README.md")]) {
      expect((await gate(s, "Write", { file_path: fp, content: "" })).decision).toBe("allow");
    }
    // Reads are not this rule's business.
    expect(cadProtectedRule({ session: s.session, tool: "Read", input: { file_path: join(state, "cadwork", "locks.json") }, cwd: wt })).toBeUndefined();
  });
});
