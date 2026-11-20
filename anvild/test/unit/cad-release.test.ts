/**
 * [A4] The release pack (agent-cad-and-browser spec §4.7): the file list, the manifest and its HMAC
 * with the per-machine key, `verifyRelease`, the spec sheet (escaping, one hole row per diameter,
 * hole centres), and the atomic re-release — against the fake SolidCraft.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holesFromPicks, mergeHoleTables, raysFor, type Cylinder } from "../../src/cadwork/holes";
import { partRef } from "../../src/cadwork/partfolder";
import { readDesign } from "../../src/cadwork/refresh";
import {
  escapeHtml,
  expectedReleaseFiles,
  holeRowsByDiameter,
  releaseFolderName,
  isOsLitter,
  releaseKey,
  specSheetHtml,
  specSheetMarkdown,
  verifyRelease,
  writeReleasePack,
  MANIFEST,
  NOT_A_DRAWING,
  type ReleaseData,
} from "../../src/cadwork/release";
import { cleanupTemp, fakeManager, stopManagers, tempDir, tempRepo } from "../helpers/cad-work";

afterEach(async () => {
  await stopManagers();
  cleanupTemp();
});

const png = Buffer.from("89504e470d0a1a0a", "hex");
const data = (more: Partial<ReleaseData> = {}): ReleaseData => ({
  part: "plate",
  scriptSha: "abcdef0123456789",
  solidcraft: "0.44.1",
  process: { id: "fdm-0.4", kind: "fdm", generalTolerance: "ISO 2768-m" },
  material: "PETG",
  bbox: [6, 50, 80],
  volume: 23335.167,
  bodies: 1,
  params: [
    { name: "L", expression: "80 mm", value: 80, unit: "mm" },
    { name: "W", expression: "50 mm", value: 50, unit: "mm" },
  ],
  holes: [{ diameter: 3.4, kind: "through", depth: 6, count: 4, counterbore: [{ diameter: 6.5, depth: 3.3 }], positions: [[32, 17, 3], [-32, 17, 3], [32, -17, 3], [-32, -17, 3]] }],
  checks: [{ id: "volume", expected: 23335.167, measured: 23335.167, ok: true, hard: true }],
  advisories: ["rules.minWall: advisory — SolidCraft cannot measure wall thickness"],
  references: [{ name: "motor.step", sha256: "f".repeat(64) }],
  approvedBy: "owner",
  createdAt: "2026-11-19T00:00:00.000Z",
  ...more,
});

async function plateWithBox(repo: string) {
  const m = fakeManager();
  const ref = partRef(repo, "plate");
  await m.request(ref, { tool: "execute", args: { command: "solid.box", params: { length: 80, width: 50, height: 6 } }, kind: "mutate" });
  return { m, ref };
}

describe("release pack", () => {
  test("[A4] a pack holds exactly the §4.7 files (3MF only for FDM); the manifest hashes every file and its HMAC verifies with this machine's key (created 0600)", async () => {
    const repo = tempRepo();
    const state = tempDir();
    const key = releaseKey(state);
    expect(statSync(join(state, "cadwork", "release.key")).mode & 0o777).toBe(0o600);
    expect(releaseKey(state).equals(key)).toBe(true); // created once
    const { m, ref } = await plateWithBox(repo);
    for (const kind of ["fdm", "cnc"]) {
      const d = data({ process: { id: kind === "fdm" ? "fdm-0.4" : "cnc-3axis", kind }, scriptSha: kind === "fdm" ? "1111111aaaa" : "2222222bbbb" });
      const out = await m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, d, (await readDesign((t, a) => slot.call(t, a))).designBodies, key));
      expect(out.dir).toBe(join(ref.dir, "release", releaseFolderName("plate", d.scriptSha)));
      expect(readdirSync(out.dir).sort()).toEqual(expectedReleaseFiles("plate", kind));
      const man = JSON.parse(readFileSync(join(out.dir, MANIFEST), "utf8"));
      for (const f of readdirSync(out.dir).filter((f) => f !== MANIFEST)) expect(man.files[f]).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(out.dir, f))).digest("hex"));
      expect(verifyRelease(out.dir, key)).toMatchObject({ ok: true });
      for (const v of ["iso", "front", "top", "right"]) expect(statSync(join(out.dir, `${v}.png`)).size).toBeGreaterThan(0);
    }
    expect(expectedReleaseFiles("plate", "cnc")).not.toContain("plate.3mf");
  });

  test("[A4] verifyRelease refuses an edited file, an extra or missing file, a renamed folder and another machine's key", async () => {
    const repo = tempRepo();
    const key = releaseKey(tempDir());
    const { m, ref } = await plateWithBox(repo);
    const out = await m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, data(), ["Body1"], key));
    expect(verifyRelease(out.dir, key).ok).toBe(true);
    expect(verifyRelease(out.dir, releaseKey(tempDir()))).toMatchObject({ ok: false, reason: "the manifest's HMAC does not verify on this machine" });
    writeFileSync(join(out.dir, "extra.txt"), "x");
    expect(verifyRelease(out.dir, key)).toMatchObject({ ok: false, reason: "the folder's files are not exactly the ones the manifest lists" });
    require("node:fs").rmSync(join(out.dir, "extra.txt"));
    const step = readFileSync(join(out.dir, "plate.step"), "utf8");
    writeFileSync(join(out.dir, "plate.step"), step + " ");
    expect(verifyRelease(out.dir, key)).toMatchObject({ ok: false, reason: "plate.step does not match its sha256 in the manifest" });
    writeFileSync(join(out.dir, "plate.step"), step);
    expect(verifyRelease(out.dir, key).ok).toBe(true);
    const moved = join(ref.dir, "release", "plate-9999999");
    require("node:fs").renameSync(out.dir, moved);
    expect(verifyRelease(moved, key)).toMatchObject({ ok: false, reason: "the folder is not named for the part and script the manifest describes" });
  });

  test("[A4] re-releasing the same script replaces the folder (old moved aside, new renamed in, old removed — nothing left over); a failing export writes nothing", async () => {
    const repo = tempRepo();
    const key = releaseKey(tempDir());
    const { m, ref } = await plateWithBox(repo);
    const first = await m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, data({ createdAt: "2026-01-01T00:00:00.000Z" }), ["Body1"], key));
    writeFileSync(join(first.dir, "stray"), "left over");
    const second = await m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, data({ createdAt: "2026-02-02T00:00:00.000Z" }), ["Body1"], key));
    expect(second.dir).toBe(first.dir);
    expect(existsSync(join(second.dir, "stray"))).toBe(false);
    expect(JSON.parse(readFileSync(join(second.dir, MANIFEST), "utf8")).createdAt).toBe("2026-02-02T00:00:00.000Z");
    expect(readdirSync(join(ref.dir, "release"))).toEqual([releaseFolderName("plate", data().scriptSha)]); // no temp or old folder left
    // A body that does not exist: the STEP cannot be written, and nothing new is left behind.
    await expect(m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, data({ scriptSha: "3333333cccc" }), ["NoSuchBody"], key))).rejects.toThrow("the STEP could not be written");
    expect(readdirSync(join(ref.dir, "release"))).toEqual([releaseFolderName("plate", data().scriptSha)]);
  });

  test("[A4] review: .DS_Store, ._* and Thumbs.db in a pack are ignored when verifying and never listed in a manifest", async () => {
    const repo = tempRepo();
    const key = releaseKey(tempDir());
    const { m, ref } = await plateWithBox(repo);
    const out = await m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, data(), ["Body1"], key));
    for (const f of [".DS_Store", "._plate.step", "._.DS_Store", "Thumbs.db", "thumbs.db"]) {
      expect(isOsLitter(f)).toBe(true);
      writeFileSync(join(out.dir, f), "litter");
    }
    expect(verifyRelease(out.dir, key)).toMatchObject({ ok: true });
    for (const f of ["plate.step", "manifest.json", "DS_Store", "x._y"]) expect(isOsLitter(f)).toBe(false);
    // A manifest that LISTS litter is not one this daemon wrote.
    const man = JSON.parse(readFileSync(join(out.dir, MANIFEST), "utf8"));
    expect(Object.keys(man.files).some(isOsLitter)).toBe(false);
    writeFileSync(join(out.dir, MANIFEST), JSON.stringify({ ...man, files: { ...man.files, ".DS_Store": "0".repeat(64) } }));
    expect(verifyRelease(out.dir, key).ok).toBe(false);
    // Litter in the folder being re-released is not carried into the new pack's manifest.
    writeFileSync(join(out.dir, MANIFEST), JSON.stringify(man));
    const again = await m.run(ref, async (slot) => writeReleasePack((t, a) => slot.call(t, a), ref, data({ createdAt: "2026-03-03T00:00:00.000Z" }), ["Body1"], key));
    expect(Object.keys(JSON.parse(readFileSync(join(again.dir, MANIFEST), "utf8")).files).some(isOsLitter)).toBe(false);
    expect(again.files.map((f) => f.split("/").at(-1)!).some(isOsLitter)).toBe(false);
  });

  test("[A4] the spec sheet is headed 'Not a drawing', escapes every user-derived string (a hostile part or parameter name stays text), and has one hole row per distinct diameter with centres", () => {
    const evil = data({
      part: "<script>alert(1)</script>",
      params: [{ name: '<img src=x onerror="alert(2)">', expression: "1 | 2 `x`", value: 1, unit: "mm" }],
      advisories: ["</li><script>alert(3)</script>"],
      references: [{ name: "a&b<c>.step", sha256: "0".repeat(64) }],
    });
    const html = specSheetHtml(evil, { iso: png, front: png, top: png, right: png });
    expect(html).toContain(`<h1>${NOT_A_DRAWING}</h1>`);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    expect(html).toContain("a&amp;b&lt;c&gt;.step");
    expect(html).toContain("default-src 'none'"); // nothing loads from anywhere
    expect((html.match(/<img /g) ?? []).length).toBe(4); // only the four embedded views
    const md = specSheetMarkdown(evil);
    expect(md.startsWith(`# ${NOT_A_DRAWING}`)).toBe(true);
    expect(md).not.toContain("<script>");
    expect(md).toContain("1 \\| 2 \\`x\\`");
    expect(escapeHtml(`'"&<>`)).toBe("&#39;&quot;&amp;&lt;&gt;");
    // One row per distinct diameter, however many kinds and stacks it has.
    const rows = holeRowsByDiameter([
      { diameter: 3.4, kind: "through", depth: 6, count: 4, positions: [[1, 2, 3]] },
      { diameter: 3.4, kind: "blind", depth: 3, count: 1, positions: [[4, 5, 6]] },
      { diameter: 5, kind: "through", depth: 6, count: 2 },
    ]);
    expect(rows.map((r) => [r.diameter, r.count])).toEqual([[3.4, 5], [5, 2]]);
    expect(rows[0]!.positions).toBe("(1, 2, 3) (4, 5, 6)");
  });

  test("[A4] the hole table can carry each hole's centre (on request only; rows are keyed without it)", () => {
    // Two coaxial-free through holes of the same diameter: one row, two centres.
    const cyl = (x: number): Cylinder => ({ axis: [0, 0, 1], extent: [0, 6], origin: [x, 0, 0], radius: 1.7 });
    const cyls = [cyl(10), cyl(-10)];
    // Every radial ray hits its own wall at one radius, facing back at the axis; axial rays miss.
    const hits = cyls.flatMap((c) => raysFor(c).map((r, i) => (i < 24 ? [{ body: "B", depth: 1.7, normal: [-r.dir[0], -r.dir[1], -r.dir[2]] as [number, number, number] }] : [])));
    const plain = holesFromPicks("B", cyls, hits);
    expect(plain).toEqual([{ diameter: 3.4, kind: "through", depth: 6, count: 2 }]);
    const withPos = holesFromPicks("B", cyls, hits, { positions: true });
    expect(withPos).toEqual([{ diameter: 3.4, kind: "through", depth: 6, count: 2, positions: [[10, 0, 3], [-10, 0, 3]] }]);
    expect(mergeHoleTables([withPos, withPos])[0]).toMatchObject({ count: 4, positions: [[10, 0, 3], [-10, 0, 3], [10, 0, 3], [-10, 0, 3]] });
  });
});
