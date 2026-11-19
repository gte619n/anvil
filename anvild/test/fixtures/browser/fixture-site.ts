/**
 * A local fixture web site for the browser tests (after the C0 spike's). It stands in for "a daemon
 * the browser must not reach" and for an ordinary allowed site, and records every request it gets.
 * Loopback only, random port. Test fixture, not product code.
 */
export interface FixtureSite {
  port: number;
  /** Every request received, in order. */
  requests: { path: string; upgrade: string | null }[];
  url(path?: string, host?: string): string;
  stop(): void;
}

const html = (title: string, body: string): Response => new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });

export function startFixtureSite(): FixtureSite {
  const requests: FixtureSite["requests"] = [];
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const u = new URL(req.url);
      requests.push({ path: u.pathname, upgrade: req.headers.get("upgrade") });
      if (u.pathname === "/ws") return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (u.pathname === "/") return html("Fixture Home", `<h1>Home</h1><a id="next" href="/page2">Go to page two</a> <button onclick="document.title='clicked'">Press me</button>`);
      if (u.pathname === "/page2") return html("Fixture Two", `<h1>Second page</h1><a href="/">Back</a>`);
      if (u.pathname === "/redir") return Response.redirect(u.searchParams.get("to") ?? "/page2", 302);
      // Opens a WebSocket to ?to=<port> on loopback (default: this server) and reports in the title.
      if (u.pathname === "/ws.html") {
        return html(
          "WS test",
          `<pre id="o">connecting</pre><script>const p=new URLSearchParams(location.search).get("to")||location.port;const s=new WebSocket("ws://127.0.0.1:"+p+"/ws");s.onopen=()=>s.send("hi");s.onmessage=e=>{o.textContent="ws-got:"+e.data;document.title="ws-ok"};s.onerror=()=>{o.textContent="ws-error";document.title="ws-error"}</script>`,
        );
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws, m) {
        ws.send(`echo:${String(m)}`);
      },
    },
  });
  const port = srv.port as number;
  return { port, requests, url: (path = "/", host = "127.0.0.1") => `http://${host}:${port}${path}`, stop: () => srv.stop(true) };
}
