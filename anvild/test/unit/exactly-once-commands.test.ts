import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { AccountStore } from "../../src/auth/accounts";
import { ConnectionRegistry } from "../../src/server/registry";

const tempState = () => mkdtempSync(join(tmpdir(), "anvil-xo-"));

// Regression for adversarial-review Finding 2: daemon-handled commands (/goal, /clear, /compact) apply
// a real side effect but emit no `message.user`, so they early-return in prompt(). They must STILL
// record their cid, or a re-flushed offline copy re-runs the side effect (exactly-once violation).
test("a daemon-handled command (/goal) records its cid so a re-flush is deduped", async () => {
  const dir = tempState();
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  sup.accountAdd("work", "sk-ant-oat01-workworkwork-1111"); // a real account → NOT degraded, so /goal runs

  const s = await sup.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });
  expect(sup.isPromptApplied(s.id, "cid_goal")).toBe(false);

  sup.prompt(s.id, "/goal ship the feature", [], "cid_goal");
  expect(sup.isPromptApplied(s.id, "cid_goal")).toBe(true); // recorded despite emitting no message.user
  expect(sup.get(s.id)!.data.goal?.condition).toBe("ship the feature"); // applied exactly once

  // A re-flush of the same cid is deduped at the top of prompt() — the side effect does not run again.
  sup.prompt(s.id, "/goal something completely different", [], "cid_goal");
  expect(sup.get(s.id)!.data.goal?.condition).toBe("ship the feature"); // unchanged — the dup was ignored
  rmSync(dir, { recursive: true, force: true });
});
