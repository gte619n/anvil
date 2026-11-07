// DOM test: a CAD/image/markdown path mentioned in a rendered message becomes a clickable `.file-link`
// chip (which the conversation click handler routes to openFile → the CAD viewer / reader).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./dom-env";

beforeEach(() => installDom({ html: "<!doctype html><body><div id='composer'></div><div id='conversation'></div></body>" }));
afterEach(() => uninstallDom());

async function linkify(html: string): Promise<HTMLElement> {
  const { linkifyFilePaths } = await import("../../web/src/conversation");
  const root = document.createElement("div");
  root.innerHTML = html;
  linkifyFilePaths(root);
  return root;
}

describe("linkifyFilePaths (DOM)", () => {
  test("a CAD path becomes a .file-link chip with the path + a model icon", async () => {
    const root = await linkify("open <code>pcb/out/sync12_main.glb</code> now");
    const a = root.querySelector("a.file-link.path-file-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.dataset.path).toBe("pcb/out/sync12_main.glb");
    expect(a!.querySelector(".file-chip-icon")?.textContent).toBe("deployed_code"); // 3D cube
    expect(a!.textContent).toContain("pcb/out/sync12_main.glb");
  });

  test("an image path chip gets the image icon", async () => {
    const root = await linkify("see render.png");
    const a = root.querySelector("a.file-link") as HTMLAnchorElement | null;
    expect(a?.dataset.path).toBe("render.png");
    expect(a?.querySelector(".file-chip-icon")?.textContent).toBe("image");
  });

  test("leading ./ is stripped from data-path (fs.read is worktree-relative)", async () => {
    const root = await linkify("./out/part.step");
    expect((root.querySelector("a.file-link") as HTMLAnchorElement).dataset.path).toBe("out/part.step");
  });

  test("ordinary prose is left alone", async () => {
    const root = await linkify("let me step through the object plan");
    expect(root.querySelector("a.file-link")).toBeNull();
  });

  test("paths inside a fenced code block are not re-linkified", async () => {
    const root = await linkify("<pre><code>pcb/out/board.glb</code></pre>");
    expect(root.querySelector("a.file-link")).toBeNull();
  });
});
