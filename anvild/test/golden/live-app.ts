/**
 * Boot the REAL built web app in a Playwright page with a stubbed socket (see live-server.ts for what
 * is served). The stub replaces `window.WebSocket` before any app code runs; the app's own
 * `AnvilSocket`, event router (`main.ts`), part card, viewer and panels are the product's, unmodified.
 *
 *   const app = await bootApp(page);                 // server.hello (with "cad-work") + one session
 *   await app.push(design({ rev: 1 }));              // any server event, as the daemon would send it
 *   const sent = await app.sent("cad.param.set");    // the commands the app sent
 *   const probe = await app.probe();                 // the viewer's read-only test probe (cad.ts)
 *
 * The stub answers every correlated command with `ack`, except:
 *   cad.param.set    → `cad.param.set.result`; the expression "bogus(" is refused with BAD_EXPRESSION
 *   cad.parts.list   → `cad.parts.list.result` with the parts given to bootApp
 */
import type { Page } from "@playwright/test";

export const SESSION_ID = "sess_live";
export const CWD = "/repo/plate-project";
export const BAD_EXPRESSION = "parameters.change: cannot parse expression `bogus(` for L: unexpected end of input";

export interface Probe {
  camera: number[];
  projection: number[];
  target: number[] | null;
  zoom: number;
  triangles: number;
  vertices: number;
  modelId: string | null;
  size: [number, number, number] | null;
  units: string;
  sectionOn: boolean;
  sectionPos: number | null;
  gpuGeometries: number;
  canvases: number;
}

const session = {
  id: SESSION_ID,
  title: "plate",
  cwd: CWD,
  source: "existing-dir",
  model: "sonnet",
  autonomy: "allowlist",
  status: "idle",
  createdAt: "2026-11-19T00:00:00.000Z",
  lastActivityAt: "2026-11-19T00:00:00.000Z",
  usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
};

/** A `cad.design` for the plate. Odd revs are served fixture A, even revs fixture B (live-server.ts). */
export function design(more: { rev: number } & Record<string, unknown>, gate: Record<string, unknown> = {}): Record<string, unknown> {
  const L = more.rev % 2 === 1 ? 80 : 120;
  return {
    type: "cad.design",
    cwd: CWD,
    part: "plate",
    preview: `cad/plate/.cache/preview-${more.rev}.glb`,
    params: [
      { name: "L", expression: `${L} mm`, value: L, unit: "mm" },
      { name: "W", expression: "50 mm", value: 50, unit: "mm" },
      { name: "T", expression: "6 mm", value: 6, unit: "mm" },
    ],
    gate: { state: "pass", checks: [{ id: "volume", expected: 23335.167, measured: 23335.167, ok: true, hard: true }], warnings: [], staleBuild: false, ...gate },
    busy: false,
    by: "agent",
    sessionIds: [SESSION_ID],
    ...more,
  };
}

export async function bootApp(page: Page, opts: { capabilities?: string[]; parts?: string[] } = {}) {
  const capabilities = opts.capabilities ?? ["autopilot", "cad-work"];
  await page.addInitScript(
    ({ session, capabilities, parts, cwd, bad }) => {
      const w = window as any;
      w.__ANVIL_CAD_TEST__ = true; // cad.ts publishes its read-only probe only when this is set
      localStorage.setItem("anvil.sessions", JSON.stringify([session]));
      localStorage.setItem("anvil.active", session.id);
      const state = { sent: [] as any[], sockets: [] as any[], glContexts: 0, glCanvases: new Set<any>() };
      w.__anvil = state;
      const stamp = (ev: any) => JSON.stringify({ v: 4, ts: new Date().toISOString(), ...ev });
      const deliver = (ev: any) => {
        for (const s of state.sockets) if (s.readyState === 1) s.onmessage?.({ data: stamp(ev) });
      };
      w.__anvilPush = deliver;
      class StubSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        onopen: any;
        onmessage: any;
        onclose: any;
        onerror: any;
        constructor(public url: string) {
          state.sockets.push(this);
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
            this.onmessage?.({ data: stamp({ type: "server.hello", serverId: "srv_test", serverName: "test", version: "0.0.0-test", protocolVersion: 4, capabilities, role: "standalone" }) });
            this.onmessage?.({ data: stamp({ type: "session.list", sessions: [session] }) });
          }, 0);
        }
        send(data: string) {
          const cmd = JSON.parse(data);
          if (cmd.type === "ping") return void setTimeout(() => this.onmessage?.({ data: stamp({ type: "pong" }) }), 0);
          state.sent.push(cmd);
          if (!cmd.cid) return;
          let reply: any = { type: "ack", cid: cmd.cid };
          if (cmd.type === "cad.param.set") {
            const refused = String(cmd.expression).trim() === "bogus(";
            reply = { type: "cad.param.set.result", cid: cmd.cid, cwd: cmd.cwd, part: cmd.part, name: cmd.name, ok: !refused, ...(refused ? { error: bad } : {}) };
          } else if (cmd.type === "cad.parts.list") {
            reply = { type: "cad.parts.list.result", cid: cmd.cid, cwd, parts: parts.map((part: string) => ({ part, hasDesign: true, live: true, busy: false, rev: 1, gate: { state: "pass", checks: [], warnings: [], staleBuild: false } })) };
          }
          setTimeout(() => this.onmessage?.({ data: stamp(reply) }), 0);
        }
        close() {
          this.readyState = 3;
        }
        addEventListener() {}
        removeEventListener() {}
      }
      w.WebSocket = StubSocket;
      // Count WebGL contexts: one per canvas that was ever handed a GL context.
      const real = HTMLCanvasElement.prototype.getContext;
      (HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement, type: string, ...rest: any[]) {
        const ctx = (real as any).call(this, type, ...rest);
        if (ctx && /^(webgl2?|experimental-webgl)$/.test(type) && !state.glCanvases.has(this)) {
          state.glCanvases.add(this);
          state.glContexts++;
        }
        return ctx;
      };
    },
    { session, capabilities, parts: opts.parts ?? ["plate"], cwd: CWD, bad: BAD_EXPRESSION },
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__anvil?.sent.length > 0, null, { timeout: 30_000 }); // the app spoke: hello was handled

  const probe = (): Promise<Probe | null> => page.evaluate(() => (window as any).__anvilCadProbe?.() ?? null);
  return {
    errors,
    push: (ev: Record<string, unknown>) => page.evaluate((e) => (window as any).__anvilPush(e), ev),
    sent: (type?: string) => page.evaluate((t) => (window as any).__anvil.sent.filter((c: any) => !t || c.type === t), type),
    glContexts: () => page.evaluate(() => (window as any).__anvil.glContexts as number),
    probe,
    /** Wait until the viewer's model has this many triangles; returns the probe then. */
    async model(triangles: number): Promise<Probe> {
      await page.waitForFunction((n) => (window as any).__anvilCadProbe?.()?.triangles === n, triangles, { timeout: 30_000 });
      return (await probe())!;
    },
    /** Wait for the camera to come to rest (orbit damping, the opening fit), then return the probe. */
    async settled(): Promise<Probe> {
      let last = "";
      for (let i = 0; i < 100; i++) {
        const p = await probe();
        const now = JSON.stringify([p?.camera, p?.projection, p?.target]);
        if (p && now === last) return p;
        last = now;
        await page.waitForTimeout(150);
      }
      throw new Error("the camera never came to rest");
    },
  };
}
