import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerEvent } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { SessionStore } from "../../src/session/store";
import { Session } from "../../src/session/session";
import { ConnectionRegistry } from "../../src/server/registry";

const tempState = () => mkdtempSync(join(tmpdir(), "anvil-restart-"));
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "anvil-repo-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "f.txt"), "x");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}
const freshCmd = (repo: string, title: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "fresh-worktree", repoRoot: repo, base: "HEAD", title } as const);

// ── store ────────────────────────────────────────────────────────────────────
test("store: saveAll is atomic (no leftover temp) and round-trips", () => {
  const dir = tempState();
  const store = new SessionStore(dir);
  store.saveAll([{ data: { id: "sess_x" } as never, lastSeq: 3 }]);
  expect(store.loadAll().length).toBe(1);
  expect(existsSync(join(dir, "sessions.json"))).toBe(true);
  expect(existsSync(join(dir, "sessions.json.tmp"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("store: a corrupt sessions.json is backed up, not silently wiped", () => {
  const dir = tempState();
  const store = new SessionStore(dir);
  writeFileSync(join(dir, "sessions.json"), "{ this is not json");
  expect(store.loadAll()).toEqual([]); // daemon can still start
  const backups = readdirSync(dir).filter((f) => f.startsWith("sessions.json.corrupt-"));
  expect(backups.length).toBe(1); // bad file preserved for forensics
  expect(readFileSync(join(dir, backups[0]!), "utf8")).toContain("not json");
  rmSync(dir, { recursive: true, force: true });
});

// ── restore resilience ────────────────────────────────────────────────────────
test("restore: a malformed session entry is quarantined; the good one still loads", () => {
  const dir = tempState();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const good = sup1.create({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd: dir });

  // inject a poison row that throws when wrapped (data.id is read first)
  const raw = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as { sessions: unknown[] };
  raw.sessions.push({ data: null, lastSeq: 0 });
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(raw));

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry()); // must NOT throw
  expect(sup2.get(good.id)).toBeDefined();
  // Only the good session loads (poison row quarantined); the default concierge chat is always
  // present, so count the non-default sessions.
  expect(sup2.list().filter((s) => !s.isDefault).length).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("restore: a fresh-worktree session whose worktree vanished is recovered", () => {
  const dir = tempState();
  const repo = makeRepo();
  const sup1 = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup1.create(freshCmd(repo, "Recover Me"));
  const cwd = s.data.cwd;
  expect(existsSync(cwd)).toBe(true);

  rmSync(cwd, { recursive: true, force: true }); // simulate the worktree being deleted out from under it
  expect(existsSync(cwd)).toBe(false);

  const sup2 = new Supervisor({ stateDir: dir }, new ConnectionRegistry()); // restore recovers it
  expect(sup2.get(s.id)).toBeDefined();
  expect(existsSync(cwd)).toBe(true); // worktree re-established from the branch
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// ── reset ──────────────────────────────────────────────────────────────────────
test("reset: recovers a missing worktree and clears a frozen status", async () => {
  const dir = tempState();
  const repo = makeRepo();
  const sup = new Supervisor({ stateDir: dir }, new ConnectionRegistry());
  const s = sup.create(freshCmd(repo, "Stuck"));
  const cwd = s.data.cwd;

  rmSync(cwd, { recursive: true, force: true });
  s.data.status = "thinking"; // wedged: spinning with no live driver

  await sup.reset(s.id);
  expect(existsSync(cwd)).toBe(true);
  expect(sup.get(s.id)!.data.status).toBe("idle"); // re-read so TS doesn't narrow to the set literal
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// ── disposal guard ───────────────────────────────────────────────────────────
test("session: emit is a no-op after dispose (late-draining turn can't write to a dead session)", () => {
  const sink: ServerEvent[] = [];
  const s = new Session(
    { id: "sess_d" } as never,
    0,
    (_id, e) => sink.push(e),
    () => {},
    () => {},
  );
  s.emit({ type: "status", status: "thinking" });
  expect(sink.length).toBe(1);
  s.dispose();
  s.emit({ type: "status", status: "idle" }); // dropped
  expect(sink.length).toBe(1);
  expect(s.isDisposed).toBe(true);
});
