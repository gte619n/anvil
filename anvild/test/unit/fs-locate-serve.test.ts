import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { Supervisor } from "../../src/session/supervisor";
import { FileNotFound } from "../../src/fs/session-fs";
import { ConnectionRegistry } from "../../src/server/registry";
import { AccountStore } from "../../src/auth/accounts";

// Regression for "3D model won't load from a chat link": the file-path chip linkifies the basename
// the agent names in prose (e.g. "mirror_riser_v3_preview.stl"), but the real file lives in a subdir.
// The reader (fsRead) already forgives that; the byte-serving endpoints (/files, /cad, /cad-gerber)
// used exact-only fsResolve and 404'd — handing the error body to STLLoader ("Offset is outside the
// bounds of the DataView") and 404ing "Download original". The endpoints now use fsLocate, which
// mirrors the reader's forgiving basename search.
const createCmd = (cwd: string) =>
  ({ v: PROTOCOL_VERSION, ts: "t", type: "session.create", source: "existing-dir", cwd }) as const;

function newSup(): { sup: Supervisor; dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anvil-fslocate-")));
  const accounts = new AccountStore(dir);
  const sup = new Supervisor({ stateDir: dir, accounts, envFile: join(dir, "env") }, new ConnectionRegistry());
  return { sup, dir };
}

test("fsLocate forgives a prose basename that lives in a subdir (fsResolve does not)", async () => {
  const { sup, dir } = newSup();
  mkdirSync(join(dir, "mirror-mount"), { recursive: true });
  const real = join(dir, "mirror-mount", "mirror_riser_v3_preview.stl");
  writeFileSync(real, "solid\n");
  const s = await sup.create(createCmd(dir));

  // Exact resolve points at the (non-existent) root path — the old 404 path.
  const exact = sup.fsResolve(s.data.id, "mirror_riser_v3_preview.stl");
  expect(existsSync(exact)).toBe(false);

  // Forgiving resolve finds it in the subdir — what the byte endpoints now use.
  const located = sup.fsLocate(s.data.id, "mirror_riser_v3_preview.stl");
  expect(located.kind).toBe("file");
  if (located.kind === "file") expect(located.abs).toBe(real);

  rmSync(dir, { recursive: true, force: true });
});

test("fsLocate returns choices for an ambiguous basename and throws when nothing matches", async () => {
  const { sup, dir } = newSup();
  mkdirSync(join(dir, "a"), { recursive: true });
  mkdirSync(join(dir, "b"), { recursive: true });
  writeFileSync(join(dir, "a", "part.stl"), "solid\n");
  writeFileSync(join(dir, "b", "part.stl"), "solid\n");
  const s = await sup.create(createCmd(dir));

  const located = sup.fsLocate(s.data.id, "part.stl");
  expect(located.kind).toBe("choices");
  if (located.kind === "choices") expect(located.paths.sort()).toEqual(["a/part.stl", "b/part.stl"]);

  expect(() => sup.fsLocate(s.data.id, "nope.stl")).toThrow(FileNotFound);

  rmSync(dir, { recursive: true, force: true });
});

// fsLocateRel powers the CAD viewer's pre-load disambiguation (/api/sessions/:id/locate): a resolved
// file comes back worktree-RELATIVE (not an abs disk path) so the client can re-request it unambiguously,
// and an ambiguous basename comes back as the candidate rel paths for the viewer's picker.
test("fsLocateRel returns a worktree-relative path for a resolved file", async () => {
  const { sup, dir } = newSup();
  mkdirSync(join(dir, "mirror-mount"), { recursive: true });
  writeFileSync(join(dir, "mirror-mount", "mirror_riser_v3_preview.stl"), "solid\n");
  const s = await sup.create(createCmd(dir));

  const located = sup.fsLocateRel(s.data.id, "mirror_riser_v3_preview.stl");
  expect(located).toEqual({ kind: "file", path: "mirror-mount/mirror_riser_v3_preview.stl" });

  rmSync(dir, { recursive: true, force: true });
});

test("fsLocateRel surfaces the ambiguous candidates (so the viewer can show a picker)", async () => {
  const { sup, dir } = newSup();
  mkdirSync(join(dir, "a"), { recursive: true });
  mkdirSync(join(dir, "b"), { recursive: true });
  writeFileSync(join(dir, "a", "part.stl"), "solid\n");
  writeFileSync(join(dir, "b", "part.stl"), "solid\n");
  const s = await sup.create(createCmd(dir));

  const located = sup.fsLocateRel(s.data.id, "part.stl");
  expect(located.kind).toBe("choices");
  if (located.kind === "choices") expect(located.paths.sort()).toEqual(["a/part.stl", "b/part.stl"]);

  rmSync(dir, { recursive: true, force: true });
});
