/**
 * The CAD rules of the protected check (agent-cad-and-browser spec §4.4). They run at the top of the
 * permission gate — before the remembered-allow lookup and before `bypass` — so no autonomy policy
 * and no earlier "always allow" can wave these through:
 *
 *  ALWAYS DENY
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to `cad/<part>/part.json` in the session's
 *     worktree. The file is written by the anvil_cad tools only.
 *   - Bash commands that mention the daemon's own CAD and browser state (`<stateDir>/cadwork`,
 *     `<stateDir>/solidcraft`, `<stateDir>/browser-profile`) or `solidcraft-cli`, or that pass
 *     `--remote-debugging-port` or `--user-data-dir`.
 *  ALWAYS PROMPT (no "always allow"; denied when nobody is there to answer)
 *   - `Edit` / `Write` / `MultiEdit` to `cad/rules.json`.
 *  OWNER CARD (the tool's own typed card is the prompt; denied when unattended)
 *   - `propose_expectations`.
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

/** State dirs of the daemons in this process (one in production; several in tests). */
const stateDirs = new Set<string>();
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

/** Why a shell command is refused, or undefined. */
export function refusedBash(command: string, dirs: Iterable<string> = stateDirs): string | undefined {
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
    const rel = targetInWorktree(ctx);
    if (rel && PART_JSON_RE.test(rel)) {
      return { kind: "deny", reason: `${rel} is written by the anvil_cad tools only: use record_expectations to set a part's expectations and propose_expectations to change them` };
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
export function registerCadProtectedRules(stateDir: string): () => void {
  stateDirs.add(stateDir);
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
