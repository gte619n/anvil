// Builds the CadIo data-access object the viewer modules consume (cad.ts, cad-ecad.ts), so they
// never reach into fleet/WS internals. Pure glue over fleet's REST helpers + an injected directory
// lister. See docs/plans/2026-11-06-cad-viewer.md §3.3 and DL-5 (all over REST, no protocol change).
import type { CadIo, CadLocateResult } from "./cad-types";
import { attachImageBlob } from "./composer";
import { serverApiUrl, serverFetch, wireSessionId, type Server } from "./fleet";

function filesPath(sid: string, path: string): string {
  return `/api/sessions/${sid}/files?path=${encodeURIComponent(path)}`;
}

/** Reject a non-OK fetch with the server's message instead of handing the error body (e.g. a 404
 *  "not found") to a binary loader — a truncated/HTML body makes STLLoader throw the opaque "Offset
 *  is outside the bounds of the DataView" (and "Download original" then 404s too). Surfaces the real
 *  reason in the viewer's error card. */
async function okOrThrow(resP: Promise<Response>, path: string): Promise<Response> {
  const res = await resP;
  if (!res.ok) {
    const msg = (await res.text().catch(() => "")).trim();
    throw new Error(`Couldn't load ${path.split("/").pop() || path} — ${msg || res.statusText || res.status}`);
  }
  return res;
}

// A monotonic-ish suffix so repeated snapshots don't 409 against the no-overwrite PUT route.
let snapSeq = 0;

export function makeCadIo(opts: {
  /** The server owning the session (main's `activeServer`). */
  server: () => Server;
  /** The raw active session id (main's `activeId`); wired to the protocol id here. */
  sessionId: () => string;
  /** Lists bare entry names in a worktree directory (injected; omit for single-file contexts). */
  listDir?: (dir: string) => Promise<string[]>;
}): CadIo {
  const base = (): string => opts.server().url;
  const sid = (): string => wireSessionId(opts.sessionId());
  return {
    locate: async (p): Promise<CadLocateResult> => {
      // A miss/forbidden just falls back to treating the path as concrete — the subsequent load then
      // surfaces the real reason in the error card rather than swallowing it here.
      const res = await serverFetch(base(), `/api/sessions/${sid()}/locate?path=${encodeURIComponent(p)}`);
      if (!res.ok) return { kind: "file", path: p };
      return (await res.json()) as CadLocateResult;
    },
    fileUrl: (p) => serverApiUrl(base(), filesPath(sid(), p)),
    cadUrl: (p, lod) => serverApiUrl(base(), `/api/sessions/${sid()}/cad?path=${encodeURIComponent(p)}&lod=${lod}`),
    gerberUrl: (p, side) => serverApiUrl(base(), `/api/sessions/${sid()}/cad-gerber?path=${encodeURIComponent(p)}&side=${side}`),
    fetchBytes: async (p) => new Uint8Array(await (await okOrThrow(serverFetch(base(), filesPath(sid(), p)), p)).arrayBuffer()),
    fetchText: async (p) => (await okOrThrow(serverFetch(base(), filesPath(sid(), p)), p)).text(),
    listSiblings: async (p) => {
      if (!opts.listDir) return [];
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      return opts.listDir(dir);
    },
    // Save-to-project: PUT the PNG into a `snapshots/` folder. The route refuses overwrite (409), so
    // a unique suffix keeps repeated captures from colliding. Returns the written worktree path.
    saveSnapshot: async (name, png) => {
      const stem = name.replace(/\.png$/i, "");
      const rel = `snapshots/${stem}-${++snapSeq}.png`;
      const res = await serverFetch(base(), filesPath(sid(), rel), { method: "PUT", body: png });
      if (!res.ok) throw new Error((await res.text()) || `save failed (${res.status})`);
      const j = (await res.json().catch(() => ({}))) as { path?: string };
      return j.path ?? rel;
    },
    // Insert-into-chat: add the PNG to the composer as a pending attachment (rides the next message).
    insertSnapshot: async (name, png) => {
      await attachImageBlob(name, png);
    },
  };
}
