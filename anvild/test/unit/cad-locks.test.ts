/**
 * [A2] The lock store (agent-cad-and-browser spec §4.1, §4.14 #42): what the owner approved, kept
 * outside the repo, hub-authoritative and synced fleet-wide.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCKS_APPROVE_PATH, LOCKS_PUSH_PATH, LockStore, LockSync, isNewer, repoKey, type FleetRole, type PartLock, type RulesLock } from "../../src/cadwork/locks";
import { cleanupTemp, tempDir, tempRepo } from "../helpers/cad-work";

afterEach(() => cleanupTemp());

const REPO = "git@example.com:me/widgets";
const lock = (part: string, at: string, more: Partial<PartLock> = {}): PartLock => ({
  repo: REPO,
  part,
  sha: `sha-${part}-${at}`,
  approvedBy: "owner",
  status: "dimensioned",
  values: { bbox: [6, 50, 80], volume: 23335.167, bodies: 1, holes: [{ diameter: 3.4, count: 4 }] },
  at,
  ...more,
});
const rules = (at: string, text = '{"schema":1,"processes":[]}'): RulesLock => ({ repo: REPO, sha: `rules-${at}`, text, at });
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

describe("cad lock store", () => {
  test("[A2] it keeps, per repo and part, the approved hash, who approved, the evaluated numbers and ownerParams; per repo the rules hash", () => {
    const state = tempDir();
    const store = new LockStore(state);
    expect(store.file).toBe(join(state, "cadwork", "locks.json"));
    expect(store.getPart(REPO, "plate")).toBeUndefined();
    const l = lock("plate", "2026-11-19T10:00:00.000Z", { approvedBy: "agent-initial", ownerParams: { L: 80 } });
    store.putPart(l);
    store.putRules(rules("2026-11-19T10:00:00.000Z"));
    // A second store on the same state dir (a daemon restart) reads it back exactly.
    const again = new LockStore(state);
    expect(again.getPart(REPO, "plate")).toEqual(l);
    expect(again.getPart(REPO, "plate")!.values!.volume).toBe(23335.167);
    expect(again.getPart(REPO, "plate")!.approvedBy).toBe("agent-initial");
    expect(again.getPart(REPO, "plate")!.ownerParams).toEqual({ L: 80 });
    expect(again.getPart("another-repo", "plate")).toBeUndefined(); // keyed by repo AND part
    expect(again.getRules(REPO)!.sha).toBe("rules-2026-11-19T10:00:00.000Z");
    expect(JSON.parse(readFileSync(store.file, "utf8")).schema).toBe(1);
    expect((Bun.file(store.file) as any).size).toBeGreaterThan(0);
  });

  test("[A2] the repo key is the remote URL when there is one, else the main checkout's real path, shared by its worktrees", () => {
    const repo = tempRepo();
    expect(repoKey(repo)).toBe(repo); // no remote: the real path
    // A linked worktree of the same repo has the same key, so a session's worktree shares the approvals.
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const wt = join(tempDir(), "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "side");
    expect(repoKey(wt)).toBe(repo);
    // With a remote the key is its URL (trailing .git removed), whatever the path of the clone.
    git(repo, "remote", "add", "origin", "git@example.com:me/widgets.git");
    expect(repoKey(repo)).toBe("git@example.com:me/widgets");
    expect(repoKey(wt)).toBe("git@example.com:me/widgets");
    const other = tempRepo();
    git(other, "remote", "add", "upstream", "https://example.com/me/widgets/");
    expect(repoKey(other)).toBe("https://example.com/me/widgets"); // no origin: the first remote
  });

  test("[A2] a corrupt lock file is quarantined and the store starts empty (every part needs adopting again)", () => {
    const state = tempDir();
    mkdirSync(join(state, "cadwork"), { recursive: true });
    const file = join(state, "cadwork", "locks.json");
    for (const text of ["{ torn", JSON.stringify({ schema: 9, parts: [lock("plate", "2026-11-19T10:00:00.000Z")] }), "[]"]) {
      writeFileSync(file, text);
      const store = new LockStore(state);
      expect(store.snapshot()).toEqual({ parts: [], rules: [] });
      expect(store.quarantined).toBeString();
      expect(readFileSync(store.quarantined!, "utf8")).toBe(text); // kept for a person to look at
      expect(existsSync(file)).toBe(false);
    }
    expect(readdirSync(join(state, "cadwork")).filter((f) => f.startsWith("locks.json.corrupt-")).length).toBeGreaterThan(0);
    // The store still works afterwards.
    const store = new LockStore(state);
    store.putPart(lock("plate", "2026-11-19T10:00:00.000Z"));
    expect(new LockStore(state).getPart(REPO, "plate")).toBeDefined();
  });

  test("[A2] conflicts: the latest approval per (repo, part) wins by timestamp; a tie keeps the copy already held", () => {
    const store = new LockStore(tempDir());
    const older = lock("plate", "2026-11-19T10:00:00.000Z");
    const newer = lock("plate", "2026-11-19T11:00:00.000Z");
    expect(isNewer(newer, older)).toBe(true);
    expect(isNewer(older, newer)).toBe(false);
    expect(isNewer(older, { ...older })).toBe(false); // a tie does not replace
    expect(isNewer(older, undefined)).toBe(true);
    store.putPart(newer);
    expect(store.merge({ parts: [older], rules: [] })).toBe(0);
    expect(store.getPart(REPO, "plate")).toEqual(newer);
    const tie = { ...newer, sha: "someone-else" };
    expect(store.merge({ parts: [tie] })).toBe(0);
    expect(store.getPart(REPO, "plate")!.sha).toBe(newer.sha);
    const newest = lock("plate", "2026-11-19T12:00:00.000Z");
    expect(store.merge({ parts: [newest, lock("bracket", "2026-11-19T09:00:00.000Z")], rules: [rules("2026-11-19T09:00:00.000Z")] })).toBe(3);
    expect(store.getPart(REPO, "plate")).toEqual(newest);
    expect(store.getPart(REPO, "bracket")).toBeDefined(); // other parts are independent
    expect(store.merge({ rules: [rules("2026-11-19T08:00:00.000Z")] })).toBe(0);
    // Garbage entries are ignored rather than stored.
    expect(store.merge({ parts: [{ repo: REPO } as any, null as any], rules: [{} as any] })).toBe(0);
  });
});

/** A tiny in-memory fleet: each daemon is a LockSync, and `fetch` routes by URL to the right one. */
function fleet() {
  const down = new Set<string>();
  const daemons = new Map<string, LockSync>();
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    const origin = `http://${url.host}`;
    const target = daemons.get(origin);
    const body = JSON.parse(init.body);
    calls.push({ url: String(input), body });
    if (!target || down.has(origin)) throw new Error("ECONNREFUSED");
    if (init.headers["content-type"] !== "application/json") return new Response("application/json required", { status: 415 });
    if (url.pathname === LOCKS_APPROVE_PATH) return Response.json(target.acceptFromMember(body));
    if (url.pathname === LOCKS_PUSH_PATH) {
      target.acceptFromHub(body);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const add = (origin: string, role: (sync: LockSync) => FleetRole) => {
    const changes: number[] = [];
    const sync = new LockSync(new LockStore(tempDir()), { fetchImpl, timeoutMs: 500, onRemoteChange: () => void changes.push(1) });
    sync.setRole(() => role(sync));
    daemons.set(origin, sync);
    return { sync, store: sync.store, changes };
  };
  const HUB = "http://hub:7701";
  const hub = add(HUB, () => ({ kind: "hub", serverId: "srv_hub", selfUrl: async () => HUB, members: () => [{ serverId: "srv_m1", url: "http://m1:7701/" }, { serverId: "srv_m2", url: "http://m2:7701/" }] }));
  const m1 = add("http://m1:7701", () => ({ kind: "member", serverId: "srv_m1", hubServerId: "srv_hub" }));
  const m2 = add("http://m2:7701", () => ({ kind: "member", serverId: "srv_m2", hubServerId: "srv_hub" }));
  return { hub, m1, m2, down, calls, HUB };
}

describe("cad lock store hub sync", () => {
  test("[A2] a standalone daemon just uses the local file: nothing is sent anywhere", async () => {
    const sent: unknown[] = [];
    const sync = new LockSync(new LockStore(tempDir()), { fetchImpl: (async (...a: unknown[]) => void sent.push(a)) as any });
    sync.approvePart(lock("plate", "2026-11-19T10:00:00.000Z"));
    sync.approveRules(rules("2026-11-19T10:00:00.000Z"));
    await sync.settled();
    expect(sent).toEqual([]);
    expect(sync.store.getPart(REPO, "plate")).toBeDefined();
    expect(sync.store.pending()).toEqual([]);
    expect(await sync.broadcast()).toEqual([]);
  });

  test("[A2] an approval on the hub is stored there and broadcast to every member, with the hub's address", async () => {
    const f = fleet();
    f.hub.sync.approvePart(lock("plate", "2026-11-19T10:00:00.000Z"));
    await f.hub.sync.settled();
    for (const m of [f.m1, f.m2]) {
      expect(m.store.getPart(REPO, "plate")!.machine).toBe("srv_hub");
      expect(m.store.hub()).toEqual({ serverId: "srv_hub", url: f.HUB });
      expect(m.changes.length).toBeGreaterThan(0); // open parts are re-checked on arrival
    }
    expect(f.calls.every((c) => c.url.endsWith(LOCKS_PUSH_PATH))).toBe(true);
  });

  test("[A2] an approval on a member is applied locally, sent to the hub, and reaches the other members", async () => {
    const f = fleet();
    await f.hub.sync.broadcast(); // members learn the hub's address
    f.m1.sync.approvePart(lock("plate", "2026-11-19T10:00:00.000Z"));
    expect(f.m1.store.getPart(REPO, "plate")).toBeDefined(); // at once, before any network call
    f.m1.sync.approveRules(rules("2026-11-19T10:00:00.000Z"));
    await f.m1.sync.settled();
    await f.hub.sync.settled();
    expect(f.m1.store.pending()).toEqual([]);
    expect(f.hub.store.getPart(REPO, "plate")!.machine).toBe("srv_m1");
    expect(f.hub.store.getRules(REPO)!.sha).toBe("rules-2026-11-19T10:00:00.000Z");
    // The part approved on machine 1 is known on machine 2 with no action there.
    expect(f.m2.store.getPart(REPO, "plate")).toEqual(f.m1.store.getPart(REPO, "plate"));
    expect(f.m2.store.getRules(REPO)).toEqual(f.hub.store.getRules(REPO));
  });

  test("[A2] a member that cannot reach the hub applies locally, queues (durably), and delivers later", async () => {
    const f = fleet();
    await f.hub.sync.broadcast();
    f.down.add(f.HUB);
    f.m1.sync.approvePart(lock("plate", "2026-11-19T10:00:00.000Z"));
    await f.m1.sync.settled();
    expect(f.m1.store.getPart(REPO, "plate")).toBeDefined(); // usable offline
    expect(f.m1.store.pending()).toHaveLength(1);
    expect(f.hub.store.getPart(REPO, "plate")).toBeUndefined();
    // The queue survives a daemon restart.
    const restarted = new LockStore(join(f.m1.store.file, "..", ".."));
    expect(restarted.pending()).toHaveLength(1);
    expect(restarted.hub()).toEqual({ serverId: "srv_hub", url: f.HUB });
    // Still down: a retry changes nothing and loses nothing.
    expect(await f.m1.sync.flush()).toEqual({ delivered: 0, queued: 1 });
    f.down.delete(f.HUB);
    await f.m1.sync.retry();
    await f.hub.sync.settled();
    expect(f.m1.store.pending()).toEqual([]);
    expect(f.hub.store.getPart(REPO, "plate")!.machine).toBe("srv_m1");
    expect(f.m2.store.getPart(REPO, "plate")).toBeDefined();
  });

  test("[A2] a member that has never heard from the hub queues, and delivers when the hub's first push arrives", async () => {
    const f = fleet();
    f.m1.sync.approvePart(lock("plate", "2026-11-19T10:00:00.000Z"));
    await f.m1.sync.settled();
    expect(f.m1.store.pending()).toHaveLength(1); // no address for the hub yet
    expect(f.calls).toEqual([]);
    await f.hub.sync.broadcast();
    await f.m1.sync.settled();
    await f.hub.sync.settled();
    expect(f.m1.store.pending()).toEqual([]);
    expect(f.m1.store.getPart(REPO, "plate")).toBeDefined(); // the hub's (empty) store did not erase the queued approval
    expect(f.hub.store.getPart(REPO, "plate")).toBeDefined();
  });

  test("[A2] conflict between machines: the later approval wins fleet-wide, whichever arrives last", async () => {
    const f = fleet();
    await f.hub.sync.broadcast();
    f.down.add(f.HUB);
    // Offline, machine 1 approves at 10:00; meanwhile machine 2 (also offline) approves at 11:00.
    f.m1.sync.approvePart(lock("plate", "2026-11-19T10:00:00.000Z", { sha: "from-m1" }));
    f.m2.sync.approvePart(lock("plate", "2026-11-19T11:00:00.000Z", { sha: "from-m2" }));
    await Promise.all([f.m1.sync.settled(), f.m2.sync.settled()]);
    f.down.delete(f.HUB);
    // The LATER one is delivered first, the earlier one second: the earlier must not overwrite it.
    await f.m2.sync.flush();
    await f.m1.sync.flush();
    await f.hub.sync.settled();
    for (const d of [f.hub, f.m1, f.m2]) expect(d.store.getPart(REPO, "plate")!.sha).toBe("from-m2");
    expect(f.m1.store.pending()).toEqual([]);
    // A member's stale copy never beats the hub: the hub's push replaces it.
    f.m1.store.putPart(lock("bracket", "2026-11-19T09:00:00.000Z"));
    await f.hub.sync.broadcast();
    expect(f.m1.store.getPart(REPO, "bracket")).toBeUndefined();
  });

  test("[A2] a member only takes a push from the hub it is paired with as its address book, and a hub notes members it missed", async () => {
    const f = fleet();
    f.down.add("http://m2:7701");
    const results = await f.hub.sync.broadcast();
    expect(results.find((r) => r.serverId === "srv_m1")!.ok).toBe(true);
    expect(results.find((r) => r.serverId === "srv_m2")!.ok).toBe(false);
    expect([...f.hub.sync.unreached]).toEqual(["srv_m2"]);
    f.down.delete("http://m2:7701");
    f.hub.store.putPart(lock("plate", "2026-11-19T10:00:00.000Z"));
    await f.hub.sync.retry();
    expect([...f.hub.sync.unreached]).toEqual([]);
    expect(f.m2.store.getPart(REPO, "plate")).toBeDefined();
    // A queued approval is not sent to an address learned from a different hub.
    f.m1.store.setHub({ serverId: "srv_other", url: "http://evil:7701" });
    f.m1.sync.approvePart(lock("gear", "2026-11-19T10:00:00.000Z"));
    await f.m1.sync.settled();
    expect(f.calls.some((c) => c.url.startsWith("http://evil"))).toBe(false);
    expect(f.m1.store.pending()).toHaveLength(1);
  });

  test("[A2] review 8: pairing does not wipe earlier local approvals — on first contact with a hub a member uploads what it approved before, merged by time", async () => {
    const f = fleet();
    // m1 worked standalone before it was paired: two parts and the rules approved, nothing queued.
    const mine = lock("plate", "2026-11-19T10:00:00.000Z", { machine: "srv_m1" });
    const older = lock("gear", "2026-11-19T08:00:00.000Z", { machine: "srv_m1" });
    f.m1.store.putPart(mine);
    f.m1.store.putPart(older);
    f.m1.store.putRules(rules("2026-11-19T10:00:00.000Z"));
    expect(f.m1.store.pending()).toEqual([]);
    expect(f.m1.store.hub()).toBeUndefined();
    // The hub already holds a NEWER approval of `gear`, and its own part.
    const hubGear = lock("gear", "2026-11-19T09:00:00.000Z", { machine: "srv_hub" });
    f.hub.store.putPart(hubGear);
    f.hub.store.putPart(lock("bracket", "2026-11-19T09:00:00.000Z"));

    await f.hub.sync.broadcast(); // the first push the member ever gets
    await f.m1.sync.settled();
    await f.hub.sync.settled();
    await f.m1.sync.settled();
    // Nothing the member had approved was lost…
    expect(f.m1.store.getPart(REPO, "plate")).toEqual(mine);
    expect(f.m1.store.getRules(REPO)).toBeDefined();
    // …it reached the hub (and through it the rest of the fleet)…
    expect(f.hub.store.getPart(REPO, "plate")).toEqual(mine);
    expect(f.hub.store.getRules(REPO)!.sha).toBe("rules-2026-11-19T10:00:00.000Z");
    expect(f.m2.store.getPart(REPO, "plate")).toEqual(mine);
    // …and the conflict rule held: the hub's later approval of `gear` won, on both sides.
    expect(f.hub.store.getPart(REPO, "gear")).toEqual(hubGear);
    expect(f.m1.store.getPart(REPO, "gear")).toEqual(hubGear);
    expect(f.m1.store.getPart(REPO, "bracket")).toBeDefined();
    expect(f.m1.store.pending()).toEqual([]);
    expect(f.calls.some((c) => c.url.endsWith(LOCKS_APPROVE_PATH) && c.body.serverId === "srv_m1" && c.body.parts.length === 2 && c.body.rules.length === 1)).toBe(true);
    // A later push from the same hub is not "first contact": nothing is uploaded again.
    const approves = f.calls.filter((c) => c.url.endsWith(LOCKS_APPROVE_PATH)).length;
    await f.hub.sync.broadcast();
    await f.m1.sync.settled();
    expect(f.calls.filter((c) => c.url.endsWith(LOCKS_APPROVE_PATH)).length).toBe(approves);
    // While the hub cannot be reached for the upload, the approvals stay queued and stay in force.
    const g = fleet();
    g.m1.store.putPart(mine);
    g.down.add(g.HUB);
    g.m1.sync.acceptFromHub({ hubServerId: "srv_hub", hubUrl: g.HUB, parts: [], rules: [] });
    await g.m1.sync.settled();
    expect(g.m1.store.getPart(REPO, "plate")).toEqual(mine);
    expect(g.m1.store.pending()).toHaveLength(1);
  });

  test("[A2] review 5: an approval is found under any identity of its repo — the remote anywhere, the path only on the machine that made it", () => {
    const store = new LockStore(tempDir());
    const repo = tempRepo();
    const byPath = lock("plate", "2026-11-19T10:00:00.000Z", { repo, path: repo, machine: "srv_a" });
    store.putPart(byPath);
    store.putRules({ ...rules("2026-11-19T10:00:00.000Z"), repo, path: repo, machine: "srv_a" });
    const withRemote = { key: "git@example.com:me/new", remote: "git@example.com:me/new", path: repo };
    expect(store.getPart(withRemote.key, "plate")).toBeUndefined(); // the exact-key lookup would have lost it
    expect(store.findPart(withRemote, "plate", "srv_a")).toEqual(byPath);
    expect(store.findRules(withRemote, "srv_a")).toBeDefined();
    expect(store.findPart(withRemote, "plate", "srv_b")).toBeUndefined(); // same path on another machine is another folder
    expect(store.findPart(withRemote, "gear", "srv_a")).toBeUndefined();
    // Stored under a remote and looked up after the remote was removed (path identity, same machine).
    const byRemote = lock("gear", "2026-11-19T10:00:00.000Z", { repo: "git@example.com:me/new", remote: "git@example.com:me/new", path: repo, machine: "srv_a" });
    store.putPart(byRemote);
    expect(store.findPart({ key: repo, path: repo }, "gear", "srv_a")).toEqual(byRemote);
    // Stored under a remote: found from any clone of it, on any machine.
    expect(store.findPart({ key: "git@example.com:me/new", remote: "git@example.com:me/new", path: "/somewhere/else" }, "gear", "srv_z")).toEqual(byRemote);
    // The newest of several matching entries wins.
    const later = lock("plate", "2026-11-19T12:00:00.000Z", { repo: withRemote.key, remote: withRemote.remote, path: repo, machine: "srv_a" });
    store.putPart(later);
    expect(store.findPart(withRemote, "plate", "srv_a")).toEqual(later);
  });
});
