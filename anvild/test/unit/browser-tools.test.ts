/**
 * [C2] The closed tool classification for Playwright MCP 0.0.86 (agent-cad-and-browser §4.14 item 24;
 * the table is the C0 evidence's, written out again here so a change to either side shows).
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_TOOL_NAMES, classifyBrowserTool, filenameProblem, uploadPathProblem, uploadPaths } from "../../src/browser/tools";

const cls = (tool: string, input: Record<string, unknown> = {}) => {
  const v = classifyBrowserTool(tool, input);
  return "cls" in v ? v.cls : `deny`;
};

describe("classification", () => {
  test("[C2] the table is exactly the C0 one: 25 tools in six classes", () => {
    const expected: Record<string, string[]> = {
      read: ["browser_snapshot", "browser_take_screenshot", "browser_wait_for", "browser_console_messages", "browser_network_requests", "browser_network_request", "browser_find"],
      navigation: ["browser_navigate", "browser_navigate_back"],
      input: ["browser_click", "browser_type", "browser_press_key", "browser_fill_form", "browser_select_option", "browser_drag", "browser_hover", "browser_handle_dialog"],
      upload: ["browser_file_upload"],
      script: ["browser_evaluate", "browser_run_code_unsafe"],
      other: ["browser_close", "browser_resize", "browser_emulate_media"],
    };
    for (const [klass, tools] of Object.entries(expected)) for (const t of tools) expect([t, cls(t)]).toEqual([t, klass]);
    const split = ["browser_tabs", "browser_drop"];
    expect([...BROWSER_TOOL_NAMES].sort()).toEqual([...Object.values(expected).flat(), ...split].sort());
    expect(BROWSER_TOOL_NAMES).toHaveLength(25);
  });

  test("[C2] browser_tabs splits by action: list reads; new, select and close navigate; anything else is denied", () => {
    expect(cls("browser_tabs", { action: "list" })).toBe("read");
    expect(cls("browser_tabs", { action: "new", url: "https://a.test/" })).toBe("navigation");
    expect(cls("browser_tabs", { action: "new" })).toBe("navigation");
    expect(cls("browser_tabs", { action: "select", index: 1 })).toBe("navigation");
    expect(cls("browser_tabs", { action: "close" })).toBe("navigation");
    expect(cls("browser_tabs", {})).toBe("deny");
    expect(cls("browser_tabs", { action: "LIST" })).toBe("deny");
    expect(cls("browser_tabs", { action: ["list"] })).toBe("deny");
  });

  test("[C2] browser_drop splits by payload: data is input, paths is an upload (paths wins when both are given), neither is denied", () => {
    expect(cls("browser_drop", { data: { "text/plain": "hi" } })).toBe("input");
    expect(cls("browser_drop", { paths: ["a.step"] })).toBe("upload");
    expect(cls("browser_drop", { data: { "text/plain": "hi" }, paths: ["a.step"] })).toBe("upload");
    expect(cls("browser_drop", { paths: [] })).toBe("deny");
    expect(cls("browser_drop", {})).toBe("deny");
  });

  test("[C2] any tool not in the table is denied — a newer server's tools, opt-in capability tools, prototype names", () => {
    for (const t of ["browser_pdf_save", "browser_mouse_click_xy", "browser_install", "browser_verify_text_visible", "browser_start_tracing", "browser_cookie_set", "browser_route", "navigate", "", "constructor", "toString", "__proto__", "browser_navigate "]) {
      const v = classifyBrowserTool(t, {});
      expect("deny" in v).toBe(true);
    }
  });
});

describe("filename arguments", () => {
  test("[C2] a filename that is absolute or contains .. is refused, at any depth; a plain relative name is fine", () => {
    for (const filename of ["/etc/cron.d/x", "/tmp/out.png", "../out.png", "a/../../out.png", "..", "~/out.png", "C:\\out.png", "a/b/..", 42, { a: 1 }, "x\0y"]) {
      expect([filename, typeof filenameProblem({ filename })]).toEqual([filename, "string"]);
    }
    expect(typeof filenameProblem({ options: { filename: "../x" } })).toBe("string");
    expect(typeof filenameProblem({ fields: [{ filename: "/abs" }] })).toBe("string");
    for (const filename of ["shot.png", "out/page.yml", "a..b.png", "..hidden", undefined, null]) expect([filename, filenameProblem({ filename })]).toEqual([filename, undefined]);
    expect(filenameProblem({ url: "https://a.test/../x", element: "../" })).toBeUndefined(); // only the filename key
    expect(filenameProblem({})).toBeUndefined();
  });
});

describe("upload paths", () => {
  test("[C2] upload paths must resolve inside the session worktree — relative, absolute, .. and symlinks all checked on the real path", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "anvil-c2-up-")));
    try {
      const wt = join(root, "wt");
      mkdirSync(join(wt, "parts"), { recursive: true });
      writeFileSync(join(wt, "parts", "a.step"), "x");
      writeFileSync(join(root, "secret.txt"), "s");
      symlinkSync(join(root, "secret.txt"), join(wt, "link-out"));
      symlinkSync(join(wt, "parts", "a.step"), join(wt, "link-in"));

      expect(uploadPathProblem("parts/a.step", wt)).toBeUndefined();
      expect(uploadPathProblem(join(wt, "parts", "a.step"), wt)).toBeUndefined();
      expect(uploadPathProblem("link-in", wt)).toBeUndefined();
      expect(uploadPathProblem("not-there-yet.txt", wt)).toBeUndefined();

      for (const p of ["../secret.txt", join(root, "secret.txt"), "/etc/hosts", "parts/../../secret.txt", "link-out", ".", wt, "~/.ssh/id_ed25519".replace("~", "/Users/x")]) {
        expect([p, typeof uploadPathProblem(p, wt)]).toEqual([p, "string"]);
      }
      expect(uploadPathProblem(`${wt}-evil/x`, wt)).toMatch(/outside/); // a sibling whose name starts the same
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("[C2] uploadPaths reads a non-empty list of strings and nothing else", () => {
    expect(uploadPaths({ paths: ["a", "b"] })).toEqual(["a", "b"]);
    for (const paths of [undefined, [], "a", [1], [""], [null]]) expect(uploadPaths({ paths })).toBeUndefined();
  });
});
