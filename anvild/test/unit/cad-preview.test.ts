/**
 * [A3] The preview half of the refresh (agent-cad-and-browser spec §4.3 steps 4–5, §4.8): the GLB a
 * refresh writes, pruning, revision numbers, and the `busy` / `waiting` flags on `cad.design`.
 * The real manager, refresh and service; SolidCraft is the fake.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partRef } from "../../src/cadwork/partfolder";
import { exportPreview, newestPreview, previewRevs, prunePreviews, PREVIEW_PATH_RE, PREVIEWS_KEPT } from "../../src/cadwork/refresh";
import { BUSY_NOTICE_MS } from "../../src/session/cadwork-service";
import { BOX, FakeClock, cleanupTemp, fakeCadSession, stopServices, tempRepo, until } from "../helpers/cad-work";
import { FAKE_SOLIDCRAFT } from "../helpers/fake-solidcraft";
import { readGlb } from "../golden/live-glb";

afterEach(async () => {
  await stopServices();
  cleanupTemp();
});
const fake = { resolveCli: () => ({ path: FAKE_SOLIDCRAFT, source: "env" as const }) };
const designs = (x: { broadcasts: any[] }, part: string) => x.broadcasts.filter((e) => e.type === "cad.design" && e.part === part);
const cache = (repo: string, part: string) => join(repo, "cad", part, ".cache");
const previews = (repo: string, part: string) => readdirSync(cache(repo, part)).filter((n) => n.startsWith("preview-")).sort();

test("[A3] a refresh writes .cache/preview-<rev>.glb — a valid GLB of the design in metres, Y up — and cad.design names it", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  await x.tools.open_part!({ part: "plate" });
  expect((await x.tools.execute!({ command: "solid.box", params: { length: 80, width: 50, height: 6, name: "Plate" } })).isError).toBe(false);
  await x.tools.check_part!({ part: "plate" });
  const ev = x.design("plate");
  expect(ev.preview).toBe(`cad/plate/.cache/preview-${ev.rev}.glb`);
  expect(PREVIEW_PATH_RE.test(ev.preview)).toBe(true);
  const glb = readGlb(readFileSync(join(repo, ev.preview)));
  expect(glb.meshes).toBe(1);
  // CAD x, y, z in mm → x, z, -y in metres: an 80 × 50 × 6 mm plate is 0.08 × 0.006 × 0.05.
  const size = [0, 1, 2].map((k) => Math.round((glb.max[k]! - glb.min[k]!) * 1e6) / 1e6);
  expect(size).toEqual([0.08, 0.006, 0.05]);
  expect(x.service.snapshot(partRef(repo, "plate"))!.outcome.preview).toBe(ev.preview);
  // The file is inside the git-excluded cache folder, so it never shows up as a change to commit.
  const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
  expect(status).not.toContain("preview-");
});

test("[A3] previews older than the newest three are deleted, and rev rises by one per refresh", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  await x.tools.open_part!({ part: "plate" });
  const revs: number[] = [];
  for (let i = 0; i < 6; i++) {
    await x.tools.execute!(BOX(`B${i}`, 10 + i));
    await x.tools.check_part!({ part: "plate" });
    revs.push(x.design("plate").rev);
  }
  for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1]!);
  const last = revs.at(-1)!;
  expect(PREVIEWS_KEPT).toBe(3);
  expect(previews(repo, "plate")).toHaveLength(3);
  expect(previewRevs(join(repo, "cad", "plate")).at(-1)).toBe(last);
  expect(existsSync(join(cache(repo, "plate"), `preview-${last}.glb`))).toBe(true);
  expect(existsSync(join(cache(repo, "plate"), `preview-${revs[0]}.glb`))).toBe(false);
  // Every rev of every event is unique and ascending: a client can count how far behind it is.
  const all = designs(x, "plate").map((e) => e.rev);
  expect([...all].sort((a, b) => a - b)).toEqual(all);
});

test("[A3] prunePreviews keeps the newest N by revision number and ignores other files", () => {
  const repo = tempRepo();
  const dir = join(repo, "cad", "p");
  mkdirSync(join(dir, ".cache"), { recursive: true });
  for (const n of ["preview-2.glb", "preview-10.glb", "preview-9.glb", "preview-1.glb", "preview-x.glb", "design.conflict.json", "preview-3.glb.tmp"]) writeFileSync(join(dir, ".cache", n), "x");
  expect(previewRevs(dir)).toEqual([1, 2, 9, 10]);
  expect(prunePreviews(dir, 2)).toEqual([1, 2]);
  expect(readdirSync(join(dir, ".cache")).sort()).toEqual(["design.conflict.json", "preview-10.glb", "preview-3.glb.tmp", "preview-9.glb", "preview-x.glb"]);
  expect(newestPreview({ key: dir, dir, worktree: repo, part: "p" })).toEqual({ rev: 10, path: "cad/p/.cache/preview-10.glb" });
  expect(previewRevs(join(repo, "cad", "nope"))).toEqual([]);
});

test("[A3] an empty design has no preview and no error", async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, fake);
  await x.tools.open_part!({ part: "empty" });
  // A parameter and nothing else: a change (so a refresh runs) with no body to draw.
  expect((await x.tools.execute!({ command: "parameters.add", params: { name: "L", expression: "80 mm" } })).isError).toBe(false);
  const gate = await x.tools.check_part!({ part: "empty" });
  expect(gate.isError).toBe(false);
  const ev = x.design("empty");
  expect(ev.preview).toBeUndefined();
  expect(ev.rev).toBeGreaterThan(0);
  const snap = x.service.snapshot(partRef(repo, "empty"))!;
  expect(snap.outcome.previewError).toBeUndefined();
  expect(existsSync(cache(repo, "empty")) ? previews(repo, "empty") : []).toEqual([]);
});

test("[A3] a failed export is reported on the outcome and never throws or writes a path", async () => {
  const repo = tempRepo();
  const ref = partRef(repo, "plate");
  const refused = await exportPreview(async () => ({ isError: true, text: "nothing to export: kernel said no", content: [] }) as any, ref, 4, ["Body"]);
  expect(refused).toEqual({ error: "nothing to export: kernel said no" });
  const threw = await exportPreview(async () => {
    throw new Error("process died");
  }, ref, 5, ["Body"]);
  expect(threw).toEqual({ error: "process died" });
  const silent = await exportPreview(async () => ({ isError: false, text: "{}", content: [] }) as any, ref, 6, ["Body"]); // said ok, wrote nothing
  expect(silent.preview).toBeUndefined();
  expect(silent.error).toBeTruthy();
  let called = false;
  expect(await exportPreview(async () => ((called = true), { isError: false, text: "", content: [] }) as any, ref, 7, [])).toEqual({});
  expect(called).toBe(false); // no bodies: SolidCraft is not even asked
});

test("[A3] after a daemon restart the next rev is above every preview left on disk, so the newest file is never pruned", async () => {
  const repo = tempRepo();
  const a = fakeCadSession(repo, fake);
  await a.tools.open_part!({ part: "plate" });
  for (let i = 0; i < 4; i++) {
    await a.tools.execute!(BOX(`B${i}`, 10));
    await a.tools.check_part!({ part: "plate" });
  }
  const before = a.design("plate").rev;
  await stopServices();

  const b = fakeCadSession(repo, fake, "sess_b"); // a new service: its memory of revisions is gone
  await b.tools.open_part!({ part: "plate" });
  await b.tools.check_part!({ part: "plate" });
  const ev = b.design("plate");
  expect(ev.rev).toBe(before + 1);
  expect(existsSync(join(repo, ev.preview))).toBe(true);
  expect(previews(repo, "plate")).toHaveLength(3);
});

test("[A3] busy: a request still running after BUSY_NOTICE_MS is announced with the same rev, and cleared when the queue drains", async () => {
  const repo = tempRepo();
  const clock = new FakeClock();
  const x = fakeCadSession(repo, { ...fake, manager: { clock } });
  const ref = partRef(repo, "plate");
  await x.tools.open_part!({ part: "plate" });
  await x.tools.execute!(BOX("B", 10));
  await x.tools.check_part!({ part: "plate" });
  await until(() => !x.manager.status(ref)!.busy, "idle");
  const rev = x.design("plate").rev;
  expect(x.design("plate").busy).toBe(false);
  const n = designs(x, "plate").length;

  let release!: () => void;
  const held = x.manager.run(ref, () => new Promise<void>((r) => (release = r)));
  await until(() => x.manager.status(ref)!.busy, "the job to start");
  clock.advance(BUSY_NOTICE_MS - 1);
  expect(designs(x, "plate")).toHaveLength(n); // a short request costs no event
  clock.advance(1);
  expect(designs(x, "plate")).toHaveLength(n + 1);
  expect(x.design("plate")).toMatchObject({ busy: true, rev });
  release();
  await held;
  await until(() => designs(x, "plate").length === n + 2, "the busy flag to clear");
  expect(x.design("plate")).toMatchObject({ busy: false, rev });
});

test('[A3] a panel edit while the cap is full waits for a slot, and cad.design says "waiting" until it gets one', async () => {
  const repo = tempRepo();
  const x = fakeCadSession(repo, { ...fake, manager: { maxProcs: 1 } });
  const [plate, other] = [partRef(repo, "plate"), partRef(repo, "other")];
  await x.tools.open_part!({ part: "plate" });
  await x.tools.batch!({ commands: [{ command: "parameters.add", params: { name: "L", expression: "80 mm" } }, { command: "solid.box", params: { length: "L", width: 50, height: 6, name: "Plate" } }] });
  await x.tools.check_part!({ part: "plate" });
  // The one slot is now taken by another part that is busy, so `plate` cannot evict it.
  await x.tools.open_part!({ part: "other" });
  await until(() => !x.manager.status(other)!.busy, "idle");
  expect(x.manager.status(plate)!.live).toBe(false);
  let release!: () => void;
  const held = x.manager.run(other, () => new Promise<void>((r) => (release = r)));
  await until(() => x.manager.status(other)!.busy, "the other part to be busy");

  const edit = x.service.setParam(repo, "plate", "L", "120");
  await until(() => x.manager.status(plate)!.waitingForSlot, "the edit to wait for a slot");
  await until(() => x.design("plate").waiting === true, "the UI to be told");
  expect(x.design("plate")).toMatchObject({ waiting: true, busy: true });
  let settled = false;
  void edit.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 50));
  expect(settled).toBe(false);

  release();
  await held;
  expect(await edit).toEqual({ ok: true });
  await until(() => !x.manager.status(plate)!.busy, "the queue to drain");
  const last = x.design("plate");
  expect(last.waiting).toBeUndefined();
  expect(last.by).toBe("panel");
  expect(last.params.find((p: any) => p.name === "L").value).toBe(120);
  expect(designs(x, "plate").some((e) => e.by === "panel" && !e.waiting)).toBe(true);
});
