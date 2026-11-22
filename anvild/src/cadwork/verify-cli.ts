#!/usr/bin/env bun
/**
 * The merge guard on the command line (agent-cad-and-browser spec §4.11):
 *
 *   bun anvild/src/cadwork/verify-cli.ts [--changed-since REF] [--part NAME …] [--json]
 *
 * Run from anywhere inside a worktree. It replays each selected part's `design.json` in a fresh,
 * sandboxed SolidCraft process and checks it against what the owner approved (./verify.ts).
 *
 * EXIT CODES
 *   0  every selected part passes (a `concept` part is reported and does not fail)
 *   1  at least one part fails, is a gap, is unverified, or needs adopting
 *   2  could not run: not inside a git repo, no SolidCraft binary, a bad ref or argument, an
 *      unreadable lock store
 *
 * WHAT IT READS, NEVER WRITES
 *   - the worktree: `git rev-parse --show-toplevel` of the current folder
 *   - the daemon's state dir (`ANVIL_STATE_DIR`, default `~/.anvil`): the lock store
 *     `cadwork/locks.json` (opened read-only — no folder is created, a corrupt file is left where it
 *     is), the fleet pin `solidcraft-pin.json` and `server-id`
 *   - the binary: `resolveSolidcraftCli()`, after priming it with the pinned managed build when
 *     the state dir has one — the same build the daemon runs. There is no flag to name a binary.
 *
 * SAME-USER RISK (spec §6, decision 40). `ANVIL_SOLIDCRAFT_CLI` and `ANVIL_STATE_DIR` are read from
 * the environment, as the daemon reads them, so whoever runs this can point it at another binary or
 * another lock store. The guard is a check an agent runs on its own work; the autopilot's verify hook
 * (Phase B3) calls `verifyParts` in the daemon, with the daemon's own store and binary.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSolidcraftCli, setManagedSolidcraftCli } from "../solidcraft/binary";
import { installedSolidcraft } from "../solidcraft/install";
import { PIN_FILE, parsePin } from "../solidcraft/pin";
import { gitToplevel } from "./partfolder";
import { verifyParts, type VerifyResult } from "./verify";

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_CANNOT_RUN = 2;

export interface CliArgs {
  changedSince?: string;
  parts: string[];
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
  const out: CliArgs = { parts: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string | undefined => {
      const eq = a.indexOf("=");
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    if (a === "--json") out.json = true;
    else if (a === "--changed-since" || a.startsWith("--changed-since=")) {
      const v = value();
      if (!v) return { error: "--changed-since needs a git ref (e.g. --changed-since origin/main)" };
      out.changedSince = v;
    } else if (a === "--part" || a.startsWith("--part=")) {
      const v = value();
      if (!v) return { error: "--part needs a part name" };
      out.parts.push(v);
      // `--part a b c`: the names that follow, up to the next flag.
      while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") && a === "--part") out.parts.push(argv[++i]!);
    } else if (a === "-h" || a === "--help") return { error: "usage: bun anvild/src/cadwork/verify-cli.ts [--changed-since REF] [--part NAME …] [--json]" };
    else return { error: `unknown argument ${JSON.stringify(a)}. usage: bun anvild/src/cadwork/verify-cli.ts [--changed-since REF] [--part NAME …] [--json]` };
  }
  return out;
}

/** The daemon's state dir, as the daemon resolves it (config.ts): `ANVIL_STATE_DIR`, else `~/.anvil`. */
export function stateDirFrom(env: Record<string, string | undefined>, home = homedir()): string {
  const raw = env.ANVIL_STATE_DIR ?? "~/.anvil";
  return raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
}

/**
 * The binary, as the daemon would pick it. A pinned managed build installed in the state dir comes
 * first (after `ANVIL_SOLIDCRAFT_CLI`, exactly as `resolveSolidcraftCli` orders them). A pin with no
 * verified install is a machine the daemon would refuse CAD on: so does this.
 */
export function resolveBinary(stateDir: string, env: Record<string, string | undefined>): { path: string; source: string } | { error: string } {
  if (!env.ANVIL_SOLIDCRAFT_CLI?.trim()) {
    const pinFile = join(stateDir, PIN_FILE);
    if (existsSync(pinFile)) {
      let pin: ReturnType<typeof parsePin>;
      try {
        pin = parsePin(JSON.parse(readFileSync(pinFile, "utf8")));
      } catch {
        pin = undefined;
      }
      if (!pin) return { error: `${pinFile} is unreadable, so the fleet's SolidCraft build is unknown` };
      const have = installedSolidcraft(stateDir, pin.version, pin.sha256);
      if (!have) return { error: `the fleet pins SolidCraft ${pin.version}, which is not installed on this machine (the daemon installs it)` };
      setManagedSolidcraftCli({ path: have.path, version: have.version });
    }
  }
  const r = resolveSolidcraftCli(env);
  if (!r) return { error: "SolidCraft is not installed on this machine (no solidcraft-cli found)" };
  if (!existsSync(r.path)) return { error: `solidcraft-cli was not found at ${r.path}` };
  return { path: r.path, source: r.source };
}

function readServerId(stateDir: string): string | undefined {
  try {
    return readFileSync(join(stateDir, "server-id"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown): string => (typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : String(v));

/** The human-readable report. */
export function formatReport(r: VerifyResult, worktree: string): string {
  const lines: string[] = [];
  const sel = r.selection;
  const how = sel.all ? "every part" : [sel.named.length ? `--part ${sel.named.join(" ")}` : "", sel.changedSince !== undefined ? `changed since ${sel.changedSince}${sel.rulesChanged ? " (cad/rules.json changed: every part)" : ""}` : ""].filter(Boolean).join(" + ");
  lines.push(`CAD merge guard: ${worktree} — ${how}`);
  if (r.parts.length === 0) lines.push("  no parts to verify");
  const w = Math.max(4, ...r.parts.map((p) => p.part.length));
  if (r.parts.length) lines.push(`  ${"PART".padEnd(w)}  STATE       RESULT  DETAIL`);
  for (const p of r.parts) {
    const measured = p.measurement ? `volume ${num(p.measurement.volume)} mm³, box ${p.measurement.bbox.map(num).join(" × ")} mm` : "";
    // A plain failure is listed check by check below; any other reason (adoption, gap, concept) is said here.
    const detail = p.ok ? (p.reason ? `${p.reason}; ${measured}` : measured) : p.failing.length && p.reason?.startsWith("the gate fails") ? `${p.failing.length} check${p.failing.length === 1 ? "" : "s"} fail` : (p.reason ?? "");
    lines.push(`  ${p.part.padEnd(w)}  ${p.state.padEnd(10)}  ${p.ok ? "ok  " : "FAIL"}    ${detail}`);
    if (!p.ok) for (const f of p.failing) lines.push(`  ${" ".repeat(w)}    - ${f}`);
  }
  lines.push(r.ok ? "OK: every selected part passes." : "FAILED: do not commit this merge; fix or re-check the parts above.");
  return lines.join("\n");
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd(), out = (s: string) => console.log(s), err = (s: string) => console.error(s)): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    err(args.error);
    return EXIT_CANNOT_RUN;
  }
  const worktree = gitToplevel(cwd);
  if (!worktree) {
    err(`verify-cli: ${cwd} is not inside a git repository`);
    return EXIT_CANNOT_RUN;
  }
  const stateDir = stateDirFrom(env);
  const binary = resolveBinary(stateDir, env);
  if ("error" in binary) {
    err(`verify-cli: ${binary.error}`);
    return EXIT_CANNOT_RUN;
  }
  const result = await verifyParts({ worktree, parts: args.parts, changedSince: args.changedSince, stateDir, binary, machine: readServerId(stateDir) });
  if (args.json) out(JSON.stringify({ ...result, worktree, binary: binary.path }, null, 2));
  if (result.error) {
    err(`verify-cli: ${result.error}`);
    return EXIT_CANNOT_RUN;
  }
  if (!args.json) out(formatReport(result, worktree));
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verify-cli: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      process.exit(EXIT_CANNOT_RUN);
    },
  );
}
