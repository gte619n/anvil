/**
 * [A3] Functional scenario for Phase A3 (agent-cad-and-browser spec §5 "Phase A3", §8.2): live preview
 * and the parameters panel on the daemon side. Real Supervisor / service / manager / refresh / lock
 * store, real WebSocket clients against a real server where the bullet is about clients; SolidCraft
 * is the fake, resolved through `ANVIL_SOLIDCRAFT_CLI` as production resolves a binary. One test per
 * Acceptance bullet in the spec's order (the sixth, the viewer, is test/golden/live.pw.ts), then §7's
 * Phase A3 rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { cadTools } from "../../src/agent/cad-tools";
import { AccountStore } from "../../src/auth/accounts";
import { partRef } from "../../src/cadwork/partfolder";
import { evalExpr } from "../../src/cadwork/expr";
import { repoIdentity } from "../../src/cadwork/locks";
import { MOVED_WITHOUT_APPROVAL } from "../../src/cadwork/gate";
import { CadworkService } from "../../src/session/cadwork-service";
import { DISK_CONFLICT_REASON, readDesignFile } from "../../src/cadwork/poststep";
import { dispatch } from "../../src/server/dispatch";
import { createServer, type ServerHandle } from "../../src/server/http";
import { ConnectionRegistry } from "../../src/server/registry";
import { Supervisor } from "../../src/session/supervisor";
import { FakeClock, PLATE_VOLUME, RULES, buildPlate, callable, modelPlate, cleanupTemp, fakeCadSession, stopServices, tempRepo, until, writeRules } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";
import { readGlb } from "../golden/live-glb";

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["ANVIL_SOLIDCRAFT_CLI", "ANVIL_CAD_MAX_PROCS", "CLAUDE_CODE_OAUTH_TOKEN"]) saved[k] = process.env[k];
  process.env.ANVIL_SOLIDCRAFT_CLI = FAKE_SOLIDCRAFT;
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "sk-ant-oat-test-placeholder"; // a server will not boot without a credential; no turn is run
  delete process.env.ANVIL_CAD_MAX_PROCS;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const supervisors: Supervisor[] = [];
const servers: ServerHandle[] = [];
const sockets: WebSocket[] = [];
const stateDirs: string[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await stopServices();
  for (const s of supervisors.splice(0)) await s.shutdown().catch(() => undefined);
  for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanupTemp();
});

const fake = { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" as const }) };
const text = (p: string) => readFileSync(p, "utf8");
const designJson = (repo: string) => join(repo, "cad", "plate", "design.json");
const partJson = (repo: string) => join(repo, "cad", "plate", "part.json");
const designsOf = (events: any[], part = "plate") => events.filter((e) => e.type === "cad.design" && e.part === part);
const volumeOf = (ev: any): number => ev.gate.checks.find((c: any) => c.id === "volume").measured;
/** The expression design.json holds for a parameter (the script export folds later changes into its definition). */
const scripted = (repo: string, name: string): string => {
  const cmds: any[] = JSON.parse(text(designJson(repo))).commands;
  let expr: unknown;
  for (const c of cmds) {
    if (c.command === "parameters.add" && c.params?.name === name) expr = c.params.expression ?? c.params.value;
    if (c.command === "parameters.change" && c.params?.changes?.[name] !== undefined) expr = c.params.changes[name];
    if (c.command === "parameters.change" && c.params?.name === name) expr = c.params.expression ?? c.params.value;
  }
  return String(expr);
};
const frame = (cmd: Record<string, unknown>) => JSON.stringify({ v: PROTOCOL_VERSION, ts: "t", ...cmd });
const createCmd = (cwd: string) => ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd }) as any;
function tempState(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-cad-a3-state-")));
  stateDirs.push(dir);
  return dir;
}
function accountsIn(stateDir: string): AccountStore {
  const accounts = new AccountStore(stateDir);
  if (accounts.list().length === 0) accounts.add("test", "sk-ant-oat01-testtesttest-0000");
  return accounts;
}

/** A real Supervisor with cad-work on, a capturing `query` for every session driver, and a session
 *  on `repo` whose agent built the reference plate and whose owner adopted the rules: gate `pass`. */
async function plateOnSupervisor(repo: string) {
  const stateDir = tempState();
  const registry = new ConnectionRegistry();
  const broadcasts: any[] = [];
  const toAll = registry.toAll.bind(registry);
  registry.toAll = ((ev: any) => {
    broadcasts.push(ev);
    return toAll(ev);
  }) as typeof registry.toAll;
  const modelQueries: unknown[] = [];
  const sup = new Supervisor(
    {
      stateDir,
      accounts: accountsIn(stateDir),
      envFile: join(stateDir, "env"),
      features: ["cad-work"],
      sessionQueryFn: ((args: unknown) => {
        modelQueries.push(args); // any model query a session makes lands here
        throw new Error("no model query is expected in this test");
      }) as any,
    },
    registry,
  );
  supervisors.push(sup);
  const session = await sup.create(createCmd(repo));
  const tools = callable(cadTools(sup.cadwork.toolDeps(session.id, repo)) as any);
  await buildReferencePlate(repo, tools, () => {
    const done = new Set(broadcasts.filter((e) => e.type === "cad.expectations.resolved").map((e) => e.requestId));
    for (const c of broadcasts.filter((e) => e.type === "cad.expectations.request" && !done.has(e.requestId))) sup.respondCadExpectations(c.requestId, true);
  });
  const sent: any[] = [];
  const conn = { id: "conn_test", attached: new Set<string>() };
  const send = (cmd: Record<string, unknown>) => dispatch(conn, frame(cmd), (ev) => void sent.push(ev), { supervisor: sup, registry, push: undefined as any });
  return { sup, session, tools, broadcasts, modelQueries, sent, send, ref: partRef(repo, "plate") };
}
async function buildReferencePlate(repo: string, tools: ReturnType<typeof callable>, approve: () => void) {
  writeRules(repo, RULES);
  await modelPlate(tools);
  const first = await tools.check_part!({ part: "plate" });
  if (first.isError) throw new Error(first.text);
  approve();
  expect((await tools.check_part!({ part: "plate" })).json.state).toBe("pass");
}

describe("Phase A3 acceptance", () => {
  test("[A3] acceptance 1: ten mutating calls in 200 ms produce ten script writes, at most two cad.design events, and the last event's rev matches the final state", async () => {
    const repo = tempRepo();
    const clock = new FakeClock(); // the burst takes 0 ms of manager time: well inside 200 ms, and deterministic
    let renames = 0;
    const realFs = await import("node:fs");
    const x = fakeCadSession(repo, {
      ...fake,
      manager: {
        clock,
        poststepFs: {
          writeFile: (p, t) => realFs.writeFileSync(p, t),
          rename: (from, to) => {
            if (to.endsWith("/design.json")) renames++;
            realFs.renameSync(from, to);
          },
        },
      },
    });
    const ref = partRef(repo, "plate");
    await x.tools.open_part!({ part: "plate" });
    expect((await x.tools.execute!({ command: "parameters.add", params: { name: "L", expression: "80 mm" } })).isError).toBe(false);
    await x.tools.check_part!({ part: "plate" });
    await until(() => !x.manager.status(ref)!.busy, "idle");
    clock.advance(10_000); // a quiet spell: the burst starts with the debounce window open

    const changed: string[] = [];
    x.manager.subscribe((e) => {
      if (e.type === "changed") changed.push(e.scriptSha!);
    });
    const before = { events: designsOf(x.broadcasts).length, renames, rev: x.design("plate").rev };
    // Ten mutating calls, all issued at once (the agent's tools, the same queue the panel uses).
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => x.tools.execute!({ command: "solid.box", params: { length: 10 + i, width: 10, height: 10, name: `B${i}` } })));
    expect(replies.every((r) => !r.isError)).toBe(true);
    await until(() => !x.manager.status(ref)!.busy, "the queue to drain");

    // Ten script writes: one atomic rename onto design.json per call, each a different script.
    expect(renames - before.renames).toBe(10);
    expect(changed).toHaveLength(10);
    expect(new Set(changed).size).toBe(10);
    // At most two cad.design events for the whole burst — counting every one, busy-only ones included.
    const events = designsOf(x.broadcasts).slice(before.events);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(2);
    // The last one is the final state: its rev is the service's, it was taken of the final script,
    // it shows all ten bodies, and its preview is the file of that rev.
    const last = events.at(-1)!;
    const snap = x.service.snapshot(ref)!;
    expect(last.rev).toBe(snap.rev);
    expect(last.rev).toBe(before.rev + events.length);
    expect(snap.outcome.scriptSha).toBe(changed.at(-1));
    expect(readDesignFile(ref.dir).scriptSha).toBe(changed.at(-1));
    expect(snap.outcome.measurement!.bodies).toBe(10);
    expect(last.busy).toBe(false);
    expect(last.preview).toBe(`cad/plate/.cache/preview-${last.rev}.glb`);
    expect(readGlb(readFileSync(join(repo, last.preview))).meshes).toBe(10);
    expect(x.manager.status(ref)!.refreshPending).toBe(false);
  });

  test('[A3] acceptance 2: cad.param.set L=120 with no session turn running gives one cad.design with by:"panel", the new volume, design.json containing the new expression, and zero model queries', async () => {
    const repo = tempRepo();
    const x = await plateOnSupervisor(repo);
    await until(() => !x.sup.cadwork.manager.status(x.ref)!.busy, "idle");
    expect(volumeOf(designsOf(x.broadcasts).at(-1))).toBeCloseTo(23335.167, 2);
    expect(scripted(repo, "L")).toBe("80 mm");
    expect(x.session.data.status).toBe("idle"); // no turn is running, and none was ever started
    const n = designsOf(x.broadcasts).length;

    x.send({ type: "cad.param.set", cid: "c1", cwd: repo, part: "plate", name: "L", expression: "120" });
    await until(() => x.sent.length === 1, "the reply");
    expect(x.sent[0]).toMatchObject({ type: "cad.param.set.result", cid: "c1", cwd: repo, part: "plate", name: "L", ok: true });
    expect(x.sent[0].error).toBeUndefined();
    await until(() => !x.sup.cadwork.manager.status(x.ref)!.busy, "the queue to drain");
    await new Promise((r) => setTimeout(r, 50));

    const after = designsOf(x.broadcasts).slice(n);
    expect(after).toHaveLength(1); // exactly one event
    expect(after[0].by).toBe("panel");
    expect(volumeOf(after[0])).toBeCloseTo(35335.167, 2); // the new volume (§4.14 #11)
    expect(after[0].params.find((p: any) => p.name === "L")).toMatchObject({ value: 120 });
    expect(after[0].gate.state).toBe("pass"); // the owner's change re-derives the expected numbers
    expect(after[0].preview).toBe(`cad/plate/.cache/preview-${after[0].rev}.glb`);
    // design.json holds the new expression, as the last word on L.
    expect(scripted(repo, "L")).toContain("120");
    expect(scripted(repo, "L")).not.toContain("80");
    // No model was asked: the capturing query was never called, no driver exists, no turn ran.
    expect(x.modelQueries).toEqual([]);
    expect((x.sup as any).drivers.size).toBe(0);
    expect(x.session.data.status).toBe("idle");
    expect(x.session.data.usage.turns).toBe(0);
  });

  test("[A3] acceptance 3: a bad expression returns the SolidCraft error and changes neither file", async () => {
    const repo = tempRepo();
    const x = await plateOnSupervisor(repo);
    await until(() => !x.sup.cadwork.manager.status(x.ref)!.busy, "idle");
    const before = { design: text(designJson(repo)), part: text(partJson(repo)), events: designsOf(x.broadcasts).length };
    // What SolidCraft itself answers to the same change, asked directly.
    const direct = await x.sup.cadwork.manager.request(x.ref, { tool: "execute", args: { command: "parameters.change", params: { changes: { L: "80 +* mm(" } } }, kind: "mutate" });
    expect(direct.result.isError).toBe(true);

    x.send({ type: "cad.param.set", cid: "bad", cwd: repo, part: "plate", name: "L", expression: "80 +* mm(" });
    await until(() => x.sent.length === 1, "the reply");
    expect(x.sent[0]).toMatchObject({ type: "cad.param.set.result", cid: "bad", ok: false });
    expect(x.sent[0].error).toBe(direct.result.text); // SolidCraft's own words
    expect(x.sent[0].error.length).toBeGreaterThan(5);
    // …and an unknown parameter is refused too, not silently created (§4.14 #6).
    x.send({ type: "cad.param.set", cid: "unknown", cwd: repo, part: "plate", name: "Zed", expression: "5" });
    await until(() => x.sent.length === 2, "the second reply");
    expect(x.sent[1]).toMatchObject({ ok: false });
    expect(x.sent[1].error).toContain("Zed");

    await until(() => !x.sup.cadwork.manager.status(x.ref)!.busy, "the queue to drain");
    expect(text(designJson(repo))).toBe(before.design);
    expect(text(partJson(repo))).toBe(before.part);
    expect(designsOf(x.broadcasts).slice(before.events).filter((e) => e.by === "panel")).toEqual([]);
    expect(x.sup.cadwork.manager.status(x.ref)!.params.find((p) => p.name === "L")!.value).toBe(80);
    expect(x.modelQueries).toEqual([]);
  });

  test('[A3] acceptance 4: a panel edit queued during an agent call runs after it, and the agent\'s following tool result contains "owner changed L"', async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT, deps: { manager: { extraEnv: { FAKE_SC_DELAY_MS: "40" } } } });
    const ref = partRef(repo, "plate");
    expect(x.gate.state).toBe("pass");
    await until(() => !x.manager.status(ref)!.busy, "idle");
    const written: string[] = [];
    x.manager.subscribe((e) => {
      if (e.type === "changed") written.push(`${scripted(repo, "W")} / ${scripted(repo, "L")}`);
    });

    const order: string[] = [];
    // The agent's call is in flight (the fake answers slowly)…
    const agentCall = x.tools.execute!({ command: "parameters.change", params: { changes: { W: "55" } } }).then((r) => (order.push("agent call returned"), r));
    await until(() => x.manager.status(ref)!.busy, "the agent's call to be running");
    // …when the owner edits L in the panel. It is queued behind the agent's call.
    const panel = x.service.setParam(repo, "plate", "L", "120").then((r) => (order.push("panel edit applied"), r));
    expect(x.manager.status(ref)!.queued).toBeGreaterThanOrEqual(1);

    const first = await agentCall;
    expect(first.isError).toBe(false);
    expect(first.text).not.toContain("owner changed"); // it had not happened yet when this call ran
    expect(await panel).toEqual({ ok: true });
    expect(order).toEqual(["agent call returned", "panel edit applied"]);
    // design.json has both, the agent's change first.
    // Two script writes, the agent's change first, then the owner's on top of it.
    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/^55\b.* \/ 80\b/);
    expect(written[1]).toMatch(/^55\b.* \/ 120\b/);

    // The agent's FOLLOWING tool result — any anvil_cad tool — carries the note, once.
    const next = await x.tools.inspect_design!({ measure: false, sketches: false, timeline: false, bodies: false });
    expect(next.isError).toBe(false);
    expect(next.text).toContain("owner changed L");
    expect(next.notes.join("\n")).toContain("owner changed L to 120");
    expect((await x.tools.measure!({ summary: true })).text).not.toContain("owner changed");
    expect(x.design("plate").by).toBe("panel");
  });

  test("[A3] acceptance 5: a change made to design.json on disk while a request is running is not overwritten: .cache/design.conflict.json exists and the part is fail with the conflict message", async () => {
    const repo = tempRepo();
    let edit: (() => void) | undefined;
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT, deps: { manager: { beforeScriptRename: () => edit?.() } } });
    const ref = partRef(repo, "plate");
    expect(x.gate.state).toBe("pass");
    const conflictFile = join(ref.dir, ".cache", "design.conflict.json");
    expect(existsSync(conflictFile)).toBe(false);

    // While the owner's parameter change is running, someone edits design.json (an editor, a checkout).
    const handEdited = text(designJson(repo)).replace(/\n$/, "") + "\n\n";
    edit = () => {
      edit = undefined;
      writeFileSync(designJson(repo), handEdited);
    };
    const r = await x.service.setParam(repo, "plate", "L", "120");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(DISK_CONFLICT_REASON);

    expect(text(designJson(repo))).toBe(handEdited); // NOT overwritten
    expect(existsSync(conflictFile)).toBe(true);
    expect(text(conflictFile)).toContain("120"); // what the request produced is kept beside it
    const state = x.manager.status(ref)!.state;
    expect(state).toMatchObject({ status: "fail", reason: DISK_CONFLICT_REASON, conflict: true });
    const ev = x.design("plate");
    expect(ev.gate.state).toBe("fail");
    expect(JSON.stringify(ev.gate)).toContain(DISK_CONFLICT_REASON);
    expect(x.service.takeOwnerNotes("sess_cad")).toEqual([]); // nothing was changed, so nothing to tell the agent

    // The same holds for the agent's own call, and it is told.
    await x.service.refreshDesign(repo, "plate");
    edit = () => {
      edit = undefined;
      writeFileSync(designJson(repo), handEdited + "\n");
    };
    const agent = await x.tools.execute!({ command: "parameters.change", params: { changes: { W: "60" } } });
    expect(agent.text).toContain(DISK_CONFLICT_REASON);
    expect(text(designJson(repo))).toBe(handEdited + "\n");
    expect(x.manager.status(ref)!.state.status).toBe("fail");

    // Rebuild (disk wins) clears it.
    await x.service.refreshDesign(repo, "plate");
    await until(() => !x.manager.status(ref)!.busy, "the rebuild");
    expect(x.manager.status(ref)!.state.conflict).toBe(false);
    expect(x.design("plate").by).toBe("reload");
    expect(x.design("plate").gate.state).toBe("pass");
    expect(x.manager.status(ref)!.params.find((p) => p.name === "L")!.value).toBe(80); // the disk's design, not the lost change
  });
});

describe("Phase A3 clients (§7, §4.8)", () => {
  interface Client {
    frames: any[];
    send: (cmd: Record<string, unknown>) => void;
  }
  async function daemon() {
    const stateDir = tempState();
    const handle = createServer({ host: "127.0.0.1", port: 0, stateDir, envFile: join(stateDir, "env"), accounts: accountsIn(stateDir), features: ["cad-work"], resolveIdentity: async () => ({ trust: "sameUser" as const }) });
    servers.push(handle);
    const url = `http://127.0.0.1:${handle.port}`;
    const client = async (): Promise<Client> => {
      const frames: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
      sockets.push(ws);
      ws.onmessage = (m) => void frames.push(JSON.parse(String(m.data)));
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws error"));
      });
      return { frames, send: (cmd) => ws.send(frame(cmd)) };
    };
    return { handle, url, sup: handle.supervisor, client, stateDir };
  }
  /** Wait until a socket has received the part's current state (frames trail the daemon by a tick). */
  const caughtUp = (d: Awaited<ReturnType<typeof daemon>>, c: Client, repo: string) =>
    until(() => designsOf(c.frames).at(-1)?.rev === d.sup.cadwork.snapshot(partRef(repo, "plate"))?.rev && designsOf(c.frames).at(-1)?.busy === false, "the socket to catch up");
  async function plateOn(d: Awaited<ReturnType<typeof daemon>>, repo: string, watcher: Client) {
    const session = await d.sup.create(createCmd(repo));
    const tools = callable(cadTools(d.sup.cadwork.toolDeps(session.id, repo)) as any);
    await buildReferencePlate(repo, tools, () => {
      /* approved below, once the card is on the socket */
    }).catch(() => undefined);
    await until(() => watcher.frames.some((e) => e.type === "cad.expectations.request"), "the adopt card");
    for (const c of watcher.frames.filter((e) => e.type === "cad.expectations.request")) d.sup.respondCadExpectations(c.requestId, true);
    expect((await tools.check_part!({ part: "plate" })).json.state).toBe("pass");
    await until(() => !d.sup.cadwork.manager.status(partRef(repo, "plate"))!.busy, "idle");
    await caughtUp(d, watcher, repo);
    return { session, tools, ref: partRef(repo, "plate") };
  }

  test("[A3] two clients send cad.param.set at once: queued in arrival order, two cad.design events", async () => {
    const d = await daemon();
    const [a, b] = [await d.client(), await d.client()];
    expect(a.frames[0]).toMatchObject({ type: "server.hello" });
    expect(a.frames[0].capabilities).toContain("cad-work");
    const repo = tempRepo();
    const x = await plateOn(d, repo, a);
    await caughtUp(d, b, repo);
    const start = d.sup.cadwork.snapshot(x.ref)!.rev;

    a.send({ type: "cad.param.set", cid: "a1", cwd: repo, part: "plate", name: "L", expression: "100" });
    b.send({ type: "cad.param.set", cid: "b1", cwd: repo, part: "plate", name: "L", expression: "120" });
    await until(() => a.frames.some((e) => e.cid === "a1") && b.frames.some((e) => e.cid === "b1"), "both replies");
    await until(() => !d.sup.cadwork.manager.status(x.ref)!.busy, "the queue to drain");
    await caughtUp(d, a, repo);
    await caughtUp(d, b, repo);
    // Each sender gets its own answer, and only its own.
    expect(a.frames.find((e) => e.cid === "a1")).toMatchObject({ type: "cad.param.set.result", ok: true, name: "L" });
    expect(b.frames.find((e) => e.cid === "b1")).toMatchObject({ type: "cad.param.set.result", ok: true, name: "L" });
    expect(a.frames.some((e) => e.cid === "b1")).toBe(false);
    // Two events, in the order the commands arrived, and both clients see the same two.
    for (const c of [a, b]) {
      const events = designsOf(c.frames).filter((e) => e.rev > start);
      expect(events.map((e) => [e.by, e.params.find((p: any) => p.name === "L").value])).toEqual([["panel", 100], ["panel", 120]]);
      expect(events[1].rev).toBe(events[0].rev + 1);
      expect(volumeOf(events[1])).toBeCloseTo(35335.167, 2);
    }
    // The script has both changes in that order, and ends at 120.
    expect(scripted(repo, "L")).toContain("120");
    expect(d.sup.cadwork.manager.status(x.ref)!.params.find((p) => p.name === "L")!.value).toBe(120);
  });

  test("[A3] an arbitrary cwd from a client is refused by every cad command and by the preview route", async () => {
    const d = await daemon();
    const c = await d.client();
    const repo = tempRepo();
    const x = await plateOn(d, repo, c);
    const stranger = tempRepo(); // a real repo with a real part folder the daemon was never told about
    const before = text(designJson(repo));
    c.send({ type: "cad.parts.list", cid: "l", cwd: stranger });
    c.send({ type: "cad.param.set", cid: "p", cwd: stranger, part: "plate", name: "L", expression: "1" });
    c.send({ type: "cad.design.refresh", cid: "r", cwd: stranger, part: "plate" });
    c.send({ type: "cad.param.set", cid: "p2", cwd: "/", part: "plate", name: "L", expression: "1" });
    c.send({ type: "cad.param.set", cid: "p3", cwd: join(repo, "cad"), part: "plate", name: "L", expression: "1" });
    await until(() => ["l", "p", "r", "p2", "p3"].every((id) => c.frames.some((e) => e.cid === id)), "the refusals");
    for (const id of ["l", "p", "r", "p2", "p3"]) {
      const f = c.frames.find((e) => e.cid === id);
      expect(f.type).toBe("command.error");
      expect(f.message).toContain("is not the worktree of a session or a registered environment");
    }
    expect(existsSync(join(stranger, "cad"))).toBe(false); // nothing was created there
    expect(text(designJson(repo))).toBe(before);
    expect(d.sup.cadwork.manager.status(x.ref)!.params.find((p) => p.name === "L")!.value).toBe(80);

    const ev = designsOf(c.frames).at(-1);
    const get = (cwd: string, path: string) => fetch(`${d.url}/api/cad/preview?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
    expect((await get(stranger, ev.preview)).status).toBe(403);
    expect((await get("/", ev.preview)).status).toBe(403);
    expect((await get(repo, "cad/plate/design.json")).status).toBe(404);
    expect((await get(repo, "cad/plate/part.json")).status).toBe(404);
    expect((await get(repo, "../../etc/passwd")).status).toBe(404);
  });

  test("[A3] the daemon serves the newest preview on the route the viewer uses; cad.parts.list and cad.design.refresh answer over the socket", async () => {
    const d = await daemon();
    const c = await d.client();
    const repo = tempRepo();
    const x = await plateOn(d, repo, c);
    const ev = designsOf(c.frames).at(-1);
    expect(ev.preview).toBe(`cad/plate/.cache/preview-${ev.rev}.glb`);
    // Exactly the URL web/src/cad-io.ts `makeCadPartIo` builds.
    const res = await fetch(`${d.url}/api/cad/preview?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(ev.preview)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    const glb = readGlb(new Uint8Array(await res.arrayBuffer()));
    expect(glb.meshes).toBe(1);
    expect(Math.round((glb.max[0]! - glb.min[0]!) * 1e6) / 1e6).toBe(0.08); // 80 mm, in metres

    // The list refreshes a part whose process is up (its state is of the design as it is now, never
    // of numbers stored in part.json), so it reports the revision after `ev`.
    c.send({ type: "cad.parts.list", cid: "list", cwd: repo });
    await until(() => c.frames.some((e) => e.cid === "list"), "the parts list");
    await caughtUp(d, c, repo);
    const listed = designsOf(c.frames).at(-1);
    expect(listed.rev).toBe(ev.rev + 1);
    expect(c.frames.find((e) => e.cid === "list")).toMatchObject({ type: "cad.parts.list.result", cwd: repo, parts: [{ part: "plate", hasDesign: true, live: true, rev: listed.rev, preview: listed.preview, gate: { state: "pass" } }] });

    // A socket that opens later is handed the part's current state, preview included.
    const late = await d.client();
    await until(() => designsOf(late.frames).length > 0, "the current design on connect");
    expect(designsOf(late.frames).at(-1)).toMatchObject({ rev: listed.rev, preview: listed.preview });

    // Rebuild: the part is restarted from design.json, and the event says so.
    const pid = d.sup.cadwork.manager.status(x.ref)!.pid;
    c.send({ type: "cad.design.refresh", cid: "rebuild", cwd: repo, part: "plate" });
    await until(() => c.frames.some((e) => e.cid === "rebuild"), "the ack");
    expect(c.frames.find((e) => e.cid === "rebuild").type).toBe("ack");
    const after = designsOf(c.frames).at(-1);
    expect(after.by).toBe("reload");
    expect(after.rev).toBe(listed.rev + 1);
    expect(after.gate.state).toBe("pass");
    expect(d.sup.cadwork.manager.status(x.ref)!.pid).not.toBe(pid);
    expect(existsSync(join(repo, after.preview))).toBe(true);
  });

  test("[A3] review: the preview route serves only what the daemon exported — a file written over a preview, or one it never exported, is 404 — with no-cache and the recorded sha as ETag, across a restart", async () => {
    const d = await daemon();
    const c = await d.client();
    const repo = tempRepo();
    await plateOn(d, repo, c);
    const ev = designsOf(c.frames).at(-1);
    const url = (p: string) => `${d.url}/api/cad/preview?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(p)}`;
    const ok = await fetch(url(ev.preview));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-cache"); // revs restart after a cache wipe: a name is not a version
    const etag = ok.headers.get("etag")!;
    const sha = createHash("sha256").update(readFileSync(join(repo, ev.preview))).digest("hex");
    expect(etag).toBe(`"${sha}"`);
    expect((await fetch(url(ev.preview), { headers: { "if-none-match": etag } })).status).toBe(304);
    // What a restarted daemon knows: the record is persisted under the state dir.
    const again = new CadworkService({ enabled: false, getSession: () => undefined, stateDir: d.stateDir });
    expect(again.previewEntry(repo, ev.preview)).toEqual({ abs: join(repo, ev.preview), sha });
    // A preview the daemon never exported (a hand-made file of a valid name) is not served…
    writeFileSync(join(repo, "cad", "plate", ".cache", "preview-999.glb"), readFileSync(join(repo, ev.preview)));
    expect((await fetch(url("cad/plate/.cache/preview-999.glb"))).status).toBe(404);
    // …and neither is an exported one whose bytes were replaced (the model on screen cannot be swapped).
    writeFileSync(join(repo, ev.preview), Buffer.from("glTF not really"));
    expect((await fetch(url(ev.preview))).status).toBe(404);
    expect(again.previewEntry(repo, ev.preview)).toBeUndefined();
  });

  test("[A3] review: the CAD routes send no permissive CORS and refuse a foreign browser Origin with 403 (the WebSocket's origin gate); other routes are unchanged", async () => {
    const d = await daemon();
    const c = await d.client();
    const repo = tempRepo();
    await plateOn(d, repo, c);
    const ev = designsOf(c.frames).at(-1);
    const url = `${d.url}/api/cad/preview?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(ev.preview)}`;
    const foreign = await fetch(url, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(url, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(pre.status).toBe(403);
    // Same origin (the PWA) and no Origin at all (native clients) are served — still with no `*`.
    for (const headers of [{ origin: d.url }, {}] as Record<string, string>[]) {
      const r = await fetch(url, { headers });
      expect(r.status).toBe(200);
      // Never `*`: an allowed Origin is named back exactly (a fleet peer's page can read it), none → none.
      expect(r.headers.get("access-control-allow-origin")).toBe(headers.origin ?? null);
    }
    // Not a CAD route: the bundled native clients' permissive CORS is untouched.
    const health = await fetch(`${d.url}/api/health`, { headers: { origin: "https://evil.example" } });
    expect(health.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("Phase A3 review: owner edits", () => {
  test("[A3] review: the agent changes L, the owner then edits T in the panel — the gate still fails on L naming its old and new values, and the accepted numbers move for T only", async () => {
    const repo = tempRepo();
    const x = await buildPlate(repo, { cli: FAKE_SOLIDCRAFT });
    expect(x.gate.state).toBe("pass");
    const ref = partRef(repo, "plate");
    expect((await x.tools.set_parameter!({ name: "L", expression: "120" })).isError).toBe(false); // the agent, unapproved
    let g = await x.check();
    expect(g.state).toBe("fail");
    expect(g.failing.join("\n")).toContain(MOVED_WITHOUT_APPROVAL);
    const owner = await x.service.setParamAsOwner(ref, "T", "6.5"); // the owner, an unrelated parameter
    expect(owner.ok).toBe(true);
    g = await x.check();
    expect(g.state).toBe("fail");
    const moved = g.failing.find((l: string) => l.startsWith("accepted:"))!;
    expect(moved).toContain(MOVED_WITHOUT_APPROVAL);
    expect(moved).toContain("bbox[2] 80 → 120");
    expect(moved).toContain("L 80 → 120");
    expect(moved).not.toContain("T ");
    // The accepted numbers: T's change only. L is still the 80 that was accepted.
    const lock = x.service.locks.findPart(repoIdentity(repo), "plate")!;
    expect(lock.values!.bbox).toEqual([6.5, 50, 80]);
    expect(lock.values!.volume).toBeCloseTo(evalExpr(PLATE_VOLUME, { L: 80, W: 50, T: 6.5 }), 6);
    expect(lock.declared).toEqual({ L: 80, W: 50, T: 6.5 });
    expect(lock.approvedBy).toBe("agent-initial"); // a panel edit is not a confirmation of the agent's numbers
    // The owner then sets L back to what was accepted: everything agrees again.
    expect((await x.service.setParamAsOwner(ref, "L", "80")).ok).toBe(true);
    expect((await x.check()).state).toBe("pass");
  });
});
