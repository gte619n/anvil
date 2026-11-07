// Isolates the occt-import-js call in a Bun Worker thread for crash containment + a hard timeout
// (DL-8). A malformed B-rep can send OCCT into an unbounded loop or a native crash; running it in a
// worker lets us terminate() it without taking the daemon down. If worker spawn is unavailable we
// fall back to an in-process run that still honors timeoutMs via Promise.race (see below).

import { CadConvertError } from "./types";

export interface OcctResult {
  root: unknown;
  meshes: unknown[];
}

type OcctKind = "step" | "iges" | "brep";

interface WorkerReply {
  success: boolean;
  root?: unknown;
  meshes?: unknown[];
  error?: string;
}

/** Spawn the worker, post the bytes, race its reply against the timeout, terminate on timeout. */
function runInWorker(bytes: Uint8Array, kind: OcctKind, timeoutMs: number): Promise<OcctResult> {
  return new Promise<OcctResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./occt-worker.ts", import.meta.url).href, { type: "module" });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        // best-effort; worker may already be gone
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new CadConvertError("conversion timed out")));
    }, timeoutMs);

    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (msg && msg.success) {
        finish(() => resolve({ root: msg.root, meshes: msg.meshes ?? [] }));
      } else {
        finish(() => reject(new CadConvertError(msg?.error || "occt conversion failed")));
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      finish(() => reject(new CadConvertError(e.message || "occt worker crashed")));
    };

    worker.postMessage({ bytes, kind });
  });
}

/** In-process fallback: still bounded by timeoutMs via Promise.race (no crash containment). */
async function runInProcess(bytes: Uint8Array, kind: OcctKind, timeoutMs: number): Promise<OcctResult> {
  // occt-import-js is untyped; `any` confined here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: occtFactory } = (await import("occt-import-js")) as any;

  const work = (async (): Promise<OcctResult> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const occt: any = await occtFactory();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res: any;
    if (kind === "step") res = occt.ReadStepFile(u8, null);
    else if (kind === "iges") res = occt.ReadIgesFile(u8, null);
    else res = occt.ReadBrepFile(u8, null);
    if (!res || !res.success) throw new CadConvertError("occt failed to read the file");
    return { root: res.root, meshes: res.meshes ?? [] };
  })();

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CadConvertError("conversion timed out")), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Tessellate a B-rep file via occt-import-js. Prefers a Worker thread for crash containment;
 * falls back to in-process (timeout-only) if the worker can't be constructed in this runtime.
 */
export async function runOcct(
  bytes: Uint8Array,
  kind: OcctKind,
  timeoutMs: number,
): Promise<OcctResult> {
  try {
    return await runInWorker(bytes, kind, timeoutMs);
  } catch (err) {
    // A genuine conversion/timeout failure must propagate — only a *spawn* failure falls back.
    if (err instanceof CadConvertError) throw err;
    return await runInProcess(bytes, kind, timeoutMs);
  }
}
