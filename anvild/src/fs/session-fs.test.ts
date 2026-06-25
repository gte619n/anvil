import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNotFound, locateInside } from "./session-fs";

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
