// Live mode for the CAD viewer (agent-cad-and-browser spec §4.9, Phase A3): the viewer follows a
// part as the agent (or the owner, in the parameters panel) changes it.
//
//   FOLLOW (on by default)  every `cad.design` with a new `rev` is shown — cad.ts swaps the model IN
//                           PLACE, so the camera, the section plane and the measurements stay put.
//   PAUSED                  the model stays as it is; a badge says how many revisions behind it is, and
//                           Reload jumps to the newest (and stays paused).
//   REBUILD                 sends `cad.design.refresh`: the daemon rebuilds the part from design.json.
//   BUSY                    "working…" while a request is running or queued, or "waiting for a CAD
//                           slot" while the part is held because every SolidCraft slot is taken.
//
// Two pieces, both free of three.js and of the socket so they run under jsdom:
//   createCadDesignStore()  the newest `cad.design` per server + worktree + part, with listeners.
//   createCadLive()         the Follow / Paused state machine and its small toolbar.
import type { CadDesignEvent } from "../../protocol";

export const WAITING_FOR_SLOT = "waiting for a CAD slot";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ── the newest design per part ──────────────────────────────────────────────────────────────────
export interface CadDesignStore {
  /** Record an event; listeners of that part are told. */
  put(url: string, ev: CadDesignEvent): void;
  get(url: string, cwd: string, part: string): CadDesignEvent | undefined;
  /** Hear every later event of one part. Returns unsubscribe. */
  subscribe(url: string, cwd: string, part: string, fn: (ev: CadDesignEvent) => void): () => void;
  /** A server went away: forget its parts. */
  forget(url: string): void;
}

export function createCadDesignStore(): CadDesignStore {
  const latest = new Map<string, CadDesignEvent>();
  const listeners = new Map<string, Set<(ev: CadDesignEvent) => void>>();
  const key = (url: string, cwd: string, part: string): string => `${url}\n${cwd}\n${part}`;
  return {
    put(url, ev) {
      const k = key(url, ev.cwd, ev.part);
      latest.set(k, ev);
      for (const fn of [...(listeners.get(k) ?? [])]) {
        try {
          fn(ev);
        } catch {
          /* one broken listener must not stop the others (or the event router) */
        }
      }
    },
    get: (url, cwd, part) => latest.get(key(url, cwd, part)),
    subscribe(url, cwd, part, fn) {
      const k = key(url, cwd, part);
      let set = listeners.get(k);
      if (!set) listeners.set(k, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    },
    forget(url) {
      for (const k of [...latest.keys()]) if (k.startsWith(`${url}\n`)) latest.delete(k);
    },
  };
}

// ── Follow / Paused ─────────────────────────────────────────────────────────────────────────────
export interface CadLiveDeps {
  part: string;
  /** Put this revision's model on screen (the first load, or an in-place swap). Only called for an
   *  event that has a `preview`. Rejects when it could not be shown. */
  show(ev: CadDesignEvent): Promise<void>;
  /** Nothing to show for this revision (an empty design): take any model off screen. */
  clear?(ev: CadDesignEvent): void;
  /** Rebuild pressed. */
  rebuild(): void;
}

export interface CadLive {
  /** The toolbar: Follow, the "N behind" badge, Reload, Rebuild, the busy line. */
  el: HTMLElement;
  /** Feed every `cad.design` of the part here. */
  onDesign(ev: CadDesignEvent): void;
  /** Show the newest revision now, whatever Follow says (opening the viewer, Reload). */
  showLatest(): Promise<void>;
  following(): boolean;
  /** How many revisions newer than the one on screen have arrived. */
  behind(): number;
  /** The revision on screen (0: none yet). */
  shownRev(): number;
  latest(): CadDesignEvent | undefined;
  dispose(): void;
}

export function createCadLive(deps: CadLiveDeps): CadLive {
  let follow = true;
  let latest: CadDesignEvent | undefined;
  let shown = 0;
  let loading = false;
  let again = false;
  let error = "";
  let disposed = false;

  const root = el("div", "cad-live");
  root.dataset.part = deps.part;
  const followBtn = el("button", "cad-live-follow", "Follow");
  followBtn.type = "button";
  followBtn.dataset.live = "follow";
  followBtn.setAttribute("role", "switch");
  const badge = el("span", "cad-live-behind");
  badge.dataset.live = "behind";
  const reloadBtn = el("button", "cad-live-reload", "Reload");
  reloadBtn.type = "button";
  reloadBtn.dataset.live = "reload";
  const rebuildBtn = el("button", "cad-live-rebuild", "Rebuild");
  rebuildBtn.type = "button";
  rebuildBtn.dataset.live = "rebuild";
  rebuildBtn.title = "Rebuild from design.json on disk";
  const busy = el("span", "cad-live-busy");
  busy.dataset.live = "busy";
  busy.setAttribute("role", "status");
  const err = el("span", "cad-live-error");
  err.dataset.live = "error";
  root.append(followBtn, badge, reloadBtn, rebuildBtn, busy, err);

  const behind = (): number => (latest ? Math.max(0, latest.rev - shown) : 0);

  function render(): void {
    followBtn.setAttribute("aria-checked", String(follow));
    followBtn.classList.toggle("on", follow);
    followBtn.textContent = follow ? "Follow" : "Paused";
    followBtn.title = follow ? "Following every change — tap to pause" : "Paused — tap to follow again";
    const n = behind();
    const lagging = !follow && n > 0;
    badge.hidden = !lagging;
    badge.textContent = lagging ? `${n} behind` : "";
    reloadBtn.hidden = !lagging;
    const waiting = latest?.waiting === true;
    const working = latest?.busy === true || loading;
    busy.hidden = !(waiting || working);
    busy.textContent = waiting ? WAITING_FOR_SLOT : working ? "working…" : "";
    busy.classList.toggle("waiting", waiting);
    err.hidden = !error;
    err.textContent = error;
    root.dataset.rev = String(shown);
    root.dataset.latest = String(latest?.rev ?? 0);
  }

  async function showLatest(): Promise<void> {
    if (disposed || !latest) return;
    if (loading) {
      again = true; // a swap is in flight: go round once more when it lands, straight to the newest
      return;
    }
    const ev = latest;
    if (ev.rev === shown) return;
    loading = true;
    render();
    try {
      if (ev.preview) await deps.show(ev);
      else deps.clear?.(ev);
      shown = ev.rev;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
    if (disposed) return;
    render();
    if (again) {
      again = false;
      if (latest && latest.rev !== shown && !error) await showLatest();
    }
  }

  followBtn.onclick = () => {
    follow = !follow;
    render();
    if (follow) void showLatest(); // catching up is what turning Follow back on means
  };
  reloadBtn.onclick = () => void showLatest();
  rebuildBtn.onclick = () => deps.rebuild();
  render();

  return {
    el: root,
    onDesign(ev) {
      if (disposed || ev.part !== deps.part) return;
      latest = ev;
      render();
      if (follow) void showLatest();
    },
    showLatest,
    following: () => follow,
    behind,
    shownRev: () => shown,
    latest: () => latest,
    dispose() {
      disposed = true;
      root.remove();
    },
  };
}
