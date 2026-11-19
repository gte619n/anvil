/**
 * The closed classification of Playwright MCP 0.0.86's 25 default tools (agent-cad-and-browser §4.14
 * item 24; the table is the C0 evidence's). The gate knows a tool by its class; a `mcp__browser__*`
 * tool that is not in this table is denied, so a server upgrade that adds a tool adds nothing the
 * owner has not seen. Pure: no I/O except `uploadPathProblem`, which resolves symlinks.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type BrowserToolClass =
  /** Looks at the page; changes nothing. */
  | "read"
  /** Changes which page is shown. */
  | "navigation"
  /** Acts on the page: click, type, key, form, select, drag, hover, dialog, dropped text. */
  | "input"
  /** Sends a local file to the page. */
  | "upload"
  /** Runs model-written script in the page or in the server. */
  | "script"
  /** Housekeeping: close, resize, emulate media. */
  | "other";

const TABLE: Readonly<Record<string, BrowserToolClass | "by-action" | "by-payload">> = {
  browser_snapshot: "read",
  browser_take_screenshot: "read",
  browser_wait_for: "read",
  browser_console_messages: "read",
  browser_network_requests: "read",
  browser_network_request: "read",
  browser_find: "read",
  browser_tabs: "by-action",
  browser_navigate: "navigation",
  browser_navigate_back: "navigation",
  browser_click: "input",
  browser_type: "input",
  browser_press_key: "input",
  browser_fill_form: "input",
  browser_select_option: "input",
  browser_drag: "input",
  browser_hover: "input",
  browser_handle_dialog: "input",
  browser_drop: "by-payload",
  browser_file_upload: "upload",
  browser_evaluate: "script",
  browser_run_code_unsafe: "script",
  browser_close: "other",
  browser_resize: "other",
  browser_emulate_media: "other",
};

/** Every tool name the table knows (25). */
export const BROWSER_TOOL_NAMES: readonly string[] = Object.keys(TABLE);

export type BrowserToolVerdict = { cls: BrowserToolClass } | { deny: string };

const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/**
 * The class of one call, or why it is refused outright. `browser_tabs` splits on `action`
 * (`list` reads; `new`, `select` and `close` navigate) and `browser_drop` on its payload (`paths`
 * uploads; `data` is input).
 */
export function classifyBrowserTool(tool: string, input: Record<string, unknown>): BrowserToolVerdict {
  const entry = Object.hasOwn(TABLE, tool) ? TABLE[tool] : undefined;
  if (!entry) return { deny: `${tool} is not a browser tool Anvil knows (Playwright MCP's tool list is closed at the version Anvil pins)` };
  if (entry === "by-action") {
    const action = input.action;
    if (action === "list") return { cls: "read" };
    if (action === "new" || action === "select" || action === "close") return { cls: "navigation" };
    return { deny: `${tool}: unknown action ${JSON.stringify(action)}` };
  }
  if (entry === "by-payload") {
    if (input.paths !== undefined) return nonEmptyList(input.paths) ? { cls: "upload" } : { deny: `${tool}: paths must be a non-empty list` };
    if (input.data !== undefined) return { cls: "input" };
    return { deny: `${tool} needs either data or paths` };
  }
  return { cls: entry };
}

/**
 * Why a `filename` argument is refused, or undefined. Several read tools write a file under the
 * workspace root when given `filename`; an absolute path or one with `..` could put it anywhere.
 * Looks at every `filename` key at any depth.
 */
export function filenameProblem(input: unknown, depth = 0): string | undefined {
  if (!input || typeof input !== "object" || depth > 6) return undefined;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "filename" && v !== undefined && v !== null) {
      if (typeof v !== "string") return "filename must be a string";
      if (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("~")) return "filename must be a relative path (it is written inside the browser's output folder)";
      if (v.split(/[\\/]/).includes("..")) return 'filename must not contain ".."';
      if (v.includes("\0")) return "filename is not valid";
    } else if (v && typeof v === "object") {
      const inner = filenameProblem(v, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** The local paths an upload call would send (`browser_file_upload {paths}`, `browser_drop {paths}`). */
export function uploadPaths(input: Record<string, unknown>): string[] | undefined {
  const p = input.paths;
  if (!Array.isArray(p) || !p.length || p.some((x) => typeof x !== "string" || !x)) return undefined;
  return p as string[];
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Why `path` may not be uploaded from a session whose worktree is `worktree`, or undefined. The path
 * (relative ones resolve against the worktree) must be inside the worktree after symlinks are
 * resolved, so a link in the repo that points at `~/.ssh` does not pass.
 */
export function uploadPathProblem(path: string, worktree: string): string | undefined {
  const root = realOrSelf(resolve(worktree));
  const real = realOrSelf(resolve(worktree, path));
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${path} is outside this session's worktree`;
  return undefined;
}
