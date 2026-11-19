/**
 * The CAD rules of the protected check (agent-cad-and-browser spec §4.4). They run at the top of the
 * permission gate — before the remembered-allow lookup and before `bypass` — so no autonomy policy
 * and no earlier "always allow" can wave these through:
 *
 *  ALWAYS DENY
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to `cad/<part>/part.json` in the session's
 *     worktree. The file is written by the anvil_cad tools only.
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to ANYTHING under the daemon's state dir —
 *     the lock store, the session store, credentials — whatever the path looks like (relative, through
 *     a symlink). The only folders under it a session may write in are the ones it works in: the
 *     session worktrees root and the cloned-repos folder.
 *   - Bash commands that mention the daemon's own CAD and browser state (`<stateDir>/cadwork`,
 *     `<stateDir>/solidcraft`, `<stateDir>/browser-profile`) or `solidcraft-cli`, or that pass
 *     `--remote-debugging-port` or `--user-data-dir`.
 *  ALWAYS PROMPT (no "always allow"; denied when nobody is there to answer)
 *   - `Edit` / `Write` / `MultiEdit` to `cad/rules.json`.
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to `cad/<part>/design.json`: the script is
 *     written by the daemon; a hand edit is the owner's to allow, each time.
 *  OWNER CARD (the tool's own typed card is the prompt; denied when unattended)
 *   - `propose_expectations`. (`record_expectations` parks the same kind of card itself, but only
 *     for a part that already has geometry — see `CadworkService.recordExpectations`.)
 *
 * The Bash patterns are a tripwire, not a wall: a determined command can avoid them. What the gate
 * relies on is the lock store — a `part.json` or `rules.json` written by any route the daemon did
 * not approve leaves a hash the store does not know (spec §6).
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gitToplevel } from "../cadwork/partfolder";
import { CAD_OWNER_CARD_TOOL_IDS } from "./cad-tool-ids";
import { registerProtectedRule, type ProtectedContext, type ProtectedRule, type ProtectedVerdict } from "./protected";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Folders under the daemon's state dir that an agent's shell must stay out of. */
export const PROTECTED_STATE_FOLDERS = ["cadwork", "solidcraft", "browser-profile"] as const;
const PART_JSON_RE = /^cad\/[^/]+\/part\.json$/;
const DESIGN_JSON_RE = /^cad\/[^/]+\/design\.json$/;

/** State dirs of the daemons in this process (one in production; several in tests), each with the
 *  folders under it that sessions may write in. */
const stateDirs = new Map<string, string[]>();
const roots = new Map<string, string>();

/** Resolve symlinks on the deepest existing ancestor and keep the rest (the file may not exist yet). */
function realish(p: string): string {
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  try {
    return join(realpathSync(dir), ...rest);
  } catch {
    return resolve(p);
  }
}

function worktreeRoot(cwd: string): string {
  let root = roots.get(cwd);
  if (root === undefined) {
    root = gitToplevel(cwd) ?? realish(cwd);
    if (roots.size > 500) roots.clear();
    roots.set(cwd, root);
  }
  return root;
}

/** The target of a file tool, relative to the session's worktree, lower-cased (macOS file names are
 *  case-insensitive, so `cad/plate/PART.JSON` is the same file). Undefined when outside it. */
function targetInWorktree(ctx: ProtectedContext): string | undefined {
  const raw = ctx.input.file_path ?? ctx.input.notebook_path ?? ctx.input.path;
  if (typeof raw !== "string" || !raw) return undefined;
  const abs = realish(isAbsolute(raw) ? raw : resolve(ctx.cwd, raw));
  const rel = relative(worktreeRoot(ctx.cwd), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split("\\").join("/").toLowerCase();
}

const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.replace(/\/+$/, "") + "/");

/**
 * Why a file tool's target is off limits because it is inside a daemon's state dir, or undefined.
 * The target is resolved the way the write would be: a relative path against the session's cwd, and
 * symlinks of the nearest existing ancestor followed.
 */
export function refusedStatePath(rawPath: unknown, cwd: string, dirs: Iterable<[string, string[]]> = stateDirs): string | undefined {
  if (typeof rawPath !== "string" || !rawPath) return undefined;
  const abs = realish(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath));
  for (const [dir, writable] of dirs) {
    const root = realish(dir);
    if (!under(abs, root)) continue;
    if (writable.some((w) => under(abs, realish(w)) && abs !== realish(w))) continue; // inside a session worktree or a cloned repo
    return "the daemon's state folder is not a session's to edit (it holds the approvals, the session store and credentials)";
  }
  return undefined;
}

/** Why a shell command is refused, or undefined. */
export function refusedBash(command: string, dirs: Iterable<string> = stateDirs.keys()): string | undefined {
  if (/solidcraft-cli/i.test(command)) return "running solidcraft-cli from a shell is not allowed: use the anvil_cad tools, which run SolidCraft through the daemon";
  if (/--remote-debugging-port\b/i.test(command)) return "`--remote-debugging-port` is not allowed in a session shell: it opens a browser to remote control";
  if (/--user-data-dir\b/i.test(command)) return "`--user-data-dir` is not allowed in a session shell: browser profiles are the daemon's";
  const home = homedir();
  for (const dir of dirs) {
    const forms = new Set<string>([dir]);
    try {
      forms.add(realpathSync(dir));
    } catch {
      /* not there yet */
    }
    for (const d of [...forms]) {
      if (home && (d === home || d.startsWith(home + "/"))) {
        const tail = d.slice(home.length);
        forms.add(`~${tail}`);
        forms.add(`$HOME${tail}`);
        forms.add(`\${HOME}${tail}`);
      }
    }
    for (const d of forms) {
      for (const folder of PROTECTED_STATE_FOLDERS) {
        if (command.includes(`${d.replace(/\/+$/, "")}/${folder}`)) return `the daemon's ${folder} folder is off limits to session shells`;
      }
    }
  }
  return undefined;
}

export const cadProtectedRule: ProtectedRule = (ctx): ProtectedVerdict => {
  if (FILE_TOOLS.has(ctx.tool)) {
    const state = refusedStatePath(ctx.input.file_path ?? ctx.input.notebook_path ?? ctx.input.path, ctx.cwd);
    if (state) return { kind: "deny", reason: state };
    const rel = targetInWorktree(ctx);
    if (rel && PART_JSON_RE.test(rel)) {
      return { kind: "deny", reason: `${rel} is written by the anvil_cad tools only: use record_expectations to set a part's expectations and propose_expectations to change them` };
    }
    if (rel && DESIGN_JSON_RE.test(rel)) {
      return { kind: "always-prompt", reason: `${rel} is the part's script, written by the daemon after every change: a hand edit replaces the design itself`, label: "Allow this edit", denyWhenUnattended: true };
    }
    if (rel === "cad/rules.json" && ctx.tool !== "NotebookEdit") {
      return { kind: "always-prompt", reason: "cad/rules.json sets the manufacturing limits every part is checked against", label: "Allow this edit", denyWhenUnattended: true };
    }
    return undefined;
  }
  if (ctx.tool === "Bash") {
    const command = typeof ctx.input.command === "string" ? ctx.input.command : "";
    const why = refusedBash(command);
    return why ? { kind: "deny", reason: why } : undefined;
  }
  if (CAD_OWNER_CARD_TOOL_IDS.includes(ctx.tool)) {
    return { kind: "owner-card", reason: "changing a part's locked expectations needs the owner's approval on its card" };
  }
  return undefined;
};

/**
 * Register the CAD rules for a daemon whose state lives in `stateDir`. Idempotent: the rule is one
 * function (registered once however many times this is called) and the state dirs are a set. Returns
 * a thunk that withdraws this state dir, and the rule with the last one.
 */
export function registerCadProtectedRules(stateDir: string, writable: string[] = [join(stateDir, "worktrees"), join(stateDir, "repos")]): () => void {
  stateDirs.set(stateDir, writable);
  unregister = registerProtectedRule(cadProtectedRule);
  return () => {
    stateDirs.delete(stateDir);
    if (stateDirs.size === 0) unregister?.();
  };
}
let unregister: (() => void) | undefined;

/** Test-only: withdraw the rule and forget every state dir and cached worktree root. */
export function resetCadProtectedForTest(): void {
  unregister?.();
  unregister = undefined;
  stateDirs.clear();
  roots.clear();
}
