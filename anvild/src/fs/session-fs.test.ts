import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileExists, FileNotFound, listDir, locateInside, writeFile } from "./session-fs";

// locateInside is the forgiving resolver behind fs.read: Claude names a markdown file by basename in
// prose (`design.md`) while it lives in a subdir (`docs/plans/design.md`). A click sends the bare
// name; the daemon must still find it instead of throwing ENOENT as an "internal error" toast. When a
// bare name is genuinely ambiguous (2+ paths) it returns `choices` for the client to pick from.
describe("locateInside", () => {
  let root: string;
  beforeAll(() => {
    // realpath so the root mirrors a production worktree cwd (not under a /var→/private symlink)
    root = realpathSync(mkdtempSync(join(tmpdir(), "anvil-fs-")));
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "packages", "api"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# top\n");
    writeFileSync(join(root, "docs", "plans", "design.md"), "# design\n");
    writeFileSync(join(root, "docs", "plans", "anvil-impl-5-apple-clients.md"), "# apple\n");
    writeFileSync(join(root, "packages", "api", "design.md"), "# other design\n");
    writeFileSync(join(root, "node_modules", "pkg", "design.md"), "# decoy\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("resolves a path that exists literally", () => {
    expect(locateInside(root, "README.md")).toEqual({ kind: "file", abs: join(root, "README.md") });
  });

  test("finds a bare basename that actually lives in a subdir", () => {
    expect(locateInside(root, "anvil-impl-5-apple-clients.md")).toEqual({ kind: "file", abs: join(root, "docs", "plans", "anvil-impl-5-apple-clients.md") });
  });

  test("strips a leading ./ before searching", () => {
    expect(locateInside(root, "./anvil-impl-5-apple-clients.md")).toEqual({ kind: "file", abs: join(root, "docs", "plans", "anvil-impl-5-apple-clients.md") });
  });

  test("a typed-out subpath disambiguates between same-named files", () => {
    expect(locateInside(root, "plans/design.md")).toEqual({ kind: "file", abs: join(root, "docs", "plans", "design.md") });
  });

  test("a bare basename matching 2+ files returns sorted choices (node_modules excluded)", () => {
    expect(locateInside(root, "design.md")).toEqual({ kind: "choices", paths: ["docs/plans/design.md", "packages/api/design.md"] });
  });

  test("throws FileNotFound for a name that isn't anywhere in the tree", () => {
    expect(() => locateInside(root, "does-not-exist.md")).toThrow(FileNotFound);
  });
});

// writeFile backs the file browser's drag-drop upload. It must confine writes to the worktree
// (same boundary as reads/downloads) and refuse to clobber an existing path (arch §8.1).
describe("writeFile", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "anvil-up-")));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "existing.txt"), "old\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("writes a new file into the worktree and reports its size", () => {
    const bytes = new TextEncoder().encode("hello upload");
    const res = writeFile(root, "sub/new.txt", bytes);
    expect(res).toEqual({ path: "sub/new.txt", size: bytes.byteLength });
    expect(readFileSync(join(root, "sub", "new.txt"), "utf8")).toBe("hello upload");
    // the new file shows up in a listing with a size + mtime detail
    const entry = listDir(root, "sub").entries.find((e) => e.name === "new.txt");
    expect(entry?.size).toBe(bytes.byteLength);
    expect(typeof entry?.mtime).toBe("number");
  });

  test("refuses to overwrite an existing path", () => {
    expect(() => writeFile(root, "existing.txt", new Uint8Array([1]))).toThrow(FileExists);
    expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("old\n"); // untouched
  });

  test("refuses a path that escapes the worktree", () => {
    expect(() => writeFile(root, "../escape.txt", new Uint8Array([1]))).toThrow(/escapes/);
  });
});
