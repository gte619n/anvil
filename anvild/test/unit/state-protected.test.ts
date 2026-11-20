/**
 * [C2]/[C3] The state folder's file-tool protection covers the browser's, the test daemons', the
 * integration registry's and SolidCraft's state, with ANY of those features on (merge item (c);
 * decisions 95, 119, 128, 151), and every worktree's `.anvil-browser/` and `.anvil-downloads/`.
 * Paths go through Track A's one resolver: `~/…` is the home folder, case is ignored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { protectedVerdict, resetProtectedRulesForTest } from "../../src/agent/protected";
import { registerStateDirProtection } from "../../src/agent/state-protected";
import { AccountStore } from "../../src/auth/accounts";
import { loadConfig } from "../../src/config";
import { ConnectionRegistry } from "../../src/server/registry";
import { Supervisor } from "../../src/session/supervisor";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  resetProtectedRulesForTest();
});

const session = { id: "sess_1", data: { autonomy: "bypass" } } as any;
const write = (file_path: string, cwd: string) => protectedVerdict({ session, tool: "Write", input: { file_path, content: "x" }, cwd });

describe("state-dir protection for Track B and C state", () => {
  test("[C3] Write via `~/…` to browser-loggedin.json, the browser runtime folder and testdaemons.json is denied (and the other browser, registry and SolidCraft state); a session worktree under the state dir is not", () => {
    // A state dir under the home folder, so `~/…` names it (as the CLI expands it).
    const state = realpathSync(mkdtempSync(join(homedir(), ".anvil-state-protect-test-")));
    cleanup.push(() => rmSync(state, { recursive: true, force: true }));
    const worktrees = join(state, "worktrees");
    const wt = join(worktrees, "sess_1");
    mkdirSync(wt, { recursive: true });
    cleanup.push(registerStateDirProtection(state, [worktrees, join(state, "repos")]));
    const tilde = (p: string) => "~" + p.slice(homedir().length);
    for (const rel of ["browser-loggedin.json", "browser/playwright-mcp.json", "browser/runtime/index.js", "testdaemons.json", "browser-sites.json", "browser-profile/Default/Cookies", "mcp-integrations.json", "solidcraft-pin.json", "solidcraft/0.4.0/solidcraft-cli", "BROWSER-LOGGEDIN.JSON"]) {
      for (const path of [tilde(join(state, rel)), join(state, rel)]) {
        const v = write(path, wt);
        expect(v?.kind).toBe("deny");
      }
    }
    expect(write(join(wt, "src", "a.ts"), wt)).toBeUndefined();
    expect(write("src/a.ts", wt)).toBeUndefined();
  });

  test("[C3] Write into a worktree's .anvil-browser/ (or the .anvil-downloads/ quarantine) is denied, whatever the case or route", () => {
    const state = realpathSync(mkdtempSync(join(tmpdir(), "anvil-state-protect-")));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "anvil-repo-protect-")));
    cleanup.push(() => rmSync(state, { recursive: true, force: true }), () => rmSync(repo, { recursive: true, force: true }));
    cleanup.push(registerStateDirProtection(state, [join(state, "worktrees")]));
    for (const path of [".anvil-browser/page.yml", join(repo, ".anvil-browser", "report.step"), "src/../.ANVIL-BROWSER/x.png", ".anvil-downloads/part.step"]) {
      const v = write(path, repo);
      expect(v?.kind).toBe("deny");
      if (v?.kind === "deny") expect(v.reason).toContain("written by the daemon");
    }
    expect(protectedVerdict({ session, tool: "Edit", input: { file_path: ".anvil-browser/x", old_string: "a", new_string: "b" }, cwd: repo })?.kind).toBe("deny");
    expect(write("notes/anvil-browser.md", repo)).toBeUndefined();
  });

  test("[C2] a daemon with only mcp-integrations on (no cad-work) registers the rule, and withdraws it on shutdown", async () => {
    const state = realpathSync(mkdtempSync(join(tmpdir(), "anvil-state-sup-")));
    cleanup.push(() => rmSync(state, { recursive: true, force: true }));
    const config = loadConfig({ HOME: state, ANVIL_FEATURES: "mcp-integrations" });
    const accounts = new AccountStore(state);
    accounts.add("test", "sk-ant-oat01-testtesttest-0000");
    const sup = new Supervisor({ stateDir: state, accounts, envFile: join(state, "env"), features: config.features }, new ConnectionRegistry());
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "anvil-repo-sup-")));
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
    expect(write(join(state, "testdaemons.json"), repo)?.kind).toBe("deny");
    expect(write(join(state, "mcp-integrations.json"), repo)?.kind).toBe("deny");
    await sup.shutdown();
    expect(write(join(state, "testdaemons.json"), repo)).toBeUndefined();
  });
});
