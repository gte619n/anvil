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
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to anything under `cad/<part>/.cache/` (the
 *     daemon's previews, thumbnails and temp files — what the viewer shows) or `cad/<part>/release/`
 *     (release packs are daemon-written and HMAC-checked).
 *   - Bash commands that mention the daemon's own CAD and browser state (`<stateDir>/cadwork`,
 *     `<stateDir>/solidcraft`, `<stateDir>/browser-profile`) or `solidcraft-cli`, or that pass
 *     `--remote-debugging-port` or `--user-data-dir`.
 *  Every file-tool target is resolved by ONE resolver (./tool-paths.ts): `~` / `~/` expand to the
 *  daemon user's home as the CLI does, `~user` is refused outright, and comparisons ignore case
 *  and Unicode look-alikes (NFKC); a NEW name under `cad/` outside printable ASCII is denied.
 *  ALWAYS PROMPT (no "always allow"; denied when nobody is there to answer)
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to `cad/rules.json`.
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` to `cad/<part>/design.json`: the script is
 *     written by the daemon; a hand edit is the owner's to allow, each time.
 *  OWNER CARD (the tool's own typed card is the prompt; denied when unattended)
 *   - `propose_expectations`, `request_dimensions`, `release_part` (Phase A4). (`record_expectations` parks the same kind of card itself, but only
 *     for a part that already has geometry — see `CadworkService.recordExpectations`.)
 *
 * The Bash patterns are a tripwire, not a wall: a determined command can avoid them. What the gate
 * relies on is the lock store — a `part.json` or `rules.json` written by any route the daemon did
 * not approve leaves a hash the store does not know (spec §6).
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitToplevel } from "../cadwork/partfolder";
import { isUnder, newComponentsSafe, realish, relUnder, resolveToolPath, toolPathArg } from "./tool-paths";
import { CAD_OWNER_CARD_TOOL_IDS, cadToolId } from "./cad-tool-ids";
import { registerProtectedRule, type ProtectedContext, type ProtectedRule, type ProtectedVerdict } from "./protected";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Folders under the daemon's state dir that an agent's shell must stay out of. */
export const PROTECTED_STATE_FOLDERS = ["cadwork", "solidcraft", "browser-profile"] as const;
const PART_JSON_RE = /^cad\/[^/]+\/part\.json$/;
const DESIGN_JSON_RE = /^cad\/[^/]+\/design\.json$/;
/** Daemon-written folders of a part: previews, thumbnails, temp files; release packs. */
const DAEMON_DIR_RE = /^cad\/[^/]+\/(\.cache|release)(\/|$)/;

/** State dirs of the daemons in this process (one in production; several in tests), each with the
 *  folders under it that sessions may write in. */
const stateDirs = new Map<string, string[]>();
const roots = new Map<string, string>();

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
function targetInWorktree(abs: string, cwd: string): string | undefined {
  return relUnder(worktreeRoot(cwd), abs);
}

/** Inside a session's own folder under a writable root — never a file in the root itself. */
const insideWritable = (abs: string, root: string): boolean => {
  const rel = relUnder(realish(root), abs);
  return rel !== undefined && rel.includes("/");
};

/**
 * Why a file tool's target is off limits because it is inside a daemon's state dir, or undefined.
 * The target is resolved the way the write would be: a relative path against the session's cwd, and
 * symlinks of the nearest existing ancestor followed.
 */
export function refusedStatePath(rawPath: unknown, cwd: string, dirs: Iterable<[string, string[]]> = stateDirs): string | undefined {
  const r = resolveToolPath(rawPath, cwd);
  if (!r) return undefined;
  if (!r.ok) return r.reason;
  for (const [dir, writable] of dirs) {
    const root = realish(dir);
    if (!isUnder(r.abs, root)) continue;
    if (writable.some((w) => insideWritable(r.abs, w))) continue; // inside one session worktree or one cloned repo
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

const OWNER_CARD_REASON: Record<string, string> = {
  [cadToolId("propose_expectations")]: "changing a part's locked expectations needs the owner's approval on its card",
  [cadToolId("request_dimensions")]: "a concept part's dimensions are typed by the owner on their card",
  [cadToolId("release_part")]: "releasing a part needs the owner's approval on its release card",
};

export const cadProtectedRule: ProtectedRule = (ctx): ProtectedVerdict => {
  if (FILE_TOOLS.has(ctx.tool)) {
    const target = resolveToolPath(toolPathArg(ctx.input), ctx.cwd);
    if (!target) return undefined;
    if (!target.ok) return { kind: "deny", reason: target.reason };
    const state = refusedStatePath(target.abs, ctx.cwd);
    if (state) return { kind: "deny", reason: state };
    const rel = targetInWorktree(target.abs, ctx.cwd);
    // A NEW file or folder under cad/ must be named in printable ASCII: the volume folds Unicode look-
    // alikes (`ſ`, `K`, fullwidth letters, combining marks) onto protected names in ways no rule should
    // have to predict. Existing names are what the file system says they are (realpath).
    if (rel && (rel === "cad" || rel.startsWith("cad/")) && !newComponentsSafe(target.abs)) {
      return { kind: "deny", reason: `${JSON.stringify(toolPathArg(ctx.input))} creates a name under cad/ with characters outside printable ASCII; part folders and their files are named in plain ASCII` };
    }
    if (rel && DAEMON_DIR_RE.test(rel)) {
      return { kind: "deny", reason: `${rel} is in a folder the daemon writes (previews, thumbnails, release packs); it is not a session's to edit` };
    }
    if (rel && PART_JSON_RE.test(rel)) {
      return { kind: "deny", reason: `${rel} is written by the anvil_cad tools only: use record_expectations to set a part's expectations and propose_expectations to change them` };
    }
    if (rel && DESIGN_JSON_RE.test(rel)) {
      return { kind: "always-prompt", reason: `${rel} is the part's script, written by the daemon after every change: a hand edit replaces the design itself`, label: "Allow this edit", denyWhenUnattended: true };
    }
    if (rel === "cad/rules.json") {
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
    return { kind: "owner-card", reason: OWNER_CARD_REASON[ctx.tool] ?? "this needs the owner's approval on its card" };
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
