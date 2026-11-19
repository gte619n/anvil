/**
 * Replaying one design script under one SolidCraft build, inside a sandbox.
 *
 * `solidcraft-cli eval` has no sandbox: on 0.44.1 a script step with a `path` writes that file
 * wherever it points. `mcp --in <script>` is no better — the `--allow-path` rule is not applied to
 * a script loaded at start (checked on 0.44.1: four out of four file-writing steps wrote outside).
 * What IS sandboxed is a tool call on a running server. So the replay here is:
 *
 *   solidcraft-cli mcp --headless --compact --allow-path <box>/work --require-allow-path
 *
 * with NO `--in`, in a new empty folder, with the environment exactly `PATH`, `TMPDIR`,
 * `SOLIDCRAFT_GPU=cpu` and a throwaway `HOME` inside the box; then `batch {commands}` (a step that
 * names a file outside `<box>/work` is refused by the server and the whole batch rolled back),
 * `measure {}` and `inspect_design` for the timeline and parameter errors. The box is deleted
 * afterwards, whatever happened.
 *
 * This is the second layer. The first is ./script-screen.ts, which callers apply before this and
 * which refuses such a script outright; this layer is what holds if the screen is ever wrong.
 *
 * The JSON-RPC client is deliberately minimal and private to the replay.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxBuild {
  path: string;
  version: string;
}

/** What the server reported: the shape `solidcraft-cli eval` prints, assembled from two tool calls. */
export interface ReplayDocument {
  bodies: unknown[];
  body_count?: number;
  timeline: unknown[];
  params: unknown[];
}

export type SandboxedReplay =
  /** The script was replayed and the build reported on it (feature errors, if any, are in `doc`). */
  | { status: "replayed"; doc: ReplayDocument }
  /** The build ran and refused the script: a step it does not accept, or one the sandbox stopped. */
  | { status: "refused-by-build"; error: string }
  /** No verdict: the build could not be started, crashed, hung past the timeout, or spoke nonsense. */
  | { status: "could-not-run"; error: string };

export interface SandboxOptions {
  timeoutMs?: number;
  /** Where the box is made (a temp folder the caller owns). Default: the system temp folder. */
  tmpRoot?: string;
  /** `PATH` for the process. Nothing else is taken from the daemon's environment. */
  pathEnv?: string;
  /** Test seam: called with the box paths before the process starts. */
  onBox?: (box: { root: string; work: string; home: string; tmp: string }) => void;
}

export const SANDBOX_TIMEOUT_MS = 120_000;
const firstLine = (s: string): string => s.trim().split("\n").pop()?.slice(0, 400) ?? "";

interface Rpc {
  call(method: string, params?: unknown): Promise<{ result?: any; error?: { code: number; message: string } }>;
  notify(method: string): void;
}

/** The text blocks of a tool result, joined. */
function toolText(result: any): string {
  return Array.isArray(result?.content) ? result.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n") : "";
}

/**
 * Replay `commands` under `build` in a sandbox and return what the build measured. Never throws.
 * `scriptText` is written into the box as `work/design.json` (the only file there) for the record.
 */
export async function sandboxedReplay(build: SandboxBuild, scriptText: string, commands: unknown[], opts: SandboxOptions = {}): Promise<SandboxedReplay> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  let root: string;
  try {
    root = realpathSync(mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "sc-box-")));
  } catch (e) {
    return { status: "could-not-run", error: `could not make a sandbox folder: ${e instanceof Error ? e.message : String(e)}` };
  }
  const box = { root, work: join(root, "work"), home: join(root, "home"), tmp: join(root, "tmp") };
  let proc: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Kill the build AND anything it started: it leads its own process group. */
  const killAll = (): void => {
    const pid = proc?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  try {
    for (const d of [box.work, box.home, box.tmp]) mkdirSync(d);
    writeFileSync(join(box.work, "design.json"), scriptText);
    opts.onBox?.(box);

    let ended: string | undefined;
    const waiting = new Map<number, (m: any) => void>();
    const fail = (why: string): void => {
      ended ??= why;
      for (const resolve of waiting.values()) resolve({ dead: ended });
      waiting.clear();
    };
    let stderr = "";
    try {
      proc = spawn(build.path, ["mcp", "--headless", "--compact", "--allow-path", box.work, "--require-allow-path"], {
        cwd: box.work,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a timeout reaches whatever it started as well.
        detached: true,
        // Exactly these four. No credentials, no real HOME.
        env: { PATH: opts.pathEnv ?? "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: box.tmp, HOME: box.home, SOLIDCRAFT_GPU: "cpu" },
      });
    } catch (e) {
      return { status: "could-not-run", error: `could not start SolidCraft ${build.version}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const p = proc;
    exited = new Promise((resolve) => {
      p.once("error", (e) => {
        fail(`could not start SolidCraft ${build.version}: ${e.message}`);
        resolve(null);
      });
      p.once("exit", (code, signal) => {
        fail(`SolidCraft ${build.version} stopped (${signal ? `signal ${signal}` : `exit ${code}`})${stderr.trim() ? `: ${firstLine(stderr)}` : ""}`);
        resolve(code);
      });
    });
    p.stdin?.on("error", () => {}); // a build that dies mid-write must not raise EPIPE here
    p.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    // One message per line each way; replies are matched by id.
    let buf = "";
    p.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (typeof m?.id === "number") {
            waiting.get(m.id)?.(m);
            waiting.delete(m.id);
          }
        } catch {
          /* not a message */
        }
      }
    });
    timer = setTimeout(() => {
      fail(`SolidCraft ${build.version} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`);
      killAll();
    }, timeoutMs);

    let nextId = 1;
    const write = (msg: unknown): void => {
      try {
        p.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch (e) {
        fail(`could not write to SolidCraft ${build.version}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const rpc: Rpc = {
      call: (method, params) =>
        new Promise((resolve) => {
          if (ended) return resolve({ error: { code: -1, message: ended } });
          const id = nextId++;
          waiting.set(id, (m) => resolve(m.dead ? { error: { code: -1, message: m.dead } } : m));
          write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
        }),
      notify: (method) => write({ jsonrpc: "2.0", method }),
    };
    const cannot = (what: string, r: { error?: { message: string } }): SandboxedReplay => ({ status: "could-not-run", error: `${what}: ${r.error?.message ?? "no reply"}` });

    const init = await rpc.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anvil-replay", version: "1" } });
    if (!init.result) return cannot(`SolidCraft ${build.version} did not start`, init);
    rpc.notify("notifications/initialized");

    const batch = await rpc.call("tools/call", { name: "batch", arguments: { commands } });
    if (!batch.result) return cannot("the replay did not complete", batch);
    if (batch.result.isError) {
      // The build's own refusal: a step it does not accept, or one its sandbox stopped. The text is
      // JSON for a batch failure; fall back to it verbatim.
      let error = toolText(batch.result);
      try {
        const j = JSON.parse(error) as { failed?: { command?: string; error?: string; index?: number } };
        if (j.failed) error = `step ${(j.failed.index ?? 0) + 1} (${j.failed.command ?? "?"}): ${j.failed.error ?? "refused"}`;
      } catch {
        /* plain text */
      }
      return { status: "refused-by-build", error: error.slice(0, 600) };
    }

    const read = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | string> => {
      const r = await rpc.call("tools/call", { name, arguments: args });
      if (!r.result || r.result.isError) return r.result ? toolText(r.result) || `${name} failed` : (r.error?.message ?? `${name}: no reply`);
      try {
        const j = JSON.parse(toolText(r.result)) as Record<string, unknown>;
        if (j && typeof j === "object" && !Array.isArray(j)) return j;
      } catch {
        /* fall through */
      }
      return `${name} returned something that is not a JSON object`;
    };
    const measured = await read("measure", {});
    if (typeof measured === "string") return { status: "could-not-run", error: measured };
    const design = await read("inspect_design", { measure: false, sketches: false, timeline: "summary", bodies: true });
    if (typeof design === "string") return { status: "could-not-run", error: design };
    if (!Array.isArray(measured.bodies) || !Array.isArray(design.timeline) || !Array.isArray(design.params)) {
      return { status: "could-not-run", error: `SolidCraft ${build.version} answered without bodies, a timeline or parameters` };
    }
    return {
      status: "replayed",
      doc: { bodies: measured.bodies, ...(typeof measured.body_count === "number" ? { body_count: measured.body_count } : {}), timeline: design.timeline, params: design.params },
    };
  } catch (e) {
    return { status: "could-not-run", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      proc?.stdin?.end();
    } catch {
      /* already closed */
    }
    if (proc && exited) {
      // stdin EOF ends the server in a few ms; do not wait on one that will not go. Either way the
      // whole group is signalled, so nothing it started outlives the replay.
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2_000))]);
      if (!gone) killAll();
      else {
        try {
          process.kill(-proc.pid!, "SIGKILL"); // stragglers left in the group by a build that exited
        } catch {
          /* the group is empty */
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
