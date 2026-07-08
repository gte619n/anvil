import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordStart, recordExit } from "../../src/daemon/lifecycle";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "anvil-life-"));
}
const ledger = (dir: string): { phase: string; reason?: string; pid: number; uptimeMs?: number } =>
  JSON.parse(readFileSync(join(dir, "lifecycle.json"), "utf8"));

// Silence the module's own console output and capture which channel it used (log = deliberate/first
// start, warn = abnormal prior exit) so we can assert the classification without noise.
function capture(fn: () => void): { log: string[]; warn: string[] } {
  const out = { log: [] as string[], warn: [] as string[] };
  const rec = (arr: string[]) => (m: string) => arr.push(m);
  recordStartSpy = { log: rec(out.log), warn: rec(out.warn) };
  fn();
  recordStartSpy = undefined;
  return out;
}
let recordStartSpy: { log: (m: string) => void; warn: (m: string) => void } | undefined;
const start = (dir: string): void => {
  recordStart(dir, (m) => recordStartSpy?.log(m), (m) => recordStartSpy?.warn(m));
};

test("first start has no prior record and stamps this run running", () => {
  const dir = tmp();
  try {
    const out = capture(() => start(dir));
    expect(out.warn).toHaveLength(0);
    expect(out.log.join("\n")).toContain("no prior run record");
    expect(ledger(dir).phase).toBe("running");
    expect(ledger(dir).pid).toBe(process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean exit is reported as a DELIBERATE restart on the next start", () => {
  const dir = tmp();
  try {
    start(dir); // run A boots
    recordExit(dir, "SIGTERM"); // run A gets kickstart -k'd
    expect(ledger(dir).phase).toBe("exited");
    expect(ledger(dir).reason).toBe("SIGTERM");
    expect(typeof ledger(dir).uptimeMs).toBe("number");

    const out = capture(() => start(dir)); // run B boots, reads run A's clean exit
    expect(out.warn).toHaveLength(0);
    expect(out.log.join("\n")).toMatch(/exited CLEANLY via SIGTERM.*deliberate restart/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that never recorded an exit is flagged ABNORMAL (crash/SIGKILL/respawn)", () => {
  const dir = tmp();
  try {
    start(dir); // run A boots …and dies without ever calling recordExit (SIGKILL / bun parse error)
    expect(ledger(dir).phase).toBe("running"); // ledger still says running — the tell

    const out = capture(() => start(dir)); // run B boots
    expect(out.log.join("\n")).not.toContain("CLEANLY");
    expect(out.warn.join("\n")).toMatch(/did NOT exit cleanly.*NOT a graceful update/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bind-failed and watchdog are recordable exit reasons", () => {
  const dir = tmp();
  try {
    recordExit(dir, "bind-failed", "port 7701 in use");
    expect(ledger(dir).reason).toBe("bind-failed");
    recordExit(dir, "watchdog", "exceeded 4s"); // last write wins
    expect(ledger(dir).reason).toBe("watchdog");
    expect(existsSync(join(dir, "lifecycle.json"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
