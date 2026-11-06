// Builds the CadIo data-access object the viewer modules consume (cad.ts, cad-ecad.ts), so they
// never reach into fleet/WS internals. Pure glue over fleet's REST helpers + an injected directory
// lister. See docs/plans/2026-11-06-cad-viewer.md §3.3 and DL-5 (all over REST, no protocol change).
import type { CadIo } from "./cad-types";
import { serverApiUrl, serverFetch, wireSessionId, type Server } from "./fleet";

function filesPath(sid: string, path: string): string {
  return `/api/sessions/${sid}/files?path=${encodeURIComponent(path)}`;
}

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
    fileUrl: (p) => serverApiUrl(base(), filesPath(sid(), p)),
    cadUrl: (p, lod) => serverApiUrl(base(), `/api/sessions/${sid()}/cad?path=${encodeURIComponent(p)}&lod=${lod}`),
    fetchBytes: async (p) => new Uint8Array(await (await serverFetch(base(), filesPath(sid(), p))).arrayBuffer()),
    fetchText: async (p) => (await serverFetch(base(), filesPath(sid(), p))).text(),
    listSiblings: async (p) => {
      if (!opts.listDir) return [];
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      return opts.listDir(dir);
    },
  };
}
