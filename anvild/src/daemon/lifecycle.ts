/**
 * Restart-reason ledger + timestamped logging (arch §5 diagnostics). The daemon log lines were
 * untimestamped and carried no record of WHY a restart happened, so a churn of "listening" lines was
 * un-attributable: was it a deliberate `Update Anvil` / `kickstart -k`, or launchd's KeepAlive
 * respawning a process that crashed / was SIGKILLed / hit broken source on `bun run` off the live
 * checkout? This module answers that on the next start.
 *
 * Mechanism: a single `<stateDir>/lifecycle.json` holds the last known state. On start we read the
 * PRIOR run's final record and log it, then stamp this run `running`. Every graceful exit path
 * overwrites it with `exited` + a reason. So on the following start:
 *   • prior record `exited`  → the last process reached a shutdown handler = a DELIBERATE restart
 *     (SIGTERM from kickstart/update, SIGINT, an uncaught error we caught, or a failed bind).
 *   • prior record still `running` → it died WITHOUT reaching a handler = an ABNORMAL exit
 *     (SIGKILL/OOM, a parse/import error in the live checkout, or a forced launchd respawn).
 *   • no record → first start / fresh state dir.
 * This cleanly separates "someone/something updated or restarted it" from "it crashed and KeepAlive
 * brought it back", which is the distinction needed to explain hub flakiness.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version";

export type ExitReason = "SIGTERM" | "SIGINT" | "watchdog" | "uncaughtException" | "unhandledRejection" | "bind-failed";

interface LifecycleRecord {
  phase: "running" | "exited";
  pid: number;
  ppid: number; // who launched us — launchd vs a stray shell/worktree run
  version: string;
  managed: string; // ANVIL_MANAGED ("launchd"/"systemd"/"") — unmanaged runs never respawn
  startedAt: string;
  exitedAt?: string;
  uptimeMs?: number;
  reason?: ExitReason;
  detail?: string;
}

const ledgerPath = (stateDir: string): string => join(stateDir, "lifecycle.json");

// This run's start, captured by recordStart, so recordExit can report uptime + the same startedAt.
let startedMs = 0;
let startedAtIso = "";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function safeWrite(path: string, rec: LifecycleRecord): void {
  try {
    writeFileSync(path, `${JSON.stringify(rec)}\n`);
  } catch {
    /* logging must never break startup/shutdown */
  }
}

/**
 * Log how the PRIOR run ended (from the on-disk ledger), then stamp this run as `running`. Call once,
 * early in startup, after the state dir is known. Returns the prior record for callers that want it.
 */
export function recordStart(stateDir: string, log: (m: string) => void = console.log, warn: (m: string) => void = console.warn): LifecycleRecord | undefined {
  startedMs = Date.now();
  startedAtIso = new Date(startedMs).toISOString();
  const path = ledgerPath(stateDir);

  let prior: LifecycleRecord | undefined;
  try {
    if (existsSync(path)) prior = JSON.parse(readFileSync(path, "utf8")) as LifecycleRecord;
  } catch {
    /* corrupt/partial ledger — treat as no record */
  }

  if (!prior) {
    log(`[lifecycle] no prior run record (first start or fresh state dir); this pid ${process.pid}, ppid ${process.ppid}, ${VERSION}`);
  } else if (prior.phase === "exited") {
    const lived = prior.uptimeMs != null ? `, ran ${fmtDur(prior.uptimeMs)}` : "";
    log(
      `[lifecycle] prior run (pid ${prior.pid}, ${prior.version}) exited CLEANLY via ${prior.reason ?? "?"}` +
        `${prior.detail ? ` (${prior.detail})` : ""}${lived}, ended ${prior.exitedAt ?? "?"} — a deliberate restart.`,
    );
  } else {
    // Still `running` in the ledger → the previous process never reached a shutdown handler.
    warn(
      `[lifecycle] prior run (pid ${prior.pid}, ${prior.version}, started ${prior.startedAt}) did NOT exit cleanly — ` +
        `crash / SIGKILL / OOM, broken source on \`bun run\`, or a forced launchd respawn. This was NOT a graceful update.`,
    );
  }

  safeWrite(path, {
    phase: "running",
    pid: process.pid,
    ppid: process.ppid,
    version: VERSION,
    managed: process.env.ANVIL_MANAGED ?? "",
    startedAt: startedAtIso,
  });
  return prior;
}

/** Stamp the ledger `exited` with its reason. Call from every graceful shutdown path so the NEXT start
 *  can tell a deliberate restart from an abnormal one. Last write wins (a later, more-specific reason —
 *  e.g. the watchdog forcing exit — supersedes the signal). */
export function recordExit(stateDir: string, reason: ExitReason, detail?: string): void {
  safeWrite(ledgerPath(stateDir), {
    phase: "exited",
    pid: process.pid,
    ppid: process.ppid,
    version: VERSION,
    managed: process.env.ANVIL_MANAGED ?? "",
    startedAt: startedAtIso || new Date().toISOString(),
    exitedAt: new Date().toISOString(),
    uptimeMs: startedMs ? Date.now() - startedMs : undefined,
    reason,
    detail,
  });
}

/** Prefix every daemon log line with an ISO timestamp so restart cadence + event timing are legible in
 *  the launchd log (previously bare lines like "[todoist] replicated token" couldn't be timed). The
 *  daemon's stdout/stderr is only ever the launchd log file — nothing parses it — so a prefix is safe.
 *  Call once, first thing in main, before anything logs. */
export function installTimestampedConsole(): void {
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]): void => orig(`[${new Date().toISOString()}]`, ...args);
  }
}
