/**
 * [A1] The CAD process manager (agent-cad-and-browser spec §4.2, §4.3, §4.14 #1 #5 #18; §7 rows
 * tagged A1). Real manager, the fake SolidCraft as its binary, a fake clock where time matters.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BATCH_TIMEOUT_MS,
  CadError,
  CadManager,
  DEFAULT_MAX_PROCS,
  IDLE_EXIT_MS,
  OLDER_SOLIDCRAFT,
  REFUSED_DESIGN,
  REQUEST_TIMEOUT_MS,
  UNREPLAYABLE_FILE,
  WAITING_FOR_SLOT,
  maxProcsFromEnv,
  type CadManagerEvent,
} from "../../src/cadwork/manager";
import { BadPartName, UnsafePartFolder, CAD_EXCLUDE_LINES, PART_NAME_RE, ensureCadExcludes, gitToplevel, isValidPartName, listParts, partRef, type PartRef } from "../../src/cadwork/partfolder";
import { DISK_CONFLICT_REASON, designFileText, scriptSha } from "../../src/cadwork/poststep";
import { BOX, FakeClock, cleanupTemp, fakeManager, readDesignPlain, recordingSpawn, stopManagers, tempDir, tempRepo, until, writeDesign } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT, REFERENCE_PLATE } from "../helpers/fake-solidcraft";

afterEach(async () => {
  await stopManagers();
  cleanupTemp();
});

const exec = (m: CadManager, ref: PartRef, command: string, params: Record<string, unknown> = {}) =>
  m.request(ref, { tool: "execute", args: { command, params }, kind: "mutate" });
const box = (m: CadManager, ref: PartRef, name = "Box", size = 10) => exec(m, ref, "solid.box", BOX(name, size).params);
const measure = async (m: CadManager, ref: PartRef) => (await m.request(ref, { tool: "measure", args: { summary: true }, kind: "read" })).result.json;
const volume = async (m: CadManager, ref: PartRef) => (await measure(m, ref)).total.volume_mm3 as number;
/** design.json with its fake `timeline.add` steps shown as the commands they stand for. */
const design = (ref: PartRef) => readDesignPlain(join(ref.dir, "design.json"));
const designBytes = (ref: PartRef) => readFileSync(join(ref.dir, "design.json"), "utf8");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("part folders", () => {
  test("[A1] a part name is a name, never a path", () => {
    expect(PART_NAME_RE.source).toBe("^[a-z0-9][a-z0-9-]{0,39}$");
    for (const good of ["plate", "motor-mount", "a", "0", "x".repeat(40), "m3-bracket-v2"]) expect(isValidPartName(good)).toBe(true);
    for (const bad of ["../x", "a/b", "/abs", ".", "..", "", "-lead", "Plate", "x".repeat(41), "a b", "a.b", "a_b", "plate\n", 7, null, undefined]) {
      expect(isValidPartName(bad)).toBe(false);
    }
    const repo = tempRepo();
    expect(() => partRef(repo, "../x")).toThrow(BadPartName);
    expect(() => partRef(repo, "../x")).toThrow("not a path");
  });

  test("[A1] the key is realpath(worktree)/cad/<part>, whatever path the worktree was reached by", () => {
    const repo = tempRepo();
    const ref = partRef(repo, "plate");
    expect(ref.key).toBe(`${repo}/cad/plate`);
    expect(ref.dir).toBe(ref.key);
    const link = join(tempDir(), "link");
    symlinkSync(repo, link);
    expect(partRef(link, "plate").key).toBe(ref.key);
    expect(partRef(repo, "other").key).not.toBe(ref.key);
    // Two worktrees of one repo are two keys (two processes).
    expect(partRef(tempRepo(), "plate").key).not.toBe(ref.key);
  });

  test("[A1] generated folders are excluded through .git/info/exclude, never .gitignore", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    await m.open(ref);
    await box(m, ref);
    const excludePath = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--git-path", "info/exclude"]).stdout.toString().trim();
    const exclude = readFileSync(join(repo, excludePath), "utf8");
    expect(CAD_EXCLUDE_LINES).toEqual(["cad/*/.cache/", "cad/*/release/"]);
    for (const line of CAD_EXCLUDE_LINES) expect(exclude.split("\n").filter((l) => l === line)).toHaveLength(1);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    // Idempotent: a second part (and a direct call) adds nothing.
    await m.open(partRef(repo, "bracket"));
    expect(ensureCadExcludes(repo)).toEqual([]);
    expect(readFileSync(join(repo, excludePath), "utf8")).toBe(exclude);
    // git agrees: the script is visible, the generated folders are not.
    mkdirSync(join(ref.dir, ".cache", "exports"), { recursive: true });
    writeFileSync(join(ref.dir, ".cache", "exports", "plate.step"), "x");
    mkdirSync(join(ref.dir, "release"), { recursive: true });
    writeFileSync(join(ref.dir, "release", "pack.zip"), "x");
    const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
    expect(status).toContain("cad/plate/design.json");
    expect(status).not.toContain(".cache");
    expect(status).not.toContain("release");
    expect(listParts(repo)).toEqual(["bracket", "plate"]);
    // Outside a git repo there is nothing to exclude and no worktree.
    const plain = tempDir();
    expect(ensureCadExcludes(plain)).toBeUndefined();
    expect(gitToplevel(plain)).toBeUndefined();
    expect(gitToplevel(join(repo, "cad", "plate"))).toBe(repo);
  });
});

describe("cad manager", () => {
  test("[A1] a process starts with the amended flags, only the part folder allowed, and a design is loaded by batch, never --in", async () => {
    const repo = tempRepo();
    const log = recordingSpawn();
    const m = fakeManager({ spawn: log.spawn });
    const ref = partRef(repo, "plate");
    const opened = await m.open(ref);
    expect(opened.hasDesign).toBe(false);
    expect(log.cmds).toEqual([[FAKE_SOLIDCRAFT, "mcp", "--headless", "--compact", "--allow-path", `${repo}/cad/plate`, "--require-allow-path"]]);
    expect(Object.keys(log.envs[0]!).sort()).toEqual(["HOME", "PATH", "SOLIDCRAFT_GPU", "TMPDIR"]);
    await box(m, ref);
    await m.shutdown();

    const log2 = recordingSpawn();
    const m2 = fakeManager({ spawn: log2.spawn });
    expect((await m2.open(ref)).hasDesign).toBe(true);
    // Decision 88: SolidCraft's sandbox does not cover `--in`, so the replay starts EMPTY, with the
    // same flags, and the script is sent as a batch.
    expect(log2.cmds).toEqual([[FAKE_SOLIDCRAFT, "mcp", "--headless", "--compact", "--allow-path", `${repo}/cad/plate`, "--require-allow-path"]]);
    expect((await volume(m2, ref))).toBe(1000);
    for (const cmd of [...log.cmds, ...log2.cmds]) {
      expect(cmd).not.toContain("--allow-any-path");
      expect(cmd[cmd.indexOf("--allow-path") + 1]).not.toBe(repo); // never the worktree root
      expect(cmd.filter((a) => a === "--allow-path")).toHaveLength(1);
    }
  });

  test("[A1] each part gets its own process and the same part shares one", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const [a, b] = [partRef(repo, "plate"), partRef(repo, "bracket")];
    await m.open(a);
    await m.open(b);
    await m.open(partRef(repo, "plate"));
    expect(m.liveCount()).toBe(2);
    const [pa, pb] = [m.status(a)!.pid!, m.status(b)!.pid!];
    expect(pa).not.toBe(pb);
    expect(alive(pa) && alive(pb)).toBe(true);
    await box(m, a, "Box", 10);
    expect((await measure(m, b)).body_count).toBe(0); // b's design is not a's
    expect(m.status(a)!.pid).toBe(pa);
  });

  test("[A1] every caller shares one strict FIFO queue per part", async () => {
    const repo = tempRepo();
    const m = fakeManager({ extraEnv: { FAKE_SC_DELAY_MS: "5" } });
    const ref = partRef(repo, "plate");
    const order: string[] = [];
    const seen: number[] = [];
    const jobs: Promise<unknown>[] = [];
    // Two callers ("agent" and "panel") interleave writes and reads without waiting for each other.
    for (let i = 0; i < 6; i++) {
      jobs.push(exec(m, ref, "parameters.add", { name: `p${i}`, expression: `${i} mm` }).then(() => order.push(`w${i}`)));
      jobs.push(
        m.request(ref, { tool: "inspect_design", args: { measure: false, sketches: false }, kind: "read" }).then((r) => {
          order.push(`r${i}`);
          seen.push(r.result.json.params.length);
        }),
      );
    }
    expect(m.status(ref)!.busy).toBe(true);
    expect(m.status(ref)!.queued).toBeGreaterThanOrEqual(11);
    await Promise.all(jobs);
    expect(order).toEqual(["w0", "r0", "w1", "r1", "w2", "r2", "w3", "r3", "w4", "r4", "w5", "r5"]);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]); // each read saw exactly the writes queued before it
    expect(m.status(ref)!.busy).toBe(false);
    expect(m.liveCount()).toBe(1);
  });

  test("[A1] the script is rewritten after every successful change, and not after a read or a failure", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    await m.open(ref);
    expect(existsSync(join(ref.dir, "design.json"))).toBe(false);
    const first = await box(m, ref);
    expect(first.wrote).toBe(true);
    expect(first.state.status).toBe("unverified");
    expect(design(ref).about.design).toBe("plate");
    expect(design(ref).commands).toEqual([{ command: "solid.box", params: { height: 10, length: 10, name: "Box", width: 10 } }]);
    // The file holds the exported script's `timeline.add` step for it (the screen's allowed shape).
    expect(JSON.parse(designBytes(ref)).commands).toEqual([{ command: "timeline.add", params: { feature: { id: "solid.box", params: { height: 10, length: 10, name: "Box", width: 10 }, type: "fake" } } }]);
    expect(designBytes(ref)).toBe(designFileText("plate", JSON.parse(designBytes(ref)))); // canonical: sorted keys, stable about
    expect(first.scriptSha).toBe(scriptSha(JSON.parse(designBytes(ref)).commands));
    expect(m.status(ref)!.scriptSha).toBe(first.scriptSha!);
    const before = designBytes(ref);

    const read = await m.request(ref, { tool: "measure", args: {}, kind: "read" });
    expect(read.wrote).toBe(false);
    const failed = await exec(m, ref, "no.such");
    expect(failed.result.isError).toBe(true);
    expect(failed.wrote).toBe(false);
    expect(designBytes(ref)).toBe(before);

    const second = await exec(m, ref, "parameters.add", { name: "L", expression: "80 mm" });
    expect(second.wrote).toBe(true);
    expect(second.scriptSha).not.toBe(first.scriptSha);
    expect(design(ref).commands).toHaveLength(2);
    expect(m.status(ref)!.params).toEqual([{ name: "L", expression: "80 mm", value: 80, unit: "mm" }]);
  });

  test("[A1] a process exits after 10 minutes idle and the next request replays the design", async () => {
    const repo = tempRepo();
    const clock = new FakeClock();
    const log = recordingSpawn();
    const m = fakeManager({ clock, spawn: log.spawn });
    const ref = partRef(repo, "plate");
    await box(m, ref);
    const pid = m.status(ref)!.pid!;
    expect(IDLE_EXIT_MS).toBe(600_000);
    expect(m.idleMs).toBe(600_000);
    expect(clock.pending()).toEqual([600_000]);
    clock.advance(599_999);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.status(ref)!.live).toBe(true);
    // Use resets the timer: a request at 9:59.999 buys another 10 minutes.
    expect(await volume(m, ref)).toBe(1000);
    clock.advance(599_999);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.status(ref)!.live).toBe(true);
    clock.advance(1);
    await until(() => !alive(pid), "the idle process to exit");
    await until(() => m.liveCount() === 0, "the slot to free");
    expect(m.status(ref)!.live).toBe(false);
    // Nothing is lost: the next request restarts it from design.json.
    expect(await volume(m, ref)).toBe(1000);
    expect(m.status(ref)!.pid).not.toBe(pid);
    expect(log.cmds).toHaveLength(2); // the restart (loaded by batch; never --in)
    expect(log.cmds.some((c) => c.includes("--in"))).toBe(false);
  });

  test("[A1] the cap defaults to 4 and reads ANVIL_CAD_MAX_PROCS", () => {
    expect(DEFAULT_MAX_PROCS).toBe(4);
    expect(maxProcsFromEnv({})).toBe(4);
    expect(maxProcsFromEnv({ ANVIL_CAD_MAX_PROCS: "2" })).toBe(2);
    for (const bad of ["0", "-1", "x", "1.5", ""]) expect(maxProcsFromEnv({ ANVIL_CAD_MAX_PROCS: bad })).toBe(4);
    expect(new CadManager({ maxProcs: 7 }).maxProcs).toBe(7);
  });

  test("[A1] at the cap a new part waits for a slot, visibly, while every process is busy", async () => {
    const repo = tempRepo();
    const events: CadManagerEvent[] = [];
    const m = fakeManager({ maxProcs: 1, extraEnv: { FAKE_SC_DELAY_MS: "60" }, onEvent: (e) => events.push(e) });
    const [a, b] = [partRef(repo, "plate"), partRef(repo, "bracket")];
    await m.open(a);
    const busy = box(m, a); // a is now busy for a few hundred ms
    const waiting = m.request(b, { tool: "measure", args: { summary: true }, kind: "read" });
    await until(() => m.status(b)?.waitingForSlot === true, "b to wait for a slot");
    expect(WAITING_FOR_SLOT).toBe("waiting for a CAD slot");
    expect(m.status(b)).toMatchObject({ waitingForSlot: true, live: false, busy: true });
    expect(m.liveCount()).toBe(1);
    expect(events).toContainEqual({ type: "waiting", key: b.key, part: "bracket", waiting: true });

    await busy;
    const reply = await waiting; // a went idle → evicted → b got the slot
    expect(reply.waitedForSlot).toBe(true);
    expect(reply.notes.join(" ")).toContain("waited for a CAD slot");
    expect(reply.result.json.body_count).toBe(0);
    expect(m.status(b)).toMatchObject({ waitingForSlot: false, live: true });
    expect(m.status(a)!.live).toBe(false);
    expect(m.liveCount()).toBe(1);
    expect(events).toContainEqual({ type: "waiting", key: b.key, part: "bracket", waiting: false });
    expect(events).toContainEqual({ type: "stopped", key: a.key, part: "plate", reason: "evicted" });
    // a comes back from its script when it is needed again.
    expect(await volume(m, a)).toBe(1000);
    expect(m.liveCount()).toBe(1);
  });

  test("[A1] an idle process is evicted first, least recently used first, with no waiting", async () => {
    const repo = tempRepo();
    const clock = new FakeClock();
    const m = fakeManager({ maxProcs: 2, clock });
    const [a, b, c] = [partRef(repo, "aa"), partRef(repo, "bb"), partRef(repo, "cc")];
    await box(m, a);
    clock.advance(1000);
    await box(m, b);
    clock.advance(1000);
    await volume(m, a); // a is now the most recently used; b is the LRU
    clock.advance(1000);
    const opened = await m.open(c);
    expect(opened.waitedForSlot).toBe(false);
    expect(m.liveCount()).toBe(2);
    expect(m.status(b)!.live).toBe(false);
    expect(m.status(a)!.live).toBe(true);
    expect(m.status(c)!.live).toBe(true);
    expect(m.statuses().map((s) => s.part).sort()).toEqual(["aa", "bb", "cc"]);
  });

  test("[A1] a crash fails the pending request with the stderr tail; the next request restarts and replays", async () => {
    const repo = tempRepo();
    let env: Record<string, string> = { FAKE_SC_CRASH_ON: "solid.cylinder" };
    const m = fakeManager({ extraEnv: () => env });
    const ref = partRef(repo, "plate");
    await box(m, ref);
    const pid = m.status(ref)!.pid!;
    const err = (await exec(m, ref, "solid.cylinder", { radius: 2, height: 5, operation: "join" }).catch((e) => e)) as CadError;
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("process");
    expect(err.message).toContain("simulated crash on solid.cylinder (segmentation fault)"); // the stderr tail
    expect(err.message).toContain("`execute`");
    expect(m.status(ref)!.live).toBe(false);
    expect(m.liveCount()).toBe(0);
    env = {};
    // Only the failed call is lost: the box is still there, from design.json.
    const after = await measure(m, ref);
    expect(after.body_count).toBe(1);
    expect(after.total.volume_mm3).toBe(1000);
    expect(m.status(ref)!.pid).not.toBe(pid);
    expect(design(ref).commands).toHaveLength(1);
  });

  test("[A1] a process killed between two calls is restarted and the design is intact", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    await m.request(ref, { tool: "batch", args: { commands: REFERENCE_PLATE, verbose: false }, kind: "mutate" });
    const before = await volume(m, ref);
    const pid = m.status(ref)!.pid!;
    process.kill(pid, "SIGKILL");
    await until(() => m.status(ref)!.live === false, "the manager to notice the kill");
    const after = await measure(m, ref);
    expect(after.total.volume_mm3).toBe(before);
    expect(after.bodies[0].faces).toBe(22);
    expect(m.status(ref)!.pid).not.toBe(pid);
    expect(m.liveCount()).toBe(1); // the dead process's slot was given back, not leaked
  });

  test("[A1] a daemon restart loses the processes, not the design", async () => {
    const repo = tempRepo();
    const m1 = fakeManager();
    const ref = partRef(repo, "plate");
    await m1.request(ref, { tool: "batch", args: { commands: REFERENCE_PLATE, verbose: false }, kind: "mutate" });
    const before = await volume(m1, ref);
    const pid = m1.status(ref)!.pid!;
    await m1.shutdown(); // the daemon goes away, and its SolidCraft processes with it
    expect(alive(pid)).toBe(false);
    const m2 = fakeManager(); // a new daemon knows nothing but the files
    expect(m2.status(ref)).toBeUndefined();
    expect(await volume(m2, ref)).toBe(before);
    expect(before).toBeCloseTo(23335.2, 1);
  });

  test("[A1] a hung SolidCraft is killed at the request timeout and the next call restarts it", async () => {
    const repo = tempRepo();
    const m = fakeManager({ requestTimeoutMs: 250, extraEnv: { FAKE_SC_HANG_ON: "solid.cylinder" } });
    const ref = partRef(repo, "plate");
    await box(m, ref);
    const pid = m.status(ref)!.pid!;
    const err = (await exec(m, ref, "solid.cylinder", { radius: 2, height: 5, operation: "join" }).catch((e) => e)) as CadError;
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("did not answer `execute` within");
    await until(() => !alive(pid), "the hung process to be killed");
    expect(m.status(ref)!.live).toBe(false);
    expect(await volume(m, ref)).toBe(1000);
  });

  test("[A1] requests get 120 s, a batch 600 s", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(BATCH_TIMEOUT_MS).toBe(600_000);
    const repo = tempRepo();
    const clock = new FakeClock();
    const m = fakeManager({ clock });
    const ref = partRef(repo, "plate");
    await m.open(ref);
    clock.asked.length = 0;
    await box(m, ref);
    expect(clock.asked.filter((ms) => ms !== IDLE_EXIT_MS)).toEqual([120_000, 120_000, 120_000]); // the call, the snapshot, the script export
    clock.asked.length = 0;
    await m.request(ref, { tool: "batch", args: { commands: [BOX("B2", 5)] }, kind: "mutate" });
    expect(clock.asked[0]).toBe(600_000);
    expect(clock.pending()).toEqual([IDLE_EXIT_MS]); // every request timer was cleared on reply
  });

  test("[A1] design.json changed on disk is noticed at dequeue: the process restarts from it and the caller is told", async () => {
    const repo = tempRepo();
    const m = fakeManager({ extraEnv: { FAKE_SC_DELAY_MS: "120" } });
    const ref = partRef(repo, "plate");
    await box(m, ref, "Box", 10);
    expect(await volume(m, ref)).toBe(1000);
    // Two reads are queued; the file is edited while the FIRST is running. The check is made when
    // a request is dequeued, not when it arrives, so the first is old and the second is new.
    const first = m.request(ref, { tool: "measure", args: { summary: true }, kind: "read" });
    const second = m.request(ref, { tool: "measure", args: { summary: true }, kind: "read" });
    await new Promise((r) => setTimeout(r, 30));
    writeDesign(repo, "plate", [BOX("Box", 20)]);
    const r1 = await first;
    const r2 = await second;
    expect(r1.reloaded).toBe(false);
    expect(r1.result.json.total.volume_mm3).toBe(1000);
    expect(r2.reloaded).toBe(true);
    expect(r2.result.json.total.volume_mm3).toBe(8000);
    expect(r2.notes.join(" ")).toContain("design.json was changed on disk, so the design was reloaded");
    const r3 = await m.request(ref, { tool: "measure", args: { summary: true }, kind: "read" });
    expect(r3.reloaded).toBe(false);
    expect(r3.notes).toEqual([]);
  });

  test("[A1] design.json changed during a change is never overwritten: conflict file, part failed, disk wins", async () => {
    const repo = tempRepo();
    let edit: (() => void) | undefined;
    const m = fakeManager({ beforeScriptRename: () => edit?.() });
    const ref = partRef(repo, "plate");
    await box(m, ref, "Box", 10);
    edit = () => {
      edit = undefined;
      writeDesign(repo, "plate", [BOX("Hand", 30)]); // a checkout / hand edit lands mid-request
    };
    const handEdit = () => designBytes(ref);
    const reply = await box(m, ref, "Second", 5);
    const onDisk = handEdit();
    expect(readDesignPlain(join(ref.dir, "design.json")).commands).toEqual([BOX("Hand", 30)]); // NOT overwritten
    expect(reply.wrote).toBe(false);
    expect(reply.state.status).toBe("fail");
    expect(reply.state.reason).toBe("design changed on disk during a change");
    expect(reply.state.conflict).toBe(true);
    expect(reply.notes.join(" ")).toContain(DISK_CONFLICT_REASON);
    const conflict = readDesignPlain(join(ref.dir, ".cache", "design.conflict.json"));
    expect(conflict.commands.map((c: any) => c.params.name)).toEqual(["Box", "Second"]); // what the request produced
    expect(m.status(ref)!.state.status).toBe("fail");
    // The next request rebuilds from disk (disk wins), which clears the failure.
    const next = await m.request(ref, { tool: "measure", args: { summary: true }, kind: "read" });
    expect(next.reloaded).toBe(true);
    expect(next.result.json.total.volume_mm3).toBe(27000);
    expect(next.state).toMatchObject({ status: "unverified", conflict: false });
    expect(designBytes(ref)).toBe(onDisk);
  });

  test("[A1] feature errors are read from the timeline straight after start", async () => {
    const repo = tempRepo();
    // A fillet larger than the box allows: SolidCraft still starts (--in tolerates failed features).
    writeDesign(repo, "plate", [BOX("Block", 10), { command: "solid.fillet", params: { edges: [[0, 0, 5]], radius: 8, name: "Corners" } }]);
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    const bytes = designBytes(ref);
    const opened = await m.open(ref);
    expect(opened.state.status).toBe("fail");
    expect(opened.state.featureErrors).toEqual([{ id: 2, feature: "Corners", message: "not supported yet: the fillet is larger than the faces beside its edges allow" }]);
    expect(opened.state.reason).toContain("Corners: not supported yet");
    expect(opened.notes.join(" ")).toContain("1 feature failed to build");
    // The partial geometry still measures — which is exactly why the error must be surfaced.
    expect(await volume(m, ref)).toBe(1000);
    expect(designBytes(ref)).toBe(bytes);
    // Fixing the feature clears the state.
    const fixed = await exec(m, ref, "parameters.add", { name: "pad", expression: "1 mm" });
    expect(fixed.state.status).toBe("fail"); // still failing: adding a parameter fixes nothing
    expect(fixed.notes.join(" ")).toContain("Corners");
  });

  test("[A1] a design.json that fails to replay starts empty, fails with the step, and is kept until a change succeeds", async () => {
    const repo = tempRepo();
    writeDesign(repo, "plate", [BOX("Good", 10), { command: "no.such", params: {} }]);
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    const original = designBytes(ref);
    const opened = await m.open(ref);
    expect(opened.state.status).toBe("fail");
    // The failing step, by index; it is a `timeline.add` step of the script (the batch load reports the step's command).
    expect(opened.state.replayFailure).toBe("step 2 (timeline.add): unknown command `no.such`");
    expect(opened.state.reason).toBe("design.json failed to replay: step 2 (timeline.add): unknown command `no.such`");
    expect(opened.notes.join(" ")).toContain("started EMPTY");
    expect((await measure(m, ref)).body_count).toBe(0);
    // Reads and failed changes leave the file exactly as it was.
    expect((await exec(m, ref, "still.no.such")).result.isError).toBe(true);
    expect(designBytes(ref)).toBe(original);
    expect(m.status(ref)!.state.status).toBe("fail");
    // A successful change is what replaces it; the old file is kept in .cache.
    const ok = await box(m, ref, "Fresh", 5);
    expect(ok.wrote).toBe(true);
    expect(ok.state.status).toBe("unverified");
    expect(design(ref).commands.map((c: any) => c.params.name)).toEqual(["Fresh"]);
    expect(readFileSync(join(ref.dir, ".cache", UNREPLAYABLE_FILE), "utf8")).toBe(original);
    // A file that is not JSON at all takes the same path.
    writeFileSync(join(repo, "cad", "plate", "design.json"), "not json\n");
    const again = await m.request(ref, { tool: "measure", args: { summary: true }, kind: "read" });
    expect(again.state.status).toBe("fail");
    expect(again.state.reason).toContain("design.json failed to replay");
    expect(again.result.json.body_count).toBe(0);
    expect(designBytes(ref)).toBe("not json\n");
  });

  test("[A1] every load is screened first: a design.json carrying a file-writing step is refused, nothing is spawned, and the part fails with the screen's reason until the file changes", async () => {
    const repo = tempRepo();
    const log = recordingSpawn();
    const m = fakeManager({ spawn: log.spawn });
    const outside = tempDir("anvil-cad-victim-");
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "original\n");
    const path = writeDesign(repo, "plate", [BOX()]);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.commands.push({ command: "parameters.export", params: { path: victim } });
    writeFileSync(path, JSON.stringify(doc));
    const bytes = readFileSync(path, "utf8");
    const ref = partRef(repo, "plate");
    const err = (await m.open(ref).catch((e) => e)) as CadError;
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("refused");
    expect(err.message).toContain(REFUSED_DESIGN);
    expect(err.message).toContain("step 2 (parameters.export)");
    expect(log.cmds).toEqual([]); // nothing spawned
    expect(m.status(ref)!.state.status).toBe("fail");
    expect(m.status(ref)!.state.reason).toContain(REFUSED_DESIGN);
    // A Rebuild is a load as well.
    expect(((await m.reload(ref).catch((e) => e)) as CadError).code).toBe("refused");
    expect(log.cmds).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("original\n");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    // Restoring a clean file lets it load (by batch, never --in).
    writeDesign(repo, "plate", [BOX()]);
    expect((await m.open(ref)).state.status).toBe("unverified");
    expect(log.cmds).toHaveLength(1);
    expect(log.cmds[0]).not.toContain("--in");
    expect(await volume(m, ref)).toBe(1000);
  });

  test("[A1] a design loaded by batch cannot be undone away: the agent's undo stops at the loaded design", async () => {
    const repo = tempRepo();
    writeDesign(repo, "plate", [BOX("A", 10), BOX("B", 5)]);
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    await m.open(ref);
    expect(await volume(m, ref)).toBe(1125);
    const before = designBytes(ref);
    const u = await m.request(ref, { tool: "undo", kind: "undo" });
    expect(u.result.isError).toBe(true);
    expect(u.result.text).toBe("nothing to undo");
    expect(await volume(m, ref)).toBe(1125);
    expect(designBytes(ref)).toBe(before);
    // The agent's own change is still undoable, back to (and not past) the loaded design.
    await box(m, ref, "C", 2);
    expect(await volume(m, ref)).toBe(1133);
    expect((await m.request(ref, { tool: "undo", kind: "undo" })).result.isError).toBe(false);
    expect(await volume(m, ref)).toBe(1125);
    expect((await m.request(ref, { tool: "undo", kind: "undo" })).result.isError).toBe(true);
    expect(await volume(m, ref)).toBe(1125);
  });

  test("[A1] a design from a newer format is refused by Anvil itself, and the local format is learned once per binary", async () => {
    const repo = tempRepo();
    const log = recordingSpawn();
    // FAKE_SC_NEWER=warn makes the fake behave like the real 0.44.1, which does NOT enforce
    // about.format on a script: if this is refused, it is the manager refusing it.
    const m = fakeManager({ spawn: log.spawn, extraEnv: { FAKE_SC_NEWER: "warn" } });
    writeDesign(repo, "plate", [BOX()], { design: "plate", format: "solidcraft/99", version: "9.0.0" });
    writeDesign(repo, "bracket", [BOX()], { design: "bracket", format: "solidcraft/59", version: "0.45.0" });
    writeDesign(repo, "same", [BOX()], { design: "same", format: "solidcraft/58", version: "0.44.1" });
    const ref = partRef(repo, "plate");
    const bytes = designBytes(ref);
    const err = (await m.open(ref).catch((e) => e)) as CadError;
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("format");
    expect(OLDER_SOLIDCRAFT).toBe("this machine's SolidCraft is older than the design");
    expect(err.message).toContain("this machine's SolidCraft is older than the design");
    expect(err.message).toContain("format 99");
    expect(err.message).toContain("reads up to 58");
    expect(designBytes(ref)).toBe(bytes);
    expect(existsSync(join(ref.dir, ".cache"))).toBe(false); // refused before anything was written
    expect(m.liveCount()).toBe(0);
    expect(((await m.open(partRef(repo, "bracket")).catch((e) => e)) as CadError).code).toBe("format");
    // The format is read from the process started for the part itself: one spawn per attempt, no
    // separate probe process (the A1 review's finding: a failed probe used to skip the check).
    expect(log.cmds).toHaveLength(2);
    expect(log.cmds.some((c) => c.includes("--in"))).toBe(false); // the format is checked BEFORE the script is sent
    await until(() => m.liveCount() === 0, "the refused processes to be gone");
    // The same format replays.
    expect((await m.open(partRef(repo, "same"))).state.status).toBe("unverified");
    expect(log.cmds).toHaveLength(3);
    // A build that reads a higher format accepts the file the older one refused.
    const newer = fakeManager({ extraEnv: { FAKE_SC_FORMAT: "59" } });
    expect((await newer.open(partRef(repo, "bracket"))).hasDesign).toBe(true);
    // A build that ENFORCES the format itself (the fake's default) is refused the same way, not
    // started empty as an unreplayable design.
    const strict = fakeManager();
    const strictErr = (await strict.open(ref).catch((e) => e)) as CadError;
    expect(strictErr.code).toBe("format");
    expect(strictErr.message).toContain("format 99");
    expect(designBytes(ref)).toBe(bytes);
  });

  test("[A1] a design.json with a missing or non-numeric format is refused before anything starts, and a build that cannot report its format opens nothing", async () => {
    const repo = tempRepo();
    const log = recordingSpawn();
    const m = fakeManager({ spawn: log.spawn, extraEnv: { FAKE_SC_NEWER: "warn" } });
    writeDesign(repo, "noformat", [BOX()], { design: "noformat", version: "0.44.1" });
    writeDesign(repo, "badformat", [BOX()], { design: "badformat", format: "latest", version: "0.44.1" });
    for (const part of ["noformat", "badformat"]) {
      const ref = partRef(repo, part);
      const bytes = designBytes(ref);
      const err = (await m.open(ref).catch((e) => e)) as CadError;
      expect(err).toBeInstanceOf(CadError);
      expect(err.code).toBe("format");
      expect(err.message).toContain("does not say which SolidCraft format");
      expect(designBytes(ref)).toBe(bytes);
      expect(existsSync(join(ref.dir, ".cache"))).toBe(false);
    }
    expect(log.cmds).toEqual([]); // nothing was spawned for either
    expect(m.liveCount()).toBe(0);
    // A brand-new part has no file, so there is nothing to check and it opens.
    expect((await m.open(partRef(repo, "fresh"))).hasDesign).toBe(false);

    // A process that cannot say which format it writes: the design is not opened (fail closed).
    writeDesign(repo, "ok", [BOX()]);
    const mute = fakeManager({ extraEnv: { FAKE_SC_CRASH_ON: "timeline.export_script" } });
    const err = (await mute.open(partRef(repo, "ok")).catch((e) => e)) as CadError;
    expect(err.code).toBe("format");
    expect(err.message).toContain("could not learn which design format");
    expect(mute.liveCount()).toBe(0);
  });

  test("[A1] a symlinked cad folder or part folder is refused, and nothing is written outside the worktree", async () => {
    const repo = tempRepo();
    const outside = tempDir("anvil-cad-outside-");
    mkdirSync(join(repo, "cad"), { recursive: true });
    symlinkSync(outside, join(repo, "cad", "evil"));
    // The reference itself is refused…
    expect(() => partRef(repo, "evil")).toThrow(UnsafePartFolder);
    expect(() => partRef(repo, "evil")).toThrow("symbolic link");
    // …and so is a reference built before the link existed (the check is repeated at start).
    const m = fakeManager();
    const stale = { key: join(repo, "cad", "evil"), worktree: repo, part: "evil", dir: join(repo, "cad", "evil") };
    const err = (await m.open(stale).catch((e) => e)) as CadError;
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("unsafe");
    expect(m.liveCount()).toBe(0);
    expect(readdirSync(outside)).toEqual([]);

    // Two names linked to one folder never share a design: the alias is refused.
    await m.request(partRef(repo, "real"), { tool: "execute", args: { command: "solid.box", params: BOX().params }, kind: "mutate" });
    symlinkSync(join(repo, "cad", "real"), join(repo, "cad", "alias"));
    expect(() => partRef(repo, "alias")).toThrow(UnsafePartFolder);
    expect(listParts(repo)).toEqual(["real"]);

    // A symlinked `cad` folder: every part under it is refused, and nothing lands in its target.
    const repo2 = tempRepo();
    const outside2 = tempDir("anvil-cad-outside-");
    symlinkSync(outside2, join(repo2, "cad"));
    expect(() => partRef(repo2, "plate")).toThrow("cad/ folder is a symbolic link");
    const stale2 = { key: join(repo2, "cad", "plate"), worktree: repo2, part: "plate", dir: join(repo2, "cad", "plate") };
    expect(((await m.open(stale2).catch((e) => e)) as CadError).code).toBe("unsafe");
    expect(readdirSync(outside2)).toEqual([]);
  });

  test("[A1] undo and redo revert one agent request, however many SolidCraft steps it was", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    const undo = () => m.request(ref, { tool: "undo", kind: "undo" });
    const redo = () => m.request(ref, { tool: "redo", kind: "redo" });
    const depth = async () => (await m.request(ref, { tool: "inspect_design", args: { measure: false, sketches: false, timeline: false, bodies: false }, kind: "read" })).result.json.undo as number;

    await m.request(ref, { tool: "batch", args: { commands: REFERENCE_PLATE, verbose: false }, kind: "mutate" });
    expect(await depth()).toBe(16); // one batch, sixteen SolidCraft undo steps
    await exec(m, ref, "parameters.change", { changes: { L: "120" } });
    expect(await depth()).toBe(17);
    expect(await volume(m, ref)).toBeCloseTo(35335.2, 1);

    const u1 = await undo(); // the parameter change: one step
    expect(u1.result.json).toEqual({ undone: "Change Parameters" });
    expect(await depth()).toBe(16);
    expect(await volume(m, ref)).toBeCloseTo(23335.2, 1);

    const u2 = await undo(); // the whole batch, not its last command
    expect(u2.notes.join(" ")).toContain("as a whole (16 SolidCraft steps)");
    expect(await depth()).toBe(0);
    expect((await measure(m, ref)).body_count).toBe(0);
    expect(design(ref).commands).toEqual([]); // the script follows undo too
    expect(u2.wrote).toBe(true);

    const r1 = await redo();
    expect(r1.notes.join(" ")).toContain("as a whole (16 SolidCraft steps)");
    expect(await depth()).toBe(16);
    expect(await volume(m, ref)).toBeCloseTo(23335.2, 1);
    await redo();
    expect(await depth()).toBe(17);
    expect(await volume(m, ref)).toBeCloseTo(35335.2, 1);
    const none = await redo();
    expect(none.result.isError).toBe(true);
    expect(none.result.text).toBe("nothing to redo");
    expect(none.wrote).toBe(false);

    // A new change after an undo discards the redo history, as in SolidCraft itself.
    await undo();
    await exec(m, ref, "parameters.change", { changes: { W: "60" } });
    expect((await redo()).result.isError).toBe(true);
    await undo();
    expect(m.status(ref)!.params.find((p) => p.name === "W")!.value).toBe(50);
    expect(m.status(ref)!.params.find((p) => p.name === "L")!.value).toBe(80);
  });

  test("[A4] re-review: after a daemon rollback (slot.revert) the agent can undo its own request and redo it back, but redo never brings back the rolled-back change", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const ref = partRef(repo, "plate");
    const undo = () => m.request(ref, { tool: "undo", kind: "undo" });
    const redo = () => m.request(ref, { tool: "redo", kind: "redo" });
    const param = (n: string) => m.status(ref)!.params.find((p) => p.name === n)!.value;
    await m.request(ref, { tool: "batch", args: { commands: REFERENCE_PLATE, verbose: false }, kind: "mutate" });
    await exec(m, ref, "parameters.change", { changes: { L: "120" } }); // the agent's own request
    // A composite job changes W and the daemon rolls it back (what a refused import does).
    await m.run(ref, async (slot) => {
      await slot.mutate("execute", { command: "parameters.change", params: { changes: { W: "60" } } });
      expect(slot.params().find((p) => p.name === "W")!.value).toBe(60);
      await slot.revert();
    });
    expect(param("W")).toBe(50);
    expect((await redo()).result.text).toBe("nothing to redo");
    expect(param("W")).toBe(50);
    // The agent undoes its own change below the rollback point, and may redo exactly that.
    await undo();
    expect(param("L")).toBe(80);
    const r = await redo();
    expect(r.result.isError).toBe(false);
    expect(param("L")).toBe(120);
    expect(param("W")).toBe(50);
    // One more redo would be the rolled-back change: refused, and nothing moves.
    const again = await redo();
    expect(again.result.text).toBe("nothing to redo");
    expect(param("W")).toBe(50);
    expect(design(ref).commands.some((c: any) => JSON.stringify(c).includes('"W":"60"'))).toBe(false);
  });

  test("[A1] the refresh hook runs after a change, is debounced in a burst, can be forced, and is a no-op when absent", async () => {
    const repo = tempRepo();
    const clock = new FakeClock();
    const m = fakeManager({ clock });
    const ref = partRef(repo, "plate");
    // With no refresh job (this phase) forcing is a no-op and the change just stays pending.
    await box(m, ref, "B0", 10);
    expect(m.status(ref)!.refreshPending).toBe(true);
    await m.forceRefresh(ref);
    await m.forceRefresh("no/such/key");
    expect(m.status(ref)!.refreshPending).toBe(true);

    const log: string[] = [];
    const volumes: number[] = [];
    m.setRefresh(async (ctx) => {
      // The job talks to the part's process inside the queue slot.
      volumes.push((await ctx.call("measure", { summary: true })).json.total.volume_mm3);
      log.push(ctx.forced ? "refresh(forced)" : "refresh");
    });
    await m.forceRefresh(ref); // the pending change from before the job was installed
    expect(log).toEqual(["refresh(forced)"]);
    expect(volumes).toEqual([1000]);
    expect(m.status(ref)!.refreshPending).toBe(false);
    await m.forceRefresh(ref); // nothing changed since: no-op
    expect(log).toHaveLength(1);

    // A read never triggers it; a single change triggers it once, after its reply, when the queue drains.
    log.length = 0;
    await volume(m, ref);
    clock.advance(10_000);
    await box(m, ref, "B1", 10).then(() => log.push("reply"));
    await until(() => log.length === 2, "the refresh after the change");
    expect(log).toEqual(["reply", "refresh"]);

    // A burst of three queued changes inside 500 ms: not after every one, but always at the end.
    log.length = 0;
    await Promise.all([box(m, ref, "B2", 10), box(m, ref, "B3", 10), box(m, ref, "B4", 10)]);
    await until(() => !m.status(ref)!.busy, "the queue to drain");
    expect(log).toEqual(["refresh"]);
    expect(volumes.at(-1)).toBe(5000);
    expect(m.status(ref)!.refreshPending).toBe(false);

    // …and once 500 ms have passed mid-burst it runs again without waiting for the end.
    log.length = 0;
    clock.advance(500);
    await Promise.all([box(m, ref, "B5", 10).then(() => log.push("r5")), box(m, ref, "B6", 10).then(() => log.push("r6"))]);
    await until(() => !m.status(ref)!.busy, "the queue to drain");
    expect(log).toEqual(["r5", "refresh", "r6", "refresh"]);

    // refreshFirst (what export_part / check_part use): a pending refresh runs BEFORE the job.
    log.length = 0;
    const change = box(m, ref, "B7", 10);
    const job = m.run(ref, async () => void log.push("job"), { refreshFirst: true });
    await Promise.all([change, job]);
    expect(log).toEqual(["refresh(forced)", "job"]);

    // A refresh that throws never fails a request; the part stays pending.
    m.setRefresh(async () => {
      throw new Error("gate exploded");
    });
    expect((await box(m, ref, "B8", 10)).result.isError).toBe(false);
    await until(() => !m.status(ref)!.busy, "the queue to drain");
    expect(m.status(ref)!.refreshPending).toBe(true);
  });

  test("[A1] shutdown stops every process and refuses new work", async () => {
    const repo = tempRepo();
    const m = fakeManager();
    const [a, b] = [partRef(repo, "plate"), partRef(repo, "bracket")];
    await m.open(a);
    await m.open(b);
    const pids = [m.status(a)!.pid!, m.status(b)!.pid!];
    await m.shutdown();
    expect(pids.map(alive)).toEqual([false, false]);
    expect(m.liveCount()).toBe(0);
    const err = (await m.open(a).catch((e) => e)) as CadError;
    expect(err).toBeInstanceOf(CadError);
    expect(err.code).toBe("shutdown");
  });

  test("[A1] with no binary the request fails as unavailable and nothing is spawned", async () => {
    const repo = tempRepo();
    const log = recordingSpawn();
    const m = new CadManager({ resolveCli: () => undefined, spawn: log.spawn });
    const err = (await m.open(partRef(repo, "plate")).catch((e) => e)) as CadError;
    expect(err.code).toBe("unavailable");
    expect(err.message).toContain("SolidCraft is not installed");
    expect(log.cmds).toEqual([]);
    expect(m.liveCount()).toBe(0);
  });
});
